/**
 * PIN 暴力破解防護 — 連錯 5 次鎖 30 分鐘
 * 本地 UI 防護（單機暴力破解），非共識路徑——可用機器時鐘
 */
import type { KeyManagerError, KeyPair, Result } from '@open4wd/interfaces';
import { err, ok } from '@open4wd/interfaces';
import { decryptSeed } from './seed-crypto';
import { deriveKeyPair } from './ed25519';
import type { ProfileStore } from './profile-store';

/** 單一 profile 在進入本地鎖定前允許的連續錯誤次數。 */
export const PIN_MAX_ATTEMPTS = 5;
/** 達錯誤上限後的本地 PIN 鎖定時間。 */
export const PIN_LOCK_DURATION_MS = 30 * 60 * 1000; // 30 分鐘

/** 嘗試解密 profile seed，並原子更新錯誤次數與鎖定期限。 */
export async function tryUnlock(
  store: ProfileStore,
  profileId: string,
  pin: string,
  now: () => number,
): Promise<Result<KeyPair, KeyManagerError>> {
  // store 讀寫（IndexedDB）reject 一律收斂為 storage-error——本函式宣告不外拋
  try {
    const profile = await store.get(profileId);
    if (!profile) return err({ code: 'profile-not-found' });

    if (now() < profile.lockedUntil) {
      return err({
        code: 'pin-locked',
        remainingMinutes: Math.ceil((profile.lockedUntil - now()) / 60000),
      });
    }

    const result = await decryptSeed(profile.encryptedSeed, pin);
    if (result.ok) {
      await store.update(profileId, { pinAttempts: 0, lockedUntil: 0 });
      return ok(deriveKeyPair(result.value));
    }

    const attempts = profile.pinAttempts + 1;
    if (attempts >= PIN_MAX_ATTEMPTS) {
      await store.update(profileId, {
        pinAttempts: attempts,
        lockedUntil: now() + PIN_LOCK_DURATION_MS,
      });
      return err({ code: 'pin-locked-now', lockMinutes: PIN_LOCK_DURATION_MS / 60000 });
    }
    await store.update(profileId, { pinAttempts: attempts });
    return err({ code: 'pin-invalid', attemptsLeft: PIN_MAX_ATTEMPTS - attempts });
  } catch {
    return err({ code: 'storage-error' });
  }
}
