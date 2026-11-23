import { describe, expect, it } from 'vitest';
import { createKuboClient } from './kubo-client';

describe('createKuboClient blockGet', () => {
  it('以 POST /api/v0/block/get 讀回原始 block bytes', async () => {
    let method = '';
    let path = '';
    let cid = '';
    let offline = '';
    const client = createKuboClient('http://kubo.test', async (input, init) => {
      const url = new URL(String(input));
      method = init?.method ?? '';
      path = url.pathname;
      cid = url.searchParams.get('arg') ?? '';
      offline = url.searchParams.get('offline') ?? '';
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });

    const bytes = await client.blockGet('bafyBlock');

    expect(method).toBe('POST');
    expect(path).toBe('/api/v0/block/get');
    expect(cid).toBe('bafyBlock');
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(offline).toBe('true');
  });

  // 少了離線旗標時 kubo 會先送出 200、只在 trailer 報缺塊，`res.ok` 因而看不出失敗，呼叫端會
  // 把串流到的空 bytes 當成有效內容；帶旗標才是本檔既有錯誤處理所預期的非 2xx。
  it('本地缺塊時以非 2xx 失敗，而不是回空 bytes', async () => {
    const client = createKuboClient('http://kubo.test', async () =>
      Promise.resolve(
        new Response(JSON.stringify({ Message: 'block was not found locally (offline)' }), {
          status: 500,
        }),
      ),
    );

    await expect(client.blockGet('bafyMissing')).rejects.toThrow('/api/v0/block/get');
  });
});

describe('createKuboClient hasBlock', () => {
  // 這個查詢只問「本地有沒有」。不帶離線旗標時，kubo 會為本地沒有的 block 轉向網路抓取；公版
  // 預設關閉 public routing 且沒有 peer，該請求不會結束，DAG 搬遷會停在第一個缺塊。
  it('以離線語意查詢本地是否已有該 block', async () => {
    let path = '';
    let cid = '';
    let offline = '';
    const client = createKuboClient('http://kubo.test', async (input) => {
      const url = new URL(String(input));
      path = url.pathname;
      cid = url.searchParams.get('arg') ?? '';
      offline = url.searchParams.get('offline') ?? '';
      return new Response(JSON.stringify({ Size: 3 }), { status: 200 });
    });

    await expect(client.hasBlock('bafyBlock')).resolves.toBe(true);
    expect(path).toBe('/api/v0/block/stat');
    expect(cid).toBe('bafyBlock');
    expect(offline).toBe('true');
  });

  it('本地沒有該 block 時回 false（非 2xx 一律視為缺塊）', async () => {
    const client = createKuboClient('http://kubo.test', async () =>
      Promise.resolve(new Response('not found', { status: 500 })),
    );

    await expect(client.hasBlock('bafyMissing')).resolves.toBe(false);
  });
});

describe('createKuboClient blockPut', () => {
  it('把呼叫端選定的 raw codec 原樣送進 Kubo query', async () => {
    let codec = '';
    const client = createKuboClient('http://kubo.test', async (input) => {
      const url = new URL(String(input));
      codec = url.searchParams.get('cid-codec') ?? '';
      return new Response(JSON.stringify({ Key: 'bafkRaw' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(client.blockPut(new Uint8Array([1, 2, 3]), 'raw')).resolves.toBe('bafkRaw');
    expect(codec).toBe('raw');
  });
});

describe('createKuboClient stats', () => {
  it('保留真實 StorageMax，即使 RepoSize 已超過上限也不以 repo+clamped available 冒充', async () => {
    const client = createKuboClient('http://kubo.test', async () =>
      Promise.resolve(
        new Response(JSON.stringify({ RepoSize: 120, StorageMax: 100 }), { status: 200 }),
      ),
    );

    await expect(client.stats()).resolves.toEqual({
      repoSizeBytes: 120,
      availableBytes: 0,
      storageMaxBytes: 100,
    });
  });
});
