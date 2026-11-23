import { multiaddr } from '@multiformats/multiaddr';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  peerIdToPublicKey,
  publicKeyToPeerId,
  type CID,
  type InitialCheckpointProof,
  type PeerId,
} from '../core';
import { loadIdentity, type NodePrivateKey } from '../node';
import { parseInitialCheckpointProofBundle } from './initial-checkpoint-proof-bundle';

export interface GenesisConfig {
  readonly dataDir: string;
  readonly receiptPath: string;
  readonly listen: readonly string[];
  readonly bootstrap: readonly string[];
  readonly governanceSigners: ReadonlySet<PeerId>;
  readonly initialCheckpointProof?: InitialCheckpointProof;
  readonly initialCheckpointProofBlocks?: ReadonlyMap<CID, Uint8Array>;
  readonly privateKey: NodePrivateKey;
  readonly releaseCommit: string;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

function isSameOrInside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return (
    relation === '' ||
    (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const allowed = new Set([
    '--data-dir',
    '--receipt',
    '--listen',
    '--bootstrap',
    '--governance-signers',
    '--initial-checkpoint-bundle',
    '--release-commit',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || !allowed.has(name))
      throw new Error(`unknown genesis argument: ${name}`);
    if (value === undefined || value.trim() === '') throw new Error(`missing value for ${name}`);
    if (values.has(name)) throw new Error(`duplicate genesis argument: ${name}`);
    values.set(name, value.trim());
  }
  return values;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function canonicalMultiaddrs(values: readonly string[], name: string): string[] {
  return values.map((value) => {
    try {
      return multiaddr(value).toString();
    } catch {
      throw new Error(`${name} contains an invalid multiaddr`);
    }
  });
}

function canonicalSigners(values: readonly string[]): ReadonlySet<PeerId> {
  const signers = new Set<PeerId>();
  for (const value of values) {
    const publicKey = peerIdToPublicKey(value as PeerId);
    if (publicKey === null) throw new Error('GOVERNANCE_SIGNERS contains an invalid PeerId');
    const canonical = publicKeyToPeerId(publicKey);
    if (canonical !== value) throw new Error('GOVERNANCE_SIGNERS contains a non-canonical PeerId');
    if (signers.has(canonical as PeerId))
      throw new Error('GOVERNANCE_SIGNERS contains a duplicate');
    signers.add(canonical as PeerId);
  }
  if (signers.size !== 1 && signers.size < 3)
    throw new Error('GOVERNANCE_SIGNERS must contain exactly 1 or at least 3 PeerIds');
  return signers;
}

export async function parseGenesisConfig(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): Promise<GenesisConfig> {
  const args = parseArgs(argv);
  const dataDir = resolve(
    required(args.get('--data-dir') ?? env['GENESIS_DATA_DIR'], 'GENESIS_DATA_DIR'),
  );
  const receiptPath = resolve(
    required(args.get('--receipt') ?? env['GENESIS_RECEIPT_PATH'], 'GENESIS_RECEIPT_PATH'),
  );
  if (isSameOrInside(dataDir, receiptPath))
    throw new Error('GENESIS_RECEIPT_PATH must be outside GENESIS_DATA_DIR');
  const listen = canonicalMultiaddrs(
    list(args.get('--listen') ?? env['GENESIS_LISTEN']),
    'GENESIS_LISTEN',
  );
  if (listen.length === 0) throw new Error('GENESIS_LISTEN requires at least one multiaddr');
  const bootstrap = canonicalMultiaddrs(
    list(args.get('--bootstrap') ?? env['GENESIS_BOOTSTRAP']),
    'GENESIS_BOOTSTRAP',
  );
  const governanceSigners = canonicalSigners(
    list(args.get('--governance-signers') ?? env['GOVERNANCE_SIGNERS']),
  );
  const bundlePathValue =
    args.get('--initial-checkpoint-bundle') ??
    env['GENESIS_INITIAL_CHECKPOINT_BUNDLE_PATH']?.trim();
  let initialCheckpointProof: InitialCheckpointProof | undefined;
  let initialCheckpointProofBlocks: ReadonlyMap<CID, Uint8Array> | undefined;
  if (bundlePathValue !== undefined && bundlePathValue !== '') {
    const bundlePath = resolve(bundlePathValue);
    if (isSameOrInside(dataDir, bundlePath))
      throw new Error('GENESIS_INITIAL_CHECKPOINT_BUNDLE_PATH must be outside GENESIS_DATA_DIR');
    const verified = await parseInitialCheckpointProofBundle(
      JSON.parse(await readFile(bundlePath, 'utf8')),
    );
    const configuredSigners = [...governanceSigners].sort();
    if (
      configuredSigners.length !== verified.proof.targetGovernanceSigners.length ||
      configuredSigners.some(
        (signer, index) => signer !== verified.proof.targetGovernanceSigners[index],
      )
    )
      throw new Error('rebirth target governance signer set does not match GOVERNANCE_SIGNERS');
    initialCheckpointProof = verified.proof;
    initialCheckpointProofBlocks = verified.blocks;
  }
  const releaseCommit = required(
    args.get('--release-commit') ?? env['GENESIS_RELEASE_COMMIT'],
    'GENESIS_RELEASE_COMMIT',
  );
  if (!COMMIT_SHA.test(releaseCommit))
    throw new Error('GENESIS_RELEASE_COMMIT must be a full lowercase 40-character commit SHA');
  if (!env['BOOTSTRAP_PEER_PRIVKEY']?.trim())
    throw new Error('BOOTSTRAP_PEER_PRIVKEY is required for persistent genesis identity');
  const replicaDataDir = env['DATA_DIR']?.trim();
  if (replicaDataDir && resolve(replicaDataDir) === dataDir)
    throw new Error('genesis and normal replica data directories must be distinct');
  const privateKey = await loadIdentity(env);

  return {
    dataDir,
    receiptPath,
    listen,
    bootstrap,
    governanceSigners,
    ...(initialCheckpointProof === undefined
      ? {}
      : { initialCheckpointProof, initialCheckpointProofBlocks }),
    privateKey,
    releaseCommit,
  };
}
