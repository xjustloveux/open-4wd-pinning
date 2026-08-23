import * as dagCbor from '@ipld/dag-cbor';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { base32 } from 'multiformats/bases/base32';
import { base58btc } from 'multiformats/bases/base58';
import { CID as MultiformatsCID } from 'multiformats/cid';
import { describe, expect, it } from 'vitest';
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
  parseInitialCheckpointProofBundle,
  serializeInitialCheckpointProofBundle,
} from './initial-checkpoint-proof-bundle';

const toBytes = (value: unknown): Uint8Array => {
  const encoded = dagCbor.encode(value);
  return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
};

const entryBlock = (label: string): { cid: CID; bytes: Uint8Array } => {
  const bytes = toBytes({ label });
  const cid = MultiformatsCID.parse(cidOfBytes(bytes), base32).toString(base58btc) as CID;
  return { cid, bytes };
};

async function fixture(): Promise<{
  proof: InitialCheckpointProof;
  blocks: Map<CID, Uint8Array>;
}> {
  const sourceKey = await generateKeyPair('Ed25519');
  const targetKey = await generateKeyPair('Ed25519');
  const sourceSigner = publicKeyToPeerId(sourceKey.publicKey.raw);
  const targetSigner = publicKeyToPeerId(targetKey.publicKey.raw);
  const head = entryBlock('bundle-source-head');
  const sourceLedgerAddress = `/orbitdb/${head.cid}`;
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
    log_head_cids: [head.cid],
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
  return {
    proof: { ...core, commitment: initialCheckpointProofCommitment(core) },
    blocks: new Map([
      [head.cid, head.bytes],
      [stateCid, stateBytes],
      [signerSetCid, signerBytes],
      [checkpointCid, checkpointBytes],
    ]),
  };
}

describe('initial checkpoint proof bundle', () => {
  it('records exactly the blocks used by full offline proof verification', async () => {
    const { proof, blocks } = await fixture();
    const bundle = await createInitialCheckpointProofBundle(proof, {
      get: (cid) => Promise.resolve(blocks.get(cid) ?? null),
    });
    const parsed = await parseInitialCheckpointProofBundle(
      JSON.parse(serializeInitialCheckpointProofBundle(bundle)),
    );

    expect(parsed.proof).toEqual(proof);
    expect([...parsed.blocks.keys()].sort()).toEqual([...blocks.keys()].sort());
  });

  it('rejects missing, altered, duplicate, and unreferenced packaged blocks', async () => {
    const { proof, blocks } = await fixture();
    const bundle = await createInitialCheckpointProofBundle(proof, {
      get: (cid) => Promise.resolve(blocks.get(cid) ?? null),
    });
    const missing = { ...bundle, blocks: bundle.blocks.slice(1) };
    await expect(parseInitialCheckpointProofBundle(missing)).rejects.toThrow(/missing/u);

    const altered = {
      ...bundle,
      blocks: bundle.blocks.map((block, index) =>
        index === 0 ? { ...block, bytesBase64: Buffer.from('altered').toString('base64') } : block,
      ),
    };
    await expect(parseInitialCheckpointProofBundle(altered)).rejects.toThrow(/CID/u);

    const duplicate = { ...bundle, blocks: [...bundle.blocks, bundle.blocks[0]!] };
    await expect(parseInitialCheckpointProofBundle(duplicate)).rejects.toThrow(/duplicate/u);

    const extra = entryBlock('not-referenced');
    const unreferenced = {
      ...bundle,
      blocks: [
        ...bundle.blocks,
        { cid: extra.cid, bytesBase64: Buffer.from(extra.bytes).toString('base64') },
      ],
    };
    await expect(parseInitialCheckpointProofBundle(unreferenced)).rejects.toThrow(/unreferenced/u);
  });
});
