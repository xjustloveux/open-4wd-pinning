/**
 * network/sync — rollback wire、收件 admission、投票與終止語意的協定綁定常數。
 * 任一值改動都可能讓同場 peer 對訊息接受範圍或終局產生不同判斷，須升 protocol major。
 */

export const ROLLBACK_FRAME_BUFFER_DEFAULT = 8; // 回滾視窗（7–10 中位數）
export const ROLLBACK_FRAME_BUFFER_MIN = 7;
export const ROLLBACK_FRAME_BUFFER_MAX = 10;
export const STATE_BUFFER_MAX_FRAMES = 12; // 環狀緩衝容量、刻意大於回滾視窗
export const SNAPSHOT_INTERVAL_FRAMES = 120; // 2 秒
export const SNAPSHOT_CHECKSUM_BYTES = 32; // 使用 SHA-256
export const MAX_INPUT_EVENTS_PER_FRAME = 4; // chip skill slot 上限；同 skill 每幀至多一筆
export const SYNC_SNAPSHOT_MAX_BYTES = 4_194_304; // 4 MiB；單包 catch-up 快照絕對上限
export const RACE_MESSAGE_MAX_BYTES = SYNC_SNAPSHOT_MAX_BYTES + 384; // wire 頭＋PeerId＋簽章裕度
/** 60Hz input 的獨立 ingress bucket；90/s 持續率並容許 120 筆短 burst。 */
export const INGRESS_INPUT_TOKEN_BUCKET_MESSAGES = 120;
export const INGRESS_INPUT_TOKEN_REFILL_PER_SECOND = 90;
/** checksum／catch-up 控制訊息的獨立低頻 bucket。 */
export const INGRESS_CONTROL_TOKEN_BUCKET_MESSAGES = 32;
export const INGRESS_CONTROL_TOKEN_REFILL_PER_SECOND = 32;
export const INGRESS_TOKEN_BUCKET_BYTES = RACE_MESSAGE_MAX_BYTES + 65_536;
/** token bucket 由空補滿所需時間；限制 decode/copy/hash/verify 前的持續工作量。 */
export const INGRESS_TOKEN_BUCKET_REFILL_MS = 1_000;
export const VERIFIED_QUEUE_MAX_MESSAGES_PER_PEER = 256;
export const VERIFIED_QUEUE_MAX_BYTES_PER_PEER = SYNC_SNAPSHOT_MAX_BYTES + 65_536;
/** ordered race-control DataChannel 的單一 DAG-CBOR wire 上限。 */
export const CONTROL_MESSAGE_MAX_BYTES = 256 * 1024;
/** 每個 remote peer 可瞬時送入的低頻 control 訊息數。 */
export const CONTROL_INGRESS_TOKEN_BUCKET_MESSAGES = 32;
export const CONTROL_INGRESS_MESSAGE_REFILL_PER_SECOND = 16;
export const CONTROL_INGRESS_TOKEN_BUCKET_BYTES = CONTROL_MESSAGE_MAX_BYTES + 65_536;
export const CONTROL_INGRESS_BYTE_REFILL_PER_SECOND = CONTROL_MESSAGE_MAX_BYTES;
/** oversized／malformed wire 累積到此值即關閉該 peer control link。 */
export const CONTROL_WIRE_VIOLATION_LIMIT = 3;
export const CONTROL_RACE_ID_MAX_BYTES = 256;
export const CONTROL_APP_TYPE_MAX_BYTES = 64;
export const CONTROL_KEY_ANNOUNCES_MAX_PER_PEER = 8;
/** waiting-room control link 的一般訊息與 byte ingress 預算。 */
export const ROOM_INGRESS_TOKEN_BUCKET_MESSAGES = 64;
export const ROOM_INGRESS_MESSAGE_REFILL_PER_SECOND = 32;
export const ROOM_INGRESS_TOKEN_BUCKET_BYTES = 320 * 1024;
export const ROOM_INGRESS_BYTE_REFILL_PER_SECOND = 256 * 1024;
/** OPAQUE／狀態／簽章／開賽等高成本 room wire 的獨立 quota。 */
export const ROOM_EXPENSIVE_TOKEN_BUCKET_MESSAGES = 8;
export const ROOM_EXPENSIVE_MESSAGE_REFILL_PER_SECOND = 4;
/** 連續 admission drop 達此值即關閉 room-control link。 */
export const ROOM_INGRESS_CONSECUTIVE_DROP_CLOSE_THRESHOLD = 16;
/** spectator JSON wire 的方向別 decode 前上限。 */
export const SPECTATOR_WIRE_MAX_BYTES = 256 * 1024;
export const SPECTATOR_REPLAY_WIRE_MAX_BYTES =
  Math.ceil((SYNC_SNAPSHOT_MAX_BYTES * 4) / 3) + 64 * 1024;
export const SPECTATOR_CLIENT_WIRE_MAX_BYTES = 128;
/** source→viewer replay/fallback ingress 的持續 message／byte 預算。 */
export const SPECTATOR_SOURCE_INGRESS_TOKEN_BUCKET_MESSAGES = 120;
export const SPECTATOR_SOURCE_INGRESS_MESSAGE_REFILL_PER_SECOND = 90;
export const SPECTATOR_SOURCE_INGRESS_TOKEN_BUCKET_BYTES =
  SPECTATOR_REPLAY_WIRE_MAX_BYTES + 1024 * 1024;
export const SPECTATOR_SOURCE_INGRESS_BYTE_REFILL_PER_SECOND = 4 * 1024 * 1024;
/** 大型 replay checkpoint 在 UTF-8／JSON 前的獨立低頻 quota。 */
export const SPECTATOR_CHECKPOINT_TOKEN_BUCKET_MESSAGES = 1;
export const SPECTATOR_CHECKPOINT_MESSAGE_REFILL_PER_SECOND = 0.2;
/** viewer→source mode-select ingress 的獨立低頻預算。 */
export const SPECTATOR_VIEWER_INGRESS_TOKEN_BUCKET_MESSAGES = 8;
export const SPECTATOR_VIEWER_INGRESS_MESSAGE_REFILL_PER_SECOND = 4;
export const SPECTATOR_VIEWER_INGRESS_TOKEN_BUCKET_BYTES = 1024;
export const SPECTATOR_VIEWER_INGRESS_BYTE_REFILL_PER_SECOND = 512;
/** 連續 admission drop 達此值即關閉 spectator link。 */
export const SPECTATOR_INGRESS_CONSECUTIVE_DROP_CLOSE_THRESHOLD = 16;
export const SYNC_REQUEST_COOLDOWN_FRAMES = 120; // 同 peer 2 秒至多回應一份快照
/** snapshot offer 候選對齊間隔；最近兩個候選可讓相差最多 7 幀的 responders 仍有共同幀。 */
export const CATCH_UP_OFFER_ALIGNMENT_FRAMES = ROLLBACK_FRAME_BUFFER_DEFAULT;
export const CATCH_UP_OFFER_CANDIDATES = 2;
export const CATCH_UP_OFFER_TTL_FRAMES = 900; // 與 15 秒 reconnect horizon 同長
export const CATCH_UP_PROBE_TIMEOUT_FRAMES = 60;
export const CATCH_UP_PROBE_RETRY_LIMIT = 2;
export const CATCH_UP_PROBE_REPLACE_AFTER_FRAMES =
  CATCH_UP_PROBE_TIMEOUT_FRAMES * CATCH_UP_PROBE_RETRY_LIMIT;
export const CATCH_UP_REQUEST_TIMEOUT_FRAMES = 300; // 4 MiB 在合理最低頻寬下保留 5 秒
export const CATCH_UP_OFFER_MAX_ENTRIES = 8;
export const CATCH_UP_OFFER_MAX_BYTES =
  CATCH_UP_OFFER_MAX_ENTRIES * CATCH_UP_OFFER_CANDIDATES * SYNC_SNAPSHOT_MAX_BYTES;
export const PEER_DESYNC_TOLERANCE_FRAMES = 30; // checksum 等待容差（逾窗=該輪缺席、不阻塞多數決）
/** 15 秒重連窗在 60Hz 下最多可合理落後的幀數；超出者不得以前跳快照注入。 */
export const CATCH_UP_MAX_ADVANCE_FRAMES = 900;
export const CHECKSUM_PAST_HORIZON_FRAMES = SNAPSHOT_INTERVAL_FRAMES + PEER_DESYNC_TOLERANCE_FRAMES;
export const DESYNC_STRIKE_LIMIT = 3; // 連續 mismatch 達此值 → persistent-desync（不 rollback、僅累積）
export const SPECTATOR_BROADCAST_INTERVAL_MS = 100; // 觀戰 10Hz
