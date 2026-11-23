import { describe, expect, it } from 'vitest';
import { verifyPinRequest, NonceCache, type PinPayload } from './signed-request';
import { makeSigner, signPinBody } from './auth.test-support';

const NOW = 1_700_000_000_000;

describe('verifyPinRequest', () => {
  it.each(['part', 'track'] as const)('接受共享 API category：%s', async (category) => {
    const s = await makeSigner(1);
    const body = await signPinBody(
      s,
      { type: 'pinning-pin', cid: 'bafyA', category, sizeHintBytes: 1 },
      NOW,
    );
    expect(verifyPinRequest(body, NOW, new NonceCache()).ok).toBe(true);
  });

  it('拒絕共享 API 詞彙以外的 category，即使簽章本身正確', async () => {
    const s = await makeSigner(1);
    const body = await signPinBody(
      s,
      {
        type: 'pinning-pin',
        cid: 'bafyA',
        category: 'metrics-cardinality-bomb',
        sizeHintBytes: 1,
      } as unknown as PinPayload,
      NOW,
    );
    expect(verifyPinRequest(body, NOW, new NonceCache())).toEqual({
      ok: false,
      code: 'SIG_INVALID',
    });
  });

  it('合法 pin 請求通過並回 signer 與 payload', async () => {
    const s = await makeSigner(1);
    const body = await signPinBody(
      s,
      { type: 'pinning-pin', cid: 'bafyA', category: 'part', sizeHintBytes: 42 },
      NOW,
    );
    const r = verifyPinRequest(body, NOW, new NonceCache());
    expect(r).toMatchObject({ ok: true, signer: s.peerId, payload: { cid: 'bafyA' } });
  });

  it('sizeHintBytes 必須是正整數；0 不再能通過簽章請求形狀檢查', async () => {
    const s = await makeSigner(1);
    const body = await signPinBody(
      s,
      { type: 'pinning-pin', cid: 'bafyA', category: 'part', sizeHintBytes: 0 },
      NOW,
    );
    expect(verifyPinRequest(body, NOW, new NonceCache())).toEqual({
      ok: false,
      code: 'SIG_INVALID',
    });
  });

  it('pin 簽章重放成 unpin＝拒（type 域分隔）', async () => {
    const s = await makeSigner(1);
    const body = await signPinBody(
      s,
      { type: 'pinning-pin', cid: 'bafyA', category: 'part', sizeHintBytes: 1 },
      NOW,
    );
    const forged = { ...body, payload: { type: 'pinning-unpin', cid: 'bafyA' } };
    expect(verifyPinRequest(forged, NOW, new NonceCache()).ok).toBe(false);
  });

  it('時戳窗：±30s 恰界內過、+30,001ms 拒', async () => {
    const s = await makeSigner(1);
    const body = await signPinBody(s, { type: 'pinning-unpin', cid: 'bafyA' }, NOW);
    expect(verifyPinRequest(body, NOW + 30_000, new NonceCache()).ok).toBe(true);
    expect(verifyPinRequest(body, NOW + 30_001, new NonceCache()).ok).toBe(false);
  });

  it('同 nonce 重送拒；不同 signer 同 nonce 各自獨立', async () => {
    const a = await makeSigner(1);
    const b = await makeSigner(2);
    const nonces = new NonceCache();
    const bodyA = await signPinBody(a, { type: 'pinning-unpin', cid: 'x' }, NOW);
    expect(verifyPinRequest(bodyA, NOW, nonces).ok).toBe(true);
    expect(verifyPinRequest(bodyA, NOW, nonces).ok).toBe(false);
    const bodyB = await signPinBody(
      b,
      { type: 'pinning-unpin', cid: 'x' },
      NOW,
      // nonce 維持 Uint8Array：SignedBody.nonce 與 vendored SignedPayload<T> 介面一致，若轉型為
      // string 會因兩型別互不重疊而編譯失敗。
      (bodyA as { nonce: Uint8Array }).nonce,
    );
    expect(verifyPinRequest(bodyB, NOW, nonces).ok).toBe(true);
  });

  it('竄改 payload 任一欄＝SIG_INVALID', async () => {
    const s = await makeSigner(1);
    const body = await signPinBody(
      s,
      { type: 'pinning-pin', cid: 'bafyA', category: 'part', sizeHintBytes: 1 },
      NOW,
    );
    const tampered = {
      ...body,
      payload: { ...(body as { payload: object }).payload, cid: 'bafyB' },
    };
    expect(verifyPinRequest(tampered, NOW, new NonceCache())).toEqual({
      ok: false,
      code: 'SIG_INVALID',
    });
  });

  it('亂簽章的請求不佔 nonce：壞簽章不擋後續同 nonce 真簽章', async () => {
    const s = await makeSigner(1);
    const nonces = new NonceCache();
    const body = await signPinBody(s, { type: 'pinning-unpin', cid: 'x' }, NOW);
    const forgedSignature = {
      ...body,
      // 竄改一個 byte，與原簽章必然不同；同 signer／同 nonce，只有簽章是假的
      signature: Uint8Array.from(body.signature, (b, i) => (i === 0 ? b ^ 0xff : b)),
    };
    expect(verifyPinRequest(forgedSignature, NOW, nonces).ok).toBe(false);
    // 若收錄動作發生在驗章之前，上一行就會先佔用這組 (signer, nonce)，害下面這筆合法同 nonce
    // 的真訊息被誤判重放而拒收；此案直接證明收錄已延後到驗章通過之後才發生。
    expect(verifyPinRequest(body, NOW, nonces).ok).toBe(true);
  });

  it('garbage body 不 throw：null／不成形物件／簽章欄非 Uint8Array 皆回 SIG_INVALID', () => {
    const nonces = new NonceCache();
    expect(verifyPinRequest(null, NOW, nonces)).toEqual({ ok: false, code: 'SIG_INVALID' });
    expect(verifyPinRequest({ a: 1 }, NOW, nonces)).toEqual({ ok: false, code: 'SIG_INVALID' });
    expect(
      verifyPinRequest(
        {
          payload: { type: 'pinning-unpin', cid: 'x' },
          timestamp: NOW,
          nonce: new Uint8Array(16),
          signer: 'peerX',
          signature: 'deadbeef', // 非 Uint8Array（例如漏做 wire 層 hex 解碼）——結構檢查應擋下、不拋例外
        },
        NOW,
        nonces,
      ),
    ).toEqual({ ok: false, code: 'SIG_INVALID' });
  });
});

describe('NonceCache', () => {
  it('TTL 逐出：add 後經過 2×容忍窗＋1ms，has() 回 false', () => {
    const nonces = new NonceCache();
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    expect(nonces.add('peerX', nonce, NOW)).toBe(true);
    expect(nonces.has('peerX', nonce, NOW)).toBe(true);
    // 容忍窗 30s；TTL＝2×容忍窗＝60s，故 60,001ms 後應已被剪枝逐出
    expect(nonces.has('peerX', nonce, NOW + 60_001)).toBe(false);
  });

  it('硬頂 fail-closed：滿載時新項目被拒、既有項目不被逐出', () => {
    const nonces = new NonceCache(2); // 小值注入，不需真填協定常數的滿量
    const n1 = crypto.getRandomValues(new Uint8Array(16));
    const n2 = crypto.getRandomValues(new Uint8Array(16));
    const n3 = crypto.getRandomValues(new Uint8Array(16));
    expect(nonces.add('peerX', n1, NOW)).toBe(true);
    expect(nonces.add('peerX', n2, NOW)).toBe(true);
    // 滿載——與 vendored NonceSet.add 同語意：拒收新項目，不逐出任何既有項目
    expect(nonces.add('peerX', n3, NOW)).toBe(false);
    expect(nonces.has('peerX', n1, NOW)).toBe(true);
    expect(nonces.has('peerX', n2, NOW)).toBe(true);
    expect(nonces.has('peerX', n3, NOW)).toBe(false);
  });
});
