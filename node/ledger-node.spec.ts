/**
 * in-process 雙節點複寫——證明 vendored 棧在 Node 下真的能起、能連、能複寫：兩個
 * headless ledger node 以 @libp2p/memory 傳輸互連（bootstrap 指向對方既有 listen
 * multiaddr），節點 a 附加一筆合法事件，輪詢節點 b 的帳本讀取面直到看見該事件。
 *
 * `testConfig` 回傳 config＋peerId 兩者（而非只回 config）：libp2p 私鑰的確定性衍生
 * （`libp2pPrivateKeyFromSeed`）本身是非同步 API，故本輔助函式亦非同步；`LedgerNode`
 * 的公開介面刻意不曝露 peerId，`appendTestEvent` 需要它來滿足 `ugc-maintenance` 事件
 * schema 的 `payer === peerId`
 * 收件規則，故由呼叫端一併保留。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memory } from '@libp2p/memory';
import {
  createBlockAccess,
  libp2pPrivateKeyFromSeed,
  Protocol,
  publicKeyToPeerId,
  type BlockAccess,
  type Open4wdLedgerOptions,
  type PeerId,
} from '../core';
import { startLedgerNode, type LedgerNode, type LedgerNodeConfig } from './ledger-node';

/**
 * 零工作量 admission scheme（baseBits/maxExtraBits＝0 ⇒ requiredBits 恆 0），與主棧測試慣例
 * 一致：讓 PoW 挖礦立即完成、輪詢視窗只花在啟動與複寫，避免逼近逾時。兩節點皆傳同值——否
 * 則收件端會 fallback 到 Admission v1 而拒收對方以零工作量 scheme 挖出的條目。
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

/** BaseEvent 型別借道 Open4wdLedgerOptions 萃取——同 ledger-node.ts 手法，避免繞過 barrel 直 import vendor。 */
type LedgerEventBase = Parameters<NonNullable<Open4wdLedgerOptions['validateIncoming']>>[0];
type ContentCid = Awaited<ReturnType<BlockAccess['putDagCbor']>>;

/**
 * 最小合法事件——vendored `LEDGER_EVENT_TYPES` 是封閉目錄、`isExactLedgerEvent` 逐型別
 * 驗深層 schema（見 core/vendor/ledger/ledger-admission.ts、ledger-event-schema.ts）：
 * 隨意型別字串或多餘/缺漏欄位會在 OrbitDB access-controller 層被拒收。`ugc-maintenance`
 * 是型別目錄中欄位最少的單簽事件（cid／payer／burnAmount／reason 四欄，payer 須等於
 * 簽署者 peerId、burnAmount 允許 0n）。
 */
interface TestUgcMaintenanceEvent extends LedgerEventBase {
  readonly type: 'ugc-maintenance';
  readonly cid: ContentCid;
  readonly payer: PeerId;
  readonly burnAmount: bigint;
  readonly reason: 'retire' | 'renew' | 'unretire';
}

function seedFor(label: 'a' | 'b'): Uint8Array {
  const seed = new Uint8Array(32);
  seed.fill(label.charCodeAt(0));
  return seed;
}

interface TestNodeSetup {
  readonly config: LedgerNodeConfig;
  readonly peerId: PeerId;
}

async function testConfig(label: 'a' | 'b', peer?: LedgerNode): Promise<TestNodeSetup> {
  const privateKey = await libp2pPrivateKeyFromSeed(seedFor(label));
  const peerId = publicKeyToPeerId(privateKey.publicKey.raw);
  const config: LedgerNodeConfig = {
    dataDir: mkdtempSync(join(tmpdir(), `o4wd-ledger-node-${label}-`)),
    privateKey,
    listen: [`/memory/ledger-node-test-${label}`],
    // bootstrap 指向對方目前實際 listen 的完整 multiaddr（含 peerId 後綴，libp2p 自動附加）。
    bootstrap:
      peer === undefined ? [] : peer.libp2p.getMultiaddrs().map((address) => address.toString()),
    relayEnabled: false,
    extraTransports: [memory()],
    admissionScheme: TEST_ADMISSION_SCHEME,
  };
  return { config, peerId };
}

async function appendTestEvent(node: LedgerNode, peerId: PeerId): Promise<void> {
  const blocks = createBlockAccess(node.ipfs);
  const cid = await blocks.putDagCbor(new TextEncoder().encode('ledger-node.spec test payload'));
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

describe('startLedgerNode', () => {
  // vitest 預設單測 5s 逾時遠短於 expect.poll 自身的 20s 窗——兩顆節點啟動＋輪詢複寫都算進
  // 同一筆測試，外層逾時須至少涵蓋 poll 視窗本身。
  it('兩個 in-process 節點可互連並複寫一筆事件', async () => {
    const setupA = await testConfig('a');
    const a = await startLedgerNode(setupA.config);
    nodes.push(a);
    const setupB = await testConfig('b', a); // b bootstrap 指向 a
    const b = await startLedgerNode(setupB.config);
    nodes.push(b);

    // @libp2p/memory 傳輸不被 @libp2p/bootstrap 的位址 matcher 收錄（故 bootstrap discovery
    // 對 memory 位址無效），與主棧真節點對測模板一致，改由測試顯式 dial 建立連線；生產走真實
    // 傳輸時 bootstrap 欄位照常生效。
    await b.libp2p.dial(a.libp2p.getMultiaddrs()[0]!, { signal: AbortSignal.timeout(5_000) });

    await appendTestEvent(a, setupA.peerId);

    await expect.poll(async () => (await eventCount(b)) >= 1, { timeout: 20_000 }).toBe(true);
  }, 25_000);

  it('transferBlocks 經 Bitswap 取 UGC 但不回填可對外供應的 ledger blockstore', async () => {
    const setupA = await testConfig('a');
    const a = await startLedgerNode(setupA.config);
    nodes.push(a);
    const setupB = await testConfig('b', a);
    const b = await startLedgerNode(setupB.config);
    nodes.push(b);
    await b.libp2p.dial(a.libp2p.getMultiaddrs()[0]!, { signal: AbortSignal.timeout(5_000) });

    const bytes = new TextEncoder().encode('root-scoped UGC must not enter generic Bitswap cache');
    const cid = await createBlockAccess(a.ipfs).putRaw(bytes);
    await expect(b.transferBlocks.get(cid, 5_000)).resolves.toEqual(bytes);

    await a.close();
    nodes.splice(nodes.indexOf(a), 1);
    await expect(createBlockAccess(b.ipfs).get(cid, 100)).resolves.toBeNull();
  }, 25_000);
});
