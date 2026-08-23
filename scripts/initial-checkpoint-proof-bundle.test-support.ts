import * as dagCbor from '@ipld/dag-cbor';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { base32 } from 'multiformats/bases/base32';
import { base58btc } from 'multiformats/bases/base58';
import { CID as MultiformatsCID } from 'multiformats/cid';
import {
  chainIdFromLedgerAddress,
  cidOfBytes,
  emptyDerivedState,
  encodeDerivedState,
  encodeSignerSet,
  initialCheckpointProofCommitment,
  ledgerSigningDigest,
  publicKeyToPeerId,
  type CID,
  type InitialCheckpointProof,
  type LedgerCheckpoint,
  type Signature,
} from '../core';
import {
  createInitialCheckpointProofBundle,
  type InitialCheckpointProofBundle,
} from './initial-checkpoint-proof-bundle';

const toBytes = (value: unknown): Uint8Array => {
  const encoded = dagCbor.encode(value);
  return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
};

export async function makeInitialCheckpointProofBundleFixture(): Promise<{
  proof: InitialCheckpointProof;
  bundle: InitialCheckpointProofBundle;
  blocks: Map<CID, Uint8Array>;
}> {
  const sourceKey = await generateKeyPair('Ed25519');
  const targetKey = await generateKeyPair('Ed25519');
  const sourceSigner = publicKeyToPeerId(sourceKey.publicKey.raw);
  const targetSigner = publicKeyToPeerId(targetKey.publicKey.raw);
  const headBytes = toBytes({ label: 'bundle-source-head' });
  const headCid = MultiformatsCID.parse(cidOfBytes(headBytes), base32).toString(base58btc) as CID;
  const sourceLedgerAddress = `/orbitdb/${headCid}`;
  const state = {
    ...emptyDerivedState(),
    economyConfig: {
      ...emptyDerivedState().economyConfig,
      epoch: 4,
      governanceSigners: [targetSigner],
    },
  };
  const stateBytes = encodeDerivedState(state);
  const stateCid = cidOfBytes(stateBytes);
  const signerBytes = encodeSignerSet(new Set([sourceSigner]));
  const signerSetCid = cidOfBytes(signerBytes);
  const unsigned: Omit<LedgerCheckpoint, 'signatures'> = {
    checkpoint_version: 1,
    timestamp: 1_800_000_000_000,
    log_head_cids: [headCid],
    derived_state_cid: stateCid,
    previous_checkpoint_cid: null,
    signer_set_cid: signerSetCid,
    signer_set_size: 1,
    quorum: 1,
    proposer: sourceSigner,
  };
  const checkpointBytes = toBytes({
    ...unsigned,
    signatures: [
      (await sourceKey.sign(ledgerSigningDigest(sourceLedgerAddress, unsigned))) as Signature,
    ],
  });
  const checkpointCid = cidOfBytes(checkpointBytes);
  const core: Omit<InitialCheckpointProof, 'commitment'> = {
    version: 1,
    sourceLedgerAddress,
    sourceChainId: chainIdFromLedgerAddress(sourceLedgerAddress),
    sourceGenesisSigners: [sourceSigner],
    targetGovernanceSigners: [targetSigner],
    checkpointChainCids: [checkpointCid],
    checkpointCid,
    initialStateCid: stateCid,
    derivedStateCid: stateCid,
    signerSetCid,
    sourceCheckpointTimestamp: unsigned.timestamp,
    sourceMinimumCheckpointTimestamp: unsigned.timestamp,
    sourceConfigEpoch: 4,
  };
  const proof = { ...core, commitment: initialCheckpointProofCommitment(core) };
  const blocks = new Map<CID, Uint8Array>([
    [headCid, headBytes],
    [stateCid, stateBytes],
    [signerSetCid, signerBytes],
    [checkpointCid, checkpointBytes],
  ]);
  const bundle = await createInitialCheckpointProofBundle(proof, {
    get: (cid) => Promise.resolve(blocks.get(cid) ?? null),
  });
  return { proof, bundle, blocks };
}
