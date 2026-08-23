import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { ClusterClientError, createClusterClient } from './cluster-client';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server | undefined;

/** 起一顆最小假 cluster（port 0＝隨機可用埠），回傳它的 baseUrl。 */
const startFakeCluster = async (handler: Handler): Promise<string> => {
  server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake cluster：無法取得監聽位址');
  }
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  if (server === undefined) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

describe('createClusterClient', () => {
  it('pin 發出 POST /pins/<cid> 且 query 帶 meta-signer／meta-source', async () => {
    let seenMethod = '';
    let seenPath = '';
    let seenQuery: URLSearchParams | undefined;
    const baseUrl = await startFakeCluster((req, res) => {
      seenMethod = req.method ?? '';
      const parsed = new URL(req.url ?? '', 'http://localhost');
      seenPath = parsed.pathname;
      seenQuery = parsed.searchParams;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cid: 'bafyCID' }));
    });

    const client = createClusterClient(baseUrl);
    await client.pin('bafyCID', {
      category: 'part',
      signer: 'peerA',
      logicalSizeBytes: 42,
      physicalSizeBytes: 24,
      source: 'api',
    });

    expect(seenMethod).toBe('POST');
    expect(seenPath).toBe('/pins/bafyCID');
    expect(seenQuery?.get('meta-signer')).toBe('peerA');
    expect(seenQuery?.get('meta-source')).toBe('api');
    expect(seenQuery?.get('meta-category')).toBe('part');
    expect(seenQuery?.get('meta-logicalSizeBytes')).toBe('42');
    expect(seenQuery?.get('meta-physicalSizeBytes')).toBe('24');
  });

  it('list 解析回應為 PinRecord 串流', async () => {
    const baseUrl = await startFakeCluster((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({
          cid: 'cidA',
          metadata: {
            category: 'part',
            signer: 's1',
            logicalSizeBytes: '10',
            physicalSizeBytes: '7',
            source: 'api',
          },
        })}\n`,
      );
      res.write(
        `${JSON.stringify({ cid: 'cidB', metadata: { category: 'checkpoint', source: 'auto' } })}\n`,
      );
      res.end();
    });

    const client = createClusterClient(baseUrl);
    const records = [];
    for await (const rec of client.list()) records.push(rec);

    expect(records).toEqual([
      {
        cid: 'cidA',
        meta: {
          category: 'part',
          signer: 's1',
          logicalSizeBytes: 10,
          physicalSizeBytes: 7,
          source: 'api',
        },
      },
      { cid: 'cidB', meta: { category: 'checkpoint', source: 'auto' } },
    ]);
  });

  it('list 忽略非數字 logical/physical size——parsePinRecord 防線', async () => {
    const baseUrl = await startFakeCluster((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        `${JSON.stringify({
          cid: 'cidDirty',
          metadata: {
            category: 'part',
            source: 'api',
            logicalSizeBytes: 'not-a-number',
            physicalSizeBytes: 'not-a-number',
          },
        })}\n`,
      );
      res.end();
    });

    const client = createClusterClient(baseUrl);
    const records = [];
    for await (const rec of client.list()) records.push(rec);

    expect(records).toEqual([{ cid: 'cidDirty', meta: { category: 'part', source: 'api' } }]);
    expect(records[0]?.meta.logicalSizeBytes).toBeUndefined();
    expect(records[0]?.meta.physicalSizeBytes).toBeUndefined();
  });

  it('非 2xx 拋錯含狀態碼', async () => {
    const baseUrl = await startFakeCluster((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    });

    const client = createClusterClient(baseUrl);
    await expect(client.pin('cidX', { category: 'part', source: 'api' })).rejects.toThrow(/500/);
    await expect(client.pin('cidX', { category: 'part', source: 'api' })).rejects.toBeInstanceOf(
      ClusterClientError,
    );
  });

  it('get 查詢單一 CID：200 回應解析成 PinRecord（GET /pins/<cid>）', async () => {
    let seenMethod = '';
    let seenPath = '';
    const baseUrl = await startFakeCluster((req, res) => {
      seenMethod = req.method ?? '';
      seenPath = new URL(req.url ?? '', 'http://localhost').pathname;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          cid: 'cidSingle',
          metadata: {
            category: 'part',
            signer: 's1',
            logicalSizeBytes: '99',
            physicalSizeBytes: '55',
            source: 'api',
          },
        }),
      );
    });

    const client = createClusterClient(baseUrl);
    const record = await client.get('cidSingle');

    expect(seenMethod).toBe('GET');
    expect(seenPath).toBe('/pins/cidSingle');
    expect(record).toEqual({
      cid: 'cidSingle',
      meta: {
        category: 'part',
        signer: 's1',
        logicalSizeBytes: 99,
        physicalSizeBytes: 55,
        source: 'api',
      },
    });
  });

  it('get 對從未 pin 過的 CID：狀態全為 unpinned 的 200 回應視為沒有記錄', async () => {
    // 真 cluster 對未 pin 與已 unpin 的 CID 都回 200 與一份狀態物件。把它當成既有記錄，
    // 會讓 pin 流程誤判「別人已經 pin 過」而對每一筆首次 pin 冪等短路，回成功卻什麼都沒做。
    const baseUrl = await startFakeCluster((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          cid: 'cidNeverPinned',
          metadata: null,
          peer_map: { peerA: { status: 'unpinned' } },
        }),
      );
    });

    const client = createClusterClient(baseUrl);
    await expect(client.get('cidNeverPinned')).resolves.toBeUndefined();
  });

  it('get 對進行中的 pin（pin_queued／pinning）：仍視為既有記錄，所有權保護不被繞過', async () => {
    const baseUrl = await startFakeCluster((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          cid: 'cidPinning',
          metadata: { category: 'part', signer: 's1', source: 'api' },
          peer_map: { peerA: { status: 'unpinned' }, peerB: { status: 'pin_queued' } },
        }),
      );
    });

    const client = createClusterClient(baseUrl);
    await expect(client.get('cidPinning')).resolves.toEqual({
      cid: 'cidPinning',
      meta: { category: 'part', signer: 's1', source: 'api' },
    });
  });

  it('get 對沒有 peer_map 的回應：保守視為既有記錄，不放行覆寫', async () => {
    const baseUrl = await startFakeCluster((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cid: 'cidLegacyShape', metadata: { signer: 's2' } }));
    });

    const client = createClusterClient(baseUrl);
    await expect(client.get('cidLegacyShape')).resolves.toEqual({
      cid: 'cidLegacyShape',
      meta: { signer: 's2' },
    });
  });

  it('get 對未被 pin 過的 CID：404 轉譯成 undefined，不拋錯', async () => {
    const baseUrl = await startFakeCluster((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });

    const client = createClusterClient(baseUrl);
    await expect(client.get('cidMissing')).resolves.toBeUndefined();
  });

  it('get 對非 404 的非 2xx（例如 500）：拋 ClusterClientError，與其餘操作一致', async () => {
    const baseUrl = await startFakeCluster((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    });

    const client = createClusterClient(baseUrl);
    await expect(client.get('cidX')).rejects.toBeInstanceOf(ClusterClientError);
  });

  it('unpin 發出 DELETE／peers 數出 NDJSON 行數', async () => {
    let seenMethod = '';
    let seenPath = '';
    const baseUrl = await startFakeCluster((req, res) => {
      const parsed = new URL(req.url ?? '', 'http://localhost');
      if (parsed.pathname === '/peers') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.end(`${JSON.stringify({ id: 'peerA' })}\n${JSON.stringify({ id: 'peerB' })}\n`);
        return;
      }
      seenMethod = req.method ?? '';
      seenPath = parsed.pathname;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cid: 'cidX' }));
    });

    const client = createClusterClient(baseUrl);
    await client.unpin('cidX');
    expect(seenMethod).toBe('DELETE');
    expect(seenPath).toBe('/pins/cidX');
    expect(await client.peers()).toBe(2);
  });
});
