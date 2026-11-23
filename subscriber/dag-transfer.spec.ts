import * as dagCbor from '@ipld/dag-cbor';
import * as dagPb from '@ipld/dag-pb';
import * as raw from 'multiformats/codecs/raw';
import { varint } from 'multiformats';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { describe, expect, it } from 'vitest';
import type { BlockAccess } from '../core';
import type { KuboClient } from '../pinning';
import { hasCompleteDag, measureCompleteDag, transferDag } from './dag-transfer';

async function dagCborCid(bytes: Uint8Array): Promise<string> {
  return CID.createV1(dagCbor.code, await sha256.digest(bytes)).toString();
}

async function rawCid(bytes: Uint8Array): Promise<string> {
  return CID.createV1(raw.code, await sha256.digest(bytes)).toString();
}

async function dagPbCid(bytes: Uint8Array): Promise<string> {
  return CID.createV1(dagPb.code, await sha256.digest(bytes)).toString();
}

function unixFsFileData(size: number): Uint8Array {
  const encoded = new Uint8Array(varint.encodingLength(size));
  varint.encodeTo(size, encoded);
  return new Uint8Array([8, 2, 24, ...encoded, 32, ...encoded]);
}

describe('transferDag', () => {
  it('搬運 CIDv1(raw) UGC leaf 時保留 raw codec，不嘗試 DAG-CBOR 解碼', async () => {
    const bytes = new TextEncoder().encode('opaque glb bytes');
    const cid = await rawCid(bytes);
    const codecs: string[] = [];
    const blocks: BlockAccess = {
      async get(requested) {
        return String(requested) === cid ? bytes : null;
      },
      async putDagCbor(): Promise<never> {
        throw new Error('transferDag test must not write through BlockAccess');
      },
      async putRaw(): Promise<never> {
        throw new Error('transferDag test must not write through BlockAccess');
      },
      async pin(): Promise<never> {
        throw new Error('transferDag test must not pin through BlockAccess');
      },
    };
    const kubo: KuboClient = {
      async blockPut(value, codec) {
        codecs.push(codec);
        return codec === 'raw' ? rawCid(value) : dagCborCid(value);
      },
      async hasBlock() {
        return false;
      },
      async stats() {
        return { repoSizeBytes: 0, availableBytes: 0 };
      },
    };

    await expect(transferDag({ root: cid, blocks, kubo })).resolves.toEqual({
      blockCount: 1,
      logicalDagBytes: bytes.byteLength,
      logicalContentBytes: bytes.byteLength,
      newPhysicalBytes: bytes.byteLength,
      blocks: [{ cid, sizeBytes: bytes.byteLength }],
      complete: true,
    });
    expect(codecs).toEqual(['raw']);
  });

  it('搬運 canonical dag-pb UnixFS root 與 raw child，並量出完整 GLB 邏輯大小', async () => {
    const childBytes = new Uint8Array([1, 2, 3, 4]);
    const childCid = await rawCid(childBytes);
    const rootBytes = dagPb.encode({
      Data: unixFsFileData(childBytes.byteLength),
      Links: [{ Hash: CID.parse(childCid), Name: '', Tsize: childBytes.byteLength }],
    });
    const rootCid = await dagPbCid(rootBytes);
    const source = new Map([
      [rootCid, rootBytes],
      [childCid, childBytes],
    ]);
    const codecs: string[] = [];
    const blocks: BlockAccess = {
      async get(cid) {
        return source.get(String(cid)) ?? null;
      },
      async putDagCbor(): Promise<never> {
        throw new Error('unexpected write');
      },
      async putRaw(): Promise<never> {
        throw new Error('unexpected write');
      },
      async pin(): Promise<never> {
        throw new Error('unexpected pin');
      },
    };
    const kubo: KuboClient = {
      async blockPut(bytes, codec) {
        codecs.push(codec);
        return codec === 'dag-pb' ? dagPbCid(bytes) : rawCid(bytes);
      },
      async hasBlock() {
        return false;
      },
      async stats() {
        return { repoSizeBytes: 0, availableBytes: 0 };
      },
    };

    const result = await transferDag({ root: rootCid, blocks, kubo });
    expect(result.logicalContentBytes).toBe(childBytes.byteLength);
    expect(result.blockCount).toBe(2);
    expect(codecs).toEqual(['dag-pb', 'raw']);
  });

  it('parent 已在 Kubo 時仍遍歷 links、補齊 child，並分開回報 logical 與新增 physical bytes', async () => {
    const childBytes = dagCbor.encode({ value: 'child' });
    const childCid = await dagCborCid(childBytes);
    const parentBytes = dagCbor.encode({ child: CID.parse(childCid) });
    const parentCid = await dagCborCid(parentBytes);
    const source = new Map<string, Uint8Array>([
      [parentCid, parentBytes],
      [childCid, childBytes],
    ]);
    const reads: string[] = [];
    const stored = new Set([parentCid]);
    const blocks: BlockAccess = {
      async get(cid) {
        reads.push(String(cid));
        return source.get(String(cid)) ?? null;
      },
      async putDagCbor(): Promise<never> {
        throw new Error('transferDag test must not write through BlockAccess');
      },
      async putRaw(): Promise<never> {
        throw new Error('transferDag test must not write through BlockAccess');
      },
      async pin(): Promise<never> {
        throw new Error('transferDag test must not pin through BlockAccess');
      },
    };
    const kubo: KuboClient = {
      async blockPut(bytes) {
        const cid = await dagCborCid(bytes);
        stored.add(cid);
        return cid;
      },
      async hasBlock(cid) {
        return stored.has(cid);
      },
      async stats() {
        return { repoSizeBytes: 0, availableBytes: 0 };
      },
    };

    const result = await transferDag({ root: parentCid, blocks, kubo });

    expect(reads).toEqual([parentCid, childCid]);
    expect(stored.has(childCid)).toBe(true);
    expect(result).toEqual({
      blockCount: 2,
      logicalDagBytes: parentBytes.byteLength + childBytes.byteLength,
      newPhysicalBytes: childBytes.byteLength,
      blocks: [
        { cid: parentCid, sizeBytes: parentBytes.byteLength },
        { cid: childCid, sizeBytes: childBytes.byteLength },
      ],
      complete: true,
    });
  });

  it('在寫入 Kubo 前以 signed maxBytes 硬擋低報內容', async () => {
    const bytes = new TextEncoder().encode('larger than declared');
    const cid = await rawCid(bytes);
    let writes = 0;
    const blocks = blockSource(new Map([[cid, bytes]]));
    const kubo = kuboSink(() => {
      writes += 1;
    });

    await expect(
      transferDag({ root: cid, blocks, kubo, limits: { maxBytes: bytes.byteLength - 1 } }),
    ).rejects.toThrow(/maxBytes/);
    expect(writes).toBe(0);
  });

  it('限制 DAG graph depth 與單塊 fan-out', async () => {
    const childBytes = dagCbor.encode({ value: 'child' });
    const childCid = await dagCborCid(childBytes);
    const parentBytes = dagCbor.encode({ a: CID.parse(childCid), b: CID.parse(childCid) });
    const parentCid = await dagCborCid(parentBytes);
    const blocks = blockSource(
      new Map<string, Uint8Array>([
        [parentCid, parentBytes],
        [childCid, childBytes],
      ]),
    );

    await expect(
      transferDag({ root: parentCid, blocks, kubo: kuboSink(), limits: { maxDepth: 0 } }),
    ).rejects.toThrow(/maxDepth/);
    await expect(
      transferDag({
        root: parentCid,
        blocks,
        kubo: kuboSink(),
        limits: { maxLinksPerBlock: 1 },
      }),
    ).rejects.toThrow(/maxLinksPerBlock/);
  });

  it('限制 decoded IPLD nesting，並在 AbortSignal 已取消時不讀取來源', async () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 8; i += 1) nested = { nested };
    const bytes = dagCbor.encode(nested);
    const cid = await dagCborCid(bytes);
    let reads = 0;
    const blocks = blockSource(new Map([[cid, bytes]]), () => {
      reads += 1;
    });
    await expect(
      transferDag({ root: cid, blocks, kubo: kuboSink(), limits: { maxIpldNesting: 3 } }),
    ).rejects.toThrow(/maxIpldNesting/);

    const controller = new AbortController();
    controller.abort();
    await expect(
      transferDag({ root: cid, blocks, kubo: kuboSink(), signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    expect(reads).toBe(1);
  });
});

function blockSource(
  source: Map<string, Uint8Array>,
  onRead: () => void = () => undefined,
): BlockAccess {
  return {
    async get(cid) {
      onRead();
      return source.get(String(cid)) ?? null;
    },
    async putDagCbor(): Promise<never> {
      throw new Error('test must not write through BlockAccess');
    },
    async putRaw(): Promise<never> {
      throw new Error('test must not write through BlockAccess');
    },
    async pin(): Promise<never> {
      throw new Error('test must not pin through BlockAccess');
    },
  };
}

function kuboSink(onWrite: () => void = () => undefined): KuboClient {
  return {
    async blockPut(bytes, codec) {
      onWrite();
      return codec === 'raw' ? rawCid(bytes) : dagCborCid(bytes);
    },
    async hasBlock() {
      return false;
    },
    async stats() {
      return { repoSizeBytes: 0, availableBytes: 0 };
    },
  };
}

describe('hasCompleteDag', () => {
  it('完整且 CID 相符的 raw UGC leaf 回 true', async () => {
    const bytes = new TextEncoder().encode('opaque raw leaf');
    const cid = await rawCid(bytes);
    const kubo: KuboClient = {
      async blockPut(): Promise<never> {
        throw new Error('completeness check must not write');
      },
      async hasBlock() {
        return true;
      },
      async blockGet(requested) {
        if (requested !== cid) throw new Error('missing block');
        return bytes;
      },
      async stats() {
        return { repoSizeBytes: 0, availableBytes: 0 };
      },
    };

    await expect(hasCompleteDag({ root: cid, kubo })).resolves.toBe(true);
  });

  it('完整 DAG 可重算 block count 與 logical bytes，缺塊則回 null', async () => {
    const childBytes = dagCbor.encode({ value: 'child' });
    const childCid = await dagCborCid(childBytes);
    const parentBytes = dagCbor.encode({ child: CID.parse(childCid) });
    const parentCid = await dagCborCid(parentBytes);
    const stored = new Map<string, Uint8Array>([
      [parentCid, parentBytes],
      [childCid, childBytes],
    ]);
    const kubo: KuboClient = {
      async blockPut(): Promise<never> {
        throw new Error('measurement must not write');
      },
      async hasBlock(cid) {
        return stored.has(cid);
      },
      async blockGet(cid) {
        const bytes = stored.get(cid);
        if (bytes === undefined) throw new Error('missing block');
        return bytes;
      },
      async stats() {
        return { repoSizeBytes: 0, availableBytes: 0 };
      },
    };

    await expect(measureCompleteDag({ root: parentCid, kubo })).resolves.toEqual({
      blockCount: 2,
      logicalDagBytes: parentBytes.byteLength + childBytes.byteLength,
      blocks: [
        { cid: parentCid, sizeBytes: parentBytes.byteLength },
        { cid: childCid, sizeBytes: childBytes.byteLength },
      ],
    });
    stored.delete(childCid);
    await expect(measureCompleteDag({ root: parentCid, kubo })).resolves.toBeNull();
  });

  it('root block 存在但 dag-cbor child 缺少時回 false', async () => {
    const childBytes = dagCbor.encode({ value: 'child' });
    const childCid = await dagCborCid(childBytes);
    const parentBytes = dagCbor.encode({ child: CID.parse(childCid) });
    const parentCid = await dagCborCid(parentBytes);
    const stored = new Map<string, Uint8Array>([[parentCid, parentBytes]]);
    const kubo: KuboClient = {
      async blockPut(): Promise<never> {
        throw new Error('completeness check must not write');
      },
      async hasBlock(cid) {
        return stored.has(cid);
      },
      async blockGet(cid) {
        const bytes = stored.get(cid);
        if (bytes === undefined) throw new Error('missing block');
        return bytes;
      },
      async stats() {
        return { repoSizeBytes: 0, availableBytes: 0 };
      },
    };

    await expect(hasCompleteDag({ root: parentCid, kubo })).resolves.toBe(false);
  });
});
