/**
 * 房間發現表 — `room-announce` 寫入、`room-close` 刪除、ttl 過期清理（呼叫端每 30s
 * `sweepExpired`）；房主每 30s 重新公告覆蓋 ttl。訊息須先過 TopicSubscriber 驗簽
 * （簽章／時戳／nonce），本表再做歸屬完整性：公告者必須是房主本人、同房號的
 * 後續公告與關房只認原房主（防冒名公告與惡意關房）。全部 ephemeral、不入帳本。
 */
import type { PeerId, SignedPayload, Unsubscribe } from '@open4wd/interfaces';
import type { RoomId } from '../room-identity';
import type { RoomAnnouncePayload, RoomPresencePayload, RoomTopicPayload } from './topics';

/** 已通過 TopicSubscriber 驗簽、可進入公開房間表的公告。 */
export type RoomAnnouncement = SignedPayload<RoomAnnouncePayload>;

/** 從公開房間租約推導、可安全顯示的玩家所在狀態。 */
export interface PublicRoomPresence {
  state: 'public-room' | 'racing';
  roomId: RoomId;
  trackId: string;
}

/** waitForRoom 的可測試單次計時器埠。 */
export interface RoomDiscoveryWaitTimers {
  setTimeout(handler: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_WAIT_TIMERS: RoomDiscoveryWaitTimers = {
  setTimeout: (handler, milliseconds) => globalThis.setTimeout(handler, milliseconds),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** 驗證房主歸屬並維護有 TTL 的公開房間與成員 presence 表。 */
export class RoomDiscoveryTable {
  /** 每個 RoomId 最新且已驗證房主歸屬的公告。 */
  private readonly rooms = new Map<RoomId, RoomAnnouncement>();
  /** 每個房間內非房主 peer 的簽章 presence 租約。 */
  private readonly presence = new Map<RoomId, Map<PeerId, SignedPayload<RoomPresencePayload>>>();
  /** 房間清單變更 listeners。 */
  private readonly listeners = new Set<(rooms: readonly RoomAnnouncement[]) => void>();
  /** 依房間分組的 peer 加入 listeners。 */
  private readonly joinedListeners = new Map<RoomId, Set<(peer: PeerId) => void>>();
  /** 依房間分組的 peer 離開 listeners。 */
  private readonly leftListeners = new Map<RoomId, Set<(peer: PeerId) => void>>();

  /** 已驗簽訊息入口（TopicSubscriber handler 直接接）；歸屬不符＝靜默忽略 */
  handleMessage(message: SignedPayload<RoomTopicPayload>): void {
    if (message.payload.type === 'room-announce') {
      const announcement = message as RoomAnnouncement;
      if (announcement.signer !== announcement.payload.hostPeerId) return; // 公告者≠房主
      const existing = this.rooms.get(announcement.payload.roomId);
      if (existing && existing.payload.hostPeerId !== announcement.payload.hostPeerId) return; // 撞號搶佔
      this.rooms.set(announcement.payload.roomId, announcement);
      this.notify();
      return;
    }
    if (message.payload.type === 'room-presence') {
      const room = this.rooms.get(message.payload.roomId);
      if (
        room === undefined ||
        message.signer !== message.payload.peerId ||
        message.payload.hostPeerId !== room.payload.hostPeerId ||
        message.payload.peerId === room.payload.hostPeerId
      )
        return;
      const peers = this.presence.get(message.payload.roomId) ?? new Map();
      const joined = !peers.has(message.payload.peerId);
      if (joined && peers.size >= ROOM_PRESENCE_MAX_PEERS) return;
      peers.set(message.payload.peerId, message as SignedPayload<RoomPresencePayload>);
      this.presence.set(message.payload.roomId, peers);
      if (joined) this.notifyJoined(message.payload.roomId, message.payload.peerId);
      return;
    }
    if (message.payload.type === 'room-presence-left') {
      const room = this.rooms.get(message.payload.roomId);
      if (
        room === undefined ||
        message.signer !== message.payload.peerId ||
        message.payload.hostPeerId !== room.payload.hostPeerId ||
        message.payload.peerId === room.payload.hostPeerId
      )
        return;
      const peers = this.presence.get(message.payload.roomId);
      if (peers?.delete(message.payload.peerId) === true)
        this.notifyLeft(message.payload.roomId, message.payload.peerId);
      return;
    }
    const existing = this.rooms.get(message.payload.roomId);
    if (!existing || message.signer !== existing.payload.hostPeerId) return; // 非房主關房
    this.rooms.delete(message.payload.roomId);
    this.presence.delete(message.payload.roomId);
    this.notify();
  }

  /**
   * ttl 過期清理（牆鐘；公告時戳＋ttl < now＝過期）；回傳清掉的房號。
   * ttl 為公告者自報——夾上限防「超長 ttl 滯留灌表」（房主本就每 30s 重公告覆蓋）。
   */
  sweepExpired(now: number): RoomId[] {
    const expired: RoomId[] = [];
    for (const [roomId, announcement] of this.rooms) {
      const effectiveTtl = Math.min(announcement.payload.ttl, ROOM_TTL_MAX_MS);
      if (announcement.timestamp + effectiveTtl < now) expired.push(roomId);
    }
    for (const roomId of expired) this.rooms.delete(roomId);
    for (const roomId of expired) this.presence.delete(roomId);

    let presenceChanged = false;
    for (const [roomId, peers] of this.presence)
      for (const [peerId, current] of peers) {
        const effectiveTtl = Math.min(current.payload.ttl, ROOM_TTL_MAX_MS);
        if (current.timestamp + effectiveTtl >= now) continue;
        peers.delete(peerId);
        presenceChanged = true;
        this.notifyLeft(roomId, peerId);
      }
    if (expired.length > 0 || presenceChanged) this.notify();
    return expired;
  }

  /** 去重後即時清單（Map 鍵＝房號、天然去重） */
  listActiveRooms(): RoomAnnouncement[] {
    return [...this.rooms.values()];
  }

  /** 取得指定房間最近一次通過驗證的公告；不存在或已過期時回傳空值。 */
  getRoom(roomId: RoomId): RoomAnnouncement | null {
    return this.rooms.get(roomId) ?? null;
  }

  /** 等待指定房間出現有效公告，逾時或取消時回傳空值。 */
  waitForRoom(
    roomId: RoomId,
    timeoutMs: number,
    timers: RoomDiscoveryWaitTimers = DEFAULT_WAIT_TIMERS,
  ): Promise<RoomAnnouncement | null> {
    const existing = this.getRoom(roomId);
    if (existing !== null) return Promise.resolve(existing);
    return new Promise((resolve) => {
      let settled = false;
      let timer: unknown = undefined;
      let unsubscribe: Unsubscribe = () => undefined;
      const settle = (room: RoomAnnouncement | null): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        timers.clearTimeout(timer);
        resolve(room);
      };
      unsubscribe = this.subscribeRooms(() => {
        const room = this.getRoom(roomId);
        if (room !== null) settle(room);
      });
      timer = timers.setTimeout(() => settle(null), Math.max(0, timeoutMs));
      const room = this.getRoom(roomId);
      if (room !== null) settle(room);
    });
  }

  /** 列出目前仍有有效公告的節點識別穩定快照。 */
  peerIds(roomId: RoomId): PeerId[] {
    const room = this.rooms.get(roomId);
    if (room === undefined) return [];
    return [room.payload.hostPeerId, ...(this.presence.get(roomId)?.keys() ?? [])];
  }

  /** 僅由已接受公開房間公告推導且保障隱私的 presence。 */
  publicPresenceOf(peerId: PeerId): PublicRoomPresence | null {
    const candidates = [...this.rooms.values()]
      .filter(
        (announcement) =>
          announcement.payload.visibility === 'public' &&
          announcement.payload.state !== 'closed' &&
          this.peerIds(announcement.payload.roomId).includes(peerId),
      )
      .sort(
        (left, right) =>
          right.timestamp - left.timestamp ||
          left.payload.roomId.localeCompare(right.payload.roomId),
      );
    const announcement = candidates[0];
    if (announcement === undefined) return null;
    return {
      state: announcement.payload.state === 'waiting' ? 'public-room' : 'racing',
      roomId: announcement.payload.roomId,
      trackId: announcement.payload.trackId,
    };
  }

  /** 訂閱首次出現有效房間公告的節點，並回傳解除監聽函式。 */
  onPeerJoined(roomId: RoomId, handler: (peer: PeerId) => void): Unsubscribe {
    const listeners = this.joinedListeners.get(roomId) ?? new Set();
    listeners.add(handler);
    this.joinedListeners.set(roomId, listeners);
    return () => listeners.delete(handler);
  }

  /** 訂閱最後一筆公告過期或撤銷的節點，並回傳解除監聽函式。 */
  onPeerLeft(roomId: RoomId, handler: (peer: PeerId) => void): Unsubscribe {
    const listeners = this.leftListeners.get(roomId) ?? new Set();
    listeners.add(handler);
    this.leftListeners.set(roomId, listeners);
    return () => listeners.delete(handler);
  }

  /** 訂閱房間公告表快照變更，並立即提供目前可見房間。 */
  subscribeRooms(handler: (rooms: readonly RoomAnnouncement[]) => void): Unsubscribe {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** 以新的去重房間快照通知所有清單訂閱者。 */
  private notify(): void {
    const snapshot = this.listActiveRooms();
    for (const listener of this.listeners) listener(snapshot);
  }

  /** 通知指定房間某個 presence 首次出現。 */
  private notifyJoined(roomId: RoomId, peer: PeerId): void {
    for (const listener of this.joinedListeners.get(roomId) ?? []) listener(peer);
  }

  /** 通知指定房間某個 presence 明示離開或租約過期。 */
  private notifyLeft(roomId: RoomId, peer: PeerId): void {
    for (const listener of this.leftListeners.get(roomId) ?? []) listener(peer);
  }
}

/** 房主端週期重公告的間隔（每 30s 重新公告覆蓋 ttl、同間隔掃過期） */
export const ROOM_REANNOUNCE_INTERVAL_MS = 30_000;

/** 公告／presence lease：涵蓋一分鐘級背景節流再保留一次喚醒與網路延遲餘裕。 */
export const ROOM_PRESENCE_LEASE_TTL_MS = 4 * ROOM_REANNOUNCE_INTERVAL_MS;

/** 自報 ttl 的生效上限（重公告間隔的 10 倍寬裕）——超長 ttl 視同此值、防滯留灌表 */
export const ROOM_TTL_MAX_MS = 10 * ROOM_REANNOUNCE_INTERVAL_MS;
export const ROOM_PRESENCE_MAX_PEERS = 64;
