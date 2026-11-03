/**
 * 常數不變式 — CI `pnpm run check:invariants` 與 vitest 共用
 * 違反＝CI 阻擋 merge
 */
import * as gameplay from './protocol/gameplay';
import * as ledger from './protocol/ledger';
import * as matchmaking from './protocol/matchmaking';
import * as physics from './protocol/physics';
import * as ugc from './protocol/ugc';
import * as sync from './network/sync';
import * as localPolicy from './network/local-policy';

/** ADR 03 輸入延遲／回滾視窗不變式所需的輸入值（測試可替換以驗證違反時的 label）。 */
export interface InvariantInputs {
  readonly fixedFramerateHz: number;
  readonly inputDelayFrames: number;
  readonly rollbackFrameBufferDefault: number;
  readonly rollbackFrameBufferMax: number;
  readonly skillInputDelayMaxMs: number;
  readonly networkOneWayLatencyToleranceMs: number;
  readonly stateBufferMaxFrames: number;
  readonly catchUpOfferAlignmentFrames: number;
  readonly snapshotIntervalFrames: number;
  readonly persistentLagDemoteFrames: number;
  readonly spectatorReplayResyncLimit: number;
}

/** 以實際常數組出 ADR 03 不變式的輸入值。 */
function actualInvariantInputs(): InvariantInputs {
  return {
    fixedFramerateHz: physics.FIXED_FRAMERATE_HZ,
    inputDelayFrames: sync.INPUT_DELAY_FRAMES,
    rollbackFrameBufferDefault: sync.ROLLBACK_FRAME_BUFFER_DEFAULT,
    rollbackFrameBufferMax: sync.ROLLBACK_FRAME_BUFFER_MAX,
    skillInputDelayMaxMs: sync.SKILL_INPUT_DELAY_MAX_MS,
    networkOneWayLatencyToleranceMs: sync.NETWORK_ONE_WAY_LATENCY_TOLERANCE_MS,
    stateBufferMaxFrames: sync.STATE_BUFFER_MAX_FRAMES,
    catchUpOfferAlignmentFrames: sync.CATCH_UP_OFFER_ALIGNMENT_FRAMES,
    snapshotIntervalFrames: sync.SNAPSHOT_INTERVAL_FRAMES,
    persistentLagDemoteFrames: localPolicy.PERSISTENT_LAG_DEMOTE_FRAMES,
    spectatorReplayResyncLimit: localPolicy.SPECTATOR_REPLAY_RESYNC_LIMIT,
  };
}

/** 逐條檢查輸入延遲、回滾視窗與緩衝的不變式（依 D-20261028-03 的參數約束）、回傳違反清單 */
export function checkInvariantsFor(values: InvariantInputs): string[] {
  const violations: string[] = [];
  const assert = (cond: boolean, label: string): void => {
    if (!cond) violations.push(label);
  };
  const hz = values.fixedFramerateHz;
  const d = values.inputDelayFrames;
  const r = values.rollbackFrameBufferDefault;

  assert(
    r >= 1 && r <= values.rollbackFrameBufferMax,
    'rollback buffer 1 ≤ default ≤ max（頓挫上限）',
  );
  assert(
    d * 1000 <= values.skillInputDelayMaxMs * hz,
    '技能反應延遲上限：D×1000 ≤ SKILL_INPUT_DELAY_MAX_MS×HZ',
  );
  assert(
    (d + r) * 1000 >= values.networkOneWayLatencyToleranceMs * hz,
    '單向延遲容忍下限：(D+R)×1000 ≥ NETWORK_ONE_WAY_LATENCY_TOLERANCE_MS×HZ',
  );
  assert(
    values.stateBufferMaxFrames >= r + values.catchUpOfferAlignmentFrames,
    'StateBuffer 保留時窗 ≥ R + catch-up 對齊間隔',
  );
  assert(values.stateBufferMaxFrames > r + 1, 'StateBuffer 保留時窗 > R + 1（001095）');
  assert(
    values.stateBufferMaxFrames * 2 > d + r,
    '未來輸入窗 STATE_BUFFER×2 > D + R（容得下排程輸入）',
  );
  assert(
    values.snapshotIntervalFrames % values.catchUpOfferAlignmentFrames === 0,
    'SNAPSHOT_INTERVAL 為 catch-up 對齊間隔的整數倍',
  );
  assert(
    values.persistentLagDemoteFrames > values.stateBufferMaxFrames * 2,
    '持續落後降級幀數 > STATE_BUFFER×2（001095）',
  );
  assert(values.spectatorReplayResyncLimit >= 1, '觀戰 replay 重新同步上限 ≥ 1');
  return violations;
}

/** 逐條檢查、回傳違反清單（空＝全過） */
export function checkInvariants(): string[] {
  const violations: string[] = [];
  const assert = (cond: boolean, label: string): void => {
    if (!cond) violations.push(label);
  };

  // 使用者生成內容
  assert(ugc.VEHICLE_TOTAL_MASS_MIN_GRAMS < ugc.VEHICLE_TOTAL_MASS_MAX_GRAMS, '整車質量 min < max');

  // 網路（輸入延遲、回滾視窗與緩衝；逐條定義見 checkInvariantsFor）
  violations.push(...checkInvariantsFor(actualInvariantInputs()));
  // 落後端快進（issue 001104；本機政策）
  assert(
    localPolicy.CLOCK_FAST_FORWARD_MAX_EXTRA_STEPS >= 1 &&
      localPolicy.CLOCK_FAST_FORWARD_MAX_EXTRA_STEPS <= physics.MAX_SUBSTEPS,
    '快進每 tick 額外步上限 1 ≤ 值 ≤ MAX_SUBSTEPS',
  );
  assert(
    localPolicy.CLOCK_FAST_FORWARD_STOP_LEAD_FRAMES < sync.ROLLBACK_FRAME_BUFFER_DEFAULT,
    '快進停止點 < R（啟動門檻）',
  );
  // catch-up 分 tick 追趕（issue 001108（1）；本機政策）：每 tick 預算須小於一個固定步的牆鐘時長
  assert(
    localPolicy.CATCH_UP_CHASE_TICK_BUDGET_MS > 0 &&
      localPolicy.CATCH_UP_CHASE_TICK_BUDGET_MS < 1000 / physics.FIXED_FRAMERATE_HZ,
    'catch-up 追趕每 tick 預算 0 < 值 < 1000 / FIXED_FRAMERATE_HZ',
  );
  // catch-up 日誌驗簽總上限（issue 001108（2）；本機政策）：最壞日誌條目數（與 network-sync wire 的
  // SYNC_INPUT_LOG_MAX_ENTRIES 同式）× 單筆上界換算成步數，須不短於請求逾時（心跳才有意義），且不長於
  // offer TTL（快照階段本機照常 step、落後不累加；約束來自各 voter 在 probe 時 pin 的 offer 會在 TTL 後過期）
  const syncInputLogMaxEntries =
    matchmaking.PLAYERS_PER_RACE_MAX *
    (sync.CATCH_UP_OFFER_TTL_FRAMES +
      sync.STATE_BUFFER_MAX_FRAMES +
      sync.STATE_BUFFER_MAX_FRAMES * 2 +
      2);
  const syncLogVerifyMaxSteps = Math.ceil(
    (syncInputLogMaxEntries *
      localPolicy.SYNC_LOG_VERIFY_ENTRY_MAX_MS *
      physics.FIXED_FRAMERATE_HZ) /
      1000,
  );
  assert(
    localPolicy.SYNC_LOG_VERIFY_ENTRY_MAX_MS > 0 &&
      syncLogVerifyMaxSteps >= sync.CATCH_UP_REQUEST_TIMEOUT_FRAMES &&
      syncLogVerifyMaxSteps <= sync.CATCH_UP_OFFER_TTL_FRAMES,
    'catch-up 日誌驗簽總上限 CATCH_UP_REQUEST_TIMEOUT_FRAMES ≤ ceil(最壞條目數 × 單筆上界 × HZ / 1000) ≤ CATCH_UP_OFFER_TTL_FRAMES',
  );
  // 追趕中背景恢復（issue 001108（1））：隱藏 2×STATE_BUFFER_MAX_FRAMES 幀內，每 peer 已驗佇列容得下每遠端
  // 每幀一則 input 加每 SNAPSHOT_INTERVAL_FRAMES 幀一則 checksum，延長追趕目標才不會漏收 live input
  assert(
    sync.VERIFIED_QUEUE_MAX_MESSAGES_PER_PEER * sync.SNAPSHOT_INTERVAL_FRAMES >=
      sync.STATE_BUFFER_MAX_FRAMES * 2 * (sync.SNAPSHOT_INTERVAL_FRAMES + 1),
    '已驗佇列每 peer 上限容得下 2×STATE_BUFFER_MAX_FRAMES 幀的 input＋checksum',
  );
  // catch-up 日誌驗簽分片（issue 001108（2）；本機政策）：每片預算須小於一個固定步的牆鐘時長
  assert(
    localPolicy.SYNC_LOG_VERIFY_SLICE_MS > 0 &&
      localPolicy.SYNC_LOG_VERIFY_SLICE_MS < 1000 / physics.FIXED_FRAMERATE_HZ,
    'catch-up 日誌驗簽每片預算 0 < 值 < 1000 / FIXED_FRAMERATE_HZ',
  );
  // 非同步驗簽逾時（issue 001118；本機政策）：至少容忍一個固定步的停頓，且在輸入延遲窗用完前改判
  assert(
    localPolicy.SIGNATURE_VERIFY_TIMEOUT_MS >= 1000 / physics.FIXED_FRAMERATE_HZ &&
      localPolicy.SIGNATURE_VERIFY_TIMEOUT_MS <=
        (sync.INPUT_DELAY_FRAMES * 1000) / physics.FIXED_FRAMERATE_HZ,
    '非同步驗簽逾時 1000 / FIXED_FRAMERATE_HZ ≤ 值 ≤ INPUT_DELAY_FRAMES × 1000 / FIXED_FRAMERATE_HZ',
  );
  // catch-up responder 重送（issue 001111；本機政策）：未交付至少重送一次，否則 requester 只能等逾時
  assert(localPolicy.SYNC_RESPONSE_RESEND_LIMIT >= 1, 'sync-response 未交付重送上限 ≥ 1');
  // catch-up front 夾限（issue 001107；本機政策）：觀測忽略門檻須涵蓋夾限裕度 D＋R，且不超過未來窗
  assert(
    localPolicy.CATCH_UP_MAX_OBSERVED_AHEAD_FRAMES >=
      sync.INPUT_DELAY_FRAMES + sync.ROLLBACK_FRAME_BUFFER_DEFAULT &&
      localPolicy.CATCH_UP_MAX_OBSERVED_AHEAD_FRAMES <= sync.STATE_BUFFER_MAX_FRAMES * 2,
    'catch-up 參考觀測超前忽略門檻 D＋R ≤ 值 ≤ STATE_BUFFER_MAX_FRAMES × 2',
  );
  // catch-up front 夾限下界（issue 001107；本機政策，依 mesh 實測誠實最小差 −3 取 −4）：
  // 須容許至少 1 幀抖動差，且嚴於上界裕度 D＋R
  assert(
    localPolicy.CATCH_UP_FRONT_BEHIND_TOLERANCE_FRAMES >= 1 &&
      localPolicy.CATCH_UP_FRONT_BEHIND_TOLERANCE_FRAMES <
        sync.INPUT_DELAY_FRAMES + sync.ROLLBACK_FRAME_BUFFER_DEFAULT,
    'catch-up front 下界容差 1 ≤ 值 < D＋R',
  );
  assert(
    sync.CATCH_UP_OFFER_CANDIDATES === 2 &&
      sync.STATE_BUFFER_MAX_FRAMES > sync.CATCH_UP_OFFER_ALIGNMENT_FRAMES,
    'catch-up offer 兩候選且 StateBuffer 可跨 alignment',
  );
  assert(
    sync.CATCH_UP_OFFER_MAX_ENTRIES >= matchmaking.PLAYERS_PER_RACE_MAX - 1,
    'offer cache entries ≥ 滿房遠端 peer 數',
  );
  assert(
    sync.CATCH_UP_OFFER_MAX_BYTES ===
      sync.CATCH_UP_OFFER_MAX_ENTRIES *
        sync.CATCH_UP_OFFER_CANDIDATES *
        sync.SYNC_SNAPSHOT_MAX_BYTES,
    'offer cache byte quota = entries × candidates × snapshot cap',
  );
  assert(
    sync.CATCH_UP_REQUEST_TIMEOUT_FRAMES < sync.CATCH_UP_OFFER_TTL_FRAMES &&
      sync.CATCH_UP_OFFER_TTL_FRAMES <= sync.CATCH_UP_MAX_ADVANCE_FRAMES,
    'offer request timeout < TTL ≤ catch-up horizon',
  );
  assert(
    sync.INGRESS_INPUT_TOKEN_REFILL_PER_SECOND >= 60 &&
      sync.INGRESS_INPUT_TOKEN_BUCKET_MESSAGES >= sync.INGRESS_INPUT_TOKEN_REFILL_PER_SECOND,
    'input ingress 持續率 ≥ 60Hz 且 burst ≥ 持續率',
  );
  assert(
    sync.INGRESS_CONTROL_TOKEN_REFILL_PER_SECOND < sync.INGRESS_INPUT_TOKEN_REFILL_PER_SECOND &&
      sync.INGRESS_CONTROL_TOKEN_BUCKET_MESSAGES <= sync.INGRESS_INPUT_TOKEN_BUCKET_MESSAGES,
    '低頻控制 ingress 不得借用 input 配額',
  );
  assert(
    sync.CATCH_UP_PROBE_REPLACE_AFTER_FRAMES ===
      sync.CATCH_UP_PROBE_TIMEOUT_FRAMES * sync.CATCH_UP_PROBE_RETRY_LIMIT &&
      sync.CATCH_UP_PROBE_REPLACE_AFTER_FRAMES < sync.CATCH_UP_OFFER_TTL_FRAMES,
    'probe replace = 最後一次 bounded retry 時點且小於 offer TTL',
  );
  assert(sync.CATCH_UP_REQUEST_TIMEOUT_FRAMES >= 180, 'catch-up snapshot timeout 至少 3 秒');

  // DataChannel 分段（issue 001093）
  const maxFragmentsPerMessage = (maxMessageBytes: number): number =>
    Math.ceil(maxMessageBytes / sync.DATA_CHANNEL_FRAGMENT_MIN_PAYLOAD_BYTES);
  assert(
    sync.DATA_CHANNEL_MESSAGE_FALLBACK_BYTES <= sync.DATA_CHANNEL_MESSAGE_SAFE_MAX_BYTES &&
      sync.DATA_CHANNEL_MESSAGE_FALLBACK_BYTES >=
        sync.DATA_CHANNEL_FRAGMENT_HEADER_BYTES + sync.DATA_CHANNEL_FRAGMENT_MIN_PAYLOAD_BYTES,
    'DataChannel 分段：最小段（標頭＋最小酬載）≤ 保守預設 ≤ 安全上限',
  );
  assert(
    sync.DATA_CHANNEL_REASSEMBLY_TIMEOUT_MS * physics.FIXED_FRAMERATE_HZ ===
      sync.CATCH_UP_REQUEST_TIMEOUT_FRAMES * 1_000,
    'DataChannel 重組逾時 = catch-up 完整快照請求逾時',
  );
  assert(
    sync.RACE_REASSEMBLY_MAX_BYTES_PER_PEER >= sync.RACE_MESSAGE_MAX_BYTES &&
      sync.INGRESS_TOKEN_BUCKET_BYTES >=
        sync.RACE_MESSAGE_MAX_BYTES +
          maxFragmentsPerMessage(sync.RACE_MESSAGE_MAX_BYTES) *
            sync.DATA_CHANNEL_FRAGMENT_HEADER_BYTES,
    'race 重組上限容得下最大 wire，且 byte bucket 容得下其全部分段',
  );
  assert(
    sync.CONTROL_REASSEMBLY_MAX_BYTES_PER_PEER >= sync.CONTROL_MESSAGE_MAX_BYTES &&
      sync.CONTROL_INGRESS_TOKEN_BUCKET_BYTES >=
        sync.CONTROL_MESSAGE_MAX_BYTES +
          maxFragmentsPerMessage(sync.CONTROL_MESSAGE_MAX_BYTES) *
            sync.DATA_CHANNEL_FRAGMENT_HEADER_BYTES,
    'control 重組上限容得下最大 wire，且 byte bucket 容得下其全部分段',
  );
  assert(
    sync.SPECTATOR_REASSEMBLY_MAX_BYTES_PER_PEER >= sync.SPECTATOR_REPLAY_WIRE_MAX_BYTES &&
      sync.SPECTATOR_SOURCE_INGRESS_TOKEN_BUCKET_BYTES >=
        sync.SPECTATOR_REPLAY_WIRE_MAX_BYTES +
          maxFragmentsPerMessage(sync.SPECTATOR_REPLAY_WIRE_MAX_BYTES) *
            sync.DATA_CHANNEL_FRAGMENT_HEADER_BYTES,
    'spectator 重組上限容得下最大 checkpoint，且 byte bucket 容得下其全部分段',
  );
  assert(
    sync.DATA_CHANNEL_SEND_BUFFER_MAX_BYTES >=
      sync.SPECTATOR_REPLAY_WIRE_MAX_BYTES +
        maxFragmentsPerMessage(sync.SPECTATOR_REPLAY_WIRE_MAX_BYTES) *
          sync.DATA_CHANNEL_FRAGMENT_HEADER_BYTES,
    'DataChannel 送出佇列上限容得下最大單一分段訊息',
  );

  // 配對
  assert(matchmaking.PLAYERS_PER_RACE_MIN <= matchmaking.PLAYERS_PER_RACE_MAX, '玩家數 min ≤ max');
  assert(
    matchmaking.PLAYERS_PER_RACE_MAX <= ugc.TRACK_MAX_PLAYERS_HARDCAP,
    '玩家數上限 ≤ 場地 hardcap',
  );

  // 比賽結構（多回合）
  assert(
    gameplay.MATCH_ROUND_COUNT_MIN <= gameplay.MATCH_ROUND_COUNT_DEFAULT &&
      gameplay.MATCH_ROUND_COUNT_DEFAULT <= gameplay.MATCH_ROUND_COUNT_MAX,
    '回合數 min ≤ default ≤ max',
  );

  // 重力（預設重力強度須落於場地 weather 合法域）
  const gravityStrength = Math.abs(physics.GRAVITY_X1000) / physics.INTEGER_SCALE;
  assert(gravityStrength >= 1.6 && gravityStrength <= 25, '重力強度 ∈ [1.6, 25] m/s²');
  assert(physics.PHYSICS_HARD_CCD_ENABLED, 'gameplay dynamic body 必須啟用 hard CCD');
  assert(
    Number.isSafeInteger(physics.PHYSICS_CCD_MAX_SUBSTEPS) &&
      physics.PHYSICS_CCD_MAX_SUBSTEPS >= 1 &&
      physics.PHYSICS_CCD_MAX_SUBSTEPS <= physics.MAX_SUBSTEPS,
    'CCD substeps 必須為 1..MAX_SUBSTEPS 的整數',
  );
  assert(
    physics.PHYSICS_CCD_PERSISTENT_CONTACT_POLICY === 2,
    'hard CCD 持續接觸必須只對固定目標改掃核心球（D-20261026-02、D-20261027-02）',
  );
  assert(
    physics.PHYSICS_CONTACT_NORMAL_ORDER_POLICY === 1,
    '接觸 normal 求解必須與點序無關（D-20261027-01）',
  );
  assert(
    Number.isFinite(physics.PHYSICS_SOFT_CCD_PREDICTION_M) &&
      physics.PHYSICS_SOFT_CCD_PREDICTION_M >= 0,
    'soft CCD prediction 必須為非負有限公尺值',
  );
  assert(
    Number.isFinite(physics.PROJECTILE_EXIT_CLEARANCE_M) && physics.PROJECTILE_EXIT_CLEARANCE_M > 0,
    'projectile LaunchExit clearance 必須為正有限公尺值',
  );

  // 物理 body 預算（碎片全為純視覺，不占 body 預算）
  assert(
    8 * 12 +
      8 * ugc.MAX_WEAPON_DRIVEN_BODIES +
      8 * ugc.LAUNCH_AMMO_COUNT_MAX +
      ugc.TRACK_ENTITY_COUNT_MAX <=
      physics.MAX_RIGID_BODIES_PER_RACE,
    'body 預算最壞情況 ≤ MAX_RIGID_BODIES_PER_RACE',
  );

  // 每回合 consensus anchor bounded collection
  assert(
    ledger.CONSENSUS_ANCHOR_FALLBACK_SLOT_MS > 0 &&
      ledger.CONSENSUS_ANCHOR_COLLECTION_TIMEOUT_MS > ledger.CONSENSUS_ANCHOR_FALLBACK_SLOT_MS * 4,
    'anchor collection window 必須容納 fallback slots',
  );

  // 帳本 Admission v1
  assert(
    Number.isSafeInteger(ledger.LEDGER_ADMISSION_VERSION) && ledger.LEDGER_ADMISSION_VERSION === 1,
    'Admission version 必須為整數 1',
  );
  assert(
    Number.isSafeInteger(ledger.LEDGER_ADMISSION_BASE_BITS) &&
      ledger.LEDGER_ADMISSION_BASE_BITS > 0 &&
      Number.isSafeInteger(ledger.LEDGER_ADMISSION_MAX_EXTRA_BITS) &&
      ledger.LEDGER_ADMISSION_MAX_EXTRA_BITS >= 0 &&
      ledger.LEDGER_ADMISSION_BASE_BITS + ledger.LEDGER_ADMISSION_MAX_EXTRA_BITS <= 255,
    'Admission difficulty 必須為 1–255 bits 的整數範圍',
  );
  assert(
    Number.isSafeInteger(ledger.LEDGER_ADMISSION_SIZE_UNIT_BYTES) &&
      ledger.LEDGER_ADMISSION_SIZE_UNIT_BYTES > 0 &&
      Number.isSafeInteger(ledger.LEDGER_ADMISSION_NONCE_BYTES) &&
      ledger.LEDGER_ADMISSION_NONCE_BYTES > 0,
    'Admission size unit 與 nonce bytes 必須為正整數',
  );
  assert(
    Number.isSafeInteger(ledger.LEDGER_ADMISSION_WORK_TIMEOUT_MS) &&
      ledger.LEDGER_ADMISSION_WORK_TIMEOUT_MS > 0 &&
      Number.isSafeInteger(ledger.LEDGER_ADMISSION_INTENT_QUEUE_MAX) &&
      ledger.LEDGER_ADMISSION_INTENT_QUEUE_MAX > 0,
    'Admission timeout 與 intent queue 必須為正整數',
  );
  assert(
    Number.isSafeInteger(ledger.LEDGER_ADMISSION_OUTBOX_MAX_ENTRIES) &&
      ledger.LEDGER_ADMISSION_OUTBOX_MAX_ENTRIES > 0 &&
      Number.isSafeInteger(ledger.LEDGER_ADMISSION_OUTBOX_MAX_BYTES) &&
      ledger.LEDGER_ADMISSION_OUTBOX_MAX_BYTES > 0 &&
      ledger.LEDGER_ADMISSION_OUTBOX_MAX_BYTES <= 128 * 1024 * 1024,
    'Admission outbox quota 必須為正整數且不超過 ledger blockstore quota',
  );

  return violations;
}
