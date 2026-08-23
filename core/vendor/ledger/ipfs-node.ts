/**
 * helia 節點工廠 — libp2p 實例由 peer-discovery createNode 供給（單節點單
 * libp2p、ledger 疊在其上）；blockstore/datastore 預設 IndexedDB（origin storage）。
 * 組合＝createHeliaLight＋withLibp2p(自有節點)＋withBitswap——bitswap 供塊級網路
 * 補抓（LRU miss 從已 pin peer／pinning service 抓、新玩家同步 derived state 塊）。
 * ⭐helia 與 @helia/libp2p 皆**靜態**拉 @libp2p/webrtc→Node 端載入即 require
 * node-datachannel（已拒建）——兩者一律動態載入（同 webrtc 前例）；本工廠僅供
 * 瀏覽器 runtime、測試以 LedgerIpfs stub 注入。
 * 生命週期：helia.start() 前 libp2p getter 會 throw（mixin 設計）；注意 helia.stop()
 * 會**連帶 stop 傳入的 libp2p**（mixin 行為）——關閉順序由 app 層統一（ledger 先、
 * helia 殿後）。
 */
import { IDBBlockstore } from 'blockstore-idb';
import { IDBDatastore } from 'datastore-idb';
import * as dagCbor from '@ipld/dag-cbor';
import type { LedgerIpfs } from './orbit-log';
import type { BorrowedLedgerContentStorage } from './borrowed-content-storage';

/** Ledger content blocks 在 browser authority 中的 namespace。 */
export const LEDGER_BLOCKSTORE_NAME = 'open4wd/ledger/blocks';
/** 只保存 bounded Orbit entries 的獨立 blockstore namespace。 */
export const LEDGER_ENTRY_BLOCKSTORE_NAME = 'open4wd/ledger/entries';
/** 與瀏覽器 UGC 快取權威共用的持久 Helia pin／keychain datastore。 */
export const LEDGER_DATASTORE_NAME = 'open4wd/ledger/data';

/**
 * 單一可替換 Ledger 網路 generation 的建構輸入。瀏覽器 production 提供借用的權威儲存；
 * 選用 raw-store override 為隔離 host 與測試保留舊版自有路徑。
 */
export interface CreateLedgerIpfsOptions {
  /** 附加至網路 Helia instance 的既有 generation 自有 libp2p 節點。 */
  libp2p: unknown;
  /**
   * 借用權威自有內容 store，但不取得 open／close 所有權。存在時，這些精確 adapter
   * 優先於舊版隔離 host store override。
   */
  contentStorage?: BorrowedLedgerContentStorage;
  /** 隔離 host 與測試使用的舊版 generation 自有內容 blockstore override。 */
  blockstore?: unknown;
  /** generation 自有的本機 Orbit entry blockstore override。 */
  entryBlockstore?: unknown;
  /** 隔離 host 與測試使用的舊版 generation 自有 Helia datastore override。 */
  datastore?: unknown;
  /** 回傳前是否啟動 Helia；預設為 true。 */
  start?: boolean;
}

/** 由單一 Ledger 網路 generation 追蹤的 generation 自有 store 生命週期。 */
interface OwnedLedgerStore {
  /**
   * 在 Helia 啟動前開啟 store；只有 fulfilled open 會記錄供反向清理。
   *
   * @returns store 準備供 generation 使用後 settled 的 promise。
   * @throws 原始 store open 失敗，並觸發先前自有資源清理。
   */
  open?(): Promise<void>;
  /**
   * 依 open 反向順序只關閉成功開啟的 store 一次：一般或嘗試啟動清理期間於 Helia 停止後，
   * 或後續自有 store 在嘗試啟動 Helia 前開啟失敗時直接關閉。
   *
   * @returns 此自有 store 釋放資源後 settled 的 promise。
   * @throws close 失敗；仍會嘗試後續自有 store，並以第一個失敗為準。
   */
  close?(): Promise<void>;
}

/**
 * 建立單一可替換網路 Ledger generation。
 *
 * @param options 網路、內容儲存、entry 儲存與啟動政策相依項目。
 * @returns 已啟動的 Ledger Helia surface，其 entry store 仍由 generation 擁有。
 * @throws 反向清理後保留第一個 store open 或 Helia start 失敗。初始化、清理或後續停止期間，
 * 絕不開啟或關閉借用的內容儲存。
 */
export async function createLedgerIpfs(options: CreateLedgerIpfsOptions): Promise<LedgerIpfs> {
  const { createHeliaLight } = await import('helia');
  const { withLibp2p } = await import('@helia/libp2p');
  const { withBitswap } = await import('@helia/bitswap');
  const blockstore =
    options.contentStorage?.blockstore ??
    options.blockstore ??
    new IDBBlockstore(LEDGER_BLOCKSTORE_NAME);
  const entryBlockstore =
    options.entryBlockstore ?? new IDBBlockstore(LEDGER_ENTRY_BLOCKSTORE_NAME);
  const datastore =
    options.contentStorage?.datastore ??
    options.datastore ??
    new IDBDatastore(LEDGER_DATASTORE_NAME);
  const helia = withBitswap(
    withLibp2p(
      createHeliaLight({
        blockstore: blockstore as never,
        datastore: datastore as never,
        codecs: [dagCbor],
      }),
      options.libp2p as never,
    ),
  );
  const ownedStores = (
    options.contentStorage === undefined
      ? [blockstore, datastore, entryBlockstore]
      : [entryBlockstore]
  ) as OwnedLedgerStore[];
  const openedStores: typeof ownedStores = [];
  /**
   * 依 open 反向順序只關閉成功開啟的 generation 自有 store 一次。
   *
   * @returns 嘗試所有已開啟自有 store 後 settled 的 promise。
   * @throws 後續清理嘗試完成後的第一個自有 store close 失敗。
   */
  const closeOpenedStores = async (): Promise<void> => {
    let firstError: unknown;
    const closingStores = openedStores.splice(0).reverse();
    for (const store of closingStores) {
      try {
        await store.close?.();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  };
  let startAttempted = false;
  try {
    for (const store of ownedStores) {
      if (store.open === undefined) continue;
      await store.open();
      openedStores.push(store);
    }
    if (options.start ?? true) {
      startAttempted = true;
      await helia.start();
    }
  } catch (error) {
    if (startAttempted) {
      try {
        await helia.stop();
      } catch {
        // 啟動的原始錯誤比部分啟動 Helia 的清理錯誤更具權威。
      }
    }
    try {
      await closeOpenedStores();
    } catch {
      // 啟動／open 的原始錯誤比清理錯誤更能指出失敗邊界。
    }
    throw error;
  }
  const originalStop = helia.stop.bind(helia);
  Object.defineProperties(helia, {
    entryBlockstore: { value: entryBlockstore, enumerable: true },
    stop: {
      value: async () => {
        let stopFailed = false;
        let stopError: unknown;
        try {
          await originalStop();
        } catch (error) {
          stopFailed = true;
          stopError = error;
        }
        try {
          await closeOpenedStores();
        } catch (error) {
          if (!stopFailed) throw error;
        }
        if (stopFailed) throw stopError;
      },
    },
  });
  return helia as unknown as LedgerIpfs;
}
