import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { libp2pPrivateKeyFromSeed, type PeerId } from '../core';
import type { GenesisConfig } from './ledger-genesis-config';
import { runLedgerGenesis } from './ledger-genesis';
import { ruleConformance } from './rule-conformance';

async function genesisConfig(root: string): Promise<GenesisConfig> {
  const privateKey = await libp2pPrivateKeyFromSeed(new Uint8Array(32).fill(11));
  return {
    dataDir: join(root, 'data'),
    receiptPath: join(root, 'receipt.json'),
    listen: ['/memory/genesis-conformance'],
    bootstrap: [],
    governanceSigners: new Set(['12D3KooWGenesisSigner'] as PeerId[]),
    privateKey,
    releaseCommit: '0123456789abcdef0123456789abcdef01234567',
  };
}

ruleConformance({
  ruleId: 'LEDGER-R-090',
  layer: 'service',
  contract: 'ledger-r-090-service',
  boundary: runLedgerGenesis,
  verify: async ({ invoke }) => {
    const root = await mkdtemp(join(tmpdir(), 'o4wd-genesis-conformance-'));
    const input = await genesisConfig(root);
    const close = vi.fn(() => Promise.resolve());
    const startNode = vi
      .fn()
      .mockResolvedValueOnce({ ledger: { ledgerAddress: '/orbitdb/zdummy' }, close })
      .mockResolvedValueOnce({ ledger: { ledgerAddress: '/orbitdb/zdummy' }, close });
    const receipt = await invoke(input, {
      startNode,
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      validateAddress: (value) => value,
    });
    expect(startNode).toHaveBeenCalledTimes(2);
    expect(startNode.mock.calls[0]?.[0].ledgerDbAddress).toBeUndefined();
    expect(startNode.mock.calls[1]?.[0].ledgerDbAddress).toBe('/orbitdb/zdummy');
    expect(close).toHaveBeenCalledTimes(2);
    expect(receipt.ledgerAddress).toBe('/orbitdb/zdummy');
  },
});
