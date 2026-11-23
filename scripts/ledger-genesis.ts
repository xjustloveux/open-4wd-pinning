import { link, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { exactOrbitDbAddress, publicKeyToPeerId } from '../core';
import { startLedgerNode, type LedgerNodeConfig } from '../node';
import { parseGenesisConfig, type GenesisConfig } from './ledger-genesis-config';
import {
  GENESIS_ACCESS_CONTROLLER,
  GENESIS_DATABASE_NAME,
  GENESIS_DATABASE_TYPE,
  serializeGenesisReceipt,
  type GenesisReceipt,
} from './ledger-genesis-receipt';

interface GenesisNode {
  readonly ledger: { readonly ledgerAddress: string };
  close(): Promise<void>;
}

export interface LedgerGenesisDependencies {
  readonly startNode: (config: LedgerNodeConfig) => Promise<GenesisNode>;
  readonly now?: () => Date;
  readonly validateAddress?: (value: string) => string | null;
}

async function pathKind(path: string): Promise<'missing' | 'file' | 'directory'> {
  try {
    const value = await stat(path);
    return value.isDirectory() ? 'directory' : 'file';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function assertFreshTargets(config: GenesisConfig): Promise<void> {
  if ((await pathKind(config.receiptPath)) !== 'missing')
    throw new Error(`genesis receipt already exists: ${config.receiptPath}`);
  const dataKind = await pathKind(config.dataDir);
  if (dataKind === 'file') throw new Error('genesis data directory must be a directory');
  if (dataKind === 'directory' && (await readdir(config.dataDir)).length > 0)
    throw new Error('genesis data directory must be empty');
}

async function publishReceipt(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o644);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function nodeConfig(
  config: GenesisConfig,
  genesisTimestamp: number,
  ledgerDbAddress?: string,
): LedgerNodeConfig {
  return {
    dataDir: config.dataDir,
    privateKey: config.privateKey,
    listen: config.listen,
    bootstrap: config.bootstrap,
    relayEnabled: false,
    ...(config.initialCheckpointProof === undefined
      ? { genesisGovernanceSigners: config.governanceSigners, genesisTimestamp }
      : {
          initialCheckpointProof: config.initialCheckpointProof,
          initialCheckpointProofBlocks: config.initialCheckpointProofBlocks!,
        }),
    ...(ledgerDbAddress === undefined ? {} : { ledgerDbAddress }),
  };
}

export async function runLedgerGenesis(
  config: GenesisConfig,
  dependencies: LedgerGenesisDependencies = { startNode: startLedgerNode },
): Promise<GenesisReceipt> {
  await assertFreshTargets(config);
  await mkdir(config.dataDir, { recursive: true });
  const createdAt = dependencies.now?.() ?? new Date();
  const genesisTimestamp = createdAt.getTime();
  if (!Number.isSafeInteger(genesisTimestamp) || genesisTimestamp <= 0)
    throw new TypeError('genesis timestamp must be a positive safe integer');

  const created = await dependencies.startNode(nodeConfig(config, genesisTimestamp));
  let address: string;
  try {
    address = created.ledger.ledgerAddress;
  } finally {
    await created.close();
  }
  const validateAddress = dependencies.validateAddress ?? exactOrbitDbAddress;
  if (validateAddress(address) !== address)
    throw new Error('genesis produced an invalid OrbitDB address');
  if (config.initialCheckpointProof?.sourceLedgerAddress === address)
    throw new Error('rebirth target ledger address must differ from source ledger address');

  const verified = await dependencies.startNode(nodeConfig(config, genesisTimestamp, address));
  try {
    if (verified.ledger.ledgerAddress !== address)
      throw new Error('genesis exact-address verification mismatch');
  } finally {
    await verified.close();
  }

  const receipt: GenesisReceipt = {
    version: 1,
    ledgerAddress: address,
    databaseName: GENESIS_DATABASE_NAME,
    databaseType: GENESIS_DATABASE_TYPE,
    accessController: GENESIS_ACCESS_CONTROLLER,
    genesisPeerId: publicKeyToPeerId(config.privateKey.publicKey.raw),
    governanceSigners: [...config.governanceSigners].sort(),
    genesisTimestamp,
    genesisMode: config.initialCheckpointProof === undefined ? 'ordinary' : 'rebirth',
    initialCheckpointProof:
      config.initialCheckpointProof === undefined
        ? null
        : {
            commitment: config.initialCheckpointProof.commitment,
            sourceLedgerAddress: config.initialCheckpointProof.sourceLedgerAddress,
            sourceCheckpointCid: config.initialCheckpointProof.checkpointCid,
            initialStateCid: config.initialCheckpointProof.initialStateCid,
            sourceCheckpointTimestamp: config.initialCheckpointProof.sourceCheckpointTimestamp,
          },
    createdAt: createdAt.toISOString(),
    releaseCommit: config.releaseCommit,
  };
  await publishReceipt(config.receiptPath, serializeGenesisReceipt(receipt));
  return receipt;
}

async function runCli(): Promise<void> {
  const config = await parseGenesisConfig(process.env, process.argv.slice(2));
  const receipt = await runLedgerGenesis(config);
  console.log(`Ledger genesis verified: ${receipt.ledgerAddress}`);
  console.log(`Public receipt: ${config.receiptPath}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runCli().catch((error) => {
    console.error(`ledger-genesis: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
