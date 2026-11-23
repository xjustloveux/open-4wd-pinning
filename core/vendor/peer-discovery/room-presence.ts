import type { PeerId, Unsubscribe } from '@open4wd/interfaces';
import {
  RoomDiscoveryTable,
  ROOM_PRESENCE_LEASE_TTL_MS,
  ROOM_REANNOUNCE_INTERVAL_MS,
} from './room-discovery';
import type { RoomTopicPayload } from './topics';
import type { TopicSubscriber } from './topic-subscriber';
import type { RoomId } from '../room-identity';

/** GossipRoomPresence 的可測試週期計時器埠。 */
export interface RoomPresenceTimers {
  setInterval(handler: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

/** 啟動 host 公告或 joiner presence 租約所需的完整 context。 */
export interface GossipRoomPresenceInput {
  readonly subscriber: Pick<TopicSubscriber, 'subscribe' | 'publishSigned' | 'topics'>;
  readonly table: RoomDiscoveryTable;
  readonly roomId: RoomId;
  readonly localPeerId: PeerId;
  readonly hostPeerId: PeerId;
  readonly hostDetails?: {
    readonly signalingEndpoint: string | null;
    readonly clientVersion: string;
    readonly snapshot: () => Pick<
      Extract<RoomTopicPayload, { type: 'room-announce' }>,
      | 'trackId'
      | 'playerCount'
      | 'maxPlayers'
      | 'visibility'
      | 'quickMatchEnabled'
      | 'participantPasswordRequired'
      | 'state'
      | 'ratingAnchorX1000'
    >;
  };
  readonly now?: () => number;
  readonly timers?: RoomPresenceTimers;
  readonly onVisibilityChange?: (handler: (visible: boolean) => void) => Unsubscribe;
}

const DEFAULT_TIMERS: RoomPresenceTimers = {
  setInterval: (handler, milliseconds) => globalThis.setInterval(handler, milliseconds),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

function onBrowserVisibilityChange(handler: (visible: boolean) => void): Unsubscribe {
  if (typeof document === 'undefined') return () => undefined;
  const listener = (): void => handler(document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

/**
 * 房間 joiner 的 Gossip presence 租約。建立時立即發布、每 30 秒刷新、回前景補刷新，
 * 關閉時發布 signed leave；房主身分與排序一律由已驗簽的 RoomDiscoveryTable announcement 決定。
 */
export class GossipRoomPresence {
  /** 管理週期刷新工作的計時器實作。 */
  private readonly timers: RoomPresenceTimers;
  /** 解除 rooms topic 接收訂閱的回呼。 */
  private readonly unsubscribe: Unsubscribe;
  /** 解除瀏覽器前景狀態監聽的回呼。 */
  private readonly unsubscribeVisibility: Unsubscribe;
  /** 週期重發租約的 interval handle。 */
  private readonly interval: unknown;
  /** 序列化中的發布尾端，避免 refresh 彼此越序。 */
  private pending: Promise<void> = Promise.resolve();
  /** 非強制刷新可再次送出租約的最早時間。 */
  private nextRefreshAt = Number.NEGATIVE_INFINITY;
  /** 關閉後阻止任何新發布的生命週期旗標。 */
  private closed = false;

  /** 使用 open 工廠建立，確保首次租約失敗時能完整釋放訂閱與計時器。 */
  private constructor(
    /** room、身分、subscriber 與可選 host 公告來源。 */
    private readonly input: GossipRoomPresenceInput,
  ) {
    this.timers = input.timers ?? DEFAULT_TIMERS;
    this.unsubscribe = input.subscriber.subscribe<RoomTopicPayload>(
      input.subscriber.topics.rooms,
      (message) => input.table.handleMessage(message),
    );
    this.interval = this.timers.setInterval(() => {
      void this.refresh();
    }, ROOM_REANNOUNCE_INTERVAL_MS);
    this.unsubscribeVisibility = (input.onVisibilityChange ?? onBrowserVisibilityChange)(
      (visible) => {
        if (visible) void this.refresh(true);
      },
    );
  }

  /** 開啟房間 presence topic、發布本機公告並開始追蹤遠端成員。 */
  static async open(input: GossipRoomPresenceInput): Promise<GossipRoomPresence> {
    const presence = new GossipRoomPresence(input);
    try {
      await presence.refresh();
      return presence;
    } catch (error) {
      presence.closed = true;
      presence.timers.clearInterval(presence.interval);
      presence.unsubscribeVisibility();
      presence.unsubscribe();
      throw error;
    }
  }

  get peers(): readonly PeerId[] {
    return this.input.table.peerIds(this.input.roomId);
  }

  /** 訂閱新成員加入目前房間的事件並回傳解除監聽函式。 */
  onPeerJoined(handler: (peer: PeerId) => void): Unsubscribe {
    return this.input.table.onPeerJoined(this.input.roomId, handler);
  }

  /** 訂閱成員離開或 presence 過期事件並回傳解除監聽函式。 */
  onPeerLeft(handler: (peer: PeerId) => void): Unsubscribe {
    return this.input.table.onPeerLeft(this.input.roomId, handler);
  }

  /** 停止公告、解除 topic 訂閱並清除目前房間的成員狀態。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.timers.clearInterval(this.interval);
    this.unsubscribeVisibility();
    try {
      await this.pending;
      const payload: RoomTopicPayload =
        this.input.hostDetails === undefined
          ? {
              type: 'room-presence-left',
              roomId: this.input.roomId,
              peerId: this.input.localPeerId,
              hostPeerId: this.input.hostPeerId,
            }
          : {
              type: 'room-close',
              roomId: this.input.roomId,
              reason: 'host-left',
            };
      const signed = await this.input.subscriber.publishSigned<RoomTopicPayload>(
        this.input.subscriber.topics.rooms,
        payload,
      );
      this.input.table.handleMessage(signed);
    } finally {
      this.unsubscribe();
    }
  }

  /** 依角色發布新租約並將本機 optimistic copy 送入 discovery table。 */
  private refresh(force = false): Promise<void> {
    if (this.closed) return this.pending;
    const requestedAt = (this.input.now ?? Date.now)();
    if (!force && requestedAt < this.nextRefreshAt) return this.pending;
    this.nextRefreshAt = requestedAt + ROOM_REANNOUNCE_INTERVAL_MS;
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        if (this.closed) return;
        const host = this.input.hostDetails;
        const payload: RoomTopicPayload =
          host === undefined
            ? {
                type: 'room-presence',
                roomId: this.input.roomId,
                peerId: this.input.localPeerId,
                hostPeerId: this.input.hostPeerId,
                ttl: ROOM_PRESENCE_LEASE_TTL_MS,
              }
            : {
                type: 'room-announce',
                roomId: this.input.roomId,
                hostPeerId: this.input.hostPeerId,
                signalingEndpoint: host.signalingEndpoint,
                gossipSignaling: true,
                clientVersion: host.clientVersion,
                ...host.snapshot(),
                startsAt: (this.input.now ?? Date.now)(),
                ttl: ROOM_PRESENCE_LEASE_TTL_MS,
              };
        const signed = await this.input.subscriber.publishSigned<RoomTopicPayload>(
          this.input.subscriber.topics.rooms,
          payload,
        );
        this.input.table.handleMessage(signed);
      });
    return this.pending;
  }
}
