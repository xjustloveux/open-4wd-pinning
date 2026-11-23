/**
 * pinning service 進入點（`pnpm start`）——把 config／identity／ledger-node／pinning 客戶端／
 * 配額／授權／reconcile 訂閱／管理 API（＋選配 DMCA）組成一個可長駐的服務。
 *
 * 組裝順序（資源取得序）＝config → identity → ledger-node（內含 stores／libp2p／ledger／ipfs）
 * → pinning 客戶端（lazy、不預先連線）→ 量測 Cluster roots 並重建 block 引用配額帳 →
 * DMCA（選配）→ subscriber
 * 訂閱 onCheckpointAdopted → api server。收攤（SIGINT／SIGTERM）逆序執行。
 *
 * 兩條跨模組接線：
 * ①`authDeps.reputationOf`＝讀節點自身 derive 的最新 DerivedState 的 reputation.scores（查無＝
 *   undefined＝不授權）。DerivedState 快照以 `emptyDerivedState()` 起手，帳本事件（onEvent）與
 *   檢查點採納都會刷新它——api 的授權判定是同步介面，只能讀這份就近快照，無法對每個請求即時
 *   非同步重算（見 reputationOf 說明）。
 * ②`DenyList.countNotRestoredTakedowns`＝DMCA 啟用時接 NoticeStore 同名方法、關閉時省略（恆 0）。
 *   api 的 `authDeps.isRepeatInfringer` 是同步介面，DMCA 判定卻是非同步（讀 level），故以一份
 *   同步可讀的 repeat-infringer 集橋接：啟動時預熱、每日掃描時刷新（見 refreshRepeatInfringers）。
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { loadConfig, toApiConfig } from '../config/load';
import {
  createApiServer,
  PinResourceLimitError,
  type ApiDeps,
  type PinExecutor,
  type StatsBody,
} from '../api';
import {
  emptyDerivedState,
  genesisEconomyConfigWithGovernance,
  publicKeyToPeerId,
  type DerivedState,
  type PeerId,
} from '../core';
import {
  createDmcaService,
  createDmcaInboxCrypto,
  createDmcaLifecycleExecutor,
  createNodemailerMailer,
  createNoticeStore,
  mountDmcaRoutes,
  type Mailer,
  type MountableServer,
  type NoticeStore,
} from '../dmca';
import { loadIdentity, startLedgerNode } from '../node';
import {
  createNoopMetrics,
  createPrometheusMetrics,
  startMetricsServer,
  type ClusterMetricOperation,
  type PinningMetrics,
} from '../metrics';
import {
  createClusterClient,
  createKuboClient,
  QuotaLedger,
  type KuboClient,
  type PinRecord,
} from '../pinning';
import {
  DenyList,
  DagTransferLimitError,
  DEFAULT_DAG_TRANSFER_LIMITS,
  measureCompleteDag,
  reconcileCheckpoint,
  transferDag,
  type AdoptedCheckpoint,
  type DenyListDeps,
  type ReconcileCtx,
} from '../subscriber';

const SERVICE_VERSION = process.env['npm_package_version'] ?? '0.0.0';
const DAILY_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** DMCA 開了卻沒設 SMTP 時的 fail-closed mailer：讓確認信失敗、反通知交付進入重試。 */
function loggingNoopMailer(): Mailer {
  return {
    async send() {
      throw new Error('mailer-unavailable');
    },
  };
}

interface DmcaWiring {
  /** /api/dmca/* 的委派處理器（單一 dispatcher）。 */
  readonly dmcaHandler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  /** DenyList repeat-infringer 判定的計數來源（接 NoticeStore 同名方法）。 */
  readonly countNotRestoredTakedowns: (signer: string) => Promise<number>;
  /** repeat-infringer 集刷新時列舉候選 signer 用（provider pin metadata）。 */
  readonly noticeStore: NoticeStore;
  /** 定期掃描：自第 13 工作日起 restore＋清除 72h 未確認 Notice。 */
  runSweep(): Promise<void>;
  runDeliverySweep(): Promise<void>;
}

function instrumentClusterClient(
  client: ReturnType<typeof createClusterClient>,
  metrics: PinningMetrics,
): ReturnType<typeof createClusterClient> {
  const observe = async <T>(
    operation: ClusterMetricOperation,
    run: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      const value = await run();
      metrics.recordCluster(operation, 'success', Date.now() - startedAt);
      return value;
    } catch (error) {
      metrics.recordCluster(operation, 'error', Date.now() - startedAt);
      throw error;
    }
  };
  return {
    pin: (cid, meta) => observe('pin', () => client.pin(cid, meta)),
    unpin: (cid) => observe('unpin', () => client.unpin(cid)),
    get: (cid) => observe('get', () => client.get(cid)),
    async *list() {
      const startedAt = Date.now();
      try {
        for await (const record of client.list()) yield record;
        metrics.recordCluster('list', 'success', Date.now() - startedAt);
      } catch (error) {
        metrics.recordCluster('list', 'error', Date.now() - startedAt);
        throw error;
      }
    },
    peers: () => observe('peers', () => client.peers()),
  };
}

/** DMCA 模組接線（僅在 DMCA_ENABLE 時建立）；不含 repeat-infringer 集刷新——那需要 denyList，
 *  留給 main 在 denyList 建好後負責，避免與本函式互相引用成環。 */
function setupDmca(params: {
  readonly dataDir: string;
  readonly smtpUrl: string | undefined;
  readonly agentEmail: string | undefined;
  readonly adminToken: string | undefined;
  readonly adminOperatorId: string;
  readonly trustCloudflareAccessIdentity: boolean;
  readonly adminDocsEnabled: boolean;
  readonly deliveryRetryBaseMs: number;
  readonly deliveryRetryMaxMs: number;
  readonly businessDayHolidays: readonly string[];
  readonly metrics: PinningMetrics;
  readonly cluster: ReturnType<typeof createClusterClient>;
  readonly kubo: KuboClient;
  readonly quota: QuotaLedger;
  readonly providerId: PeerId;
  readonly signProviderMessage: (message: Uint8Array) => Promise<Uint8Array>;
  readonly registerShutdown: (step: () => Promise<void>) => void;
}): DmcaWiring {
  if (params.adminToken === undefined) {
    throw new Error('DMCA 啟用時 DMCA_ADMIN_TOKEN 為必填（config 驗證不變量遭破壞）');
  }
  const noticeStore = createNoticeStore(join(params.dataDir, 'dmca-notices'));
  params.registerShutdown(() => noticeStore.close());

  const mailer: Mailer =
    params.smtpUrl !== undefined ? createNodemailerMailer(params.smtpUrl) : loggingNoopMailer();
  if (params.smtpUrl === undefined)
    console.warn(
      '[pinning] DMCA 已啟用但未設定 SMTP_URL——申訴人收不到信箱確認信，DMCA 流程無法完成；請設定 SMTP_URL',
    );

  const agentEmail = params.agentEmail ?? '';
  if (agentEmail === '')
    console.warn('[pinning] DMCA 已啟用但未設定 DMCA_AGENT_EMAIL——到案通知無收件人');

  const executor = createDmcaLifecycleExecutor({
    cluster: params.cluster,
    kubo: params.kubo,
    quota: params.quota,
  });

  const service = createDmcaService({
    store: noticeStore,
    mailer,
    executor,
    clock: { now: () => Date.now() },
    agentEmail,
    counterDeliveryRetryBaseMs: params.deliveryRetryBaseMs,
    counterDeliveryRetryMaxMs: params.deliveryRetryMaxMs,
    businessDayHolidays: params.businessDayHolidays,
    recordCounterDelivery: (outcome) => params.metrics.recordDmcaDelivery(outcome),
  });

  // 單一 dispatcher：以假 MountableServer 擷取 dmca 的 request 處理器，但不把它掛成第二個
  // 'request' listener——改由 api server 對 /api/dmca/* 前綴委派給它（見 api ApiDeps.dmcaHandler）。
  let capturedHandler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const captureServer: MountableServer = {
    on: (_event, listener) => {
      capturedHandler = listener;
    },
  };
  mountDmcaRoutes(
    captureServer,
    service,
    params.adminToken,
    params.adminOperatorId,
    params.trustCloudflareAccessIdentity,
    params.adminDocsEnabled,
    createDmcaInboxCrypto({
      providerId: params.providerId,
      now: () => Date.now(),
      randomNonce: () => randomBytes(16),
      sign: params.signProviderMessage,
    }),
  );
  if (capturedHandler === undefined)
    throw new Error('mountDmcaRoutes 未註冊 request 處理器（無法建立 dmca dispatcher）');
  const dmcaHandler = capturedHandler;

  const runSweep = async (): Promise<void> => {
    const now = Date.now();
    const startedAt = Date.now();
    let failed = false;
    try {
      await service.sweepTakedowns(now);
    } catch (error) {
      failed = true;
      console.warn('[pinning] DMCA 自動 takedown 重試掃描失敗', error);
    }
    try {
      await service.sweepCounterDeliveries(now);
    } catch {
      failed = true;
      console.warn('[pinning] DMCA claimant delivery retry sweep failed');
    }
    try {
      await service.sweepCounterRestores(now);
    } catch (error) {
      failed = true;
      console.warn('[pinning] DMCA 自動 restore 掃描失敗', error);
    }
    try {
      await service.purgeUnconfirmed(now);
    } catch (error) {
      failed = true;
      console.warn('[pinning] DMCA 未確認案清除失敗', error);
    }
    params.metrics.recordDmcaSweep(failed ? 'error' : 'success', Date.now() - startedAt);
  };

  return {
    dmcaHandler,
    countNotRestoredTakedowns: (signer) => noticeStore.countNotRestoredTakedowns(signer),
    noticeStore,
    runSweep,
    runDeliverySweep: () => service.sweepCounterDeliveries(Date.now()),
  };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, process.env['CONFIG_PATH'] ?? 'config/config.yaml');
  const metrics = config.metrics.enabled ? createPrometheusMetrics() : createNoopMetrics();

  const shutdownSteps: (() => Promise<void>)[] = [];
  const registerShutdown = (step: () => Promise<void>): void => {
    shutdownSteps.push(step);
  };
  const runShutdown = async (): Promise<void> => {
    for (const step of [...shutdownSteps].reverse()) {
      try {
        await step();
      } catch (error) {
        console.error('[pinning] 收攤步驟失敗（繼續其餘步驟）', error);
      }
    }
  };

  try {
    // ── identity ──
    const privateKey = await loadIdentity(process.env);
    const selfPeerId = publicKeyToPeerId(privateKey.publicKey.raw);
    console.log(`[pinning] identity 就緒（peerId=${selfPeerId}）`);

    // ── 治理 trust root（checkpoint 採納授權 signer set）──
    // 部署 config 注入的 PeerId 清單即實際生效的 signer set：replica 節點的 DerivedState 不推進
    // economyConfig（reducer 組合不含治理 reducer），故由部署 config 寫入 genesis。空集＝不注入
    // trust root＝fail-closed。
    const governanceSignerSet: ReadonlySet<PeerId> = new Set(
      config.governanceSigners.map((value) => value as PeerId),
    );
    if (governanceSignerSet.size === 0)
      console.warn(
        '[pinning] 未設定 GOVERNANCE_SIGNERS——checkpoint 驅動的自動 pin 停用：帳本無治理 trust root，本地無法提案 checkpoint、遠端 announcement 一律拒收；授權 pin API（POST /pin）不受影響仍可運作',
      );

    // ── ledger node（stores／libp2p／ledger／ipfs 皆在內部組裝）──
    const node = await startLedgerNode({
      dataDir: config.dataDir,
      privateKey,
      listen: config.listenWs,
      bootstrap: config.bootstrap,
      relayEnabled: config.relayEnabled,
      ledgerDbAddress: config.ledgerDbAddress,
      genesisGovernanceSigners: governanceSignerSet,
      genesisTimestamp: config.genesisTimestamp,
    });
    registerShutdown(() => node.close());
    console.log(
      `[pinning] ledger 就緒（address=${node.ledger.ledgerAddress || config.ledgerDbAddress}）`,
    );

    // ── pinning 客戶端（lazy：建構不連線，實際呼叫時才打 HTTP）──
    const cluster = instrumentClusterClient(createClusterClient(config.clusterApiUrl), metrics);
    const kubo = createKuboClient(config.kuboApiUrl);
    const blocks = node.transferBlocks;

    // ── 配額帳：以 Cluster roots＋Kubo 完整 DAG 重建逐 block 引用索引。任一項不可量測時，
    // 新 pin fail-closed；unpin／DMCA takedown 仍可運作，避免以不完整帳本超額收件。 ──
    const quota = new QuotaLedger(config.quotas);
    try {
      const records: PinRecord[] = [];
      for await (const record of cluster.list()) records.push(record);
      const measuredRecords = [];
      for (const record of records) {
        const measured = await measureCompleteDag({ root: record.cid, kubo });
        if (measured === null) {
          throw new Error(`pinned DAG is incomplete in Kubo: ${record.cid}`);
        }
        measuredRecords.push({ record, blocks: measured.blocks });
      }
      quota.loadMeasured(measuredRecords);
      console.log(`[pinning] 配額 block 引用帳已自 Cluster/Kubo 重建（${records.length} 筆 pin）`);
    } catch (error) {
      quota.markAccountingUnavailable();
      console.warn(
        '[pinning] 啟動時無法完整重建配額 block 引用帳——新 pin 已 fail-closed；unpin 仍可用',
        error,
      );
    }

    // metrics 採 pull-time 容量採集：每次 scrape 同步讀 Kubo repo 與 quota snapshot，避免只有
    // /stats 被呼叫時 gauges 才刷新。Kubo 不可讀時 listener 回 503，Prometheus up=0，不輸出
    // 可能過時的容量值。
    if (config.metrics.enabled) {
      const metricsServer = startMetricsServer(
        { host: config.metrics.host, port: config.metrics.port },
        metrics,
        async () => {
          const kuboStats = await kubo.stats();
          const quotaSnapshot = quota.snapshot();
          metrics.setCapacity({
            repoSizeBytes: kuboStats.repoSizeBytes,
            storageMaxBytes:
              kuboStats.storageMaxBytes ?? kuboStats.repoSizeBytes + kuboStats.availableBytes,
            quotaGlobalUsedBytes: quotaSnapshot.physicalSizeBytes,
            quotaGlobalLimitBytes: quotaSnapshot.globalMaxSizeBytes,
          });
        },
      );
      registerShutdown(() => metricsServer.close());
      const metricsPort = await metricsServer.ready;
      console.log(
        `[pinning] private metrics 就緒（host=${config.metrics.host} port=${metricsPort}）`,
      );
    }

    // ── 最新 DerivedState 快照（reputation／blacklist 讀取來源）──
    // 先以空狀態起手，避免啟動阻塞在 getDerivedState()；帳本事件與檢查點採納會把它刷新成實值。
    let latestDerivedState: DerivedState = emptyDerivedState(
      genesisEconomyConfigWithGovernance([...governanceSignerSet], config.genesisTimestamp),
    );
    let refreshInFlight = false;
    let refreshQueued = false;
    const refreshDerivedState = (): void => {
      refreshQueued = true;
      if (refreshInFlight) return;
      refreshInFlight = true;
      void (async () => {
        try {
          while (refreshQueued) {
            refreshQueued = false;
            latestDerivedState = await node.ledger.getDerivedState();
          }
        } catch {
          // 讀取失敗（例如收攤競態）保留最後一份良好快照，不覆寫成殘缺值。
        } finally {
          refreshInFlight = false;
        }
      })();
    };

    // ── DMCA（選配）——無 denyList 依賴，故可直接建立 const（不成環）──
    const dmca: DmcaWiring | undefined = config.dmca.enable
      ? setupDmca({
          dataDir: config.dataDir,
          smtpUrl: config.dmca.smtpUrl,
          agentEmail: config.dmca.agentEmail,
          adminToken: config.dmca.adminToken,
          adminOperatorId: config.dmca.adminOperatorId,
          trustCloudflareAccessIdentity: config.dmca.trustCloudflareAccessIdentity,
          adminDocsEnabled: config.dmca.adminDocsEnabled,
          deliveryRetryBaseMs: config.dmca.deliveryRetryBaseMs,
          deliveryRetryMaxMs: config.dmca.deliveryRetryMaxMs,
          businessDayHolidays: config.dmca.businessDayHolidays,
          metrics,
          cluster,
          kubo,
          quota,
          providerId: selfPeerId,
          signProviderMessage: (message) => Promise.resolve(privateKey.sign(message)),
          registerShutdown,
        })
      : undefined;

    // ── 拒服務名單（CID 黑名單＋repeat-infringer）──
    const denyListDeps: DenyListDeps =
      dmca !== undefined
        ? {
            currentState: () => latestDerivedState,
            countNotRestoredTakedowns: (signer) => dmca.countNotRestoredTakedowns(signer),
          }
        : { currentState: () => latestDerivedState };
    const denyList = new DenyList(denyListDeps);

    // ── repeat-infringer 同步橋：api 授權是同步介面，DMCA 判定是非同步，故維護一份同步可讀集 ──
    const repeatInfringers = new Set<string>();
    const isRepeatInfringer = (signer: string): boolean => repeatInfringers.has(signer);
    const refreshRepeatInfringers = async (): Promise<void> => {
      if (dmca === undefined) return;
      try {
        const notices = await dmca.noticeStore.list();
        const candidates = new Set<string>();
        for (const record of notices) {
          if (record.type !== 'notice') continue;
          for (const signer of Object.values(record.uploaderByCid ?? {})) candidates.add(signer);
        }
        const next = new Set<string>();
        // denyList.isRepeatInfringer 封裝了 3 振門檻——用它當權威判定，本處不另硬編門檻值。
        for (const signer of candidates)
          if (await denyList.isRepeatInfringer(signer)) next.add(signer);
        repeatInfringers.clear();
        for (const signer of next) repeatInfringers.add(signer);
      } catch (error) {
        console.warn('[pinning] repeat-infringer 集刷新失敗（保留上一份）', error);
      }
    };

    if (dmca !== undefined) {
      // 啟動預熱：把現有 taken_down 案的 repeat-infringer 先算進同步集（避免第一個請求漏擋）。
      await refreshRepeatInfringers();
      await dmca.runSweep();
      const deliveryTimer = setInterval(() => {
        void dmca.runDeliverySweep().catch(() => {
          console.warn('[pinning] DMCA claimant delivery retry sweep failed');
        });
      }, config.dmca.deliveryRetryBaseMs);
      const dailyTimer = setInterval(() => {
        void (async () => {
          await dmca.runSweep();
          await refreshRepeatInfringers();
        })();
      }, DAILY_SWEEP_INTERVAL_MS);
      registerShutdown(() => {
        clearInterval(deliveryTimer);
        clearInterval(dailyTimer);
        return Promise.resolve();
      });
    }

    // ── 授權接線 ──
    const reputationOf = (signer: string): number | undefined =>
      latestDerivedState.reputation.scores.get(signer as PeerId);

    // ── 真 PinExecutor（只準備完整 DAG；實量 quota 複查後由 API server 執行 cluster.pin）──
    const throwIfAborted = (signal: AbortSignal): void => {
      if (signal.aborted) throw new Error('pin executor aborted');
    };
    const pinExecutor: PinExecutor = {
      async preparePin({ cid, sizeHintBytes, signal }) {
        throwIfAborted(signal);
        try {
          const {
            logicalDagBytes,
            newPhysicalBytes,
            blocks: measuredBlocks,
          } = await transferDag({
            root: cid,
            blocks,
            kubo,
            limits: {
              maxBytes: Math.min(sizeHintBytes, DEFAULT_DAG_TRANSFER_LIMITS.maxBytes),
            },
            signal,
          });
          return {
            logicalSizeBytes: logicalDagBytes,
            newPhysicalSizeBytes: newPhysicalBytes,
            blocks: measuredBlocks,
          };
        } catch (error) {
          if (error instanceof DagTransferLimitError) {
            throw new PinResourceLimitError(error.message);
          }
          throw error;
        }
      },
      async unpin({ cid, signal }) {
        throwIfAborted(signal);
        await cluster.unpin(cid);
      },
    };

    // ── /stats（cluster／kubo 未就緒時各欄位優雅退 0，不 crash）──
    const startedAt = Date.now();
    let lastSyncTimestamp = 0;
    const stats = async (): Promise<StatsBody> => {
      let clusterPeers = 0;
      try {
        clusterPeers = await cluster.peers();
      } catch {
        // cluster 未就緒——維持 0。
      }
      let availableSpaceBytes = 0;
      try {
        availableSpaceBytes = (await kubo.stats()).availableBytes;
      } catch {
        // kubo 未就緒——維持 0。
      }
      const quotaSnapshot = quota.snapshot();
      return {
        node_id: selfPeerId,
        version: SERVICE_VERSION,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        total_pinned_count: quotaSnapshot.totalPins,
        total_size_bytes: quotaSnapshot.totalLogicalSizeBytes,
        available_space_bytes: availableSpaceBytes,
        ipfs_cluster_peers: clusterPeers,
        last_sync_timestamp: lastSyncTimestamp,
        accepting_pins: quotaSnapshot.acceptingPins,
        quota_used_bytes: quotaSnapshot.physicalSizeBytes,
        quota_limit_bytes: quotaSnapshot.globalMaxSizeBytes,
      };
    };

    // ── 訂閱：帳本事件刷新 DerivedState 快照；檢查點採納觸發 reconcile ──
    const reconcileCtx: ReconcileCtx = { cluster, kubo, blocks, quota };
    let prevState: DerivedState | undefined;
    let reconcileChain: Promise<void> = Promise.resolve();

    const unsubEvents = node.ledger.onEvent(refreshDerivedState);
    registerShutdown(() => {
      unsubEvents();
      return Promise.resolve();
    });

    const unsubCheckpoint = node.onCheckpointAdopted((adoption) => {
      reconcileChain = reconcileChain.then(async () => {
        try {
          const state = await node.ledger.getDerivedState();
          latestDerivedState = state;
          const cp: AdoptedCheckpoint = { ...adoption.checkpoint, cid: adoption.cid };
          const report = await reconcileCheckpoint(reconcileCtx, cp, state, prevState);
          prevState = state;
          lastSyncTimestamp = Date.now();
          console.log(
            `[pinning] reconcile 完成 checkpoint=${adoption.cid} pinned=${report.pinned.length} unpinned=${report.unpinned.length} warnings=${report.warnings.length}`,
          );
        } catch (error) {
          console.error(`[pinning] reconcile 失敗 checkpoint=${adoption.cid}`, error);
        }
      });
    });
    registerShutdown(() => {
      unsubCheckpoint();
      return Promise.resolve();
    });

    // 啟動即拉一次實值 DerivedState（不阻塞：single-flight 背景刷新）。
    refreshDerivedState();

    // ── 管理 API server ──
    const apiConfig = toApiConfig(config);
    const deps: ApiDeps = {
      config: apiConfig,
      quota,
      cluster,
      kubo,
      denyList,
      authDeps: { reputationOf, isRepeatInfringer },
      stats,
      providerId: selfPeerId,
      pinExecutor,
      metrics,
      ...(dmca !== undefined
        ? {
            dmcaHandler: dmca.dmcaHandler,
            dmcaAdminDocsEnabled: config.dmca.adminDocsEnabled,
          }
        : {}),
    };
    const apiServer = createApiServer(deps);
    registerShutdown(() => apiServer.close());
    const port = await apiServer.ready;
    console.log(`[pinning] api 就緒（port=${port}）`);

    // ── 收攤訊號 ──
    let shuttingDown = false;
    const shutdownAndExit = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[pinning] 收到 ${signal}，開始逆序收攤`);
      void runShutdown().then(() => {
        console.log('[pinning] 收攤完成，程序結束');
        process.exit(0);
      });
    };
    process.on('SIGINT', () => shutdownAndExit('SIGINT'));
    process.on('SIGTERM', () => shutdownAndExit('SIGTERM'));
  } catch (error) {
    await runShutdown();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error('[pinning] 啟動失敗', error);
  process.exit(1);
});
