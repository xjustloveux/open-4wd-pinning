/**
 * Node 端內容儲存三件套——區塊（帳本 log 內容）／entry 區塊（OrbitDB oplog 條目）
 * ／datastore（OrbitDB 中繼資料）各自獨立目錄，供上層節點組裝時注入。建構時不
 * 開啟（open 生命週期交由使用端管理）。
 */
import { FsBlockstore } from 'blockstore-fs';
import { LevelDatastore } from 'datastore-level';
import { join } from 'node:path';

/** 集中帳本節點擁有的獨立區塊、條目與中繼資料儲存。 */
export interface NodeStores {
  readonly blockstore: FsBlockstore;
  readonly entryBlockstore: FsBlockstore;
  readonly datastore: LevelDatastore;
}

/** 在設定的資料目錄下建立尚未開啟的檔案系統儲存。 */
export function createNodeStores(dataDir: string): NodeStores {
  return {
    // 開發期 baseline 直接換成 ledger-only 目錄；不重開早期曾混入 UGC cache 的 blocks/。
    blockstore: new FsBlockstore(join(dataDir, 'ledger-blocks')),
    entryBlockstore: new FsBlockstore(join(dataDir, 'entry-blocks')),
    datastore: new LevelDatastore(join(dataDir, 'datastore')),
  };
}
