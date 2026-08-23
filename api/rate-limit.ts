/**
 * per-IP token bucket 限流：純函式，狀態（每個來源的桶）由呼叫端在外部 Map 保存與傳回——同一份
 * 規則可搭配記憶體、Redis 或邊緣 KV 等任意後端（形制比照 signaling repo 的 checkRate：純函式＋
 * 呼叫端持有 state）。
 *
 * 演算法選擇：capacity 允許瞬間突發（例如使用者一次要 pin 好幾個 CID），耗盡後依 refillPerSec
 * 線性補充。比固定窗多一個好處——沒有「窗口邊界附近可被打兩倍量」的邊界效應（固定窗在
 * t=windowStart-ε 與 t=windowStart+ε 各用滿一次，短時間內合法上限即可能是 2×limit；token
 * bucket 的容量上限就是唯一的突發上限，之後嚴格照補充速率節流，行為更平滑也更好推理）。
 *
 * `checkRate` 本身純函式、不持有任何狀態；外部 Map 的生命週期管理（閒置條目回收＋硬上限
 * 逐出）另外交給 `pruneRateWindows`，見該函式定義處的完整理由。
 */

export interface TokenBucketConfig {
  /** 桶容量——允許的最大瞬間突發量（同時也是任何時刻 tokens 的上限）。 */
  readonly capacity: number;
  /** 每秒補充速率（tokens/sec）。 */
  readonly refillPerSec: number;
}

/** 記錄單一限流對象的剩餘權杖與最後補充時間。 */
export interface TokenBucketState {
  readonly tokens: number;
  readonly updatedAtMs: number;
}

/** 回傳限流裁定與呼叫端必須保存的更新狀態。 */
export interface RateResult {
  readonly allowed: boolean;
  readonly state: TokenBucketState;
}

/**
 * 判定這次請求是否放行，並回傳更新後的桶狀態（呼叫端負責存回外部 Map）。
 *
 * @param state 該來源目前的桶狀態；省略（首次見到這個來源）視為滿桶起算。
 * @param now 目前時間（ms epoch）——呼叫端注入，方便測試以固定值精確控制補充計算。
 * @param config 容量與補充速率。
 */
export function checkRate(
  state: TokenBucketState | undefined,
  now: number,
  config: TokenBucketConfig,
): RateResult {
  const previousTokens = state?.tokens ?? config.capacity;
  const previousAt = state?.updatedAtMs ?? now;
  // 時鐘不可能倒流的假設在分散式時鐘偏移下未必成立；夾在 0 以上，避免負的經過時間被
  // 誤算成「倒扣」tokens。
  const elapsedSec = Math.max(0, (now - previousAt) / 1000);
  const refilled = Math.min(config.capacity, previousTokens + elapsedSec * config.refillPerSec);

  if (refilled < 1) {
    return { allowed: false, state: { tokens: refilled, updatedAtMs: now } };
  }
  return { allowed: true, state: { tokens: refilled - 1, updatedAtMs: now } };
}

/** 逐 IP 的桶狀態 Map 若只增不減，來源愈多（IP 輪替／殭屍網路）就愈大、永不回頭——單純呼叫
 * `checkRate` 並把結果存回 Map 本身不會清掉任何條目。這個上限值只在硬上限逐出（見
 * `pruneRateWindows`）沒有指定呼叫端覆蓋值時才用得到。 */
const DEFAULT_MAX_RATE_WINDOW_ENTRIES = 10_000;

/**
 * 回收 `rateWindows` Map：清掉閒置夠久的舊條目，並在條目數超過硬上限時逐出最舊的。呼叫端
 * （`api/server.ts`）在每次限流檢查、把這次請求的桶狀態存回 Map 之後呼叫，把回收的責任跟
 * 桶狀態的保存責任放在同一個地方（純函式 `checkRate` 本身不持有、也不需要知道任何狀態的
 * 生命週期）——放在「存回之後」而不是之前，是刻意的：剛寫入的這一筆 `updatedAtMs` 必為
 * 全 map 最新，硬上限逐出（依時間由舊到新挑）永遠不會選中它，讓「這次請求處理完後 map
 * 大小不超過硬上限」這個不變式每次呼叫後都成立，不會有插入後暫時超額、要等下一次呼叫才
 * 被修正的空窗。
 *
 * TTL 判定刻意不另開一個獨立的到期時間常數，而是直接從桶的補充速率推導：一個桶補滿回
 * `capacity` 所需的時間是 `capacity / refillPerSec` 秒；一個條目閒置超過這段時間沒再打
 * 過來，它目前存著的狀態在數值上已經跟「這個來源從沒出現過」完全等價——`checkRate` 對
 * 「沒有既存 state」的處理方式正是視為滿桶起算，而閒置夠久的桶無論原本剩多少 token，
 * 補充量早就超過 capacity、一樣會被夾到滿桶。清掉這種條目不會讓下一次來訪的判定結果有
 * 任何不同，純粹是回收記憶體，沒有行為副作用（`refillPerSec` 為 0 時 TTL 算出無限大，
 * 這類永不自動回填的桶因此永遠不會被 TTL 判定為到期，只會受硬上限逐出約束）。
 *
 * 硬上限逐出是第二道防線：TTL 只清「已經閒置夠久」的條目，防不了短時間內大量*仍在活動*
 * 的不同來源同時湧入——這種情況下每個條目個別看都還沒過期，但條目總數本身該有絕對上限。
 * 超過上限時全掃一次，依 `updatedAtMs` 逐出最舊的直到回到上限。
 *
 * @param maxEntries 硬上限；省略＝`DEFAULT_MAX_RATE_WINDOW_ENTRIES`（測試以較小值驗證
 *   逐出行為，不必真的餵入上萬筆資料）。
 */
export function pruneRateWindows(
  rateWindows: Map<string, TokenBucketState>,
  now: number,
  config: TokenBucketConfig,
  maxEntries: number = DEFAULT_MAX_RATE_WINDOW_ENTRIES,
): void {
  const idleTtlMs = (config.capacity / config.refillPerSec) * 1000;
  for (const [ip, state] of rateWindows) {
    if (now - state.updatedAtMs >= idleTtlMs) rateWindows.delete(ip);
  }

  const excess = rateWindows.size - maxEntries;
  if (excess <= 0) return;
  const byAge = [...rateWindows.entries()].sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
  for (let i = 0; i < excess; i += 1) {
    const oldest = byAge[i];
    if (oldest !== undefined) rateWindows.delete(oldest[0]);
  }
}
