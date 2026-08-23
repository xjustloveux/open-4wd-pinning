import * as raw from 'multiformats/codecs/raw';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { describe, expect, it } from 'vitest';
import { QuotaLedger, type KuboClient, type PinMeta, type PinRecord } from '../pinning';
import { createDmcaLifecycleExecutor } from './lifecycle-executor';
import type { DmcaPinMetadata } from './types';

const limits = { perSignerMaxPins: 1, perSignerMaxSizeGb: 1, globalMaxSizeTb: 1 };

async function rawFixture(label: string): Promise<{ cid: string; bytes: Uint8Array }> {
  const bytes = new TextEncoder().encode(label);
  return { cid: CID.createV1(raw.code, await sha256.digest(bytes)).toString(), bytes };
}

function harness(stored: Map<string, Uint8Array>) {
  const pins = new Map<string, PinRecord>();
  const cluster = {
    async pin(cid: string, meta: PinMeta) {
      pins.set(cid, { cid, meta });
    },
    async unpin(cid: string) {
      pins.delete(cid);
    },
    async get(cid: string) {
      return pins.get(cid);
    },
    async *list() {
      yield* pins.values();
    },
    async peers() {
      return 1;
    },
  };
  const kubo: KuboClient = {
    async blockPut(): Promise<never> {
      throw new Error('restore measurement must not write');
    },
    async hasBlock(cid) {
      return stored.has(cid);
    },
    async blockGet(cid) {
      const bytes = stored.get(cid);
      if (bytes === undefined) throw new Error('missing');
      return bytes;
    },
    async stats() {
      return { repoSizeBytes: 0, availableBytes: 0 };
    },
  };
  const quota = new QuotaLedger(limits);
  return { pins, cluster, kubo, quota };
}

describe('createDmcaLifecycleExecutor', () => {
  it('成功 takedown 才同步釋放 quota，並可讀取完整原 metadata', async () => {
    const fixture = await rawFixture('dmca quota lifecycle');
    const h = harness(new Map([[fixture.cid, fixture.bytes]]));
    const meta: PinMeta = {
      category: 'part',
      signer: 'uploader',
      source: 'api',
      logicalSizeBytes: fixture.bytes.byteLength,
      physicalSizeBytes: fixture.bytes.byteLength,
    };
    h.pins.set(fixture.cid, { cid: fixture.cid, meta });
    h.quota.recordPin({ cid: fixture.cid, meta });
    const executor = createDmcaLifecycleExecutor(h);

    await expect(executor.pinMetadataFor(fixture.cid)).resolves.toEqual(meta);
    await executor.unpin([fixture.cid]);
    expect(h.quota.snapshot()).toMatchObject({ totalPins: 0, physicalSizeBytes: 0 });
  });

  it('Cluster unpin 失敗時不先釋放 quota', async () => {
    const fixture = await rawFixture('failed takedown');
    const h = harness(new Map([[fixture.cid, fixture.bytes]]));
    const meta: PinMeta = {
      category: 'part',
      signer: 'uploader',
      source: 'api',
      logicalSizeBytes: fixture.bytes.byteLength,
      physicalSizeBytes: fixture.bytes.byteLength,
    };
    h.pins.set(fixture.cid, { cid: fixture.cid, meta });
    h.quota.recordPin({ cid: fixture.cid, meta });
    h.cluster.unpin = () => Promise.reject(new Error('cluster unavailable'));

    await expect(createDmcaLifecycleExecutor(h).unpin([fixture.cid])).rejects.toThrow(
      /cluster unavailable/,
    );
    expect(h.quota.snapshot()).toMatchObject({ totalPins: 1 });
  });

  it('restore 重新量 logical DAG、保留原 ownership/physical attribution，Cluster 成功才 commit', async () => {
    const fixture = await rawFixture('restorable raw resource');
    const h = harness(new Map([[fixture.cid, fixture.bytes]]));
    const executor = createDmcaLifecycleExecutor(h);
    const saved: DmcaPinMetadata = {
      category: 'track',
      signer: 'original-uploader',
      source: 'api',
      logicalSizeBytes: 999,
      physicalSizeBytes: 77,
    };

    await executor.restore([fixture.cid], { [fixture.cid]: saved });

    expect(h.pins.get(fixture.cid)?.meta).toEqual({
      ...saved,
      logicalSizeBytes: fixture.bytes.byteLength,
    });
    expect(h.quota.snapshot()).toMatchObject({
      totalPins: 1,
      totalLogicalSizeBytes: fixture.bytes.byteLength,
      // metadata 的 77 仍是原 ingress 歸因；全域配額以目前完整 DAG 的唯一 blocks 實量為準。
      physicalSizeBytes: fixture.bytes.byteLength,
    });
  });

  it('restore 配額被拒時不建立 Cluster pin', async () => {
    const occupied = await rawFixture('occupied');
    const restoring = await rawFixture('restoring');
    const h = harness(new Map([[restoring.cid, restoring.bytes]]));
    const occupiedMeta: PinMeta = {
      category: 'part',
      signer: 'same-signer',
      source: 'api',
      logicalSizeBytes: occupied.bytes.byteLength,
      physicalSizeBytes: occupied.bytes.byteLength,
    };
    h.pins.set(occupied.cid, { cid: occupied.cid, meta: occupiedMeta });
    h.quota.recordPin({ cid: occupied.cid, meta: occupiedMeta });
    const executor = createDmcaLifecycleExecutor(h);

    await expect(
      executor.restore([restoring.cid], {
        [restoring.cid]: {
          category: 'part',
          signer: 'same-signer',
          source: 'api',
          logicalSizeBytes: restoring.bytes.byteLength,
          physicalSizeBytes: restoring.bytes.byteLength,
        },
      }),
    ).rejects.toThrow(/quota/);
    expect(h.pins.has(restoring.cid)).toBe(false);
  });

  it('Cluster restore 失敗時釋放 reservation 且不提交 quota', async () => {
    const fixture = await rawFixture('failed restore');
    const h = harness(new Map([[fixture.cid, fixture.bytes]]));
    h.cluster.pin = () => Promise.reject(new Error('cluster unavailable'));
    const executor = createDmcaLifecycleExecutor(h);

    await expect(
      executor.restore([fixture.cid], {
        [fixture.cid]: {
          category: 'part',
          signer: 'uploader',
          source: 'api',
          logicalSizeBytes: fixture.bytes.byteLength,
          physicalSizeBytes: fixture.bytes.byteLength,
        },
      }),
    ).rejects.toThrow(/cluster unavailable/);
    expect(h.quota.snapshot()).toMatchObject({ totalPins: 0, physicalSizeBytes: 0 });
  });
});
