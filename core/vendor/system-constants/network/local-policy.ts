/**
 * network/local-policy — 本機處置政策常數。
 * 非協定：只決定本機如何處置自己的落後與重同步，改值不升 protocol。
 */

/** 本機持續落後（幀）達此值即自我驅逐（lag-evicted、不自動改以觀戰者加入）；300 幀＝5 秒（使用者已裁決）。 */
export const PERSISTENT_LAG_DEMOTE_FRAMES = 300;
/** 觀戰 replay 自動重新同步的次數上限（使用者已裁決；語意由觀戰 join 流程消費）。 */
export const SPECTATOR_REPLAY_RESYNC_LIMIT = 3;
/**
 * 落後端快進（issue 001104 甲案）：嚴格多數遠端 lead 落在 (R, STATE_BUFFER×2] 時，每個 render tick
 * 在正常步之外最多追加的步數。不變式：1 ≤ 值 ≤ MAX_SUBSTEPS。
 */
export const CLOCK_FAST_FORWARD_MAX_EXTRA_STEPS = 2;
/**
 * 落後端快進的停止點：嚴格多數遠端 lead ≤ 此值即停止（不變式：< R）。
 * 已知限制（issue 001127）：lead 恆比真實進度舊單向延遲 L 幀，停在 0 殘留真實落後 L；
 * 2L > D＋R 時落後端之後的輸入到達他人時都已過舊。
 */
export const CLOCK_FAST_FORWARD_STOP_LEAD_FRAMES = 0;
/**
 * catch-up 分 tick 追趕（issue 001108（1））：每個 render tick 推進追趕幀的牆鐘預算（毫秒；至少推進一幀）。
 * 不變式：0 < 值 < 1000 / FIXED_FRAMERATE_HZ。
 */
export const CATCH_UP_CHASE_TICK_BUDGET_MS = 10;
/**
 * catch-up responder 重送（issue 001111）：sync-response 未交給通道（同步 false、送出例外或回執
 * delivered:false）時，於之後的 step 自動重送同一請求的次數上限（每次重建日誌、重新簽章）。
 * 不變式：≥ 1。
 */
export const SYNC_RESPONSE_RESEND_LIMIT = 2;
/**
 * catch-up front 夾限（issue 001107）：參考幀的觀測來源只採計不超過
 * 「本機 current＋CATCH_UP_MAX_ADVANCE_FRAMES＋此值」（現值 current＋900＋24）的遠端觀測——門檻以
 * 可 catch-up 的最大前跳為基準，再加一個未來窗；超出者不可能是可 catch-up 範圍內的真實進度，於收到時
 * 即不採計、取參考幀時也再濾一次（視同該 peer 無觀測）。只以 current＋此值為門檻會讓落後超過約
 * 32 幀的恢復端失去所有觀測、catch-up 失效，故不採。
 * 不變式：D＋R ≤ 值 ≤ STATE_BUFFER_MAX_FRAMES × 2。
 */
export const CATCH_UP_MAX_OBSERVED_AHEAD_FRAMES = 24;
/**
 * catch-up front 夾限下界（issue 001107）：provider 的 front 低於參考幀超過此值即拒收
 * （front-behind-observed）。依據：延遲不為負，誠實 front 與參考幀之差只來自單程延遲的抖動差；
 * 以 network-sync mesh harness 量測誠實情境（4 人、8 人；固定單程 1、2、4、8 幀與 1..6 幀抖動；
 * seed 20..31）的 front − 參考幀，最小值 −3、最大值 +3，下界取最小值 − 1。
 * 保證範圍同 issue 001104：catch-up 後單程抖動 1..6；更大抖動下誠實 provider 可能被拒（改向下一位 voter）。
 * 不變式：1 ≤ 值 < D＋R。
 */
export const CATCH_UP_FRONT_BEHIND_TOLERANCE_FRAMES = 4;
/**
 * catch-up 日誌驗簽分片（issue 001108（2））：sync-response 外層簽章驗過後，未命中已驗快取的日誌條目
 * 每片在此牆鐘預算（毫秒）內驗簽、至少一筆，片與片之間讓出主執行緒，使 live input 照常驗簽交付。
 * 不變式：0 < 值 < 1000 / FIXED_FRAMERATE_HZ。
 */
export const SYNC_LOG_VERIFY_SLICE_MS = 4;
/**
 * catch-up 日誌驗簽總上限的單筆成本上界（毫秒；可為小數）：引擎以「最壞日誌條目數 × 此值」換算成 60 Hz 步數，
 * 作為分片驗簽心跳可順延快照請求逾時的總上限（現值 7504 × 1.5 ms ≈ 676 步）。依據：noble 在 Firefox 主執行緒
 * 驗 7504 筆共 7241 ms（約 0.97 ms／筆），取約 1.5 倍裕度涵蓋分片讓出與主執行緒分時。不涵蓋更慢的 noble
 * 環境（Chromium 4× 降頻約 2.34 ms／筆）。上限不得長於 offer TTL：快照階段本機照常 step、與前緣的落後量
 * 不隨驗簽步數累加，真正的約束是各 voter 在 probe 時 pin 的 offer 自 pin 起 CATCH_UP_OFFER_TTL_FRAMES 幀後過期，
 * 單一 voter 的驗簽拖得比 TTL 長，之後換到的 voter 已無法回應。
 * 不變式：CATCH_UP_REQUEST_TIMEOUT_FRAMES ≤ 換算步數 ≤ CATCH_UP_OFFER_TTL_FRAMES。
 */
export const SYNC_LOG_VERIFY_ENTRY_MAX_MS = 1.5;
/**
 * 非同步驗簽逾時（issue 001118）：WebCrypto 的 import／verify 超過此牆鐘時間（毫秒）未完成，該筆改以 noble
 * 同步判定，該驗簽器之後一律改用 noble（環境判定為不可靠）。依據：WebCrypto 評估量測中合法情境最壞的單則 await
 * 往返 P95 為 2.6 ms（Chromium 4× 降頻、7 則同時等待），取約 20 倍裕度，可容忍約 3 個固定步的主執行緒
 * 停頓而不誤判。不變式：1000 / FIXED_FRAMERATE_HZ ≤ 值 ≤ INPUT_DELAY_FRAMES × 1000 / FIXED_FRAMERATE_HZ
 * （至少容忍一個固定步的停頓；卡住的驗簽在輸入延遲窗用完前就改判，不額外造成回滾）。
 */
export const SIGNATURE_VERIFY_TIMEOUT_MS = 50;
