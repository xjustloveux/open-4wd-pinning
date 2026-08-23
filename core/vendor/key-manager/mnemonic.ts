/**
 * BIP39 助記詞 — 生成預設 24 詞（256-bit）；驗證／恢復接受 12 或 24 詞
 */
import {
  generateMnemonic as bip39Generate,
  mnemonicToSeedSync,
  validateMnemonic as bip39Validate,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { Mnemonic } from '@open4wd/interfaces';

/** 產生 256-bit entropy 對應的 24 詞英文 BIP39 助記詞。 */
export function generateMnemonic(): Mnemonic {
  return bip39Generate(wordlist, 256); // 24 詞
}

/** 驗證 12 或 24 詞英文 BIP39 助記詞及 checksum。 */
export function validateMnemonic(mnemonic: Mnemonic): boolean {
  return bip39Validate(mnemonic, wordlist); // 12／24 皆可
}

/** 助記詞 → 32 bytes seed（BIP39 seed 前 32B＝Ed25519 私鑰） */
export function mnemonicToSeed(mnemonic: Mnemonic): Uint8Array {
  const full = mnemonicToSeedSync(mnemonic);
  const seed = full.slice(0, 32);
  full.fill(0); // 64B 原 buffer 用畢即歸零
  return seed;
}
