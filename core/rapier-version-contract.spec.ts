/**
 * 001057 跨 repo 契約：主 repo 的 `versionInfo.rapier_version` 上限為 128 bytes，
 * 且 `RAPIER_VERSION_CURRENT` 已是帶 WASM digest 的長字串（超過舊上限 64 bytes）。
 * pinning 的 vendored 副本必須與主 repo 同步；主 repo 改動上限或版本字串後執行 vendor:sync，
 * 本測試會隨之失敗或通過，以此提醒 pinning 同步，防止再次漂移。
 * fixture 比照主 repo src/ledger/ledger-event-schema.spec.ts 的最小合法 match-result。
 */
import { describe, expect, it } from 'vitest';
import {
  Network,
  buildSignedMessage,
  buildStartGridProof,
  createGridCommitment,
  deriveKeyPair,
  gridLockedContextDigest,
  isExactLedgerEvent,
  publicKeyToPeerId,
  signMessage,
} from './index';

const NOW = 1_700_000_000_000;
const keypair = deriveKeyPair(new Uint8Array(32).fill(91));
const peerId = publicKeyToPeerId(keypair.publicKey);
const sig = () => new Uint8Array(64);
const RAPIER_VERSION_CURRENT = Network.versioning.RAPIER_VERSION_CURRENT;

const loadout = {
  chassis: 'builtin:chassis-01',
  body: 'builtin:body-01',
  motor: 'builtin:motor-01',
  battery: 'builtin:battery-01',
  tires: {
    FL: 'builtin:tire-01',
    FR: 'builtin:tire-01',
    RL: 'builtin:tire-01',
    RR: 'builtin:tire-01',
  },
  rollers: {},
};

const gridContext = {
  version: 1 as const,
  seriesId: 'schema:0',
  roster: [peerId],
  trackManifestDigests: ['a'.repeat(64)],
  matchRules: {},
  roundCount: 1,
};
const gridContextDigest = gridLockedContextDigest(gridContext);
const gridNonce = new Uint8Array(32).fill(31);
const gridEnvelopeNonce = new Uint8Array(16).fill(32);
const signedGrid = (payload: object) => ({
  payload,
  timestamp: NOW - 1000,
  nonce: gridEnvelopeNonce,
  signer: peerId,
  signature: signMessage(
    keypair.privateKey,
    buildSignedMessage(payload, NOW - 1000, gridEnvelopeNonce, peerId),
  ),
});
const gridProof = buildStartGridProof(gridContext, [
  {
    peerId,
    commitment: signedGrid({
      type: 'grid-commitment',
      contextDigest: gridContextDigest,
      commitment: createGridCommitment(peerId, gridContextDigest, gridNonce),
    }),
    reveal: signedGrid({
      type: 'grid-reveal',
      contextDigest: gridContextDigest,
      nonce: gridNonce,
    }),
  },
] as never);

function validMatchResult(): Record<string, unknown> {
  const anchor = {
    type: 'race-consensus-anchor',
    timestamp: NOW,
    peerId,
    signature: new Uint8Array(0),
    matchId: 'match-1',
    gridContextDigest: gridProof.contextDigest,
    gridSeed: gridProof.gridSeed,
    roundIndex: 0,
    frame: 120,
    checksum: 'abc',
    presentPeers: [peerId],
    signatures: [{ signer: peerId, sig: sig() }],
  };
  return {
    type: 'match-result',
    timestamp: NOW,
    peerId,
    signature: new Uint8Array(0),
    matchId: 'match-1',
    gridProof,
    ranking: [peerId],
    rounds: [
      {
        roundIndex: 0,
        trackRef: 'builtin:track-01',
        lapCount: 1,
        endReason: 'completed',
        terminalFrame: 128,
        ranking: [peerId],
        finishTimes: { [peerId]: 1000 },
        destructionCounts: { [peerId]: 0 },
      },
    ],
    roundAnchors: [anchor],
    loadouts: { [peerId]: { peerId, carRotation: [loadout] } },
    loadoutSignatures: { [peerId]: sig() },
    matchRules: {},
    disconnects: [],
    startedAt: NOW - 1000,
    finishedAt: NOW,
    clientVersions: {},
    signatures: [{ signer: peerId, sig: sig() }],
  };
}

function withRapier(rapierVersion: string): Record<string, unknown> {
  const match = validMatchResult();
  match['clientVersions'] = {
    [peerId]: {
      client_version: '1.0.0',
      rapier_version: rapierVersion,
      protocol_version: '1',
      derive_logic_version: 1,
      builtin_assets_version: 1,
      economy_config_version: 1,
      build_timestamp: NOW,
      commit_hash: 'abc',
    },
  };
  return match;
}

describe('rapier_version 長度契約（001057）', () => {
  it('RAPIER_VERSION_CURRENT 超過舊 64 bytes 上限，且可寫入正式結算事件', () => {
    expect(new TextEncoder().encode(RAPIER_VERSION_CURRENT).length).toBeGreaterThan(64);
    expect(isExactLedgerEvent(withRapier(RAPIER_VERSION_CURRENT))).toBe(true);
  });

  it('上限 128 bytes 接受、129 bytes 拒收', () => {
    expect(isExactLedgerEvent(withRapier('x'.repeat(128)))).toBe(true);
    expect(isExactLedgerEvent(withRapier('x'.repeat(129)))).toBe(false);
  });
});
