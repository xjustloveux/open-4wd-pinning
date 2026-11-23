import { describe, expect, it } from 'vitest';
import { Protocol, admissionBaseDigest, admissionWorkDigest, hasLeadingZeroBits } from '../core';
import { InlineAdmissionMiner } from './admission-miner';

describe('InlineAdmissionMiner', () => {
  it('對最小事件輸入挖出的 nonce 通過 vendored 的驗證述詞', async () => {
    const baseDigest = admissionBaseDigest(new TextEncoder().encode('minimal-event'));
    const requiredBits = 8; // 遠低於正式 18 bits，測試保持快速
    const nonce = await new InlineAdmissionMiner().mine(
      { baseDigest, requiredBits },
      new AbortController().signal,
    );
    expect(nonce).toBeInstanceOf(Uint8Array);
    expect(nonce.byteLength).toBe(Protocol.ledger.LEDGER_ADMISSION_NONCE_BYTES);
    expect(hasLeadingZeroBits(admissionWorkDigest(baseDigest, nonce), requiredBits)).toBe(true);
  });

  it('signal 已中止時立即拒絕、不產出 nonce', async () => {
    const controller = new AbortController();
    controller.abort();
    const baseDigest = admissionBaseDigest(new TextEncoder().encode('minimal-event'));
    await expect(
      new InlineAdmissionMiner().mine({ baseDigest, requiredBits: 8 }, controller.signal),
    ).rejects.toThrow();
  });

  it('挖礦中途 abort：requiredBits 設不可達高值，中止後迅速拒絕', async () => {
    const baseDigest = admissionBaseDigest(new TextEncoder().encode('minimal-event'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const startedAt = Date.now();
    // requiredBits=64 在測試時間尺度下不可能挖中，唯一能讓 mine 結束的路徑是 abort。
    await expect(
      new InlineAdmissionMiner().mine({ baseDigest, requiredBits: 64 }, controller.signal),
    ).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});
