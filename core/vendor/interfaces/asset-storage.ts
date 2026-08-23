/**
 * AssetStorage — 內容尋址資產存取的可替換抽象（IPFS／本機 IndexedDB 皆實作此契約）
 */
import type { CID, Result, Unsubscribe } from './shared';

/** 內容尋址資產的讀寫、取消與下載進度契約。 */
export interface AssetStorage {
  readonly storageName: string;
  get(cid: CID): Promise<Result<Uint8Array>>;
  put(bytes: Uint8Array): Promise<Result<CID>>;
  has(cid: CID): Promise<boolean>;
  /** 不下載內容、僅取 metadata 大小 */
  getSize(cid: CID): Promise<Result<number>>;
  abort(cid: CID): Promise<void>;
  onProgress(cid: CID, handler: (loaded: number, total: number) => void): Unsubscribe;
}
