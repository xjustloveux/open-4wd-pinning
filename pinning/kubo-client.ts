/**
 * kubo（go-ipfs）RPC API 的最小客戶端——只覆蓋 pinning 服務需要的三個操作
 * （放 block／查 block 是否存在／查倉庫用量）。與 cluster-client 同一套風格：
 * 純 `fetch`（注入 `fetchFn`，預設 `globalThis.fetch`），零第三方依賴。
 *
 * 官方 API 參考（docs.ipfs.tech/reference/kubo/rpc）：kubo 的 RPC 端點一律是 POST，
 * 即使語意是讀取查詢也一樣。
 * - `POST /api/v0/block/put?cid-codec=<codec>`  放入一個 block（multipart 檔案上傳），
 *   回 `{ Key, Size }`；`Key` 即產出的 CID。
 * - `POST /api/v0/block/stat?arg=<cid>&offline=true` 查詢本地是否存在該 block；不存在時回非 2xx。
 * - `POST /api/v0/repo/stat`                    倉庫用量：`{ RepoSize, StorageMax, ... }`。
 *
 * 本檔 wire 正確性由後續對真 kubo 的整合測試驗證——此處先照官方 API 文件老實實作。
 */

export interface KuboClient {
  blockPut(bytes: Uint8Array, cidCodec: string): Promise<string>;
  hasBlock(cid: string): Promise<boolean>;
  blockGet?(cid: string): Promise<Uint8Array>;
  stats(): Promise<{
    repoSizeBytes: number;
    availableBytes: number;
    /** 真實 Kubo StorageMax；舊測試替身可省略，production client 一定提供。 */
    storageMaxBytes?: number;
  }>;
}

type FetchFn = typeof globalThis.fetch;

/** 非 2xx 回應統一包成這個錯誤，訊息＋`status` 欄位都帶狀態碼，方便呼叫端判斷或記 log。 */
export class KuboClientError extends Error {
  constructor(
    path: string,
    readonly status: number,
    body: string,
  ) {
    super(`kubo ${path} 回應非 2xx：HTTP ${status}${body ? ` — ${body}` : ''}`);
    this.name = 'KuboClientError';
  }
}

interface BlockPutResponse {
  Key: string;
}

interface RepoStatResponse {
  RepoSize: number;
  StorageMax: number;
}

/**
 * 區塊查詢與讀取一律要求離線語意：kubo 預設在本地沒有該 block 時改向網路抓取，而本服務這
 * 兩個呼叫的語意都只問「本地有沒有」——`hasBlock` 決定要不要重灌，`blockGet` 供既有 DAG 的
 * 量測與 root-scoped 讀取。少了這個旗標會有三個後果：Routing.Type=none 的公版預設沒有 peer
 * 可問，`block/stat` 會無限等待而讓 pin 流程停住；`block/get` 會先送出 200、只在 trailer 報錯，
 * 使呼叫端的非 2xx 判斷失效；而在營運者改開 public routing 時，節點會替請求方向公共網路抓取
 * 未持有的內容，等於在 RPC 路徑重現 Gateway.NoFetch 想擋掉的 generic block 供應。
 */
const OFFLINE_QUERY = (cid: string): string => `arg=${encodeURIComponent(cid)}&offline=true`;

/** 建立服務使用的最小 Kubo HTTP API 客戶端。 */
export function createKuboClient(
  baseUrl: string,
  fetchFn: FetchFn = globalThis.fetch,
): KuboClient & { blockGet(cid: string): Promise<Uint8Array> } {
  const root = baseUrl.replace(/\/$/, '');
  const url = (path: string, query?: string): string => `${root}${path}${query ? `?${query}` : ''}`;

  return {
    async blockPut(bytes, cidCodec) {
      const form = new FormData();
      // `new Uint8Array(bytes)` 一律配出全新、純 ArrayBuffer 背書的視圖（規格保證，不會沿用
      // 呼叫端可能傳進來、以 SharedArrayBuffer 背書的緩衝區）——`Blob`/`BlobPart` 的型別只接受
      // ArrayBuffer 背書的 view，這裡做一次防禦性複製把 `Uint8Array<ArrayBufferLike>` 收斂成
      // `Uint8Array<ArrayBuffer>`，讓公開介面能維持原本寬鬆的 `Uint8Array` 參數型別。
      form.append('file', new Blob([new Uint8Array(bytes)]));
      const res = await fetchFn(
        url('/api/v0/block/put', `cid-codec=${encodeURIComponent(cidCodec)}`),
        {
          method: 'POST',
          body: form,
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new KuboClientError('/api/v0/block/put', res.status, body);
      }
      const json = (await res.json()) as BlockPutResponse;
      return json.Key;
    },

    async hasBlock(cid) {
      // kubo 對「block 不存在」與其他錯誤同樣回非 2xx（通常 500），RPC 層沒有更細的狀態碼
      // 可辨。呼叫端（reconcile 的 transferDag）只需要「要不要重灌這個 block」的粗粒度答案，
      // 這裡採保守解讀：任何非 2xx 一律視為「沒有這個 block」，讓上層安全地重灌一次
      // （block/put 以內容定址、冪等，重灌不會造成資料錯誤，只有可忽略的多餘成本）。
      const res = await fetchFn(url('/api/v0/block/stat', OFFLINE_QUERY(cid)), {
        method: 'POST',
      });
      return res.ok;
    },

    async blockGet(cid) {
      const path = '/api/v0/block/get';
      const res = await fetchFn(url(path, OFFLINE_QUERY(cid)), { method: 'POST' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new KuboClientError(path, res.status, body);
      }
      return new Uint8Array(await res.arrayBuffer());
    },

    async stats() {
      const res = await fetchFn(url('/api/v0/repo/stat'), { method: 'POST' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new KuboClientError('/api/v0/repo/stat', res.status, body);
      }
      const json = (await res.json()) as RepoStatResponse;
      return {
        repoSizeBytes: json.RepoSize,
        availableBytes: Math.max(json.StorageMax - json.RepoSize, 0),
        storageMaxBytes: json.StorageMax,
      };
    },
  };
}
