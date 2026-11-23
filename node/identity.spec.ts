import { describe, expect, it, vi } from 'vitest';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { Buffer } from 'node:buffer';
import { loadIdentity } from './identity';

describe('loadIdentity', () => {
  it('未設 BOOTSTRAP_PEER_PRIVKEY 時回隨機臨時身分，兩次呼叫不同並發出警告', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const a = await loadIdentity({});
      const b = await loadIdentity({});
      expect(a.publicKey.raw).not.toEqual(b.publicKey.raw);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('BOOTSTRAP_PEER_PRIVKEY＝protobuf 私鑰 base64 時還原出同一 publicKey', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const original = await generateKeyPair('Ed25519');
      const base64 = Buffer.from(privateKeyToProtobuf(original)).toString('base64');
      const restored = await loadIdentity({ BOOTSTRAP_PEER_PRIVKEY: base64 });
      expect(restored.publicKey.raw).toEqual(original.publicKey.raw);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
