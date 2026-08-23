/**
 * DHT 操作 — 場地內容 provider 宣告／查找（「誰 pin 了這張場地」）與 peer 位址查找。
 * routing 面注入（runtime＝libp2p.contentRouting／peerRouting、測試＝假件）；
 * 查詢一律帶 DHT_QUERY_TIMEOUT_MS 逾時訊號。trackId 須為合法 CID 字串（來源＝
 * ledger 資產記錄；畸形輸入 CID.parse 直接拋、由呼叫端 Result 化）。
 */
import { peerIdFromString } from '@libp2p/peer-id';
import { Network } from '@open4wd/system-constants';
import { CID } from 'multiformats/cid';

/** TrackProviderHelper 使用的最小 libp2p content-routing 表面。 */
export interface ContentRoutingLike<TProvider> {
  provide(cid: CID, options?: { signal?: AbortSignal }): Promise<void>;
  findProviders(cid: CID, options?: { signal?: AbortSignal }): AsyncIterable<TProvider>;
}

/** 以有界 DHT 查詢宣告並尋找指定場地內容的 provider。 */
export class TrackProviderHelper<TProvider = unknown> {
  constructor(
    /** 實際執行 provide 與 findProviders 的 content router。 */
    private readonly routing: ContentRoutingLike<TProvider>,
    /** 每次 DHT 查詢的 AbortSignal 逾時。 */
    private readonly queryTimeoutMs: number = Network.peerDiscovery.DHT_QUERY_TIMEOUT_MS,
  ) {}

  /** 宣告本節點 pin 了 trackId 的內容 */
  async announceProvide(trackId: string): Promise<void> {
    await this.routing.provide(CID.parse(trackId), {
      signal: AbortSignal.timeout(this.queryTimeoutMs),
    });
  }

  /** 找誰有 trackId（達 limit 即提前收束） */
  async findProviders(trackId: string, options: { limit: number }): Promise<TProvider[]> {
    const providers: TProvider[] = [];
    for await (const provider of this.routing.findProviders(CID.parse(trackId), {
      signal: AbortSignal.timeout(this.queryTimeoutMs),
    })) {
      providers.push(provider);
      if (providers.length >= options.limit) break;
    }
    return providers;
  }
}

/** findPeerAddresses 使用的最小 libp2p peer-routing 表面。 */
export interface PeerRoutingLike<TAddr> {
  findPeer(
    peerId: ReturnType<typeof peerIdFromString>,
    options?: { signal?: AbortSignal },
  ): Promise<{ multiaddrs: TAddr[] }>;
}

/** 以 libp2p PeerId 字串（multihash base58btc）查 peer 可達位址 */
export async function findPeerAddresses<TAddr>(
  routing: PeerRoutingLike<TAddr>,
  libp2pPeerId: string,
  timeoutMs: number = Network.peerDiscovery.DHT_QUERY_TIMEOUT_MS,
): Promise<TAddr[]> {
  const info = await routing.findPeer(peerIdFromString(libp2pPeerId), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  return info.multiaddrs;
}
