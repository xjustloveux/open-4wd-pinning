import { randomBytes } from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { describe, expect, it } from 'vitest';
import { buildSignedMessage, publicKeyToPeerId, verifySignedPayload, type PeerId } from '../core';
import { createDmcaInboxCrypto, decodeSignedInboxWire } from './signed-inbox';

async function signedRequest(providerId: PeerId, timestamp: number) {
  const key = await generateKeyPair('Ed25519');
  const signer = publicKeyToPeerId(key.publicKey.raw) as PeerId;
  const payload = {
    type: 'open4wd-provider-dmca-inbox-request' as const,
    providerId,
    subjectPeerId: signer,
  };
  const nonce = randomBytes(16);
  const signature = await key.sign(buildSignedMessage(payload, timestamp, nonce, signer));
  return {
    key,
    signer,
    wire: {
      payload,
      timestamp,
      nonceHex: Buffer.from(nonce).toString('hex'),
      signer,
      signatureHex: Buffer.from(signature).toString('hex'),
    },
  };
}

describe('provider-signed DMCA inbox envelope', () => {
  it('驗證 requester 身分/provider/freshness 並拒絕同 nonce 重放', async () => {
    const providerKey = await generateKeyPair('Ed25519');
    const providerId = publicKeyToPeerId(providerKey.publicKey.raw) as PeerId;
    const now = 1_700_000_000_000;
    const crypto = createDmcaInboxCrypto({
      providerId,
      now: () => now,
      randomNonce: () => randomBytes(16),
      sign: (message) => Promise.resolve(providerKey.sign(message)),
    });
    const { signer, wire } = await signedRequest(providerId, now);

    expect(crypto.verifyRequest(wire)).toEqual({ subjectPeerId: signer });
    expect(crypto.verifyRequest(wire)).toBeNull();
    expect(crypto.verifyRequest({ ...wire, timestamp: now - 10 * 60_000 })).toBeNull();
    expect(
      crypto.verifyRequest({
        ...wire,
        payload: { ...wire.payload, providerId: signer },
      }),
    ).toBeNull();
  });

  it('response 由 provider 簽章且 JSON wire 可無損解回驗章', async () => {
    const providerKey = await generateKeyPair('Ed25519');
    const providerId = publicKeyToPeerId(providerKey.publicKey.raw) as PeerId;
    const now = 1_700_000_000_000;
    const crypto = createDmcaInboxCrypto({
      providerId,
      now: () => now,
      randomNonce: () => new Uint8Array(16).fill(7),
      sign: (message) => Promise.resolve(providerKey.sign(message)),
    });
    const payload = {
      type: 'open4wd-provider-dmca-inbox' as const,
      providerId,
      subjectPeerId: providerId,
      generatedAt: now,
      entries: [],
    };

    const wire = await crypto.signResponse(payload);
    const decoded = decodeSignedInboxWire(wire);
    expect(decoded?.signer).toBe(providerId);
    expect(decoded === null ? false : verifySignedPayload(decoded)).toBe(true);
  });
});
