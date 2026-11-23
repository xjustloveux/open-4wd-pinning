/**
 * libp2p 身分橋接 — 以 key-manager 的 Ed25519 seed 確定性派生 libp2p PrivateKey：
 * 同一把鑰匙、兩種表示（app 層 PeerId＝'z'＋base58(0xed01‖pub)、libp2p PeerId＝
 * multihash base58btc）。不另生身分、不落盤；型別經 Libp2pOptions 萃取（@libp2p/interface
 * 非直接依賴、不得直 import）。
 */
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import type { Libp2pOptions } from 'libp2p';

/** 從 libp2p node 選項萃取、避免額外直接依賴的私鑰型別。 */
export type Libp2pPrivateKey = NonNullable<Libp2pOptions['privateKey']>;

/** 從應用程式 Ed25519 seed 確定性建立同一身分的 libp2p 私鑰。 */
export async function libp2pPrivateKeyFromSeed(seed: Uint8Array): Promise<Libp2pPrivateKey> {
  return generateKeyPairFromSeed('Ed25519', seed);
}
