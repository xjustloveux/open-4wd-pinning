/**
 * network/sync — rollback wire、收件 admission、投票與終止語意的協定綁定常數。
 * 任一值改動都可能讓同場 peer 對訊息接受範圍或終局產生不同判斷，須升 protocol major。
 */

/** 固定輸入延遲 D（幀）：本機在 frame c 取樣的技能事件排到 c+D 才生效；全房同值、不協商（D-20261028-03）。 */
export const INPUT_DELAY_FRAMES = 6;
/** 回滾視窗 R：輸入可受理／回滾深度基準值；過舊 input（`current - R` 之前）直接丟棄。 */
export const ROLLBACK_FRAME_BUFFER_DEFAULT = 2;
/** 回滾頓挫上限 R_max：最深回滾幀數的協定上限（不變式用）。 */
export const ROLLBACK_FRAME_BUFFER_MAX = 3;
/** 技能反應延遲上限（毫秒）：D×T 不得超過此值。 */
export const SKILL_INPUT_DELAY_MAX_MS = 100;
/** 單向網路延遲容忍（毫秒）：(D+R)×T 不得低於此值，與改版前 R＝8 的容忍相同。 */
export const NETWORK_ONE_WAY_LATENCY_TOLERANCE_MS = 133;
export const STATE_BUFFER_MAX_FRAMES = 12; // 稀疏快照保留時窗（幀）、刻意大於回滾視窗
export const SNAPSHOT_INTERVAL_FRAMES = 120; // 2 秒
export const SNAPSHOT_CHECKSUM_BYTES = 32; // 使用 SHA-256
export const MAX_INPUT_EVENTS_PER_FRAME = 4; // chip skill slot 上限；同 skill 每幀至多一筆
/**
 * 4 MiB；單包 catch-up 快照絕對上限。不可變形狀以登錄參照寫入快照（D-20261028-02）後，公版三場
 * 八車 SavedState 最大約 1.17 MB（約 28%）；001091 的短期 8 MiB 上限已撤回。
 */
export const SYNC_SNAPSHOT_MAX_BYTES = 4_194_304;
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
/**
 * DataChannel 應用層分段（issue 001093）。單一 RTCDataChannel 訊息受 SCTP 協商的
 * maxMessageSize 限制（Chromium 262,144 B）；實際上限＝min(協商值, 安全上限)，未知時用
 * RFC 8841 預設值。超過上限的訊息切段送出、接收端重組後才走既有 admission 與驗簽。
 */
export const DATA_CHANNEL_MESSAGE_FALLBACK_BYTES = 65_536;
export const DATA_CHANNEL_MESSAGE_SAFE_MAX_BYTES = 262_144;
/** 分段標頭：marker(1)＋messageId(4)＋index(4)＋count(4)＋totalLength(4)＋fragmentBytes(4)。 */
export const DATA_CHANNEL_FRAGMENT_HEADER_BYTES = 21;
/** 多段訊息每段（末段除外）的最小酬載；限制單訊息段數與標頭放大。 */
export const DATA_CHANNEL_FRAGMENT_MIN_PAYLOAD_BYTES = 16_384;
/** 未完成重組的逾時；與 catch-up 完整快照請求逾時（300 幀＝5 秒）同長。 */
export const DATA_CHANNEL_REASSEMBLY_TIMEOUT_MS = 5_000;
/** 送出多段訊息前 bufferedAmount＋本訊息總段長的上限（Chromium 送出佇列 16 MiB 即關通道）。 */
export const DATA_CHANNEL_SEND_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
/** 每 peer 未完成重組的位元組上限：race＝驗證後 queue 上限、control／spectator＝ingress bucket 容量。 */
export const RACE_REASSEMBLY_MAX_BYTES_PER_PEER = VERIFIED_QUEUE_MAX_BYTES_PER_PEER;
export const CONTROL_REASSEMBLY_MAX_BYTES_PER_PEER = CONTROL_INGRESS_TOKEN_BUCKET_BYTES;
export const SPECTATOR_REASSEMBLY_MAX_BYTES_PER_PEER = SPECTATOR_SOURCE_INGRESS_TOKEN_BUCKET_BYTES;
export const SYNC_REQUEST_COOLDOWN_FRAMES = 120; // 同 peer 2 秒至多回應一份快照
/** snapshot offer 候選對齊間隔；相差最多 7 幀的 peers 共享對齊幀，與回滾深度脫鉤。 */
export const CATCH_UP_OFFER_ALIGNMENT_FRAMES = 8;
export const CATCH_UP_OFFER_CANDIDATES = 2;
export const CATCH_UP_OFFER_TTL_FRAMES = 900; // 與 15 秒 reconnect horizon 同長
export const CATCH_UP_PROBE_TIMEOUT_FRAMES = 60;
export const CATCH_UP_PROBE_RETRY_LIMIT = 2;
export const CATCH_UP_PROBE_REPLACE_AFTER_FRAMES =
  CATCH_UP_PROBE_TIMEOUT_FRAMES * CATCH_UP_PROBE_RETRY_LIMIT;
export const CATCH_UP_REQUEST_TIMEOUT_FRAMES = 300; // 5 秒；公版約 4.5 MB 快照需約 7.2 Mbps
export const CATCH_UP_OFFER_MAX_ENTRIES = 8;
export const CATCH_UP_OFFER_MAX_BYTES =
  CATCH_UP_OFFER_MAX_ENTRIES * CATCH_UP_OFFER_CANDIDATES * SYNC_SNAPSHOT_MAX_BYTES;
export const PEER_DESYNC_TOLERANCE_FRAMES = 30; // checksum 等待容差（逾窗=該輪缺席、不阻塞多數決）
/** 15 秒重連窗在 60Hz 下最多可合理落後的幀數；超出者不得以前跳快照注入。 */
export const CATCH_UP_MAX_ADVANCE_FRAMES = 900;
export const CHECKSUM_PAST_HORIZON_FRAMES = SNAPSHOT_INTERVAL_FRAMES + PEER_DESYNC_TOLERANCE_FRAMES;
export const DESYNC_STRIKE_LIMIT = 3; // 連續 mismatch 達此值 → persistent-desync（不 rollback、僅累積）
export const SPECTATOR_BROADCAST_INTERVAL_MS = 100; // 觀戰 10Hz
