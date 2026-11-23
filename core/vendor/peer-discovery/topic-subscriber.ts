/**
 * GossipSub 簽章收發 glue — 發送＝簽章封裝後上 topic、接收＝驗簽（簽章／時戳
 * ±30s／nonce 防重放）＋rate limit 全過才交 handler；畸形訊息靜默丟棄。
 * wire 編碼＝dag-cbor（SignedPayload 含 Uint8Array 欄位，JSON 無法無損往返；
 * dag-cbor 為本專案既有 canonical 序列化）。pubsub 介面比照 libp2p services.pubsub
 * 事件面（接線期直接餵入）；trustedPeers＝呼叫端維護的活引用（大廳＝已連線
 * peers、房間＝成員白名單）。分工：本層限流在驗簽後以 signer 計（authenticated、
 * 防單一身分洗版）；傳輸層洪泛（驗簽前的 CPU 面）由 gossipsub 自身 peer score
 * 與 behaviourPenalty 承擔。
 */
import * as dagCbor from '@ipld/dag-cbor';
import type { PeerId, SignedPayload } from '@open4wd/interfaces';
import { Network, Protocol } from '@open4wd/system-constants';
import { verifyP2PMessageAuthenticity } from '../security';
import { TopicRateLimiter } from './rate-limiter';
import { GossipGlobalAdmission, SourceNonceRegistry } from './source-admission';
import type { Topic, TopicNamespace } from './topics';

/** libp2p pubsub 服務的最小面（接線期以真實例餵入、測試以假件） */
export interface PubSubLike {
  /** @param topic 要加入的正式 topic。 */
  subscribe(topic: string): void;
  /** @param topic 要離開的正式 topic。 */
  unsubscribe?(topic: string): void;
  /**
   * @param topic 目的 topic。
   * @param data dag-cbor bytes。
   * @param sourceHint 記憶體測試 adapter 用的來源提示；真實 libp2p 會忽略並自行驗證來源。
   * @returns 發送完成或 void。
   */
  publish(topic: string, data: Uint8Array, sourceHint?: PeerId): void | Promise<unknown>;
  /** @param type 固定為 message。 @param listener 訊息 listener。 */
  addEventListener(
    type: 'message',
    listener: (event: { detail: PubSubMessageDetail }) => void,
  ): void;
  /** @param type 固定為 message。 @param listener 原先註冊的 listener。 */
  removeEventListener?(
    type: 'message',
    listener: (event: { detail: PubSubMessageDetail }) => void,
  ): void;
}

/** GossipSub 已驗證的訊息來源；真實 libp2p 為 PeerId object，測試可用字串。 */
export type PubSubMessageSource = string | { toString(): string };

/** PubSub message event 的 admission 所需最小欄位。 */
export interface PubSubMessageDetail {
  topic: string;
  data: Uint8Array;
  from: PubSubMessageSource;
}

/** 簽章器最小面（Open4wdKeyManager.signPayload 直接符合） */
export interface PayloadSigner {
  /** @param payload 要簽章的 payload。 @returns 含時戳、nonce、signer 與簽章的 envelope。 */
  signPayload<T>(payload: T): Promise<SignedPayload<T>>;
}

/** 覆寫 per-source 與 global admission 容量的測試／部署選項。 */
export interface TopicSubscriberOptions {
  /** 測試／特殊部署覆寫；省略採正式常數。 */
  rateWindowMs?: number;
  /** 測試／特殊部署覆寫；省略採正式常數。 */
  rateMaxPerWindow?: number;
  /** 同時追蹤的 signer/topic counter 上限。 */
  rateMaxCounters?: number;
}

/** GossipSub 的 topic allowlist、schema、簽章、重放與限流 admission boundary。 */
export class TopicSubscriber {
  /** 按 authenticated transport source 分隔的 replay nonce registry。 */
  private readonly nonceRegistry: SourceNonceRegistry;
  /** 驗簽後按來源跨 topic 聚合的訊息配額。 */
  private readonly rateLimiter: TopicRateLimiter;
  /** 驗簽前限制 bytes/messages/verification CPU 的全域配額。 */
  private readonly globalAdmission: GossipGlobalAdmission;
  /** 每個正式 topic 已註冊的已驗證訊息 handlers。 */
  private readonly handlers = new Map<Topic, Set<(message: SignedPayload<unknown>) => void>>();

  /**
   * 建立 GossipSub admission boundary。
   *
   * @param pubsub libp2p pubsub 服務。
   * @param signer 本機 payload 簽章器。
   * @param trustedPeers 接收端允許的 signer 活引用集合。
   * @param now 本機牆鐘毫秒提供者。
   * @param options 可選的限流上限覆寫。
   */
  constructor(
    /** 真實或測試 pubsub 服務的最小事件與發布介面。 */
    private readonly pubsub: PubSubLike,
    /** 為出向 payload 產生 canonical SignedPayload 的本機 signer。 */
    private readonly signer: PayloadSigner,
    /** 允許接收的 signer 活集合；陌生 signaling provider 可提供驗章型集合。 */
    private readonly trustedPeers: ReadonlySet<PeerId>,
    readonly topics: TopicNamespace,
    /** 驗證訊息時效與 admission 窗口使用的牆鐘。 */
    private readonly now: () => number = Date.now,
    options: TopicSubscriberOptions = {},
  ) {
    this.nonceRegistry = new SourceNonceRegistry(
      now,
      Network.peerDiscovery.GOSSIP_SOURCE_STATES_MAX,
      Network.peerDiscovery.GOSSIP_NONCES_PER_SOURCE_MAX,
    );
    this.rateLimiter = new TopicRateLimiter(
      now,
      options.rateWindowMs ?? Network.peerDiscovery.TOPIC_RATE_WINDOW_MS,
      options.rateMaxPerWindow ?? Network.peerDiscovery.TOPIC_RATE_MAX_PER_WINDOW,
      options.rateMaxCounters ?? Network.peerDiscovery.TOPIC_RATE_COUNTERS_MAX,
    );
    this.globalAdmission = new GossipGlobalAdmission(
      now,
      Network.peerDiscovery.GOSSIP_GLOBAL_WINDOW_MS,
      Network.peerDiscovery.GOSSIP_GLOBAL_RAW_BYTES_MAX,
      Network.peerDiscovery.GOSSIP_GLOBAL_RAW_MESSAGES_MAX,
      Network.peerDiscovery.GOSSIP_GLOBAL_VERIFICATIONS_MAX,
    );
    this.pubsub.addEventListener('message', this.handleEvent);
  }

  /**
   * 訂閱正式 topic；handler 只收完整通過 admission 的訊息。
   *
   * @param topic rooms、matchmaking 或 scoped signaling 正式 topic。
   * @param handler 接收已驗簽且已收錄 nonce 的訊息。
   * @returns 解除 listener 與 topic 訂閱的函式。
   * @throws topic 不在 allowlist 時拋出 RangeError。
   */
  subscribe<T>(topic: string, handler: (message: SignedPayload<T>) => void): () => void {
    if (!this.topics.isAllowed(topic)) throw new RangeError(`unsupported gossip topic: ${topic}`);
    const existing = this.handlers.get(topic) ?? new Set();
    if (existing.size === 0) this.pubsub.subscribe(topic);
    const erased = handler as (message: SignedPayload<unknown>) => void;
    existing.add(erased);
    this.handlers.set(topic, existing);
    return () => {
      const current = this.handlers.get(topic);
      if (current === undefined) return;
      current.delete(erased);
      if (current.size > 0) return;
      this.handlers.delete(topic);
      this.pubsub.unsubscribe?.(topic);
    };
  }

  /** 依序執行大小、解碼、schema、來源綁定、驗簽、限流與 replay admission。 */
  private readonly handleEvent = (event: { detail: PubSubMessageDetail }): void => {
    const topic = event.detail.topic;
    if (!this.topics.isAllowed(topic)) return;
    const handlers = this.handlers.get(topic);
    if (handlers === undefined || handlers.size === 0) return;
    if (event.detail.data.byteLength > Network.peerDiscovery.GOSSIP_MESSAGE_MAX_BYTES) return;
    if (!this.globalAdmission.admitRaw(event.detail.data.byteLength)) return;
    let decoded: unknown;
    try {
      decoded = dagCbor.decode(event.detail.data);
    } catch {
      return; // 畸形編碼＝丟棄
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return;
    const signed = decoded as SignedPayload<unknown>;
    if (!this.topics.isValidPayload(topic, signed.payload)) return;
    const source = normalizeSource(event.detail.from);
    if (source === null || source !== signed.signer) return;
    if (!this.globalAdmission.admitVerification()) return;
    const verified = verifyP2PMessageAuthenticity(signed, this.trustedPeers, this.now);
    if (!verified.ok) return;
    if (this.nonceRegistry.has(source, signed.nonce)) return;
    // 來源綁定與驗簽後才配置狀態；超量 unique nonce 不灌 replay registry。
    if (!this.rateLimiter.shouldAccept(source, topic)) return;
    if (!this.nonceRegistry.commit(source, signed.nonce, signed.timestamp)) return;
    for (const handler of [...handlers]) handler(signed);
  };

  /**
   * 簽章、編碼並發布 payload；出向也套用同一 allowlist/schema/bytes 上限。
   *
   * @param topic allowlist 內的正式 topic。
   * @param payload 符合 topic schema 的 payload。
   * @returns pubsub 發送完成後 resolve。
   * @throws topic、payload 或編碼大小不符合 admission 時拋出 RangeError。
   */
  async publish<T>(topic: string, payload: T): Promise<void> {
    await this.publishSigned(topic, payload);
  }

  /**
   * 簽章、編碼並發布 payload，並回傳出向 envelope 供本機 optimistic delivery 使用。
   *
   * @param topic 正式 allowlist topic。
   * @param payload 符合 topic schema 的 payload。
   * @returns pubsub 發送完成後的簽章 envelope。
   * @throws topic、payload、sender 綁定或編碼大小不符合 admission 時拋出 RangeError。
   */
  async publishSigned<T>(topic: string, payload: T): Promise<SignedPayload<T>> {
    if (!this.topics.isAllowed(topic)) throw new RangeError(`unsupported gossip topic: ${topic}`);
    if (!this.topics.isValidPayload(topic, payload)) throw new RangeError('invalid gossip payload');
    const signed = await this.signer.signPayload(payload);
    if (!this.topics.isValidPayload(topic, payload))
      throw new RangeError('gossip payload identity mismatch');
    const encoded = dagCbor.encode(signed);
    if (encoded.byteLength > Network.peerDiscovery.GOSSIP_MESSAGE_MAX_BYTES)
      throw new RangeError('gossip message exceeds byte limit');
    // cborg 的 Buffer 快路徑輸出跨 realm 不被下游位元組驗證認可——零拷貝重包本 realm 視圖
    await this.pubsub.publish(
      topic as Topic,
      new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
      signed.signer,
    );
    return signed;
  }
}

function normalizeSource(source: PubSubMessageSource): PeerId | null {
  let value: string;
  try {
    value = typeof source === 'string' ? source : source.toString();
  } catch {
    return null;
  }
  if (value.length === 0 || value.length > Protocol.security.P2P_MESSAGE_SIGNER_MAX_CHARS)
    return null;
  return value as PeerId;
}
