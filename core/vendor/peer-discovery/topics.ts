/**
 * GossipSub topics 與 payload admission。房間文字聊天走 DataChannel；賽中溝通只走
 * participant 原簽章圖示訊息，UGC 目錄由 ledger 推導、不走 gossip。
 * 發現層訊息為 ephemeral（牆鐘時間、不入帳本、不參與共識推導）。
 */
import type { PeerId } from '@open4wd/interfaces';
import { Network, Protocol } from '@open4wd/system-constants';
import type { ChainId } from '../ledger';
import { chainIdFromLedgerAddress } from '../ledger';
import { parseRoomId, type RoomId } from '../room-identity';
import { isSignalingScope, normalizeSignalMessage } from '../signaling-service/signal-envelope';

/** 已由 TopicNamespace allowlist 建立或驗證的 GossipSub topic。 */
export type Topic = string & { readonly __open4wdTopic: unique symbol };

/**
 * 單一 chain 的 GossipSub wire namespace。
 * grammar：/open4wd/<full-canonical-CID>/topic/v1[/scope]。
 */
export interface TopicNamespace {
  readonly chainId: ChainId;
  readonly rooms: Topic;
  signaling(scope: string): Topic;
  isAllowed(topic: string): topic is Topic;
  isValidPayload(topic: Topic, payload: unknown): boolean;
}

/** 為單一 chain 建立封閉的 rooms 與 signaling topic namespace。 */
export function createTopicNamespace(chainId: ChainId): TopicNamespace {
  const root = `/open4wd/${chainId}`;
  const rooms = `${root}/rooms/v1` as Topic;
  const signalingPrefix = `${root}/signaling/v1/`;
  const signalingScope = (topic: string): string | null =>
    topic.startsWith(signalingPrefix)
      ? validSignalingScope(topic.slice(signalingPrefix.length))
      : null;
  const namespace: TopicNamespace = {
    chainId,
    rooms,
    signaling(scope) {
      if (!isSignalingScope(scope)) throw new RangeError(`invalid signaling scope: ${scope}`);
      return `${signalingPrefix}${scope}` as Topic;
    },
    isAllowed(topic): topic is Topic {
      return topic === rooms || signalingScope(topic) !== null;
    },
    isValidPayload(topic, payload) {
      if (!hasBoundedShape(payload)) return false;
      if (topic === rooms) return isRoomPayload(payload);
      const scope = signalingScope(topic);
      return scope !== null && isSignalingPayload(scope, payload);
    },
  };
  return Object.freeze(namespace);
}

/** 從 OrbitDB ledger address 推導 chain-bound GossipSub namespace。 */
export function topicNamespaceFromLedgerAddress(ledgerAddress: string): TopicNamespace {
  return createTopicNamespace(chainIdFromLedgerAddress(ledgerAddress));
}

/** 房間公告（房主每 30s 重發覆蓋 ttl；startsAt／ttl＝牆鐘毫秒） */
export interface RoomAnnouncePayload {
  type: 'room-announce';
  /** canonical 房間 instance 身分。 */
  roomId: RoomId;
  hostPeerId: PeerId;
  signalingEndpoint: string | null;
  gossipSignaling: boolean;
  clientVersion: string;
  trackId: string;
  playerCount: number;
  maxPlayers: number;
  visibility: 'public' | 'private';
  quickMatchEnabled: boolean;
  participantPasswordRequired: boolean;
  state: 'waiting' | 'preloading' | 'racing' | 'settling' | 'closed';
  ratingAnchorX1000: number;
  startsAt: number;
  ttl: number;
}

/** 房主明示撤銷公開房間租約的 ephemeral 訊息。 */
export interface RoomClosePayload {
  type: 'room-close';
  roomId: RoomId;
  reason: 'race-over' | 'host-left' | 'expired';
}

/** 非房主成員定期證明仍在公開房間的短效租約。 */
export interface RoomPresencePayload {
  type: 'room-presence';
  roomId: RoomId;
  peerId: PeerId;
  hostPeerId: PeerId;
  ttl: number;
}

/** 非房主成員主動離開時立即撤銷 presence 的訊息。 */
export interface RoomPresenceLeftPayload {
  type: 'room-presence-left';
  roomId: RoomId;
  peerId: PeerId;
  hostPeerId: PeerId;
}

/** rooms topic 唯一允許的公告、關閉與成員 presence 訊息聯集。 */
export type RoomTopicPayload =
  RoomAnnouncePayload | RoomClosePayload | RoomPresencePayload | RoomPresenceLeftPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars;
}

function isSafeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value);
}

function hasBoundedShape(root: unknown): boolean {
  let entries = 0;
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > Network.peerDiscovery.GOSSIP_PAYLOAD_MAX_DEPTH) return false;
    const value = current.value;
    if (typeof value === 'string') {
      if (
        new TextEncoder().encode(value).byteLength > Network.peerDiscovery.GOSSIP_STRING_MAX_BYTES
      )
        return false;
      continue;
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      continue;
    if (typeof value !== 'object' || value instanceof Uint8Array) return false;
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    entries += children.length;
    if (entries > Network.peerDiscovery.GOSSIP_PAYLOAD_MAX_ENTRIES) return false;
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}

function isPeerId(value: unknown): value is PeerId {
  return isBoundedString(value, Protocol.security.P2P_MESSAGE_SIGNER_MAX_CHARS);
}

function isRoomPayload(payload: unknown): payload is RoomTopicPayload {
  if (!isRecord(payload) || parseRoomId(payload['roomId']) === null) return false;
  if (payload['type'] === 'room-close')
    return ['race-over', 'host-left', 'expired'].includes(String(payload['reason']));
  if (payload['type'] === 'room-presence')
    return (
      isPeerId(payload['peerId']) &&
      isPeerId(payload['hostPeerId']) &&
      isSafeNumber(payload['ttl']) &&
      payload['ttl'] > 0
    );
  if (payload['type'] === 'room-presence-left')
    return isPeerId(payload['peerId']) && isPeerId(payload['hostPeerId']);
  if (payload['type'] !== 'room-announce') return false;
  return (
    isPeerId(payload['hostPeerId']) &&
    (payload['signalingEndpoint'] === null ||
      (isBoundedString(
        payload['signalingEndpoint'],
        Network.peerDiscovery.GOSSIP_MULTIADDR_MAX_CHARS,
      ) &&
        /^wss?:\/\//.test(payload['signalingEndpoint']))) &&
    typeof payload['gossipSignaling'] === 'boolean' &&
    isBoundedString(payload['clientVersion'], 64) &&
    isBoundedString(payload['trackId'], Network.peerDiscovery.GOSSIP_RESOURCE_ID_MAX_CHARS) &&
    isSafeNumber(payload['playerCount']) &&
    payload['playerCount'] >= 0 &&
    isSafeNumber(payload['maxPlayers']) &&
    payload['maxPlayers'] >= Protocol.matchmaking.PLAYERS_PER_RACE_MIN &&
    payload['maxPlayers'] <= Protocol.matchmaking.PLAYERS_PER_RACE_MAX &&
    payload['playerCount'] <= payload['maxPlayers'] &&
    (payload['visibility'] === 'public' || payload['visibility'] === 'private') &&
    typeof payload['quickMatchEnabled'] === 'boolean' &&
    typeof payload['participantPasswordRequired'] === 'boolean' &&
    ['waiting', 'preloading', 'racing', 'settling', 'closed'].includes(String(payload['state'])) &&
    isSafeNumber(payload['ratingAnchorX1000']) &&
    payload['ratingAnchorX1000'] >= 0 &&
    isSafeNumber(payload['startsAt']) &&
    isSafeNumber(payload['ttl']) &&
    payload['ttl'] > 0
  );
}

function isSignalMessage(value: unknown): boolean {
  return normalizeSignalMessage(value).ok;
}

function validSignalingScope(scope: string): string | null {
  return isSignalingScope(scope) ? scope : null;
}

function isSignalingPayload(scope: string, payload: unknown): boolean {
  return (
    isRecord(payload) &&
    payload['type'] === 'signal-v1' &&
    payload['scope'] === scope &&
    isPeerId(payload['target']) &&
    isSignalMessage(payload['message'])
  );
}
