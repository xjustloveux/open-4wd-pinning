/**
 * Node 端 libp2p 身分載入——BOOTSTRAP_PEER_PRIVKEY 對齊 kubo Identity.PrivKey
 * 格式（protobuf 序列化私鑰的 base64），直接還原成 libp2p 身分；未設定時退回
 * 隨機臨時身分（僅供開發，重啟即變）並警告。回傳型別借道 core 已匯出的
 * libp2pPrivateKeyFromSeed 回推，避免直接 import 未宣告於 package.json 的
 * @libp2p/interface（pnpm 隔離式 node_modules 下無法解析）。
 */
import { generateKeyPair, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { Buffer } from 'node:buffer';
import { libp2pPrivateKeyFromSeed } from '../core';

/** 表示服務 libp2p 節點接受的私鑰形狀。 */
export type NodePrivateKey = Awaited<ReturnType<typeof libp2pPrivateKeyFromSeed>>;

/** 還原設定的 protobuf 金鑰，或建立臨時開發身分。 */
export async function loadIdentity(env: NodeJS.ProcessEnv): Promise<NodePrivateKey> {
  const raw = env['BOOTSTRAP_PEER_PRIVKEY'];
  if (raw !== undefined && raw.trim() !== '')
    return privateKeyFromProtobuf(Buffer.from(raw.trim(), 'base64'));
  console.warn('BOOTSTRAP_PEER_PRIVKEY 未設定——使用隨機臨時身分（重啟即變，僅供開發）');
  return generateKeyPair('Ed25519');
}
