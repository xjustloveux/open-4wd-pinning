/**
 * in-process 多節點 e2e——證明帳本複寫與自動 pin 訂閱鏈在真實節點組裝（`startLedgerNode`）
 * ＋真實 subscriber 接線（`onCheckpointAdopted → reconcileCheckpoint`）之下確實端到端接通：
 *
 * - 「客戶端 finalize 真 checkpoint → app 跨節點採納 → 三件套 auto-pin」（全鏈）：兩個
 *   `startLedgerNode` 以 @libp2p/memory 顯式互連，兩端皆顯式供給同一治理 trust root（N=1、
 *   quorum=1、signer＝客戶端 peerId，比照主 repo 跨節點 finalize→adopt 測試模板）。客戶端附加
 *   一筆合法事件、proposeCheckpoint→finalizeCheckpoint（自簽）產出真 checkpoint；app 經 OrbitDB
 *   一筆只有產生端具備 reducer 的事件、proposeCheckpoint→finalizeCheckpoint（自簽）產出真
 *   checkpoint；app 經 OrbitDB 複寫收到 announcement → 跑 quorum-follow 採納路徑（驗多簽、
 *   採納 checkpoint 內 canonical derived state，不要求本機具備該 domain reducer）→ 採納 →
 *   onCheckpointAdopted → reconcile 對記錄式 cluster 替身下 checkpoint／derived-state／signer-set
 *   三件套 auto-pin（`source==='auto'`）。採納前先斷言訂閱鏈不誤觸任何 pin。
 * - 「ws bootstrap 可達性」：app 節點開 `/ip4/127.0.0.1/tcp/0/ws` listener，另一節點以
 *   websockets transport 撥通並建立連線，收攤釋放埠。
 * - 「治理 trust root 未接線＝fail-closed」（負向控制）：①未供給 signer set 的節點連
 *   proposeCheckpoint 都被 `#authorizedSignerSet`（回 undefined）擋下——同一個閘也擋住遠端
 *   announcement 的採納；②app 明確不供給 trust root 時，客戶端 finalize 的真 checkpoint 到達也
 *   不被採納、cluster 無任何 pin。此二案是「trust root 為採納閘先決條件」的安全回歸哨兵。
 *
 * 正向案刻意令 client 與 app reducer 組合不同，是 pinning replica 不必重載整套遊戲 domain
 * registry 的正式回歸哨兵；若 node 組裝退回 full-refold，該案會因 derived state 不一致而失敗。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memory } from '@libp2p/memory';
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import {
  createBlockAccess,
  libp2pPrivateKeyFromSeed,
  Protocol,
  publicKeyToPeerId,
  type ApplierRegistry,
  type BlockAccess,
  type Open4wdLedgerOptions,
  type PeerId,
} from '../core';
import {
  startLedgerNode,
  type CheckpointAdoption,
  type LedgerNode,
  type LedgerNodeConfig,
} from '../node';
import { reconcileCheckpoint, type AdoptedCheckpoint, type ReconcileCtx } from '../subscriber';
import {
  QuotaLedger,
  type ClusterClient,
  type KuboClient,
  type PinMeta,
  type PinRecord,
} from '../pinning';

/** proposeCheckpoint 成功分支的提案型別（自公開方法回傳型別萃取，免另引 vendored 內部符號）。 */
type CheckpointProposal = Extract<
  Awaited<ReturnType<LedgerNode['ledger']['proposeCheckpoint']>>,
  { ok: true }
>['value'];

/**
 * 零工作量 admission scheme（baseBits/maxExtraBits＝0 ⇒ requiredBits 恆 0），與 node 層對測
 * 慣例一致：PoW 立即完成、輪詢視窗只花在啟動與複寫。同一帳本的節點須傳同值，否則收件端
 * 會 fallback 到 v1 而拒收對方以零工作量 scheme 挖出的條目。
 */
const TEST_ADMISSION_SCHEME: NonNullable<LedgerNodeConfig['admissionScheme']> = {
  version: 1,
  baseBits: 0,
  sizeUnitBytes: Protocol.ledger.LEDGER_ADMISSION_SIZE_UNIT_BYTES,
  maxExtraBits: 0,
  nonceBytes: Protocol.ledger.LEDGER_ADMISSION_NONCE_BYTES,
};

const nodes: LedgerNode[] = [];
afterEach(async () => {
  while (nodes.length > 0) await nodes.pop()!.close();
});

// ── ledger 事件建構（借 ledger-node.spec.ts 手法：ugc-maintenance 為欄位最少的單簽事件） ──

type LedgerEventBase = Parameters<NonNullable<Open4wdLedgerOptions['validateIncoming']>>[0];
type ContentCid = Awaited<ReturnType<BlockAccess['putDagCbor']>>;

interface TestUgcMaintenanceEvent extends LedgerEventBase {
  readonly type: 'ugc-maintenance';
  readonly cid: ContentCid;
  readonly payer: PeerId;
  readonly burnAmount: bigint;
  readonly reason: 'retire' | 'renew' | 'unretire';
}

function seedFor(label: string): Uint8Array {
  // 以整個 label 的 FNV-1a 雜湊逐位元組展開種子——若只取首字元（早期寫法），共享首字母的
  // 多字元 label（如 fc-app／fc-client）會撞出同一把 key、同一 peerId（dial self）。
  const seed = new Uint8Array(32);
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    hash = Math.imul(hash ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  for (let i = 0; i < seed.length; i++) {
    hash = Math.imul(hash ^ (hash >>> 13), 0x01000193) >>> 0;
    seed[i] = hash & 0xff;
  }
  return seed;
}

async function peerIdForSeed(label: string): Promise<PeerId> {
  const privateKey = await libp2pPrivateKeyFromSeed(seedFor(label));
  return publicKeyToPeerId(privateKey.publicKey.raw);
}

interface TestNodeSetup {
  readonly config: LedgerNodeConfig;
  readonly peerId: PeerId;
}

interface MemoryNodeOptions {
  readonly peer?: LedgerNode;
  /** 顯式治理 trust root（checkpoint 三法與採納授權）；省略＝fail-closed。 */
  readonly genesisGovernanceSigners?: ReadonlySet<PeerId>;
  readonly registry?: ApplierRegistry;
}

async function memoryNodeConfig(
  label: string,
  opts: MemoryNodeOptions = {},
): Promise<TestNodeSetup> {
  const privateKey = await libp2pPrivateKeyFromSeed(seedFor(label));
  const peerId = publicKeyToPeerId(privateKey.publicKey.raw);
  const config: LedgerNodeConfig = {
    dataDir: mkdtempSync(join(tmpdir(), `o4wd-e2e-${label}-`)),
    privateKey,
    listen: [`/memory/o4wd-e2e-${label}`],
    bootstrap:
      opts.peer === undefined
        ? []
        : opts.peer.libp2p.getMultiaddrs().map((address) => address.toString()),
    relayEnabled: false,
    extraTransports: [memory()],
    admissionScheme: TEST_ADMISSION_SCHEME,
    checkpointStartupScanTimeoutMs: 500,
    ...(opts.genesisGovernanceSigners === undefined
      ? {}
      : { genesisGovernanceSigners: opts.genesisGovernanceSigners }),
    ...(opts.registry === undefined ? {} : { registry: opts.registry }),
  };
  return { config, peerId };
}

async function appendTestEvent(node: LedgerNode, peerId: PeerId): Promise<void> {
  const blocks = createBlockAccess(node.ipfs);
  const cid = await blocks.putDagCbor(new TextEncoder().encode('e2e ledger payload'));
  const result = await node.ledger.appendEvent<TestUgcMaintenanceEvent>({
    type: 'ugc-maintenance',
    cid,
    payer: peerId,
    burnAmount: 0n,
    reason: 'renew',
  });
  if (!result.ok) throw result.error;
}

async function eventCount(node: LedgerNode): Promise<number> {
  return (await node.ledger.getAllEvents()).length;
}

/**
 * 客戶端 finalize 一個真 checkpoint（N=1 自簽）。proposeCheckpoint 無 durable 變更（僅 put 內容
 * 塊、CID 冪等），故以輪詢化解啟動期 checkpoint reconciliation 的時序，取最後一次成功提案。
 */
async function finalizeRealCheckpoint(client: LedgerNode): Promise<CheckpointProposal> {
  let proposal: CheckpointProposal | undefined;
  await expect
    .poll(
      async () => {
        const result = await client.ledger.proposeCheckpoint();
        if (result.ok) proposal = result.value;
        return result.ok;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  if (proposal === undefined) throw new Error('proposeCheckpoint 未產出提案');
  const finalized = await client.ledger.finalizeCheckpoint(proposal, [proposal.proposerSignature]);
  if (!finalized.ok) throw finalized.error;
  return proposal;
}

// ── 記錄式 pinning 替身（cluster/kubo 不碰網路；blocks 直接讀 app 真 IPFS） ──

interface RecordingCluster extends ClusterClient {
  readonly pinned: PinRecord[];
  readonly unpinned: string[];
}

interface StubPinningCtx {
  readonly ctx: ReconcileCtx;
  readonly cluster: RecordingCluster;
}

function stubPinningCtx(blocks: BlockAccess): StubPinningCtx {
  const pinned: PinRecord[] = [];
  const unpinned: string[] = [];
  const snapshot = new Map<string, PinRecord>();

  const cluster: RecordingCluster = {
    pinned,
    unpinned,
    async pin(cid: string, meta: PinMeta) {
      const record: PinRecord = { cid, meta };
      pinned.push(record);
      snapshot.set(cid, record);
    },
    async unpin(cid: string) {
      unpinned.push(cid);
      snapshot.delete(cid);
    },
    async *list() {
      for (const record of snapshot.values()) yield record;
    },
    async peers() {
      return 1;
    },
  };

  const stored = new Map<string, Uint8Array>();
  const kubo: KuboClient = {
    async blockPut(bytes: Uint8Array, codec: string) {
      const code = codec === 'raw' ? 0x55 : dagCbor.code;
      const cid = CID.createV1(code, Digest.create(0x12, sha256(bytes))).toString();
      stored.set(cid, bytes);
      return cid;
    },
    async hasBlock(cid: string) {
      return stored.has(cid);
    },
    async stats() {
      return { repoSizeBytes: 0, availableBytes: 0 };
    },
  };

  const quota = new QuotaLedger({
    perSignerMaxPins: 100,
    perSignerMaxSizeGb: 100,
    globalMaxSizeTb: 100,
  });
  return { ctx: { cluster, kubo, blocks, quota }, cluster };
}

/**
 * main.ts 的訂閱閉包形態——`onCheckpointAdopted` 回呼把採納事件（`{ cid, checkpoint }`）
 * 併成 `AdoptedCheckpoint` 交給 `reconcileCheckpoint`，串行化執行、記住上一份狀態供 diff。
 * 回傳可等待的鏈 handle，讓測試能等 reconcile 真正跑完再斷言。
 */
function wireSubscriber(
  node: LedgerNode,
  ctx: ReconcileCtx,
): {
  settled: () => Promise<void>;
  unsub: () => void;
} {
  let chain: Promise<void> = Promise.resolve();
  let prevState: Awaited<ReturnType<LedgerNode['ledger']['getDerivedState']>> | undefined;
  const onAdopt = (adoption: CheckpointAdoption): void => {
    chain = chain.then(async () => {
      const state = await node.ledger.getDerivedState();
      const cp: AdoptedCheckpoint = { ...adoption.checkpoint, cid: adoption.cid };
      await reconcileCheckpoint(ctx, cp, state, prevState);
      prevState = state;
    });
  };
  const unsub = node.onCheckpointAdopted(onAdopt);
  return { settled: () => chain, unsub };
}

async function dialPeer(from: LedgerNode, to: LedgerNode): Promise<void> {
  await from.libp2p.dial(to.libp2p.getMultiaddrs()[0]!, { signal: AbortSignal.timeout(10_000) });
}

describe('e2e：帳本複寫 → 跨節點採納 → 自動 pin 全鏈', () => {
  it('產生端含 replica 未知 domain reducer，quorum-follow 仍採納 state 並 auto-pin 三件套', async () => {
    // 治理 trust root＝客戶端 peerId（N=1、quorum=1）；app 與客戶端兩端顯式供給同一 signer set。
    const clientPeerId = await peerIdForSeed('fc-client');
    const genesisGovernanceSigners: ReadonlySet<PeerId> = new Set([clientPeerId]);

    const appSetup = await memoryNodeConfig('fc-app', { genesisGovernanceSigners });
    const app = await startLedgerNode(appSetup.config);
    nodes.push(app);
    const sourceOnlyRegistry: ApplierRegistry = {
      'ugc-maintenance': (state) => ({
        ...state,
        economy: {
          ...state.economy,
          totalBurned: state.economy.totalBurned + 1n,
        },
      }),
    };
    const clientSetup = await memoryNodeConfig('fc-client', {
      peer: app,
      genesisGovernanceSigners,
      registry: sourceOnlyRegistry,
    });
    const client = await startLedgerNode(clientSetup.config);
    nodes.push(client);
    expect(clientSetup.peerId).toBe(clientPeerId);

    // @libp2p/memory 位址不被 @libp2p/bootstrap 的 P2P matcher 收錄，改由測試顯式 dial 建立連線
    // （生產走真實傳輸時 bootstrap 欄位照常生效）——同 node/ledger-node.spec.ts。
    await dialPeer(client, app);

    // app 端以 main.ts 形態接上真 subscriber：沒有 checkpoint 被採納時不得對 cluster 下任何 pin。
    const { ctx, cluster } = stubPinningCtx(createBlockAccess(app.ipfs));
    const subscription = wireSubscriber(app, ctx);

    // 客戶端寫入一筆合法事件並等它複寫到 app（確認 mesh 已通、app 具備 fold checkpoint 所需條目）。
    await appendTestEvent(client, clientSetup.peerId);
    await expect.poll(async () => (await eventCount(app)) >= 1, { timeout: 30_000 }).toBe(true);
    await subscription.settled();
    expect(cluster.pinned, '採納前不得誤觸 pin').toHaveLength(0);

    // 客戶端 finalize 真 checkpoint → announcement 經 OrbitDB 複寫 → app 跑 vendored 採納路徑。
    const proposal = await finalizeRealCheckpoint(client);
    await expect.poll(() => cluster.pinned.length >= 3, { timeout: 30_000 }).toBe(true);
    await subscription.settled();
    subscription.unsub();

    // app 端帳本確已採納此 checkpoint（跨節點採納閘真的通過，非僅訂閱旁路）。
    const latest = await app.ledger.getLatestCheckpoint();
    expect(latest.ok).toBe(true);
    expect((await app.ledger.getDerivedState()).economy.totalBurned).toBe(1n);

    // reconcile 對 cluster 下的正是 checkpoint→derived-state→signer-set 三件套、全 source=auto、無 unpin。
    expect(cluster.pinned.map((record) => record.cid)).toEqual([
      latest.ok ? latest.value : '',
      proposal.checkpoint.derived_state_cid,
      proposal.checkpoint.signer_set_cid,
    ]);
    expect(new Set(cluster.pinned.map((record) => record.meta.source))).toEqual(new Set(['auto']));
    expect(cluster.unpinned).toHaveLength(0);
  }, 60_000);
});

describe('e2e：ws bootstrap 可達性', () => {
  it('app 節點 ws listener 可被另一節點以 websockets transport 撥通並建立連線', async () => {
    const appPrivateKey = await libp2pPrivateKeyFromSeed(seedFor('w'));
    const app = await startLedgerNode({
      dataDir: mkdtempSync(join(tmpdir(), 'o4wd-e2e-ws-app-')),
      privateKey: appPrivateKey,
      listen: ['/ip4/127.0.0.1/tcp/0/ws'],
      bootstrap: [],
      relayEnabled: false,
      checkpointStartupScanTimeoutMs: 500,
    });
    nodes.push(app);

    const wsAddress = app.libp2p
      .getMultiaddrs()
      .map((address) => address.toString())
      .find((address) => address.includes('/ws'));
    expect(wsAddress, 'app 節點應公告一個 ws multiaddr').toBeDefined();

    const clientPrivateKey = await libp2pPrivateKeyFromSeed(seedFor('x'));
    const client = await startLedgerNode({
      dataDir: mkdtempSync(join(tmpdir(), 'o4wd-e2e-ws-client-')),
      privateKey: clientPrivateKey,
      listen: [],
      bootstrap: [],
      relayEnabled: false,
      checkpointStartupScanTimeoutMs: 500,
    });
    nodes.push(client);

    await client.libp2p.dial(app.libp2p.getMultiaddrs()[0]!, {
      signal: AbortSignal.timeout(15_000),
    });

    const appPeerId = app.libp2p.peerId.toString();
    await expect
      .poll(
        () => client.libp2p.getConnections().some((c) => c.remotePeer.toString() === appPeerId),
        {
          timeout: 15_000,
        },
      )
      .toBe(true);
    const clientPeerId = client.libp2p.peerId.toString();
    expect(app.libp2p.getConnections().some((c) => c.remotePeer.toString() === clientPeerId)).toBe(
      true,
    );
  }, 45_000);
});

describe('e2e：治理 trust root 未接線＝fail-closed（負向控制）', () => {
  it('未供給 trust root 的節點無法提案 checkpoint', async () => {
    const setup = await memoryNodeConfig('nc-solo');
    const node = await startLedgerNode(setup.config);
    nodes.push(node);

    await appendTestEvent(node, setup.peerId);

    // genesis signer set 為空：本地 checkpoint 三法與跨節點採納共用同一 fail-closed authority。
    const proposed = await node.ledger.proposeCheckpoint();
    expect(proposed.ok).toBe(false);
    expect(proposed.ok ? '' : proposed.error.message).toContain('signer set 只允許');
  }, 30_000);

  it('app 未供給 trust root 時，客戶端 finalize 的真 checkpoint 到達也不被採納、cluster 無任何 pin', async () => {
    // 客戶端具 trust root（可 finalize）；app 明確不供給＝空 genesis signer set 令採納 fail closed。
    const clientPeerId = await peerIdForSeed('nc-client');
    const clientSignerSet: ReadonlySet<PeerId> = new Set([clientPeerId]);

    const appSetup = await memoryNodeConfig('nc-app'); // 無 genesis trust root
    const app = await startLedgerNode(appSetup.config);
    nodes.push(app);
    const clientSetup = await memoryNodeConfig('nc-client', {
      peer: app,
      genesisGovernanceSigners: clientSignerSet,
    });
    const client = await startLedgerNode(clientSetup.config);
    nodes.push(client);

    await dialPeer(client, app);

    const { ctx, cluster } = stubPinningCtx(createBlockAccess(app.ipfs));
    const subscription = wireSubscriber(app, ctx);

    await appendTestEvent(client, clientSetup.peerId);
    await expect.poll(async () => (await eventCount(app)) >= 1, { timeout: 30_000 }).toBe(true);

    await finalizeRealCheckpoint(client);

    // announcement 經 OrbitDB 複寫抵達 app（base event 已證明 mesh 通、同路複寫）。app 無 trust root
    // ＝採納嘗試在 signer set 閘終局拒收（不重試），故給複寫＋採納嘗試充裕窗後其狀態不再改變。
    // 正向全鏈案已證明兩端具 trust root 時區塊抓取與採納可成，故此處未採納純因缺 trust root。
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await subscription.settled();
    subscription.unsub();

    expect((await app.ledger.getLatestCheckpoint()).ok).toBe(false);
    expect(cluster.pinned).toHaveLength(0);
    expect(cluster.unpinned).toHaveLength(0);
  }, 60_000);
});
