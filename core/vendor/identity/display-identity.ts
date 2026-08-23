import type { PeerId } from '@open4wd/interfaces';
import { sha256 } from '@noble/hashes/sha2.js';

/** 遠端人物的非權威暱稱快照與已驗 PeerId 指紋呈現。 */
export interface DisplayIdentity {
  readonly fingerprint: string;
  readonly nicknameSnapshot: string | null;
  readonly label: string;
}

/** profile 與 wire 共用的暱稱 canonical 驗證結果。 */
export type NicknameValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'empty' | 'too-long' };

const encoder = new TextEncoder();
const MAX_NICKNAME_UNITS = 24;
const FORBIDDEN_NICKNAME_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 由完整 PeerId 產生固定八碼，避免共同 multibase 前綴失去辨識力。 */
export function peerFingerprint(peer: PeerId): string {
  return hex(sha256(encoder.encode(peer)).subarray(0, 4));
}

function displayUnits(character: string): number {
  const point = character.codePointAt(0) ?? 0;
  return point <= 0xff || (point >= 0xff61 && point <= 0xff9f) || character === '…' ? 1 : 2;
}

function cleanNicknameSnapshot(value: string): string {
  return value.normalize('NFC').replace(FORBIDDEN_NICKNAME_CHARACTERS, '').trim();
}

function nicknameUnits(value: string): number {
  return Array.from(value).reduce((total, character) => total + displayUnits(character), 0);
}

/** 驗證本機 profile 暱稱快照的非空與可見長度上限。 */
export function validateNicknameSnapshot(value: string): NicknameValidation {
  const cleaned = cleanNicknameSnapshot(value);
  if (cleaned.length === 0) return { ok: false, reason: 'empty' };
  if (nicknameUnits(cleaned) > MAX_NICKNAME_UNITS) return { ok: false, reason: 'too-long' };
  return { ok: true, value: cleaned };
}

/** 防禦性清理遠端快照，超過顯示上限時保留省略號。 */
export function formatNicknameSnapshot(value: string): string {
  const cleaned = cleanNicknameSnapshot(value);
  if (nicknameUnits(cleaned) <= MAX_NICKNAME_UNITS) return cleaned;
  let used = 0;
  let result = '';
  for (const character of cleaned) {
    const units = displayUnits(character);
    if (used + units + 1 > MAX_NICKNAME_UNITS) break;
    result += character;
    used += units;
  }
  return `${result}…`;
}

/** 暱稱只是呈現快照；指紋才與已驗 PeerId 綁定。 */
export function resolveDisplayIdentity(
  peer: PeerId,
  nicknameSnapshot?: string | null,
): DisplayIdentity {
  const fingerprint = peerFingerprint(peer);
  const nickname =
    nicknameSnapshot == null ? null : formatNicknameSnapshot(nicknameSnapshot) || null;
  return {
    fingerprint,
    nicknameSnapshot: nickname,
    label: nickname === null ? `#${fingerprint}` : `${nickname} #${fingerprint}`,
  };
}
