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

/** 逐條檢查、回傳違反清單（空＝全過） */
export function checkInvariants(): string[] {
  const violations: string[] = [];
  const assert = (cond: boolean, label: string): void => {
    if (!cond) violations.push(label);
  };

  // 使用者生成內容
  assert(ugc.VEHICLE_TOTAL_MASS_MIN_GRAMS < ugc.VEHICLE_TOTAL_MASS_MAX_GRAMS, '整車質量 min < max');

  // 網路（三角形不變式）
  assert(
    sync.ROLLBACK_FRAME_BUFFER_MIN <= sync.ROLLBACK_FRAME_BUFFER_DEFAULT &&
      sync.ROLLBACK_FRAME_BUFFER_DEFAULT <= sync.ROLLBACK_FRAME_BUFFER_MAX,
    'rollback buffer min ≤ default ≤ max',
  );
  assert(
    sync.STATE_BUFFER_MAX_FRAMES >= sync.ROLLBACK_FRAME_BUFFER_MAX,
    'StateBuffer 容量 ≥ 回滾視窗',
  );
  assert(
    sync.CATCH_UP_OFFER_ALIGNMENT_FRAMES === sync.ROLLBACK_FRAME_BUFFER_DEFAULT,
    'catch-up offer alignment = rollback default',
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
  assert(sync.CATCH_UP_REQUEST_TIMEOUT_FRAMES >= 180, '4 MiB snapshot timeout 至少 3 秒');

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
