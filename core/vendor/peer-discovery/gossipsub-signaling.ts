/**
 * GossipSub signaling fallback（純 P2P）——SignalMessage 以 SignedPayload 封包，
 * 在 canonical scope topic 廣播並由收端依 target 過濾。取捨是以部分頻寬換取
 * 零 signaling 基礎設施；房間 presence／發現則由 room topic 的簽章租約處理。
 */
import type {
  PeerId,
  Result,
  SignalMessage,
  SignalingProvider,
  SignalingSession,
  SignedPayload,
} from '@open4wd/interfaces';
import { err, ok } from '@open4wd/interfaces';
import { TopicSubscriber, type PayloadSigner, type PubSubLike } from './topic-subscriber';
import type { TopicNamespace } from './topics';
import { isSignalingScope } from '../signaling-service/signal-envelope';

/** canonical scope topic 上的 signaling 封包。 */
export interface SignalRelayPayload {
  type: 'signal-v1';
  scope: string;
  target: PeerId;
  message: SignalMessage;
}

interface GossipSessionState {
  readonly localPeerId: PeerId;
  readonly scope: string;
  readonly handlers: Set<
    (from: PeerId, message: SignalMessage, meta: { readonly nonce: string }) => void
  >;
  readonly seen: Set<string>;
  readonly seenOrder: string[];
  open: boolean;
}

/** 以 canonical GossipSub scope topic 提供純 P2P signaling fallback。 */
export class GossipsubSignalingProvider implements SignalingProvider {
  readonly providerId = 'gossipsub';
  readonly providerName = 'GossipSub';
  readonly priority: number;

  /** 防止 pubsub 尚未可用時開出無法送達的 session。 */
  private readonly isReady: () => boolean;
  constructor(
    /** 負責 topic schema、簽章、限流與 nonce admission 的收發器。 */
    private readonly subscriber: TopicSubscriber,
    options: { priority?: number; isReady?: () => boolean } = {},
  ) {
    this.priority = options.priority ?? 2;
    this.isReady = options.isReady ?? (() => true);
  }

  /** 建立指定房間的 GossipSub 信令工作階段，隔離 topic、訂閱與關閉生命週期。 */
  async openSession(input: {
    readonly localPeerId: PeerId;
    readonly scope: string;
  }): Promise<Result<SignalingSession>> {
    if (!isSignalingScope(input.scope)) return err(new Error('GossipSub scope 無效'));
    if (!this.isReady()) return err(new Error('GossipSub 尚未就緒'));
    const topic = this.subscriber.topics.signaling(input.scope);
    const state: GossipSessionState = {
      localPeerId: input.localPeerId,
      scope: input.scope,
      handlers: new Set(),
      seen: new Set(),
      seenOrder: [],
      open: true,
    };
    const unsubscribe = this.subscriber.subscribe<SignalRelayPayload>(topic, (signed) =>
      this.dispatch(state, signed),
    );
    return ok({
      providerId: this.providerId,
      scope: input.scope,
      send: async (target, message) => {
        if (!state.open) return err(new Error('GossipSub session 已關閉'));
        try {
          await this.subscriber.publishSigned<SignalRelayPayload>(topic, {
            type: 'signal-v1',
            scope: input.scope,
            target,
            message,
          });
          return ok(undefined);
        } catch (error) {
          return err(new Error(`gossip 發送失敗: ${String(error)}`));
        }
      },
      onMessage: (handler) => {
        state.handlers.add(handler);
        return () => state.handlers.delete(handler);
      },
      close: () => {
        state.open = false;
        state.handlers.clear();
        unsubscribe();
        return Promise.resolve();
      },
    });
  }

  /** 依 scope/target 過濾、去重後把已驗簽訊息送入 session handlers。 */
  private dispatch(session: GossipSessionState, signed: SignedPayload<SignalRelayPayload>): void {
    if (signed.payload.type !== 'signal-v1') return;
    const nonceHex = Array.from(signed.nonce, (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
    if (
      !session.open ||
      signed.payload.scope !== session.scope ||
      signed.payload.target !== session.localPeerId
    )
      return;
    const key = `${signed.signer} ${nonceHex}`;
    if (session.seen.has(key)) return;
    session.seen.add(key);
    session.seenOrder.push(key);
    if (session.seenOrder.length > 4096) {
      const oldest = session.seenOrder.shift();
      if (oldest !== undefined) session.seen.delete(oldest);
    }
    for (const handler of [...session.handlers])
      handler(signed.signer, signed.payload.message, { nonce: nonceHex });
  }

  /** 判斷底層節點、topic 訂閱與最近錯誤是否仍允許建立信令工作階段。 */
  async isHealthy(): Promise<boolean> {
    return this.isReady();
  }
}

/** 陌生玩家 signaling 用工廠：仍強制 PeerId 公鑰簽章／時戳／nonce，只不預設白名單。 */
export function createGossipsubSignalingProvider(
  pubsub: PubSubLike,
  signer: PayloadSigner,
  topics: TopicNamespace,
  now: () => number = Date.now,
): GossipsubSignalingProvider {
  const cryptographicTrust = {
    has: () => true,
    size: 0,
    [Symbol.iterator]: function* (): Iterator<PeerId> {
      // verifyP2PMessageAuthenticity 只查 has；PeerId 仍須能解出且驗過簽章。
    },
  } as unknown as ReadonlySet<PeerId>;
  return new GossipsubSignalingProvider(
    new TopicSubscriber(pubsub, signer, cryptographicTrust, topics, now),
  );
}
