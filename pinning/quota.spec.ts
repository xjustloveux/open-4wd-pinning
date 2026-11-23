import { describe, expect, it } from 'vitest';
import { QuotaLedger } from './quota';

const limits = { perSignerMaxPins: 2, perSignerMaxSizeGb: 1, globalMaxSizeTb: 1 };
const rec = (
  cid: string,
  signer: string,
  logicalSizeBytes: number,
  physicalSizeBytes = logicalSizeBytes,
) => ({
  cid,
  meta: {
    category: 'part',
    signer,
    logicalSizeBytes,
    physicalSizeBytes,
    source: 'api' as const,
  },
});

describe('QuotaLedger', () => {
  it('件數上限：第 3 件拒、unpin 後放行', () => {
    const q = new QuotaLedger(limits);
    q.recordPin(rec('c1', 's1', 10));
    q.recordPin(rec('c2', 's1', 10));
    expect(
      q.admit({ cid: 'c3', signer: 's1', logicalSizeBytes: 10, physicalSizeBytes: 10 }),
    ).toEqual({ allowed: false, reason: 'signer-pins' });
    q.recordUnpin('c1');
    expect(
      q.admit({ cid: 'c3', signer: 's1', logicalSizeBytes: 10, physicalSizeBytes: 10 }).allowed,
    ).toBe(true);
  });

  it('簽署者上限只看 logical bytes，global 上限只看 physical bytes 且包含 auto pin', () => {
    const q = new QuotaLedger(limits);
    expect(
      q.admit({
        cid: 'too-logical',
        signer: 's1',
        logicalSizeBytes: 2 * 1024 ** 3,
        physicalSizeBytes: 1,
      }).reason,
    ).toBe('signer-size');
    q.load([
      {
        cid: 'a1',
        meta: {
          category: 'checkpoint',
          source: 'auto',
          logicalSizeBytes: 2 * 1024 ** 4,
          physicalSizeBytes: 1024 ** 4,
        },
      },
    ]);
    expect(
      q.admit({ cid: 'global-full', signer: 's1', logicalSizeBytes: 10, physicalSizeBytes: 1 })
        .reason,
    ).toBe('global-size');
  });

  it('同 CID replacement admission 先扣舊帳，不增加件數或重複 physical attribution', () => {
    const q = new QuotaLedger({ ...limits, perSignerMaxPins: 1 });
    q.recordPin(rec('same', 's1', 100, 80));
    expect(q.physicalSizeBytesFor('same')).toBe(80);

    expect(
      q.admit({ cid: 'same', signer: 's1', logicalSizeBytes: 120, physicalSizeBytes: 80 }),
    ).toEqual({ allowed: true });
    q.recordPin(rec('same', 's1', 120, 80));

    expect(q.snapshot()).toEqual({
      totalPins: 1,
      totalLogicalSizeBytes: 120,
      physicalSizeBytes: 80,
      globalMaxSizeBytes: 1024 ** 4,
      acceptingPins: true,
    });
  });

  it('load 重建與增量一致（重啟不丟帳）', () => {
    const q1 = new QuotaLedger(limits);
    q1.recordPin(rec('c1', 's1', 10));
    const q2 = new QuotaLedger(limits);
    q2.load([rec('c1', 's1', 10)]);
    const admission = { cid: 'c2', signer: 's1', logicalSizeBytes: 10, physicalSizeBytes: 10 };
    expect(q2.admit(admission)).toEqual(q1.admit(admission));
    expect(q2.snapshot()).toEqual(q1.snapshot());
  });

  it('in-flight reservation 會占住額度，失敗 release 後才讓下一筆進入', () => {
    const q = new QuotaLedger({ ...limits, perSignerMaxPins: 1 });
    const first = q.reserve({
      cid: 'c1',
      signer: 's1',
      logicalSizeBytes: 100,
      physicalSizeBytes: 100,
    });
    expect(first.allowed).toBe(true);
    expect(
      q.reserve({ cid: 'c2', signer: 's1', logicalSizeBytes: 100, physicalSizeBytes: 100 }),
    ).toEqual({ allowed: false, reason: 'signer-pins' });

    if (!first.allowed) throw new Error('fixture reservation must be allowed');
    q.release(first.reservationId);
    expect(
      q.reserve({ cid: 'c2', signer: 's1', logicalSizeBytes: 100, physicalSizeBytes: 100 }).allowed,
    ).toBe(true);
  });

  it('measured recheck 與 commit 以實量取代保留量，且同 CID 不能同時保留兩次', () => {
    const q = new QuotaLedger(limits);
    const reserved = q.reserve({
      cid: 'c1',
      signer: 's1',
      logicalSizeBytes: 100,
      physicalSizeBytes: 100,
    });
    if (!reserved.allowed) throw new Error('fixture reservation must be allowed');
    expect(
      q.reserve({ cid: 'c1', signer: 's1', logicalSizeBytes: 100, physicalSizeBytes: 100 }),
    ).toEqual({ allowed: false, reason: 'in-flight' });

    const measured = { cid: 'c1', signer: 's1', logicalSizeBytes: 60, physicalSizeBytes: 40 };
    expect(q.recheck(reserved.reservationId, measured)).toEqual({ allowed: true });
    q.commit(reserved.reservationId, rec('c1', 's1', 60, 40));
    expect(q.snapshot()).toMatchObject({
      totalPins: 1,
      totalLogicalSizeBytes: 60,
      physicalSizeBytes: 40,
    });
  });

  it('兩個 roots 共用 child 時只計一次；任一 unpin 順序都保留仍被引用的 bytes', () => {
    const shared = { cid: 'shared-child', sizeBytes: 30 };
    const rootA = { cid: 'root-a-block', sizeBytes: 10 };
    const rootB = { cid: 'root-b-block', sizeBytes: 20 };

    const build = (): QuotaLedger => {
      const q = new QuotaLedger(limits);
      q.recordPin(rec('root-a', 's1', 40, 40), [rootA, shared]);
      q.recordPin(rec('root-b', 's2', 50, 20), [rootB, shared]);
      expect(q.snapshot().physicalSizeBytes).toBe(60);
      return q;
    };

    const aFirst = build();
    aFirst.recordUnpin('root-a');
    expect(aFirst.snapshot().physicalSizeBytes).toBe(50);
    aFirst.recordUnpin('root-b');
    expect(aFirst.snapshot().physicalSizeBytes).toBe(0);

    const bFirst = build();
    bFirst.recordUnpin('root-b');
    expect(bFirst.snapshot().physicalSizeBytes).toBe(40);
    bFirst.recordUnpin('root-a');
    expect(bFirst.snapshot().physicalSizeBytes).toBe(0);
  });

  it('root-scoped 讀取只承認仍入帳 root 自己的 traversal blocks', () => {
    const q = new QuotaLedger(limits);
    const shared = { cid: 'shared-child', sizeBytes: 30 };
    q.recordPin(rec('root-a', 's1', 40, 40), [{ cid: 'root-a', sizeBytes: 10 }, shared]);
    q.recordPin(rec('root-b', 's2', 50, 50), [{ cid: 'root-b', sizeBytes: 20 }, shared]);

    expect(q.hasRootBlock('root-a', 'root-a')).toBe(true);
    expect(q.hasRootBlock('root-a', 'shared-child')).toBe(true);
    expect(q.hasRootBlock('root-a', 'root-b')).toBe(false);
    expect(q.hasRootBlock('missing-root', 'shared-child')).toBe(false);

    q.recordUnpin('root-a');
    expect(q.hasRootBlock('root-a', 'shared-child')).toBe(false);
    expect(q.hasRootBlock('root-b', 'shared-child')).toBe(true);
  });

  it('啟動 measured rebuild 與增量 block index 一致，重建不可用時 reservation fail-closed', () => {
    const blocks = [
      { cid: 'root-block', sizeBytes: 10 },
      { cid: 'child-block', sizeBytes: 30 },
    ];
    const record = rec('root', 's1', 40, 40);
    const incremental = new QuotaLedger(limits);
    incremental.recordPin(record, blocks);

    const rebuilt = new QuotaLedger(limits);
    rebuilt.loadMeasured([{ record, blocks }]);
    expect(rebuilt.snapshot()).toEqual(incremental.snapshot());

    rebuilt.markAccountingUnavailable();
    expect(
      rebuilt.reserve({ cid: 'next', signer: 's1', logicalSizeBytes: 1, physicalSizeBytes: 1 }),
    ).toEqual({ allowed: false, reason: 'accounting-unavailable' });
    expect(rebuilt.snapshot().acceptingPins).toBe(false);
  });

  it('實量 recheck 與 commit 只為尚未被其他 root 引用的 blocks 保留及入帳', () => {
    const q = new QuotaLedger(limits);
    const shared = { cid: 'shared', sizeBytes: 30 };
    q.recordPin(rec('root-a', 's1', 40, 40), [{ cid: 'root-a-block', sizeBytes: 10 }, shared]);

    const reserved = q.reserve({
      cid: 'root-b',
      signer: 's2',
      logicalSizeBytes: 50,
      physicalSizeBytes: 50,
    });
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) return;

    const measuredBlocks = [{ cid: 'root-b-block', sizeBytes: 20 }, shared];
    const measured = {
      cid: 'root-b',
      signer: 's2',
      logicalSizeBytes: 50,
      physicalSizeBytes: 20,
      blocks: measuredBlocks,
    };
    expect(q.recheck(reserved.reservationId, measured)).toEqual({ allowed: true });
    q.commit(reserved.reservationId, rec('root-b', 's2', 50, 20), measuredBlocks);
    expect(q.snapshot().physicalSizeBytes).toBe(60);
  });
});
