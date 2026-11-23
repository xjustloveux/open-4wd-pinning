/**
 * 整合測試——對真 kubo＋真 cluster（compose.test.yml 起兩顆容器），驗證 pinning／subscriber／api
 * 三個模組組裝起來、真的打 HTTP 到外部服務時的 wire 正確性。單元測試（pinning/*.spec.ts、
 * api/server.spec.ts 等）一律打假替身或 node:http 假伺服器，只有這裡會真的送請求到 kubo RPC
 * 與 cluster REST API——kubo-client.ts／cluster-client.ts 檔頭都寫明「wire 正確性由整合測試
 * 驗證」，這支檔案就是那個驗證。
 *
 * docker 不在（daemon 未啟動，或 compose 檔本身有問題）＝describe.skipIf 直接跳過整組案例；
 * skip 判斷只問「`docker compose ps` 這個指令本身能不能成功執行」，完全不管服務有沒有真的
 * 起來。daemon 在但服務起不來（image 拉不下來、healthcheck 一直不過）是 beforeAll 裡
 * `docker compose up --wait` 逾時或非 0 結束碼直接拋錯，讓整組案例以「失敗」收尾——不會被
 * 誤判成 SKIP，兩種狀況的訊號必須分得開。
 *
 * 埠與生命週期：compose.test.yml 檔頭有完整說明——固定測試埠段（非 kubo／cluster 慣用預設埠，
 * 避免撞到開發者本機可能已在跑的一套）＋beforeAll／afterAll 自行 up／down，本機只要 docker
 * daemon 有在跑就會自動起停，不必手動先 `docker compose up` 一次。CI 沿用同一份 compose 檔跑
 * 同一支 spec，daemon 在 runner 上恆可用，故那邊是「必跑」而非可 SKIP。
 *
 * 三個案例彼此使用不同的 DAG fixture（不同 label → 不同內容 → 不同 CID）與不同 signer，刻意
 * 不共用——避免同一個 cid 被兩個案例先後 pin 時，第二次落進 server.ts 的「re-pin 同一 cid＝
 * 冪等短路」分支（見該檔 handlePin 的「re-pin 不得移轉所有權」說明），讓斷言看似通過、實際上
 * 根本沒有真的走到要驗證的那條路徑。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as dagCbor from '@ipld/dag-cbor';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID as MultiformatsCID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiServer, type ApiDeps, type PinExecutor, type StatsBody } from '../api';
import type { PinPayload, UnpinPayload } from '../auth';
import {
  buildSignedMessage,
  publicKeyToPeerId,
  Protocol,
  type BlockAccess,
  type PeerId,
} from '../core';
import {
  createClusterClient,
  createKuboClient,
  QuotaLedger,
  type ClusterClient,
  type KuboClient,
  type PinMeta,
} from '../pinning';
import { DEFAULT_DAG_TRANSFER_LIMITS, transferDag } from '../subscriber';

// ── docker compose 生命週期 ──────────────────────────────────────────────

const COMPOSE_FILE = fileURLToPath(new URL('./compose.test.yml', import.meta.url));

function dockerCompose(args: readonly string[], timeoutMs: number): ReturnType<typeof spawnSync> {
  return spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    stdio: 'inherit',
    windowsHide: true,
    timeout: timeoutMs,
  });
}

/** skipIf 判斷式：只問「docker compose 這個指令本身能不能跑」，不含 up／healthcheck 邏輯（那
 *  屬於下面 beforeAll，失敗時要讓案例真的紅、不是靜默跳過）。daemon 未啟動時 `docker compose
 *  ps` 會以非 0 結束碼並印出連不上 daemon 的錯誤，這裡只看結束碼。 */
function isDockerComposeAvailable(): boolean {
  const result = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'ps'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 15_000,
  });
  return result.error === undefined && result.status === 0;
}

function runDockerComposeOrThrow(args: readonly string[], timeoutMs: number): void {
  const result = dockerCompose(args, timeoutMs);
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} 失敗（exit=${String(result.status)}, signal=${String(result.signal)}）` +
        '——daemon 在但服務起不來，這是真失敗、不是 SKIP',
    );
  }
}

const DOCKER_AVAILABLE = isDockerComposeAvailable();

// ── 埠：與 compose.test.yml 讀同一組環境變數、預設值一致 ──────────────────

const KUBO_API_PORT = Number(process.env['INTEGRATION_KUBO_API_PORT'] ?? '15001');
const CLUSTER_API_PORT = Number(process.env['INTEGRATION_CLUSTER_API_PORT'] ?? '19094');

const kuboApiUrl = (): string => `http://127.0.0.1:${String(KUBO_API_PORT)}`;
const clusterApiUrl = (): string => `http://127.0.0.1:${String(CLUSTER_API_PORT)}`;

// ── CID 計算：獨立於 core/vendor 重新實作（vendored 檔不得跨模組直接 import 非 barrel 路徑，
// 這幾行本身也短得不值得為此在 core barrel 開一個新出口）——演算法與 core/vendor/ledger 的
// 內容定址一致：CIDv1、sha2-256、預設字串編碼（base32）；multiformats 與 kubo 兩邊對同樣的
// (codec, hash) 產出同一個字串，這正是 dag-transfer.ts 對 kubo 回傳 CID 做恆等斷言時倚賴的
// 前提，本檔測試就是驗證這個前提成立。 ──

const DAG_CBOR_CODE = 0x71;
const SHA2_256_CODE = 0x12;

function cidOfBytes(bytes: Uint8Array, code: number): string {
  const digest = Digest.create(SHA2_256_CODE, sha256(bytes));
  return MultiformatsCID.createV1(code, digest).toString();
}

/** dag-cbor 編碼後的 ByteView 轉成乾淨、純 ArrayBuffer 背書的 Uint8Array 視圖——比照
 *  subscriber/reconcile.test-support.ts 同款作法，避免帶著品牌型別到處傳。 */
function toCleanUint8Array(view: Uint8Array): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

// ── DAG fixture：root（dag-cbor）→ 內嵌一個真 CID link → leaf（dag-cbor）──────

interface DagFixture {
  readonly rootCid: string;
  readonly blocks: ReadonlyMap<string, Uint8Array>;
  readonly totalBytes: number;
  readonly blockCount: number;
}

/** 每個呼叫端傳入不同 label 產生完全不同內容（故完全不同 CID）——四個測試案例互不共用
 *  fixture，理由見檔頭說明。root 內嵌一個對 leaf 的真 CID link（多重 formats CID 實例，
 *  非純字串），讓 transferDag 的 BFS／collectLinks 真的走過「解出 link → 繼續抓子節點」
 *  這條路徑，不只是驗證單一葉節點的退化案例。 */
function makeDagFixture(label: string): DagFixture {
  const leafBytes = toCleanUint8Array(
    dagCbor.encode({ kind: 'leaf', label, note: 'open4wd-pinning integration fixture' }),
  );
  const leafCidStr = cidOfBytes(leafBytes, DAG_CBOR_CODE);

  const rootBytes = toCleanUint8Array(
    dagCbor.encode({ kind: 'root', label, child: MultiformatsCID.parse(leafCidStr) }),
  );
  const rootCidStr = cidOfBytes(rootBytes, DAG_CBOR_CODE);

  const blocks = new Map<string, Uint8Array>([
    [rootCidStr, rootBytes],
    [leafCidStr, leafBytes],
  ]);

  return {
    rootCid: rootCidStr,
    blocks,
    totalBytes: rootBytes.byteLength + leafBytes.byteLength,
    blockCount: blocks.size,
  };
}

/** BlockAccess 替身：內容全部來自 fixture 預先算好的 Map，get() 之外的方法整合測試流程不會
 *  呼叫到（transferDag 只讀不寫；pin 走 cluster REST，不是帳本自己的 pin），保留只為型別
 *  滿足——若真的被呼叫代表測試流程本身有誤，直接拋錯比默默回一個假值更容易抓到。 */
function createFixtureBlockAccess(blocks: ReadonlyMap<string, Uint8Array>): BlockAccess {
  return {
    async get(cid) {
      return blocks.get(cid) ?? null;
    },
    async putDagCbor(): Promise<never> {
      throw new Error(
        'fixture BlockAccess.putDagCbor：整合測試的 DAG 內容全由 fixture 預先備妥，不呼叫這個方法（僅供型別滿足）',
      );
    },
    async putRaw(): Promise<never> {
      throw new Error(
        'fixture BlockAccess.putRaw：整合測試的 DAG 內容全由 fixture 預先備妥，不呼叫這個方法（僅供型別滿足）',
      );
    },
    async pin(): Promise<never> {
      throw new Error(
        'fixture BlockAccess.pin：pinning 走 cluster REST API，不是帳本自己的 pin（僅供型別滿足）',
      );
    },
  };
}

/** 真 PinExecutor：transferDag 把完整 DAG 準備到 kubo；API server 實量複查後才 cluster.pin。
 *  （不能直接 import app/main.ts——那個檔案 import 就會立刻執行 main().catch(...) 啟動整個
 *  服務，不是一個可安全 import 的模組）。這是「管理 API 完整 /pin 流程對真 cluster」實際
 *  要驗證的組裝。 */
function buildRealPinExecutor(params: {
  readonly blocks: BlockAccess;
  readonly kubo: KuboClient;
  readonly cluster: ClusterClient;
}): PinExecutor {
  const throwIfAborted = (signal: AbortSignal): void => {
    if (signal.aborted) throw new Error('pin executor aborted');
  };
  return {
    async preparePin({ cid, sizeHintBytes, signal }) {
      throwIfAborted(signal);
      const { logicalDagBytes, newPhysicalBytes, blocks } = await transferDag({
        root: cid,
        blocks: params.blocks,
        kubo: params.kubo,
        limits: { maxBytes: Math.min(sizeHintBytes, DEFAULT_DAG_TRANSFER_LIMITS.maxBytes) },
        signal,
      });
      throwIfAborted(signal);
      return { logicalSizeBytes: logicalDagBytes, newPhysicalSizeBytes: newPhysicalBytes, blocks };
    },
    async unpin({ cid, signal }) {
      throwIfAborted(signal);
      await params.cluster.unpin(cid);
    },
  };
}

async function stubStats(): Promise<StatsBody> {
  return {
    node_id: 'integration-test-node',
    version: '0.0.0-integration',
    uptime: 0,
    total_pinned_count: 0,
    total_size_bytes: 0,
    available_space_bytes: 0,
    ipfs_cluster_peers: 0,
    last_sync_timestamp: 0,
    accepting_pins: true,
    quota_used_bytes: 0,
    quota_limit_bytes: 1024 ** 4,
  };
}

// ── 簽章：獨立於 api/api.test-support.ts 重新實作——該檔檔頭明講「僅供 api 目錄下的
// *.spec.ts 使用」，本檔不跨目錄 import 它，比照 auth.test-support.ts／api.test-support.ts
// 兩者互相獨立自成一份的既有慣例。 ──

interface TestSigner {
  readonly peerId: PeerId;
  readonly privateKey: Uint8Array;
}

function makeSigner(seed: number): TestSigner {
  const privateKey = new Uint8Array(32).fill(seed);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { peerId: publicKeyToPeerId(publicKey), privateKey };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function signBody(
  signer: TestSigner,
  payload: PinPayload | UnpinPayload,
): Promise<Record<string, unknown>> {
  const timestamp = Date.now();
  const nonce = crypto.getRandomValues(new Uint8Array(Protocol.security.P2P_MESSAGE_NONCE_BYTES));
  const message = buildSignedMessage(payload, timestamp, nonce, signer.peerId);
  const signature = ed25519.sign(message, signer.privateKey);
  return {
    payload,
    timestamp,
    nonceHex: bytesToHex(nonce),
    signer: signer.peerId,
    signatureHex: bytesToHex(signature),
  };
}

async function signedPin(
  signer: TestSigner,
  cid: string,
  opts: { category?: PinPayload['category']; sizeHintBytes?: number } = {},
): Promise<Record<string, unknown>> {
  const payload: PinPayload = {
    type: 'pinning-pin',
    cid,
    category: opts.category ?? 'part',
    sizeHintBytes: opts.sizeHintBytes ?? 0,
  };
  return signBody(signer, payload);
}

async function signedUnpin(signer: TestSigner, cid: string): Promise<Record<string, unknown>> {
  const payload: UnpinPayload = { type: 'pinning-unpin', cid };
  return signBody(signer, payload);
}

// ── 其餘小 helper ──────────────────────────────────────────────────────

/** 逐位元組比較（非長度比較）：長度先快速排除明顯不等，但真正的判定是逐一索引比對。 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 走完真 cluster 的 pinset、判斷目標 cid 在不在——cluster 是整份測試檔共用的同一個真實例，
 *  不能假設目標 cid 一定落在最前面，要走完整個串流。 */
async function clusterHasCid(cluster: ClusterClient, cid: string): Promise<boolean> {
  for await (const record of cluster.list()) {
    if (record.cid === cid) return true;
  }
  return false;
}

// ── 測試 ──────────────────────────────────────────────────────────────

describe.skipIf(!DOCKER_AVAILABLE)('整合測試：真 kubo＋真 cluster（pin-flow）', () => {
  beforeAll(() => {
    runDockerComposeOrThrow(['up', '-d', '--wait', '--wait-timeout', '90'], 110_000);
  }, 120_000);

  afterAll(() => {
    runDockerComposeOrThrow(['down', '--volumes'], 60_000);
  }, 70_000);

  it('① transferDag 搬遷 DAG 到 kubo，pin 後 cluster.list 可見完整 metadata', async () => {
    const kubo = createKuboClient(kuboApiUrl());
    const cluster = createClusterClient(clusterApiUrl());
    const fixture = makeDagFixture('case1-transfer-dag');
    const blocks = createFixtureBlockAccess(fixture.blocks);

    const result = await transferDag({ root: fixture.rootCid, blocks, kubo });
    expect(result.blockCount).toBe(fixture.blockCount);
    expect(result.logicalDagBytes).toBe(fixture.totalBytes);
    expect(result.newPhysicalBytes).toBe(fixture.totalBytes);
    expect(result.complete).toBe(true);

    const meta: PinMeta = {
      category: 'integration-fixture',
      signer: 'integration-test-signer-case1',
      logicalSizeBytes: result.logicalDagBytes,
      physicalSizeBytes: result.newPhysicalBytes,
      source: 'api',
    };
    await cluster.pin(fixture.rootCid, meta);

    // cluster 的 REST API 是以 CRDT 狀態為準的 upsert：/pins/{cid} 回應之後，pinset 的狀態
    // 已經是新的（不是排隊等背景 worker 才寫入），但仍以 poll 包一層——對真實外部服務的整合
    // 測試給自己一點餘裕，不因為極短暫的傳播延遲讓測試偶發性失敗。
    await expect
      .poll(
        async () => {
          for await (const record of cluster.list()) {
            if (record.cid === fixture.rootCid) return true;
          }
          return false;
        },
        { timeout: 10_000, interval: 250 },
      )
      .toBe(true);

    const found = await cluster.get(fixture.rootCid);
    expect(found).toBeDefined();
    expect(found?.cid).toBe(fixture.rootCid);
    expect(found?.meta.category).toBe('integration-fixture');
    expect(found?.meta.signer).toBe('integration-test-signer-case1');
    expect(found?.meta.source).toBe('api');
    expect(found?.meta.logicalSizeBytes).toBe(result.logicalDagBytes);
    expect(found?.meta.physicalSizeBytes).toBe(result.newPhysicalBytes);
  });

  it('② /pin 全流程對真 cluster → /list 有 → /unpin 後 /list 無', async () => {
    const kubo = createKuboClient(kuboApiUrl());
    const cluster = createClusterClient(clusterApiUrl());
    const fixture = makeDagFixture('case2-pin-api-flow');
    const childCid = [...fixture.blocks.keys()][1]!;
    const pinExecutor = buildRealPinExecutor({
      blocks: createFixtureBlockAccess(fixture.blocks),
      kubo,
      cluster,
    });
    const signer = makeSigner(101);

    const deps: ApiDeps = {
      config: {
        port: 0,
        auth: { authorizedSigners: [signer.peerId] },
        pinTimeoutMs: 30_000,
        provider: {
          ugcReadEnabled: true,
          ugcWriteEnabled: true,
          legalNoticeEnabled: false,
          counterNoticeEnabled: false,
          transparencyEnabled: false,
          designatedAgentRegistration: 'not-declared',
        },
      },
      quota: new QuotaLedger({
        perSignerMaxPins: 1000,
        perSignerMaxSizeGb: 50,
        globalMaxSizeTb: 5,
      }),
      cluster,
      kubo,
      denyList: { isBlacklisted: () => false },
      authDeps: { reputationOf: () => undefined, isRepeatInfringer: () => false },
      stats: stubStats,
      providerId: 'integration-provider',
      pinExecutor,
    };
    const server = createApiServer(deps);
    const base = `http://127.0.0.1:${String(await server.ready)}`;

    try {
      const pinRes = await fetch(`${base}/pin`, {
        method: 'POST',
        body: JSON.stringify(
          await signedPin(signer, fixture.rootCid, { sizeHintBytes: fixture.totalBytes }),
        ),
      });
      expect(pinRes.status).toBe(200);
      expect(await pinRes.json()).toEqual({ ok: true, cid: fixture.rootCid });

      const readRes = await fetch(`${base}/api/ugc/${fixture.rootCid}/blocks/${childCid}`);
      expect(readRes.status).toBe(200);
      expect(
        bytesEqual(new Uint8Array(await readRes.arrayBuffer()), fixture.blocks.get(childCid)!),
      ).toBe(true);

      // 應用層的可見性由上面的 root 範圍區塊讀取涵蓋；叢集層改直接問真 cluster——管理 API
      // 的公開清單端點已移除（不得列舉叢集庫存），不能用它當驗收面。
      await expect
        .poll(async () => clusterHasCid(cluster, fixture.rootCid), {
          timeout: 10_000,
          interval: 250,
        })
        .toBe(true);

      const unpinRes = await fetch(`${base}/unpin`, {
        method: 'POST',
        body: JSON.stringify(await signedUnpin(signer, fixture.rootCid)),
      });
      expect(unpinRes.status).toBe(200);
      expect(await unpinRes.json()).toEqual({ ok: true, cid: fixture.rootCid });
      expect((await fetch(`${base}/api/ugc/${fixture.rootCid}/blocks/${childCid}`)).status).toBe(
        404,
      );

      await expect
        .poll(async () => clusterHasCid(cluster, fixture.rootCid), {
          timeout: 10_000,
          interval: 250,
        })
        .toBe(false);
    } finally {
      await server.close();
    }
  });

  it('③ 配額拒絕路徑：真 QuotaLedger 對真 cluster，同一 signer 第二筆不同 cid 回 507', async () => {
    const kubo = createKuboClient(kuboApiUrl());
    const cluster = createClusterClient(clusterApiUrl());
    const fixtureA = makeDagFixture('case3-quota-a');
    const fixtureB = makeDagFixture('case3-quota-b');
    const pinExecutor = buildRealPinExecutor({
      blocks: createFixtureBlockAccess(new Map([...fixtureA.blocks, ...fixtureB.blocks])),
      kubo,
      cluster,
    });
    const signer = makeSigner(102);

    const deps: ApiDeps = {
      config: {
        port: 0,
        auth: { authorizedSigners: [signer.peerId] },
        pinTimeoutMs: 30_000,
        provider: {
          ugcReadEnabled: true,
          ugcWriteEnabled: true,
          legalNoticeEnabled: false,
          counterNoticeEnabled: false,
          transparencyEnabled: false,
          designatedAgentRegistration: 'not-declared',
        },
      },
      // perSignerMaxPins=1：這個 signer 的第一筆 pin 就把件數上限用滿，第二筆是不同 cid
      // （不會落進 handlePin 的「re-pin 同一 cid＝冪等短路」分支），quota.admit 一定判
      // signer-pins——用真 QuotaLedger 的 admit()／recordPin() 邏輯，不是 stub 假裝的判決。
      quota: new QuotaLedger({ perSignerMaxPins: 1, perSignerMaxSizeGb: 50, globalMaxSizeTb: 5 }),
      cluster,
      kubo,
      denyList: { isBlacklisted: () => false },
      authDeps: { reputationOf: () => undefined, isRepeatInfringer: () => false },
      stats: stubStats,
      providerId: 'integration-provider',
      pinExecutor,
    };
    const server = createApiServer(deps);
    const base = `http://127.0.0.1:${String(await server.ready)}`;

    try {
      const res1 = await fetch(`${base}/pin`, {
        method: 'POST',
        body: JSON.stringify(
          await signedPin(signer, fixtureA.rootCid, { sizeHintBytes: fixtureA.totalBytes }),
        ),
      });
      expect(res1.status).toBe(200);

      const res2 = await fetch(`${base}/pin`, {
        method: 'POST',
        body: JSON.stringify(
          await signedPin(signer, fixtureB.rootCid, { sizeHintBytes: fixtureB.totalBytes }),
        ),
      });
      expect(res2.status).toBe(507);
      expect(await res2.json()).toEqual({ error: 'QUOTA_EXCEEDED', reason: 'signer-pins' });
    } finally {
      await server.close();
    }
  });
});
