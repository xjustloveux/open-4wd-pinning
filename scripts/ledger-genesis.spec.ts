import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { libp2pPrivateKeyFromSeed, publicKeyToPeerId, type PeerId } from '../core';
import type { GenesisConfig } from './ledger-genesis-config';
import { makeInitialCheckpointProofBundleFixture } from './initial-checkpoint-proof-bundle.test-support';
import { runLedgerGenesis } from './ledger-genesis';

async function config(root: string): Promise<GenesisConfig> {
  const privateKey = await libp2pPrivateKeyFromSeed(new Uint8Array(32).fill(7));
  return {
    dataDir: join(root, 'data'),
    receiptPath: join(root, 'receipt.json'),
    listen: ['/memory/genesis-operation'],
    bootstrap: [],
    governanceSigners: new Set(['12D3KooWGenesisSigner'] as PeerId[]),
    privateKey,
    releaseCommit: '0123456789abcdef0123456789abcdef01234567',
  };
}

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

// 驗證規則：〔LEDGER-R-090〕
describe('runLedgerGenesis', () => {
  it('建立後以 exact address 重開驗證，再原子發布 public receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'o4wd-genesis-operation-'));
    const input = await config(root);
    const close = vi.fn(async () => undefined);
    const startNode = vi
      .fn()
      .mockResolvedValueOnce({ ledger: { ledgerAddress: '/orbitdb/zdummy' }, close })
      .mockResolvedValueOnce({ ledger: { ledgerAddress: '/orbitdb/zdummy' }, close });
    const now = vi.fn(() => new Date('2026-07-28T00:00:00.000Z'));

    const receipt = await runLedgerGenesis(input, {
      startNode,
      now,
      validateAddress: (value) => value,
    });

    expect(startNode).toHaveBeenCalledTimes(2);
    expect(startNode.mock.calls[0]![0].ledgerDbAddress).toBeUndefined();
    expect(startNode.mock.calls[1]![0].ledgerDbAddress).toBe('/orbitdb/zdummy');
    expect(startNode.mock.calls[0]![0].genesisTimestamp).toBe(1785196800000);
    expect(startNode.mock.calls[1]![0].genesisTimestamp).toBe(1785196800000);
    expect(now).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(2);
    expect(receipt.genesisPeerId).toBe(publicKeyToPeerId(input.privateKey.publicKey.raw));
    expect(receipt.genesisTimestamp).toBe(1785196800000);
    expect(JSON.parse(await readFile(input.receiptPath, 'utf8'))).toEqual(receipt);
  });

  it('既有 receipt 或 occupied data dir 在 node 建立前拒絕', async () => {
    for (const occupied of ['receipt', 'data']) {
      const root = await mkdtemp(join(tmpdir(), 'o4wd-genesis-occupied-'));
      const input = await config(root);
      if (occupied === 'receipt') await writeFile(input.receiptPath, '{}');
      else {
        await mkdir(input.dataDir);
        await writeFile(join(input.dataDir, 'unknown'), 'partial');
      }
      const startNode = vi.fn();
      await expect(runLedgerGenesis(input, { startNode })).rejects.toThrow(/already exists|empty/);
      expect(startNode).not.toHaveBeenCalled();
    }
  });

  it('open 失敗時不寫 receipt，保留 partial data 供人工復原', async () => {
    const root = await mkdtemp(join(tmpdir(), 'o4wd-genesis-failure-'));
    const input = await config(root);
    await expect(
      runLedgerGenesis(input, {
        startNode: vi.fn(async () => Promise.reject(new Error('open failed'))),
      }),
    ).rejects.toThrow('open failed');
    expect(await exists(input.receiptPath)).toBe(false);
    expect(await exists(input.dataDir)).toBe(true);
  });

  it('rebirth 只傳 proof 與已離線驗證 blocks，並在 receipt 公開 ceremony cut point', async () => {
    const root = await mkdtemp(join(tmpdir(), 'o4wd-genesis-rebirth-'));
    const base = await config(root);
    const { proof, blocks } = await makeInitialCheckpointProofBundleFixture();
    const input: GenesisConfig = {
      ...base,
      governanceSigners: new Set(proof.targetGovernanceSigners),
      initialCheckpointProof: proof,
      initialCheckpointProofBlocks: blocks,
    };
    const close = vi.fn(async () => undefined);
    const startNode = vi
      .fn()
      .mockResolvedValueOnce({ ledger: { ledgerAddress: '/orbitdb/zreborn' }, close })
      .mockResolvedValueOnce({ ledger: { ledgerAddress: '/orbitdb/zreborn' }, close });

    const receipt = await runLedgerGenesis(input, {
      startNode,
      validateAddress: (value) => value,
    });

    for (const [nodeInput] of startNode.mock.calls) {
      expect(nodeInput.genesisGovernanceSigners).toBeUndefined();
      expect(nodeInput.initialCheckpointProof).toBe(proof);
      expect(nodeInput.initialCheckpointProofBlocks).toBe(blocks);
    }
    expect(receipt.genesisMode).toBe('rebirth');
    expect(receipt.initialCheckpointProof?.commitment).toBe(proof.commitment);
    expect(receipt.initialCheckpointProof?.sourceCheckpointCid).toBe(proof.checkpointCid);
  });

  it('拒絕 rebirth 產生與來源相同的 ledger address', async () => {
    const root = await mkdtemp(join(tmpdir(), 'o4wd-genesis-rebirth-cycle-'));
    const base = await config(root);
    const { proof, blocks } = await makeInitialCheckpointProofBundleFixture();
    const input: GenesisConfig = {
      ...base,
      governanceSigners: new Set(proof.targetGovernanceSigners),
      initialCheckpointProof: proof,
      initialCheckpointProofBlocks: blocks,
    };
    const startNode = vi.fn(async () => ({
      ledger: { ledgerAddress: proof.sourceLedgerAddress },
      close: () => Promise.resolve(),
    }));

    await expect(
      runLedgerGenesis(input, { startNode, validateAddress: (value) => value }),
    ).rejects.toThrow(/source ledger/u);
    expect(startNode).toHaveBeenCalledTimes(1);
    expect(await exists(input.receiptPath)).toBe(false);
  });
});
