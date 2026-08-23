/**
 * 可驗算起跑格 ceremony 的純邏輯核心。房主只轉送 signed commitment/reveal；
 * proof、seed、base permutation 與跨回合輪替皆可由每個 peer 獨立重算。
 */
import { sha256 } from '@noble/hashes/sha2.js';
import type { PeerId } from '@open4wd/interfaces';
import { Protocol } from '@open4wd/system-constants';
import { lowercaseHex } from '../encoding/bytes';
import {
  compareCanonicalText as compareText,
  hasExactCanonicalKeys as exactKeys,
} from '../encoding/canonical-object';
import { verifySignedPayload } from '../key-manager';
import type {
  GridLockedContext,
  StartGridParticipantProof,
  StartGridProof,
} from '../ledger/events';
import { signingDigest } from '../ledger/serialize';

const CONTEXT_DOMAIN = 'open4wd.grid-context.v1';
const COMMITMENT_DOMAIN = 'open4wd.grid-commitment.v1';
const SEED_DOMAIN = 'open4wd.grid-seed.v1';
const PERMUTATION_DOMAIN = 'open4wd.grid-permutation.v1';

export type {
  GridCommitmentPayload,
  GridLockedContext,
  GridRevealPayload,
  StartGridParticipantProof,
  StartGridProof,
} from '../ledger/events';

/** 描述起跑位承諾揭露證明的驗證成功結果或具體拒絕原因。 */
export type StartGridProofVerdict = { ok: true } | { ok: false; reason: string };

const canonicalRoster = (roster: readonly PeerId[]): PeerId[] =>
  [...new Set(roster)].sort(compareText);

function canonicalContext(context: GridLockedContext): GridLockedContext {
  return {
    version: 1,
    seriesId: context.seriesId,
    roster: canonicalRoster(context.roster),
    trackManifestDigests: [...context.trackManifestDigests],
    matchRules: { ...context.matchRules },
    roundCount: context.roundCount,
  };
}

function validContext(context: GridLockedContext): boolean {
  const roster = canonicalRoster(context.roster);
  return (
    typeof context === 'object' &&
    context !== null &&
    exactKeys(context, [
      'version',
      'seriesId',
      'roster',
      'trackManifestDigests',
      'matchRules',
      'roundCount',
    ]) &&
    typeof context.matchRules === 'object' &&
    context.matchRules !== null &&
    exactKeys(context.matchRules, []) &&
    context.version === 1 &&
    typeof context.seriesId === 'string' &&
    context.seriesId.length > 0 &&
    context.seriesId.length <= 256 &&
    roster.length === context.roster.length &&
    roster.length >= 1 &&
    roster.length <= Protocol.matchmaking.PLAYERS_PER_RACE_MAX &&
    Number.isSafeInteger(context.roundCount) &&
    context.roundCount >= Protocol.gameplay.MATCH_ROUND_COUNT_MIN &&
    context.roundCount <= Protocol.gameplay.MATCH_ROUND_COUNT_MAX &&
    context.trackManifestDigests.length === context.roundCount &&
    context.trackManifestDigests.every((digest) => /^[0-9a-f]{64}$/.test(digest))
  );
}

/** locked context digest 不受 host members[] 排列影響。 */
export function gridLockedContextDigest(context: GridLockedContext): string {
  if (!validContext(context)) throw new Error('invalid grid locked context');
  return lowercaseHex(
    sha256(signingDigest({ domain: CONTEXT_DOMAIN, context: canonicalContext(context) })),
  );
}

/** 固定 32-byte nonce 與 signer/context 綁定的 commitment。 */
export function createGridCommitment(
  peerId: PeerId,
  contextDigest: string,
  nonce: Uint8Array,
): string {
  if (nonce.byteLength !== Protocol.matchmaking.START_GRID_NONCE_BYTES)
    throw new Error('grid nonce must be 32 bytes');
  return lowercaseHex(
    sha256(signingDigest({ domain: COMMITMENT_DOMAIN, peerId, contextDigest, nonce })),
  );
}

function gridSeedOf(
  contextDigest: string,
  participants: readonly StartGridParticipantProof[],
): string {
  return lowercaseHex(
    sha256(
      signingDigest({
        domain: SEED_DOMAIN,
        contextDigest,
        reveals: participants.map(({ peerId, reveal }) => ({
          peerId,
          nonce: reveal.payload.nonce,
        })),
      }),
    ),
  );
}

function verifyParticipant(
  participant: StartGridParticipantProof,
  contextDigest: string,
): StartGridProofVerdict {
  const { peerId, commitment, reveal } = participant;
  if (
    !exactKeys(participant, ['peerId', 'commitment', 'reveal']) ||
    !exactKeys(commitment, ['payload', 'timestamp', 'nonce', 'signer', 'signature']) ||
    !exactKeys(reveal, ['payload', 'timestamp', 'nonce', 'signer', 'signature']) ||
    !exactKeys(commitment.payload, ['type', 'contextDigest', 'commitment']) ||
    !exactKeys(reveal.payload, ['type', 'contextDigest', 'nonce'])
  )
    return { ok: false, reason: 'grid proof shape invalid' };
  if (commitment.signer !== peerId || reveal.signer !== peerId)
    return { ok: false, reason: 'grid proof signer mismatch' };
  if (!verifySignedPayload(commitment) || !verifySignedPayload(reveal))
    return { ok: false, reason: 'grid proof signature invalid' };
  if (
    commitment.payload.type !== 'grid-commitment' ||
    reveal.payload.type !== 'grid-reveal' ||
    commitment.payload.contextDigest !== contextDigest ||
    reveal.payload.contextDigest !== contextDigest ||
    !/^[0-9a-f]{64}$/.test(commitment.payload.commitment) ||
    !(reveal.payload.nonce instanceof Uint8Array) ||
    reveal.payload.nonce.byteLength !== Protocol.matchmaking.START_GRID_NONCE_BYTES
  )
    return { ok: false, reason: 'grid proof payload invalid' };
  if (
    commitment.payload.commitment !==
    createGridCommitment(peerId, contextDigest, reveal.payload.nonce)
  )
    return { ok: false, reason: 'grid reveal does not match commitment' };
  return { ok: true };
}

/** 收齊全 roster 後才可建立 proof；缺人、重複、替換或壞簽章一律 throw。 */
export function buildStartGridProof(
  context: GridLockedContext,
  entries: readonly StartGridParticipantProof[],
): StartGridProof {
  const normalized = canonicalContext(context);
  const contextDigest = gridLockedContextDigest(normalized);
  const participants = [...entries].sort((a, b) => compareText(a.peerId, b.peerId));
  if (
    participants.length !== normalized.roster.length ||
    participants.some((entry, index) => entry.peerId !== normalized.roster[index])
  )
    throw new Error('grid proof must cover canonical roster exactly once');
  for (const participant of participants) {
    const verdict = verifyParticipant(participant, contextDigest);
    if (!verdict.ok) throw new Error(verdict.reason);
  }
  return {
    version: 1,
    context: normalized,
    contextDigest,
    participants,
    gridSeed: gridSeedOf(contextDigest, participants),
  };
}

/** 不可信 match-start/result/anchor proof 的封閉式完整驗證。 */
export function verifyStartGridProof(proof: StartGridProof): StartGridProofVerdict {
  try {
    if (
      typeof proof !== 'object' ||
      proof === null ||
      !exactKeys(proof, ['version', 'context', 'contextDigest', 'participants', 'gridSeed']) ||
      proof.version !== 1 ||
      !validContext(proof.context) ||
      !Array.isArray(proof.participants)
    )
      return { ok: false, reason: 'grid proof context invalid' };
    const rebuilt = buildStartGridProof(proof.context, proof.participants);
    if (proof.contextDigest !== rebuilt.contextDigest || proof.gridSeed !== rebuilt.gridSeed)
      return { ok: false, reason: 'grid proof digest mismatch' };
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * base permutation 只取 proof seed 與 PeerId；roundIndex 以 canonical cyclic rotation
 * 輪替。startedAt、host members[] order 與本機時鐘都不參與。
 */
export function deriveGridSlotMap(
  proof: StartGridProof,
  roundIndex: number,
): Readonly<Record<PeerId, number>> {
  const verified = verifyStartGridProof(proof);
  if (!verified.ok) throw new Error(verified.reason);
  if (!Number.isSafeInteger(roundIndex) || roundIndex < 0 || roundIndex >= proof.context.roundCount)
    throw new Error('grid roundIndex out of range');
  const ranked = proof.context.roster
    .map((peerId) => ({
      peerId,
      digest: lowercaseHex(
        sha256(signingDigest({ domain: PERMUTATION_DOMAIN, gridSeed: proof.gridSeed, peerId })),
      ),
    }))
    .sort(
      (left, right) =>
        compareText(left.digest, right.digest) || compareText(left.peerId, right.peerId),
    );
  const slots = {} as Record<PeerId, number>;
  ranked.forEach(({ peerId }, baseIndex) => {
    slots[peerId] = (baseIndex + roundIndex) % ranked.length;
  });
  return slots;
}
