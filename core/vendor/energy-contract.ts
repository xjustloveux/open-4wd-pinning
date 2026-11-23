import { Protocol } from '@open4wd/system-constants';

const UM3_PER_M3 = 1_000_000_000_000_000_000n;

/** 正規電池編輯解析度為一毫瓦。 */
export function configuredOutputMwFromW(valueW: number): number | null {
  if (!Number.isFinite(valueW) || valueW <= 0) return null;
  const valueMw = Math.round(valueW * 1_000);
  return Number.isSafeInteger(valueMw) && valueMw / 1_000 === valueW ? valueMw : null;
}

/** 依電池浮點立方公尺上限檢查毫瓦輸出。 */
export function batteryOutputWithinVolumeM3(configuredOutputMw: number, volumeM3: number): boolean {
  if (
    !Number.isSafeInteger(configuredOutputMw) ||
    configuredOutputMw <= 0 ||
    !Number.isFinite(volumeM3) ||
    volumeM3 <= 0
  )
    return false;
  return (
    configuredOutputMw <= Math.floor(volumeM3 * Protocol.physics.K_BATTERY_OUTPUT_W_M3 * 1_000)
  );
}

/** 相同幾何限制的精確帳本端形式，使用 fingerprint 的整數 μm³。 */
export function batteryOutputWithinVolumeUm3(
  configuredOutputW: number,
  volumeUm3: bigint,
): boolean {
  const configuredOutputMw = configuredOutputMwFromW(configuredOutputW);
  if (configuredOutputMw === null || volumeUm3 <= 0n) return false;
  return (
    BigInt(configuredOutputMw) * UM3_PER_M3 <=
    volumeUm3 * BigInt(Protocol.physics.K_BATTERY_OUTPUT_W_M3) * 1_000n
  );
}

/** 只有能源槽配置的合計百分比不超過 100 時才接受。 */
export function allocationSumWithinLimit(
  slots: readonly { readonly allocationPct: number }[],
): boolean {
  return slots.reduce((sum, slot) => sum + slot.allocationPct, 0) <= 100;
}
