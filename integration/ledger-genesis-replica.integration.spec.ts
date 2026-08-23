import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memory } from '@libp2p/memory';
import { afterEach, describe, expect, it } from 'vitest';
import { libp2pPrivateKeyFromSeed, Protocol, publicKeyToPeerId, type PeerId } from '../core';
import { startLedgerNode, type LedgerNode, type LedgerNodeConfig } from '../node';

const TEST_ADMISSION_SCHEME: NonNullable<LedgerNodeConfig['admissionScheme']> = {
  version: 1,
  baseBits: 0,
  sizeUnitBytes: Protocol.ledger.LEDGER_ADMISSION_SIZE_UNIT_BYTES,
  maxExtraBits: 0,
  nonceBytes: Protocol.ledger.LEDGER_ADMISSION_NONCE_BYTES,
};

const nodes: LedgerNode[] = [];
afterEach(async () => {
  while (nodes.length > 0) await nodes.pop()!.close();
});

async function key(label: number) {
  return libp2pPrivateKeyFromSeed(new Uint8Array(32).fill(label));
}

async function createGenesis(label: number): Promise<LedgerNode> {
  const privateKey = await key(label);
  const signer = publicKeyToPeerId(privateKey.publicKey.raw);
  const node = await startLedgerNode({
    dataDir: mkdtempSync(join(tmpdir(), 'o4wd-ledger-genesis-')),
    privateKey,
    listen: [`/memory/open4wd-genesis-${label}`],
    bootstrap: [],
    relayEnabled: false,
    extraTransports: [memory()],
    admissionScheme: TEST_ADMISSION_SCHEME,
    genesisGovernanceSigners: new Set([signer] as PeerId[]),
  });
  nodes.push(node);
  return node;
}

async function createReplica(genesis: LedgerNode, label: number): Promise<LedgerNode> {
  const privateKey = await key(label);
  const signer = publicKeyToPeerId(genesis.libp2p.peerId.publicKey!.raw);
  const node = await startLedgerNode({
    dataDir: mkdtempSync(join(tmpdir(), 'o4wd-ledger-replica-empty-')),
    privateKey,
    listen: [`/memory/open4wd-replica-${label}`],
    bootstrap: [],
    relayEnabled: false,
    ledgerDbAddress: genesis.ledger.ledgerAddress,
    extraTransports: [memory()],
    admissionScheme: TEST_ADMISSION_SCHEME,
    genesisGovernanceSigners: new Set([signer] as PeerId[]),
    beforeLedgerOpen: async (libp2p) => {
      await libp2p.dial(genesis.libp2p.getMultiaddrs()[0]!, {
        signal: AbortSignal.timeout(5_000),
      });
    },
  });
  nodes.push(node);
  return node;
}

describe('ledger genesis → empty replica bring-up', () => {
  it('空 blockstore replica 透過已連線 provider 以 exact address 開啟同一 ledger（重複兩次）', async () => {
    for (let run = 0; run < 2; run++) {
      const genesis = await createGenesis(20 + run * 2);
      const replica = await createReplica(genesis, 21 + run * 2);
      expect(replica.ledger.ledgerAddress).toBe(genesis.ledger.ledgerAddress);
      expect(replica.ledger.ledgerAddress).not.toBe('open4wd-ledger');
      await nodes.pop()!.close();
      await nodes.pop()!.close();
    }
  }, 30_000);

  it('無 provider 的空 blockstore 與 malformed exact address 都 fail closed', async () => {
    const genesis = await createGenesis(97);
    const unavailableAddress = genesis.ledger.ledgerAddress;
    await nodes.pop()!.close();

    const unavailableKey = await key(98);
    await expect(
      startLedgerNode({
        dataDir: mkdtempSync(join(tmpdir(), 'o4wd-ledger-no-provider-')),
        privateKey: unavailableKey,
        listen: ['/memory/open4wd-no-provider'],
        bootstrap: [],
        relayEnabled: false,
        ledgerDbAddress: unavailableAddress,
        extraTransports: [memory()],
        admissionScheme: TEST_ADMISSION_SCHEME,
      }),
    ).rejects.toThrow();

    const privateKey = await key(99);
    const base: LedgerNodeConfig = {
      dataDir: mkdtempSync(join(tmpdir(), 'o4wd-ledger-unavailable-')),
      privateKey,
      listen: ['/memory/open4wd-unavailable'],
      bootstrap: [],
      relayEnabled: false,
      extraTransports: [memory()],
      admissionScheme: TEST_ADMISSION_SCHEME,
    };
    await expect(
      startLedgerNode({ ...base, ledgerDbAddress: '/orbitdb/not-a-canonical-cid' }),
    ).rejects.toThrow(/exact OrbitDB address/);
  });
});
