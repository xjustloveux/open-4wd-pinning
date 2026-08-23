import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicKeyToPeerId } from '../core';
import { makeInitialCheckpointProofBundleFixture } from './initial-checkpoint-proof-bundle.test-support';
import { serializeInitialCheckpointProofBundle } from './initial-checkpoint-proof-bundle';
import { parseGenesisConfig } from './ledger-genesis-config';

async function validEnv(): Promise<NodeJS.ProcessEnv> {
  const identity = await generateKeyPair('Ed25519');
  const signer = await generateKeyPair('Ed25519');
  return {
    GENESIS_DATA_DIR: 'genesis-data',
    GENESIS_RECEIPT_PATH: 'genesis-receipt.json',
    GENESIS_LISTEN: '/ip4/127.0.0.1/tcp/4001/ws',
    GOVERNANCE_SIGNERS: publicKeyToPeerId(signer.publicKey.raw),
    BOOTSTRAP_PEER_PRIVKEY: Buffer.from(privateKeyToProtobuf(identity)).toString('base64'),
    GENESIS_RELEASE_COMMIT: '0123456789abcdef0123456789abcdef01234567',
    DATA_DIR: 'replica-data',
  };
}

describe('parseGenesisConfig', () => {
  it('接受持久 identity、listen、N=1 signer 與 immutable release commit', async () => {
    const config = await parseGenesisConfig(await validEnv(), []);
    expect(config.listen).toEqual(['/ip4/127.0.0.1/tcp/4001/ws']);
    expect(config.governanceSigners.size).toBe(1);
    expect(config.releaseCommit).toBe('0123456789abcdef0123456789abcdef01234567');
  });

  it.each([
    ['GENESIS_DATA_DIR', ''],
    ['GENESIS_RECEIPT_PATH', ''],
    ['GENESIS_LISTEN', ''],
    ['GOVERNANCE_SIGNERS', ''],
    ['BOOTSTRAP_PEER_PRIVKEY', ''],
    ['GENESIS_RELEASE_COMMIT', 'master'],
  ])('%s 缺失或無效時 fail closed', async (key, value) => {
    const env = await validEnv();
    env[key] = value;
    await expect(parseGenesisConfig(env, [])).rejects.toThrow();
  });

  it('拒絕 N=2、duplicate／invalid signer 與 genesis/replica 目錄碰撞', async () => {
    const env = await validEnv();
    const second = await generateKeyPair('Ed25519');
    env['GOVERNANCE_SIGNERS'] += `,${publicKeyToPeerId(second.publicKey.raw)}`;
    await expect(parseGenesisConfig(env, [])).rejects.toThrow(/1 or at least 3/);

    const duplicate = await validEnv();
    duplicate['GOVERNANCE_SIGNERS'] += `,${duplicate['GOVERNANCE_SIGNERS']}`;
    await expect(parseGenesisConfig(duplicate, [])).rejects.toThrow(/duplicate/);

    const invalid = await validEnv();
    invalid['GOVERNANCE_SIGNERS'] = 'not-a-peer-id';
    await expect(parseGenesisConfig(invalid, [])).rejects.toThrow(/PeerId/);

    const collision = await validEnv();
    collision['DATA_DIR'] = collision['GENESIS_DATA_DIR'];
    await expect(parseGenesisConfig(collision, [])).rejects.toThrow(/distinct/);
  });

  it('載入且完整離線驗證 rebirth bundle，並要求目標治理 signer 完全一致', async () => {
    const { bundle, proof } = await makeInitialCheckpointProofBundleFixture();
    const root = await mkdtemp(join(tmpdir(), 'o4wd-rebirth-config-'));
    const bundlePath = join(root, 'proof-bundle.json');
    await writeFile(bundlePath, serializeInitialCheckpointProofBundle(bundle));
    const env = await validEnv();
    env['GOVERNANCE_SIGNERS'] = proof.targetGovernanceSigners.join(',');
    env['GENESIS_INITIAL_CHECKPOINT_BUNDLE_PATH'] = bundlePath;

    const config = await parseGenesisConfig(env, []);
    expect(config.initialCheckpointProof?.commitment).toBe(proof.commitment);
    expect(config.initialCheckpointProofBlocks?.size).toBe(bundle.blocks.length);

    const mismatch = await validEnv();
    mismatch['GENESIS_INITIAL_CHECKPOINT_BUNDLE_PATH'] = bundlePath;
    await expect(parseGenesisConfig(mismatch, [])).rejects.toThrow(/governance signer/u);
  });
});
