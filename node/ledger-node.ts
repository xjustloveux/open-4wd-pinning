/**
 * headless ledger replica 節點組裝——本機 storage 三件套 → libp2p → Node 端 LedgerIpfs
 * → OrbitDB 事件鏈／檢查點永留庫／內容定址塊 → Open4wdLedger。
 *
 * ⭐ 未採 vendored `createLedgerIpfs`：該工廠內部動態 import `helia`／`@helia/libp2p`，但
 * 這兩個套件的進入點都靜態轉出 `@libp2p/webrtc`——Node 端載入 `@libp2p/webrtc` 即 require
 * 原生模組 `node-datachannel`（本專案政策性拒建）。動態 import 只延後觸發時機、無法迴避
 * 這條靜態轉出鏈：一旦真的呼叫 `createLedgerIpfs` 必定崩潰。`ipfs-node.ts` 檔頭亦明言該
 * 工廠僅供瀏覽器 runtime。`orbit-log.ts` 對 `LedgerIpfs` 的依賴本就是結構型別，故此處在
 * Node 端手建結構相容實作（`createNodeLedgerIpfs()`）：
 * - `blockstore`／`entryBlockstore` 用本機 `FsBlockstore`（真實落磁碟）。
 * - 跨節點取塊改走標準 bitswap（`@helia/bitswap` 的 `withBitswap`）：把它施加在手建的
 *   helia 形宿主物件上（宿主僅提供 bitswap 建構所需欄位），取得 block broker。生產取塊面
 *   要向瀏覽器玩家節點抓 identity 塊／checkpoint DAG／UGC 塊，對面只講 bitswap，故此處也
 *   必須是標準 bitswap 而非私有協定。
 * - `blockstore.get` 必須回傳 `AsyncIterable<Uint8Array>`（逐塊）：`@orbitdb/core` 的
 *   IPFSBlockStorage 以 `for await (chunk of ipfs.blockstore.get(cid))` 消費，回傳
 *   `Promise<Uint8Array>` 會令其 `for await` 直接拋 TypeError。access-controller 於
 *   persistence 前解 remote peer 的 Orbit identity（`canAppend` 內 `getIdentity`）即靠這
 *   條路——本機命中直接轉遞 `FsBlockstore` 的逐塊序列，未命中則經 bitswap 向已連線／可
 *   探索到的 peer 取回單塊、回填本地快取後吐出。
 *
 * 組裝順序與收攤順序（ledger 先、ipfs 殿後）對齊瀏覽器端 bootstrap 的 connect/shutdown
 * 拆分：`connect` 回呼交給 Open4wdLedger 建構子，讓 log/checkpoints 兩埠的失敗清理統一由
 * ledger.open() 自身既有的 catch 路徑負責；本檔只需在 connect() 內部處理「回傳 LedgerPorts
 * 之前」的失敗清理，並在 open() 之後另外收攤 ipfs（含 bitswap／libp2p／stores）。
 */
import { join } from 'node:path';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { withBitswap } from '@helia/bitswap';
import { Protocol } from '../core';
import {
  cidMatchesBytes,
  createBlockAccess,
  createCheckpointStore,
  emptyDerivedState,
  genesisEconomyConfigWithGovernance,
  LEDGER_CONTENT_BLOCK_MAX_BYTES,
  openOrbitEventLog,
  Open4wdLedger,
  publicKeyToPeerId,
  type CheckpointStore,
  type CID as ContentCid,
  type ApplierRegistry,
  type BlockAccess,
  type LedgerCheckpoint,
  type LedgerIpfs,
  type InitialCheckpointProof,
  type Open4wdLedgerOptions,
  type PeerId,
  type Signature,
} from '../core';
import { createAppLibp2p, type AppPrivateKey } from './libp2p-node';
import { createNodeStores, type NodeStores } from './stores';
import { createLevelCheckpointStorage } from './checkpoint-storage';
import { InlineAdmissionMiner } from './admission-miner';

type Libp2pInstance = Awaited<ReturnType<typeof createAppLibp2p>>;
type LedgerSigner = Open4wdLedgerOptions['signer'];
type CheckpointCid = Parameters<CheckpointStore['setLatest']>[0];
type LedgerIpfsPins = LedgerIpfs['pins'];

/** Admission outbox 與 scheme 型別借道 openOrbitEventLog 參數萃取——vendor 未經 barrel 匯出。 */
type AdmissionOutbox = Parameters<typeof openOrbitEventLog>[0]['admission']['outbox'];
type AdmissionOutboxRecord = Parameters<AdmissionOutbox['put']>[0];
type AdmissionScheme = NonNullable<Parameters<typeof openOrbitEventLog>[0]['admission']['scheme']>;

type AppLibp2pExtraTransports = NonNullable<
  Parameters<typeof createAppLibp2p>[0]['extraTransports']
>;

/** 設定帳本 replica 的持久儲存、網路、准入與檢查點信任。 */
export interface LedgerNodeConfig {
  /** blockstore／entry-blockstore／datastore／checkpoint 庫的根目錄；各自落地獨立子目錄。 */
  readonly dataDir: string;
  readonly privateKey: AppPrivateKey;
  readonly listen: readonly string[];
  readonly bootstrap: readonly string[];
  readonly relayEnabled: boolean;
  /** 既有 `/orbitdb/<CIDv1-base58btc>` 位址；省略＝以固定 db 名＋固定 access-controller
   *  contract 衍生（跨節點必然相同，genesis 部署前預設路徑）。 */
  readonly ledgerDbAddress?: string;
  /** 測試注入 @libp2p/memory 等額外傳輸。 */
  readonly extraTransports?: AppLibp2pExtraTransports;
  /** 測試／受控 bring-up seam：IPFS/bitswap 已就緒、OrbitDB 尚未 open 時建立必要連線。 */
  readonly beforeLedgerOpen?: (libp2p: Libp2pInstance) => Promise<void>;
  /** 測試專用低難度 admission scheme seam；production 省略＝固定 Admission v1。同一帳本的
   *  節點須傳入同值，否則收件端 fallback 到 v1 會拒收對方以低難度 scheme 挖出的條目。 */
  readonly admissionScheme?: AdmissionScheme;
  readonly now?: () => number;
  readonly deferRetryDelaysMs?: readonly number[];
  readonly checkpointStartupScanTimeoutMs?: number;
  /** 測試 seam：模擬 checkpoint 產生端具備 replica 未載入的業務域 reducer。production 省略。 */
  readonly registry?: ApplierRegistry;
  /**
   * 治理 trust root——寫入 ledger genesis EconomyConfig，供 checkpoint 三法與遠端 announcement
   * 採納共用；省略＝空 signer set，本地提案與遠端採納皆 fail closed。
   */
  readonly genesisGovernanceSigners?: ReadonlySet<PeerId>;
  /** ordinary genesis receipt 的全網一致毫秒值。 */
  readonly genesisTimestamp?: number;
  /** Rebirth descriptor；與 ordinary genesisGovernanceSigners 互斥。 */
  readonly initialCheckpointProof?: InitialCheckpointProof;
  /** 已由 pinning bundle 完整離線驗證的 proof blocks，開 ledger 前預載至本機 blockstore。 */
  readonly initialCheckpointProofBlocks?: ReadonlyMap<ContentCid, Uint8Array>;
}

/** 回報節點採納的持久檢查點指標與已解碼檢查點。 */
export interface CheckpointAdoption {
  readonly cid: CheckpointCid;
  readonly checkpoint: LedgerCheckpoint;
}

/** 移除先前註冊的檢查點採納監聽器。 */
export type Unsub = () => void;

/** 提供執行中帳本、網路、傳輸與檢查點觀測邊界。 */
export interface LedgerNode {
  readonly ledger: Open4wdLedger;
  readonly libp2p: Libp2pInstance;
  readonly ipfs: LedgerIpfs;
  /** Pin ingestion 專用：可走 Bitswap 取塊，但不把 UGC 回填到對外供應的 ledger blockstore。 */
  readonly transferBlocks: Pick<BlockAccess, 'get'>;
  /** 橋接本節點檢查點採納（本地 finalize 或遠端 announcement 皆算）；cid 去重後才通知。 */
  onCheckpointAdopted(cb: (adoption: CheckpointAdoption) => void): Unsub;
  close(): Promise<void>;
}

function derivePeerIdentity(privateKey: AppPrivateKey): { peerId: PeerId; signer: LedgerSigner } {
  const peerId = publicKeyToPeerId(privateKey.publicKey.raw);
  return {
    peerId,
    signer: {
      getPeerId: () => peerId,
      sign: async (message) => (await privateKey.sign(message)) as Signature,
    },
  };
}

/** 純記憶體 pin 記帳——本地 blockstore 沒有真 Helia 的 GC 行程，pin/isPinned 只需忠實記帳。 */
function createLocalPinTracker(): LedgerIpfsPins {
  const pinned = new Set<string>();
  return {
    // 介面要求 AsyncIterable（真 Helia 逐塊回報 pin 進度）；本地記帳一次到位、無漸進
    // 進度可報，刻意回空序列（同主 repo 測試替身對 pins.add 的既有寫法）。
    // eslint-disable-next-line require-yield
    add: async function* (cid) {
      pinned.add(String(cid));
    },
    isPinned: async (cid) => pinned.has(String(cid)),
  };
}

type LedgerIpfsBlockstore = LedgerIpfs['blockstore'];
type NodeBlockstore = NodeStores['blockstore'];
type FindProvidersOptions = Parameters<Libp2pInstance['contentRouting']['findProviders']>[1];

/**
 * `@helia/bitswap` 的 `withBitswap` 期望一個 helia 形宿主（正常由 `createHeliaLight` 供給，
 * 但那條路 Node 端會靜態拉入 webrtc）。本介面只宣告 bitswap 建構＋mixin 生命週期實際會讀
 * ／呼叫的最小面：block broker 的登錄由宿主收集，塊面（`retrieve`／`announce`）由本檔另
 * 建的 networked blockstore 直接驅動。
 */
interface LedgerBitswapBroker {
  readonly name: string;
  retrieve(cid: CID, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  announce(cid: CID, options?: { signal?: AbortSignal }): Promise<void>;
  stop?(): Promise<void>;
}
interface LedgerBitswapMixin {
  readonly name: string;
  start(host: unknown): Promise<void>;
}

/**
 * 把本機 blockstore＋本節點 libp2p 包成 `withBitswap` 能施作的宿主，驅動其 mixin 起 bitswap
 * broker 並擷取之。bitswap 服務塊給 peer 時直接讀 `blockstore`；抓塊時對已連線 peer 廣播
 * wantlist（`routing.findProviders` 僅供額外探索，故轉遞 libp2p content routing 即可）；
 * sha256 塊 bitswap 內建 hasher，`getHasher` 只是非 sha256 code 的保險。
 */
async function startLedgerBitswap(
  libp2p: Libp2pInstance,
  blockstore: NodeBlockstore,
): Promise<{ broker: LedgerBitswapBroker; stop: () => Promise<void> }> {
  let captured: LedgerBitswapBroker | undefined;
  const host = {
    blockstore,
    libp2p,
    peerId: libp2p.peerId,
    logger: libp2p.logger,
    metrics: libp2p.metrics,
    routing: {
      findProviders: (cid: CID, options?: FindProvidersOptions) =>
        libp2p.contentRouting.findProviders(cid, options),
    },
    getHasher: async (code: number) => {
      if (code === sha256.code) return sha256;
      throw new Error(`unsupported multihash code for ledger bitswap: ${code}`);
    },
    status: 'stopped' as string,
    mixins: [] as LedgerBitswapMixin[],
    blockBrokers: [] as LedgerBitswapBroker[],
    addMixin(mixin: LedgerBitswapMixin): void {
      this.mixins.push(mixin);
    },
    hasBlockBroker(name: string): boolean {
      return this.blockBrokers.some((broker) => broker.name === name);
    },
    addBlockBroker(broker: LedgerBitswapBroker): void {
      this.blockBrokers.push(broker);
      captured = broker;
    },
  };
  const stopBrokers = async (): Promise<void> => {
    host.status = 'stopping';
    let failure: unknown;
    for (const registered of host.blockBrokers) {
      try {
        await registered.stop?.();
      } catch (error) {
        failure ??= error;
      }
    }
    host.status = 'stopped';
    if (failure !== undefined) throw failure;
  };
  withBitswap(host as unknown as Parameters<typeof withBitswap>[0]);
  // withBitswap 只掛一個 mixin；其 start 會於 status==='starting' 時建構＋啟動 broker 並登錄。
  host.status = 'starting';
  try {
    for (const mixin of host.mixins) await mixin.start(host);
  } catch (error) {
    try {
      await stopBrokers();
    } catch {
      // 保留起動失敗本身的原因，清理錯誤不覆蓋。
    }
    throw error;
  }
  host.status = 'started';
  if (captured === undefined) {
    await stopBrokers();
    throw new Error('ledger bitswap broker was not registered');
  }
  return { broker: captured, stop: stopBrokers };
}

/**
 * OrbitDB IPFSBlockStorage 以 `for await (chunk of ipfs.blockstore.get(cid))` 消費，故 get
 * 必須回 AsyncIterable：本機命中直接轉遞 `FsBlockstore` 的逐塊序列；未命中則經 bitswap 取
 * 回單塊、回填本地快取後吐出；取不到即空序列（呼叫端據以 defer／視為缺塊，不拋錯）。put
 * 落地後對 bitswap 宣告新塊，讓有待決 wantlist 的 peer 得到服務。
 */
function createBitswapLedgerBlockstore(
  blockstore: NodeBlockstore,
  broker: LedgerBitswapBroker,
): LedgerIpfsBlockstore {
  const requireCid = (cid: unknown): CID => {
    const parsed = CID.asCID(cid);
    if (parsed === null) throw new TypeError('ledger blockstore requires a CID key');
    return parsed;
  };
  async function* streamBlock(
    cid: unknown,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<Uint8Array> {
    const parsed = requireCid(cid);
    if (await blockstore.has(parsed, options)) {
      yield* blockstore.get(parsed, options);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await broker.retrieve(parsed, options);
    } catch {
      return; // 缺塊或取用失敗＝空序列（呼叫端 defer／視為缺塊）。
    }
    try {
      await blockstore.put(parsed, bytes);
    } catch {
      // 回填本地快取是最佳努力；已取得的塊仍然有效，快取失敗不得讓本次讀取落空。
    }
    yield bytes;
  }
  return {
    put: async (cid, bytes) => {
      const parsed = requireCid(cid);
      const result = await blockstore.put(parsed, bytes);
      try {
        await broker.announce(parsed);
      } catch {
        // 通知 bitswap 有新塊是最佳努力，不得讓本地寫入落空。
      }
      return result;
    },
    get: (cid, options) => streamBlock(cid, options),
    delete: async (cid) => blockstore.delete(requireCid(cid)),
  };
}

function createNonCachingBlockReader(
  blockstore: NodeBlockstore,
  broker: LedgerBitswapBroker,
): Pick<BlockAccess, 'get'> {
  return {
    get: async (cid, timeoutMs, maxBytes = LEDGER_CONTENT_BLOCK_MAX_BYTES) => {
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        maxBytes > LEDGER_CONTENT_BLOCK_MAX_BYTES
      ) {
        return null;
      }
      const parsed = CID.parse(cid);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let bytes: Uint8Array;
        if (await blockstore.has(parsed, { signal: controller.signal })) {
          const chunks: Uint8Array[] = [];
          let total = 0;
          for await (const chunk of blockstore.get(parsed, { signal: controller.signal })) {
            total += chunk.byteLength;
            if (total > maxBytes) {
              controller.abort();
              return null;
            }
            chunks.push(chunk);
          }
          bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
        } else {
          bytes = await broker.retrieve(parsed, { signal: controller.signal });
        }
        return bytes.byteLength <= maxBytes && cidMatchesBytes(cid, bytes) ? bytes : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

interface NodeLedgerIpfsRuntime {
  readonly ipfs: LedgerIpfs;
  readonly transferBlocks: Pick<BlockAccess, 'get'>;
}

/** 見檔頭說明——Node 端手建結構相容 LedgerIpfs：本機 FsBlockstore ＋本節點 libp2p，
 *  content blockstore 疊 bitswap 取塊橋（見上）；UGC 搬遷另走不回填的 reader。 */
async function createNodeLedgerIpfs(
  libp2p: Libp2pInstance,
  stores: NodeStores,
): Promise<NodeLedgerIpfsRuntime> {
  const bitswap = await startLedgerBitswap(libp2p, stores.blockstore);
  const ipfs: LedgerIpfs = {
    blockstore: createBitswapLedgerBlockstore(stores.blockstore, bitswap.broker),
    entryBlockstore: stores.entryBlockstore,
    pins: createLocalPinTracker(),
    libp2p,
    stop: async () => {
      let failure: unknown;
      try {
        await bitswap.stop();
      } catch (error) {
        failure = error;
      }
      // libp2p 關閉時會經 identify 等服務把 peer store 變更 flush 回 datastore（見
      // @libp2p/peer-store 的 PersistentStore），故三個 store 必須晚於 libp2p.stop() 才關。
      try {
        await libp2p.stop();
      } catch (error) {
        failure ??= error;
      }
      try {
        await stores.blockstore.close();
      } catch (error) {
        failure ??= error;
      }
      try {
        await stores.entryBlockstore.close();
      } catch (error) {
        failure ??= error;
      }
      try {
        await stores.datastore.close();
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    },
  };
  return {
    ipfs,
    transferBlocks: createNonCachingBlockReader(stores.blockstore, bitswap.broker),
  };
}

/**
 * Admission outbox 的行程內實作：只緩衝「已挖出 PoW、尚未確認寫入 OrbitDB」的條目，
 * 供 writer 在單次提交失敗時重試；行程重啟遺失只造成該筆重新挖礦，帳本本身的持久
 * 真相（OrbitDB log ＋ checkpoint 永留庫，皆已落磁碟）不受影響，故不需要跨重啟持久化。
 * Map 上的讀取／判斷／寫入在單一 microtask 內同步完成（呼叫之間沒有 await），與
 * LedgerAdmissionWriter 本身逐筆序列化呼叫的既有紀律相疊，不需要額外的佇列鎖。
 */
function createMemoryAdmissionOutbox(): AdmissionOutbox {
  const records = new Map<string, AdmissionOutboxRecord>();
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new Error('ledger admission outbox is closed');
  };
  return {
    list: async (identity) => {
      assertOpen();
      return [...records.values()]
        .filter((record) => record.identity === identity)
        .sort(
          (left, right) => left.createdAt - right.createdAt || left.cid.localeCompare(right.cid),
        );
    },
    put: async (record) => {
      assertOpen();
      const existing = records.get(record.cid);
      const nextCount = records.size + (existing === undefined ? 1 : 0);
      const nextBytes =
        [...records.values()].reduce((sum, value) => sum + value.byteSize, 0) -
        (existing?.byteSize ?? 0) +
        record.byteSize;
      if (nextCount > Protocol.ledger.LEDGER_ADMISSION_OUTBOX_MAX_ENTRIES)
        throw new Error('ledger admission outbox entry quota exceeded');
      if (nextBytes > Protocol.ledger.LEDGER_ADMISSION_OUTBOX_MAX_BYTES)
        throw new Error('ledger admission outbox byte quota exceeded');
      records.set(record.cid, record);
    },
    update: async (cid, patch) => {
      assertOpen();
      const existing = records.get(cid);
      if (existing === undefined) throw new Error('ledger admission outbox record not found');
      records.set(cid, { ...existing, ...patch });
    },
    remove: async (cid) => {
      assertOpen();
      records.delete(cid);
    },
    close: async () => {
      closed = true;
      records.clear();
    },
  };
}

/**
 * 包一層 setLatest：durable pointer 落地（本地 finalize 與遠端 announcement 採納皆收斂
 * 於此）即視為「檢查點已採納」——屆時其引用的 derived-state／signer-set／cold partition
 * 塊皆已在呼叫端 pin 完成（finalize／adopt 兩條路徑都先 pin 後才 setLatest）。以 cid
 * 去重避免同一檢查點的冪等 retry 重複通知；load 失敗（理論上不會，save 恆先於
 * setLatest）僅吞錯不得回頭讓已完成的 durable pointer 提交失敗。
 */
function withCheckpointAdoptionNotifications(
  store: CheckpointStore,
  notify: (adoption: CheckpointAdoption) => void,
): CheckpointStore {
  let lastNotifiedCid: CheckpointCid | null = null;
  return {
    ...store,
    setLatest: async (cid, expectedRevision) => {
      const revision = await store.setLatest(cid, expectedRevision);
      if (cid !== lastNotifiedCid) {
        lastNotifiedCid = cid;
        try {
          const checkpoint = await store.load(cid);
          if (checkpoint !== null) notify({ cid, checkpoint });
        } catch {
          // 旁路通知；不得讓觀察失敗回頭破壞已完成的 durable pointer 提交。
        }
      }
      return revision;
    },
  };
}

/** 啟動持久帳本 replica 與其檢查點准入管線。 */
export async function startLedgerNode(cfg: LedgerNodeConfig): Promise<LedgerNode> {
  if (cfg.genesisGovernanceSigners !== undefined && cfg.initialCheckpointProof !== undefined)
    throw new TypeError('ordinary genesis and initial checkpoint proof are mutually exclusive');
  if (
    (cfg.initialCheckpointProof === undefined) !==
    (cfg.initialCheckpointProofBlocks === undefined)
  )
    throw new TypeError('initial checkpoint proof and verified blocks must be provided together');
  const stores = createNodeStores(cfg.dataDir);
  await stores.blockstore.open();
  await stores.entryBlockstore.open();
  await stores.datastore.open();

  const libp2p = await createAppLibp2p({
    privateKey: cfg.privateKey,
    listen: cfg.listen,
    bootstrap: cfg.bootstrap,
    relayEnabled: cfg.relayEnabled,
    datastore: stores.datastore,
    extraTransports: cfg.extraTransports,
  });

  const identity = derivePeerIdentity(cfg.privateKey);
  const adoptionListeners = new Set<(adoption: CheckpointAdoption) => void>();
  const { ipfs, transferBlocks } = await createNodeLedgerIpfs(libp2p, stores);
  try {
    if (cfg.initialCheckpointProofBlocks !== undefined) {
      for (const [cid, bytes] of cfg.initialCheckpointProofBlocks)
        await ipfs.blockstore.put(CID.parse(cid), bytes);
    }
    await cfg.beforeLedgerOpen?.(libp2p);
  } catch (error) {
    try {
      await ipfs.stop?.();
    } catch {
      /* preserve controlled bring-up failure */
    }
    throw error;
  }
  const genesisGovernanceSigners =
    cfg.genesisGovernanceSigners === undefined
      ? undefined
      : [...cfg.genesisGovernanceSigners].sort();

  const ledger = new Open4wdLedger({
    connect: async () => {
      let checkpointStorage: Awaited<ReturnType<typeof createLevelCheckpointStorage>> | null = null;
      let rawCheckpoints: CheckpointStore | null = null;
      let log: Awaited<ReturnType<typeof openOrbitEventLog>> | null = null;
      try {
        checkpointStorage = await createLevelCheckpointStorage(join(cfg.dataDir, 'checkpoints'));
        rawCheckpoints = await createCheckpointStore({ storage: checkpointStorage });
        // durable conflict／pointer 狀態必須在 log 開啟前先看見（同瀏覽器端 bootstrap 順序）。
        await rawCheckpoints.getConflict();
        const effectiveLatest = await rawCheckpoints.getLatest();
        const pendingBoundary = await rawCheckpoints.getPendingBoundaryAdvance();
        const outbox = createMemoryAdmissionOutbox();
        log = await openOrbitEventLog({
          ipfs,
          // 省略時 vendored 預設落在相對路徑 'open4wd/orbitdb'（＝ CWD）——同一行程內起多個
          // 節點會共撞同一把 LevelDB 鎖；明確落在各節點自己的 dataDir 下才不互撞、也不外溢寫進 CWD。
          directory: join(cfg.dataDir, 'orbitdb'),
          ...(cfg.ledgerDbAddress === undefined ? {} : { addressOrName: cfg.ledgerDbAddress }),
          checkpointBoundary: async () => effectiveLatest?.checkpoint.log_head_cids ?? null,
          admission: {
            outbox,
            miner: new InlineAdmissionMiner(),
            ...(cfg.admissionScheme === undefined ? {} : { scheme: cfg.admissionScheme }),
          },
        });
        if (pendingBoundary !== null && pendingBoundary.cid === effectiveLatest?.cid) {
          await log.advanceCheckpointBoundary?.(pendingBoundary.checkpoint.log_head_cids);
          await rawCheckpoints.completeBoundaryAdvance(
            pendingBoundary.cid,
            await rawCheckpoints.getRevision(),
          );
        }
        const checkpoints = withCheckpointAdoptionNotifications(rawCheckpoints, (adoption) => {
          for (const listener of [...adoptionListeners]) {
            try {
              listener(adoption);
            } catch {
              // 單一觀察者故障不得影響其他觀察者或帳本提交流程。
            }
          }
        });
        const blocks = createBlockAccess(ipfs);
        return { log, checkpoints, blocks };
      } catch (cause) {
        try {
          await log?.stop();
        } catch {
          /* preserve connect failure */
        }
        try {
          if (rawCheckpoints !== null) await rawCheckpoints.close();
          else await checkpointStorage?.close?.();
        } catch {
          /* preserve connect failure */
        }
        throw cause;
      }
    },
    signer: identity.signer,
    now: cfg.now,
    deferRetryDelaysMs: cfg.deferRetryDelaysMs,
    checkpointStartupScanTimeoutMs: cfg.checkpointStartupScanTimeoutMs,
    ...(cfg.initialCheckpointProof !== undefined
      ? { initialCheckpointProof: cfg.initialCheckpointProof }
      : genesisGovernanceSigners === undefined
        ? {}
        : {
            // 部署 trust root 必須進入 genesis，才能隨 checkpoint state 鏈式推進。
            genesisState: () => {
              return emptyDerivedState(
                genesisEconomyConfigWithGovernance(
                  genesisGovernanceSigners,
                  cfg.genesisTimestamp ?? 0,
                ),
              );
            },
          }),
    registry: cfg.registry,
    // pinning replica 是輕量 follower：驗前一個已信任 state 的治理 quorum 後採納 checkpoint
    // 內的 canonical state；不要求本節點重載瀏覽器端全部遊戲 domain reducer。
    checkpointAdoptionMode: 'quorum-follow',
  });

  const opened = await ledger.open(identity.peerId);
  if (!opened.ok) {
    // open() 失敗時 Open4wdLedger 已自行清掉 connect() 回傳的 log／checkpoints（見其內部
    // catch）；ipfs（含 stores／libp2p）不在 LedgerPorts 之內，須由本函式自行收攤。
    try {
      await ipfs.stop?.();
    } catch {
      /* preserve open() failure */
    }
    throw opened.error;
  }

  return {
    ledger,
    libp2p,
    ipfs,
    transferBlocks,
    onCheckpointAdopted: (cb) => {
      adoptionListeners.add(cb);
      return () => adoptionListeners.delete(cb);
    },
    close: async () => {
      await ledger.close();
      // ipfs.stop() 連帶 stop 傳入的 libp2p（同真 helia 的既有慣例）——不得再另外呼叫 libp2p.stop()。
      await ipfs.stop?.();
    },
  };
}
