import { Protocol } from '@open4wd/system-constants';

const UM3_PER_M3 = 1_000_000_000_000_000_000;
const CHIP_SLOT_VOLUME_THRESHOLDS_UM3 = Protocol.ugc.CHIP_SLOT_VOLUME_THRESHOLDS_M3.map(
  (thresholdM3) => BigInt(Math.round(thresholdM3 * UM3_PER_M3)),
);

/** 以 canonical 整數體積重算晶片可用槽數。 */
export function deriveChipSlotCountFromVolumeUm3(volumeUm3: bigint | number): number {
  const canonicalVolumeUm3 = typeof volumeUm3 === 'bigint' ? volumeUm3 : BigInt(volumeUm3);
  let slots = 1;
  for (const thresholdUm3 of CHIP_SLOT_VOLUME_THRESHOLDS_UM3)
    if (canonicalVolumeUm3 >= thresholdUm3) slots++;
  return slots;
}

/** 編輯器浮點幾何在量化後使用同一份晶片槽數契約。 */
export function deriveChipSlotCount(volumeM3: number): number {
  return deriveChipSlotCountFromVolumeUm3(BigInt(Math.round(volumeM3 * UM3_PER_M3)));
}
