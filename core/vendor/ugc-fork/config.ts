/**
 * Fork 偵測門檻——原創／fork 的經濟邊界、
 * 屬 EconomyConfig.forkDetection（治理 ConfigUpdateEvent 可調、隨
 * economy_config_version 版控）。⭐判定演算法／指紋版本屬 derive_logic（client
 * 發版、FINGERPRINT_VERSION 常數）、與門檻治理**分離**。
 */

export interface ForkThreshold {
  /** 差異 < strict ＝強制 fork */
  strict: number;
  /** diff ≥ loose ＝ pass-through（原創）；介於＝suggest-fork */
  loose: number;
}

/** fork 偵測的候選窗口、距離與量化門檻設定。 */
export interface ForkDetectionConfig {
  stage1_geometry: {
    /** 幾何快篩：≥ 此值＝不像、跳過 Stage 2 */
    passthrough_threshold: number;
  };
  stage2_physics: {
    /** 底盤／車身／武器 */
    rigid: ForkThreshold;
    /** 輪胎／滾輪 */
    rolling: ForkThreshold;
    functional_mesh: ForkThreshold;
    functional_sidecar: ForkThreshold;
    chip_mesh: ForkThreshold;
    chip_skill: ForkThreshold;
    track: ForkThreshold;
  };
}

/** genesis 門檻 */
export const FORK_DETECTION_DEFAULTS: ForkDetectionConfig = {
  stage1_geometry: { passthrough_threshold: 0.1 },
  stage2_physics: {
    rigid: { strict: 0.08, loose: 0.15 },
    rolling: { strict: 0.05, loose: 0.1 },
    functional_mesh: { strict: 0.08, loose: 0.15 },
    functional_sidecar: { strict: 0.1, loose: 0.2 },
    chip_mesh: { strict: 0.05, loose: 0.15 },
    chip_skill: { strict: 0.05, loose: 0.25 },
    track: { strict: 0.1, loose: 0.2 },
  },
};

/** 指紋算法版本（derive_logic、隨 client 發版 +1；舊作品鎖原版、跨版本比對一律放行） */
export const FINGERPRINT_VERSION = 1;
