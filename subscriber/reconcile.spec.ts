import { describe, expect, it } from 'vitest';
import { DenyList, reconcileCheckpoint } from './reconcile';
import { fakeCtx, fakeDagCid, fakeState, fakeCheckpoint } from './reconcile.test-support';

describe('reconcileCheckpoint', () => {
  it('pin 檢查點三件套與全部 cold partitions（metadata source=auto）', async () => {
    const ctx = fakeCtx();
    const cp = fakeCheckpoint({ coldParts: { '2026-Q1': 'cidQ1', '2026-Q2': 'cidQ2' } });
    await reconcileCheckpoint(ctx, cp.checkpoint, cp.state, undefined);
    expect(ctx.cluster.pinned.map((p) => p.cid)).toEqual(
      expect.arrayContaining([
        cp.checkpoint.cid,
        cp.checkpoint.derived_state_cid,
        fakeDagCid('cidQ1'),
        fakeDagCid('cidQ2'),
      ]),
    );
    expect(new Set(ctx.cluster.pinned.map((p) => p.meta.source))).toEqual(new Set(['auto']));
  });

  it('上一檢查點已 pin、本輪消失的 partition 被 unpin', async () => {
    const oldCid = fakeDagCid('cidOld');
    const ctx = fakeCtx({
      initialPins: [{ cid: oldCid, meta: { category: 'cold-partition', source: 'auto' } }],
    });
    const prev = fakeState({ coldParts: { '2026-Q1': 'cidOld' } });
    const cur = fakeCheckpoint({ coldParts: { '2026-H1': 'cidMerged' } });
    await reconcileCheckpoint(ctx, cur.checkpoint, cur.state, prev);
    expect(ctx.cluster.unpinned).toContain(oldCid);
  });

  it('服務自動 cold partition 即使不在 prev，仍由 cluster 現況辨識；首次失敗會在下一輪重試', async () => {
    const orphanCid = fakeDagCid('cidOrphan');
    const activeCid = fakeDagCid('cidActive');
    const apiCid = fakeDagCid('cidApiCold');
    const ctx = fakeCtx({
      initialPins: [
        { cid: orphanCid, meta: { category: 'cold-partition', source: 'auto' } },
        { cid: activeCid, meta: { category: 'cold-partition', source: 'auto' } },
        { cid: apiCid, meta: { category: 'cold-partition', source: 'api' } },
      ],
      failUnpinOnceCids: [orphanCid],
    });
    const cur = fakeCheckpoint({ coldParts: { current: activeCid } });

    const first = await reconcileCheckpoint(ctx, cur.checkpoint, cur.state, fakeState());
    expect(first.warnings).toEqual([
      expect.objectContaining({ cid: orphanCid, operation: 'unpin' }),
    ]);
    expect(ctx.cluster.unpinned).not.toContain(orphanCid);

    const second = await reconcileCheckpoint(ctx, cur.checkpoint, cur.state, cur.state);
    expect(second.warnings).toEqual([]);
    expect(ctx.cluster.unpinned).toContain(orphanCid);
    expect(ctx.cluster.unpinned).not.toContain(activeCid);
    expect(ctx.cluster.unpinned).not.toContain(apiCid);
  });

  it('retired UGC 與黑名單 CID 被 unpin；單筆 pin 失敗只記 warning 不中斷', async () => {
    const ctx = fakeCtx({ failPinCids: ['cidQ1'] });
    const cp = fakeCheckpoint({
      coldParts: { '2026-Q1': 'cidQ1', '2026-Q2': 'cidQ2' },
      retired: ['cidRetired'],
      blacklist: ['cidBad'],
    });
    const report = await reconcileCheckpoint(ctx, cp.checkpoint, cp.state, undefined);
    expect(ctx.cluster.unpinned).toEqual(expect.arrayContaining(['cidRetired', 'cidBad']));
    expect(ctx.cluster.pinned.map((p) => p.cid)).toContain(fakeDagCid('cidQ2'));
    expect(report.warnings.length).toBe(1);
  });
});

// DenyList 是 reconcile 對外契約的一部分——這裡補一組小案例驗證其兩個判定方法，而不是
// 只靠型別檢查交差。
describe('DenyList', () => {
  it('isBlacklisted 讀 currentState() 當下的 moderation.blacklist', () => {
    let state = fakeState({ blacklist: ['cidBad'] });
    const denyList = new DenyList({ currentState: () => state });

    expect(denyList.isBlacklisted('cidBad')).toBe(true);
    expect(denyList.isBlacklisted('cidOk')).toBe(false);

    // currentState 是存取器、非建構時快照——state 換掉後查詢立刻反映新值。
    state = fakeState({ blacklist: [] });
    expect(denyList.isBlacklisted('cidBad')).toBe(false);
  });

  it('isRepeatInfringer 以注入計數與門檻 3 比較；未注入 countNotRestoredTakedowns 時恆回 false', async () => {
    const withoutInjection = new DenyList({ currentState: () => fakeState() });
    expect(await withoutInjection.isRepeatInfringer('anySigner')).toBe(false);

    const withInjection = new DenyList({
      currentState: () => fakeState(),
      countNotRestoredTakedowns: async (signer) => (signer === 'badSigner' ? 3 : 1),
    });
    expect(await withInjection.isRepeatInfringer('badSigner')).toBe(true);
    expect(await withInjection.isRepeatInfringer('okSigner')).toBe(false);
  });
});

describe('reconcileCheckpoint：auto-pin 共用 quota 與雙計量', () => {
  it('每一筆 auto-pin 帶 logical/physical bytes，成功後立即記入同一 ledger', async () => {
    const ctx = fakeCtx();
    const cp = fakeCheckpoint({ coldParts: { '2026-Q1': 'cidQ1' } });
    await reconcileCheckpoint(ctx, cp.checkpoint, cp.state, undefined);

    const checkpointPin = ctx.cluster.pinned.find((p) => p.cid === cp.checkpoint.cid);
    expect(checkpointPin).toBeDefined();
    const checkpointBytes = await ctx.blocks.get(
      cp.checkpoint.cid as Parameters<typeof ctx.blocks.get>[0],
      1,
    );
    expect(checkpointBytes).not.toBeNull();
    expect(checkpointPin?.meta.logicalSizeBytes).toBe(checkpointBytes?.byteLength);
    expect(checkpointPin?.meta.physicalSizeBytes).toBe(checkpointBytes?.byteLength);

    for (const pin of ctx.cluster.pinned) {
      expect(typeof pin.meta.logicalSizeBytes).toBe('number');
      expect(typeof pin.meta.physicalSizeBytes).toBe('number');
    }
    expect(ctx.quota.snapshot().totalPins).toBe(ctx.cluster.pinned.length);
    expect(ctx.quota.snapshot().physicalSizeBytes).toBeGreaterThan(0);
  });

  it('global physical quota 拒絕 auto pin 時不呼叫 cluster.pin，並逐筆留下 warning', async () => {
    const ctx = fakeCtx({
      quotaLimits: {
        perSignerMaxPins: 100,
        perSignerMaxSizeGb: 100,
        globalMaxSizeTb: 1 / 1024 ** 4,
      },
    });
    const cp = fakeCheckpoint();

    const report = await reconcileCheckpoint(ctx, cp.checkpoint, cp.state, undefined);

    expect(ctx.cluster.pinned).toEqual([]);
    expect(report.warnings).toHaveLength(3);
    expect(report.warnings.every((warning) => warning.message.includes('global-size'))).toBe(true);
    expect(ctx.quota.snapshot().physicalSizeBytes).toBe(0);
  });

  it('cluster.unpin 成功後立即從 ledger 扣除舊 CID', async () => {
    const oldCid = fakeDagCid('cidOld');
    const old = {
      cid: oldCid,
      meta: {
        category: 'cold-partition',
        source: 'auto' as const,
        logicalSizeBytes: 12,
        physicalSizeBytes: 8,
      },
    };
    const ctx = fakeCtx({ initialPins: [old], quotaRecords: [old] });
    const prev = fakeState({ coldParts: { '2026-Q1': 'cidOld' } });
    const cur = fakeCheckpoint({ coldParts: {} });

    await reconcileCheckpoint(ctx, cur.checkpoint, cur.state, prev);

    expect(ctx.cluster.unpinned).toContain(oldCid);
    expect(ctx.quota.snapshot().physicalSizeBytes).not.toBe(8);
  });
});
