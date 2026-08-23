import { describe, expect, it } from 'vitest';
import { serializeGenesisReceipt } from './ledger-genesis-receipt';

describe('serializeGenesisReceipt', () => {
  it('只輸出 pre-launch closed version-1 public shape、排序 signer 並以 newline 結尾', () => {
    const serialized = serializeGenesisReceipt({
      version: 1,
      ledgerAddress: '/orbitdb/zdummy',
      databaseName: 'open4wd-ledger',
      databaseType: 'events',
      accessController: 'open4wd-ledger/open4wd-ledger-admission-v1/write-any/v1',
      genesisPeerId: 'peer-genesis',
      governanceSigners: ['peer-z', 'peer-a'],
      genesisTimestamp: 1753660800000,
      genesisMode: 'ordinary',
      initialCheckpointProof: null,
      createdAt: '2026-07-28T00:00:00.000Z',
      releaseCommit: '0123456789abcdef0123456789abcdef01234567',
      secretSentinel: 'PRIVATE-SEED-MUST-NOT-LEAK',
    });

    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized).not.toContain('PRIVATE-SEED-MUST-NOT-LEAK');
    expect(JSON.parse(serialized).version).toBe(1);
    expect(JSON.parse(serialized).governanceSigners).toEqual(['peer-a', 'peer-z']);
    expect(Object.keys(JSON.parse(serialized))).toEqual([
      'version',
      'ledgerAddress',
      'databaseName',
      'databaseType',
      'accessController',
      'genesisPeerId',
      'governanceSigners',
      'genesisTimestamp',
      'genesisMode',
      'initialCheckpointProof',
      'createdAt',
      'releaseCommit',
    ]);
  });
});
