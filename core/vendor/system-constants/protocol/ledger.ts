/**
 * protocol/ledger — 鏈與多簽常數（跨 peer 共識必須一致）
 */
export { ARBITRATION_WEIGHT_X100_TABLE } from './arbitration-weight-table';

// ── 每回合 consensus anchor ──
/** 定義無法取得外部時間錨時，共識時間槽位的固定毫秒寬度。 */
export const CONSENSUS_ANCHOR_FALLBACK_SLOT_MS = 2_000;
/** 定義蒐集共識時間錨證據允許等待的最長毫秒數。 */
export const CONSENSUS_ANCHOR_COLLECTION_TIMEOUT_MS = 12_000;

/**
 * 公共 ledger OrbitDB 位址＝鏈身分（build 注入；信任根＝client 內建位址＋genesis signer set）
 * 空值＝鏈尚未建立（genesis 時產生、隨 client major 出貨）
 */
export const LEDGER_DB_ADDRESS = '';

// ── 仲裁 ──
/** 定義每次爭議仲裁抽選的評審節點數。 */
export const ARBITRATION_PANEL_SIZE = 7;
/** 定義仲裁裁定成立所需的最低有效票數。 */
export const ARBITRATION_QUORUM_VOTES = 4; // 有效票（pass+reject、棄權不計）
/** 加權 pass 必須嚴格超過此整數百分比；等於門檻仍為 reject。 */
export const ARBITRATION_PASS_THRESHOLD_PCT = 60;
/** 限制仲裁評審不足或無效時可重新抽選的次數。 */
export const ARBITRATION_REDRAW_MAX = 1;
/** 定義案件成立後延遲抽選仲裁評審的小時數。 */
export const ARBITRATION_DRAW_DELAY_HOURS = 24;
/** 定義仲裁評審可提交有效投票的小時窗口。 */
export const ARBITRATION_VOTE_WINDOW_HOURS = 72; // 待 playtest 校準
/** 定義未進入裁決的檢舉在多少天後失效。 */
export const REPORT_EXPIRE_DAYS = 90;
/** 限制單一檢舉者可同時維持的未結案件數。 */
export const REPORT_OPEN_MAX_PER_REPORTER = 3;
/** 限制單一上傳者可同時維持的待審資產數。 */
export const UPLOAD_PENDING_MAX_PER_UPLOADER = 3;
/** 定義待審違規累積至暫停上傳所需的次數。 */
export const UPLOAD_PENDING_SUSPEND_STRIKES = 3;
/** 定義因待審違規觸發的上傳暫停天數。 */
export const UPLOAD_PENDING_SUSPEND_DAYS = 30;
/** 定義節點累積至全域封鎖名單所需的有效違規次數。 */
export const GLOBAL_PEER_BLACKLIST_STRIKES = 3;

// ── 信譽（protocol 常數、非治理 config——累積型 derive 消費值不得進 config）──
/** 限制玩家每天可由賽事結果增加的最高聲譽。 */
export const REPUTATION_MATCH_GAIN_DAILY_MAX = 10; // 待 playtest 校準
/** 定義新建立身分開始使用的聲譽值。 */
export const REPUTATION_INITIAL = 500;
/** 定義聲譽計算允許保存的最低值。 */
export const REPUTATION_MIN = 0;
/** 定義聲譽計算允許保存的最高值。 */
export const REPUTATION_MAX = 1000;
/** 定義新身分適用額外聲譽保護的天數。 */
export const NEWCOMER_PROTECTION_DAYS = 7;
/** 定義新人保護期間聲譽不會跌破的下限。 */
export const NEWCOMER_REPUTATION_FLOOR = 400;
/** 定義判定惡意檢舉者時允許的最高成立率百分比。 */
export const MALICIOUS_REPORTER_ACCURACY_MAX_PCT = 30; // pct 整數、整數交叉相乘評估
/** 定義評估檢舉準確率前所需的最少已裁決樣本數。 */
export const MALICIOUS_REPORTER_SAMPLE_MIN = 10;
/** 定義惡意檢舉前科保護的 rolling 窗天數。 */
export const MALICIOUS_REPORTER_COOLDOWN_DAYS = 30;

// ── 經濟衙生讀模型 ──
/** 月流水保留當月＋前 11 個 UTC 月；變更會影響 checkpoint 共識狀態。 */
export const ECONOMY_MONTHLY_FLOW_RETENTION_MONTHS = 12;

// ── 帳本檢查點 ──
/** 定義正常情況建立帳本 checkpoint 的小時間隔。 */
export const LEDGER_CHECKPOINT_INTERVAL_HOURS = 24;
/** 限制房間可接受的釘選 checkpoint 最長帳齡。 */
export const ROOM_PINNED_CHECKPOINT_MAX_AGE_HOURS = 72; // 初估

// ── 帳本 Admission v1（entry-bound proof of work）──
/** 標識帳本 admission 工作量證明格式的目前版本。 */
export const LEDGER_ADMISSION_VERSION = 1;
/** 定義帳本事件 admission 必須滿足的基礎工作量位元數。 */
export const LEDGER_ADMISSION_BASE_BITS = 18;
/** 定義事件大小每增加多少位元組會提高 admission 難度。 */
export const LEDGER_ADMISSION_SIZE_UNIT_BYTES = 4096;
/** 限制事件大小可額外增加的 admission 難度位元數。 */
export const LEDGER_ADMISSION_MAX_EXTRA_BITS = 4;
/** 定義 admission 工作量證明 nonce 的固定位元組長度。 */
export const LEDGER_ADMISSION_NONCE_BYTES = 8;
/** 定義單筆 admission 計算允許占用的最長毫秒數。 */
export const LEDGER_ADMISSION_WORK_TIMEOUT_MS = 30_000;
/** 限制尚待處理的 admission 寫入意圖數量。 */
export const LEDGER_ADMISSION_INTENT_QUEUE_MAX = 8;
/** 限制持久 admission outbox 可保存的紀錄筆數。 */
export const LEDGER_ADMISSION_OUTBOX_MAX_ENTRIES = 32;
/** 限制持久 admission outbox 可占用的總位元組數。 */
export const LEDGER_ADMISSION_OUTBOX_MAX_BYTES = 2 * 1024 * 1024;
