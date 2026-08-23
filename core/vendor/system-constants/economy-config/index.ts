/**
 * 治理 signer 數量的純計算 helper。完整 EconomyConfig 與 genesis authority 位於
 * `src/economy/config.ts`；system-constants 不保存第二份 config shape 或預設值。
 */

/** 合法 signer set 只允許單人 bootstrap 或 3+；兩人配置拒絕。 */
export const governanceQuorum = (signerCount: number): number => {
  if (!Number.isInteger(signerCount) || signerCount < 1 || signerCount === 2)
    throw new Error('Invalid governance signer count');
  return signerCount === 1 ? 1 : Math.floor((2 * signerCount) / 3) + 1;
};
