/**
 * 事件收件驗證（**首次廣播**限定；歷史同步＝鏈上既成事實不重驗、離線暫存廣播前
 * 須重 stamp＋重簽）。標準事件＝timestamp ±30s＋單一 BaseEvent.signature；
 * match-result 的 live admission 與 timeless fold 共用自包含驗證（matchId/grid/loadout/
 * inline anchors/quorum）；事件不攜帶 payout 或經濟 frontier，金額由 canonical fold 計算；
 * race-consensus-anchor 則驗在場名單的嚴格多數簽章。
 */
import { Protocol } from '@open4wd/system-constants';
import type { BaseEvent, PeerId, Signature, Timestamp } from '@open4wd/interfaces';
import { peerIdToPublicKey, verifyMessage } from '../key-manager/ed25519';
import type {
  MatchResultEvent,
  MatchRules,
  RaceConsensusAnchorEvent,
  SignerSignature,
} from './events';
import {
  anchorFrameWithinTail,
  consensusAnchorQuorum,
  sortedUniquePeers,
} from './consensus-anchor';
import { verifyStartGridProof } from '../matchmaking/start-grid';
import { ledgerSigningDigest } from './ledger-signing';
import { loadoutSigningMessage, signingDigest } from './serialize';

const TOLERANCE_MS = Protocol.security.P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC * 1000;

/** 拒收原因（結構化；UI 以 code 映射 i18n） */
export type LedgerRejectReason =
  | 'timestamp-out-of-range'
  | 'invalid-signature'
  | 'insufficient-quorum'
  | 'signer-not-eligible'
  | 'matchid-roster-mismatch'
  | 'loadout-proof-invalid'
  | 'anchor-certificate-invalid'
  | 'match-time-invalid';

/**
 * matchId 決定性推導（綁 roster 與起跑證明）：開賽時房間成員（去重、字典序）＋開賽時戳＋
 * 場規＋GridProof 的 context digest／seed 的 canonical digest（sha-256 hex）。生成端（開賽編排）
 * 與驗證端（收件／fold）同式——任何 peer 都無法為自陳名單或挪用的 grid proof 配出他場 id。
 */
export function deriveMatchId(
  roster: readonly PeerId[],
  startedAt: Timestamp,
  matchRules: MatchRules,
  grid: Pick<import('./events').StartGridProof, 'contextDigest' | 'gridSeed'>,
): string {
  if (!/^[0-9a-f]{64}$/.test(grid.contextDigest) || !/^[0-9a-f]{64}$/.test(grid.gridSeed))
    throw new Error('invalid start grid binding');
  const digest = signingDigest({
    type: 'match-id',
    roster: [...new Set(roster)].sort(),
    startedAt,
    matchRules,
    gridContextDigest: grid.contextDigest,
    gridSeed: grid.gridSeed,
  });
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** 事件端重組生成名單：完賽者（ranking）∪ 缺席／中離者（disconnects）＝開賽時全員 */
function rosterOfMatchResult(event: MatchResultEvent): PeerId[] {
  return [...event.ranking, ...event.disconnects.map((info) => info.peerId)];
}

/**
 * ⓪-loadout 參與證明：event.loadouts 每筆須有本場 matchId-bound 有效簽章（缺／偽＝false）。
 * 攻擊者偽造不了受害者私鑰簽章、亦無法挪用他場簽章（matchId 綁定）——故無法把任意玩家
 * 塞進 loadouts；配合 applier「只罰／只評有 loadout 者」＝憑空自造一場塞人投毒信譽/斷線失效。
 */
function loadoutSignaturesValid(event: MatchResultEvent): boolean {
  for (const [peer, loadout] of Object.entries(event.loadouts)) {
    const sig = event.loadoutSignatures[peer as PeerId];
    if (sig === undefined) return false;
    if (!verifyBySigner(peer as PeerId, loadoutSigningMessage(event.matchId, loadout), sig))
      return false;
  }
  return true;
}

/** ⓪ matchId 綁 roster：與事件自身名單推導不符＝拒（擋自陳名單搶佔他場 matchId） */
function matchIdBoundToRoster(event: MatchResultEvent): boolean {
  const proof = verifyStartGridProof(event.gridProof);
  if (!proof.ok) return false;
  const roster = [...new Set(rosterOfMatchResult(event))].sort();
  if (
    event.gridProof.context.roster.length !== roster.length ||
    event.gridProof.context.roster.some((peer, index) => peer !== roster[index]) ||
    event.gridProof.context.roundCount !== event.rounds.length
  )
    return false;
  return (
    event.matchId === deriveMatchId(roster, event.startedAt, event.matchRules, event.gridProof)
  );
}

/**
 * defer＝暫緩排隊重試（非拒收）；有界重試／TTL 由儲存層守（防垃圾 base DoS）。
 * reason 開放 string 尾巴＝業務域收件驗證（仲裁／下架／評分背書）自帶拒因併入
 * 總組合（診斷用途、非共識面）。
 */
export type ReceiveVerdict =
  | { kind: 'accept' }
  | { kind: 'reject'; reason: LedgerRejectReason | (string & {}) }
  | { kind: 'defer'; reason: 'base-not-synced' | (string & {}) };

const ACCEPT: ReceiveVerdict = { kind: 'accept' };

/** ±30s 首播時戳閘（倒填／未來時間戳進不了帳本、護 registeredAt 等 time-based gate） */
export function validateEventTimestamp(
  event: Pick<BaseEvent, 'timestamp'>,
  localNow: Timestamp,
): ReceiveVerdict {
  if (Math.abs(localNow - event.timestamp) > TOLERANCE_MS)
    return { kind: 'reject', reason: 'timestamp-out-of-range' };
  return ACCEPT;
}

/** signer 自證式驗章（公鑰內含於 PeerId）；digest 已剔 signature／signatures 欄 */
function verifyBySigner(signer: PeerId, digest: Uint8Array, sig: Signature): boolean {
  const publicKey = peerIdToPublicKey(signer);
  return publicKey !== null && verifyMessage(publicKey, digest, sig);
}

/** 標準單簽事件：BaseEvent.signature 對 signingDigest(event) 由 event.peerId 驗證 */
export function verifyEventSignature(event: BaseEvent, ledgerAddress?: string): boolean {
  const digest =
    ledgerAddress === undefined ? signingDigest(event) : ledgerSigningDigest(ledgerAddress, event);
  return verifyBySigner(event.peerId, digest, event.signature);
}

/** 標準事件收件＝時戳閘＋單簽驗證（多簽事件走各自專用驗證） */
export function validateStandardEvent(
  event: BaseEvent,
  localNow: Timestamp,
  ledgerAddress?: string,
): ReceiveVerdict {
  const ts = validateEventTimestamp(event, localNow);
  if (ts.kind !== 'accept') return ts;
  if (!verifyEventSignature(event, ledgerAddress))
    return { kind: 'reject', reason: 'invalid-signature' };
  return ACCEPT;
}

/**
 * match-result 簽章集嚴格檢查（canon 字面：**每個** signer ∈ 完賽者且簽章有效）——
 * 任一非法項即整包拒收（事件是 proposer 定稿的固定工件、不該夾雜垃圾簽章；寬容
 * 跳過會造成各 client 對同事件收/拒不一＝帳本分叉風險）。同 signer 重複不灌票。
 */
function checkSignerSignatures(
  signatures: readonly SignerSignature[],
  digest: Uint8Array,
  eligible: ReadonlySet<PeerId>,
): { distinct: number } | { reject: LedgerRejectReason } {
  const seen = new Set<PeerId>();
  for (const { signer, sig } of signatures) {
    if (!eligible.has(signer)) return { reject: 'signer-not-eligible' };
    if (!verifyBySigner(signer, digest, sig)) return { reject: 'invalid-signature' };
    seen.add(signer);
  }
  return { distinct: seen.size };
}

/**
 * match-result 收件情境。事件本身攜帶完整 anchor certificates；經濟結果不在 wire，
 * 因此收件驗證只需要 original-roster 所推導的合法 signer 集合。
 */
export interface MatchResultValidationContext {
  /** 非 forfeit 完賽者（唯一合法 signer 集合） */
  eligibleSigners: ReadonlySet<PeerId>;
}

/**
 * 自包含 round certificates 的 timeless 驗證。每張證書獨立驗 chain-bound 多簽，並綁定
 * MatchResult 的 match/grid/round/tail 與證書 timestamp 當下仍在場 roster。null 是合法的
 * 「無證書」事實，但 economy fold 必須把整場判為 not-eligible。
 */
function embeddedRoundAnchorsValid(event: MatchResultEvent, ledgerAddress?: string): boolean {
  if (event.roundAnchors.length !== event.rounds.length) return false;
  const originalRoster = sortedUniquePeers(rosterOfMatchResult(event));
  for (let index = 0; index < event.rounds.length; index += 1) {
    const round = event.rounds[index]!;
    if (round.roundIndex !== index) return false;
    const anchor = event.roundAnchors[index];
    if (anchor === null) continue;
    if (
      anchor.matchId !== event.matchId ||
      anchor.roundIndex !== index ||
      anchor.gridContextDigest !== event.gridProof.contextDigest ||
      anchor.gridSeed !== event.gridProof.gridSeed ||
      anchor.timestamp < event.startedAt ||
      anchor.timestamp > event.finishedAt ||
      !anchorFrameWithinTail(anchor.frame, round.terminalFrame) ||
      !verifyRaceConsensusAnchorSignatureSet(anchor, ledgerAddress)
    )
      return false;
    const expectedPresent = originalRoster.filter(
      (peer) =>
        !event.disconnects.some(
          (info) => info.peerId === peer && info.disconnectedAt <= anchor.timestamp,
        ),
    );
    if (
      expectedPresent.length !== anchor.presentPeers.length ||
      expectedPresent.some((peer, peerIndex) => peer !== anchor.presentPeers[peerIndex])
    )
      return false;
  }
  return true;
}

/** 多簽事件 quorum：⌊N/2⌋+1。MatchResult 的 N 固定為 original active roster。 */
export function matchResultQuorum(rosterCount: number): number {
  return Math.floor(rosterCount / 2) + 1;
}

/**
 * MatchResult 一律由 original active roster 的嚴格多數背書；disconnect reason 是
 * 提案內容、不得改變分母，否則少數側可把失聯者標成 voluntary 後自行定稿。
 */
export function matchResultRequiredQuorum(
  event: Pick<MatchResultEvent, 'ranking' | 'disconnects'>,
): number {
  const originalRoster = new Set<PeerId>([
    ...event.ranking,
    ...event.disconnects.map((info) => info.peerId),
  ]);
  return matchResultQuorum(originalRoster.size);
}

/**
 * match-result 首播收件：⓪ matchId 綁 roster（與 fold 守門同式）；① signatures ≥
 * ⌊N/2⌋+1、signer ∈ 非 forfeit 完賽者、簽章對整事件（剔 signatures）有效；② 每回合
 * 非 null anchor 是 chain-bound、grid-bound、roster/time/tail-bound 的自包含多簽證書。
 */
export function validateMatchResult(
  event: MatchResultEvent,
  ctx: MatchResultValidationContext,
  localNow: Timestamp,
  ledgerAddress?: string,
): ReceiveVerdict {
  const ts = validateEventTimestamp(event, localNow);
  if (ts.kind !== 'accept') return ts;
  try {
    if (event.startedAt > event.finishedAt || event.finishedAt > event.timestamp)
      return { kind: 'reject', reason: 'match-time-invalid' };
    if (!matchIdBoundToRoster(event)) return { kind: 'reject', reason: 'matchid-roster-mismatch' };
    if (!loadoutSignaturesValid(event)) return { kind: 'reject', reason: 'loadout-proof-invalid' };
    if (!embeddedRoundAnchorsValid(event, ledgerAddress))
      return { kind: 'reject', reason: 'anchor-certificate-invalid' };
  } catch {
    return { kind: 'reject', reason: 'matchid-roster-mismatch' }; // 畸形 shape＝fail-closed
  }

  const digest =
    ledgerAddress === undefined ? signingDigest(event) : ledgerSigningDigest(ledgerAddress, event);
  const checked = checkSignerSignatures(event.signatures, digest, ctx.eligibleSigners);
  if ('reject' in checked) return { kind: 'reject', reason: checked.reject };
  if (checked.distinct < matchResultRequiredQuorum(event))
    return { kind: 'reject', reason: 'insufficient-quorum' };

  return ACCEPT;
}

/**
 * ⭐gate ⓪＋① 的 **timeless 形**（fold 守門用）：⓪ matchId 綁 roster——eligible 由
 * event.ranking 自陳推導（單人 ranking ⇒ quorum 1 ⇒ 自簽可過），若不綁名單即可搶佔
 * 任意 matchId 先行 settle、毒化 settledMatchIds 使該場真結果被冪等閘吞；綁定後自陳
 * 名單只能配出「自己這組名單」的 matchId、搶不到他場。① 簽章集對事件 digest 全驗
 * ＋quorum——非 forfeit 完賽者為唯一合法 signer。log AC 為 write:['*']、「鏈上既成
 * 事實」不構成多簽信任錨（任一 peer 可繞過 live 驗證直接 append 舊時戳條目）→ 兩者
 * 必須恆驗。畸形 shape＝false（fail-closed）。
 */
export function verifyMatchResultSignatureSet(
  event: MatchResultEvent,
  ledgerAddress?: string,
): boolean {
  try {
    if (!matchIdBoundToRoster(event)) return false;
    if (!loadoutSignaturesValid(event)) return false; // ⓪-loadout：參與證明（擋塞人投毒）
    if (event.startedAt > event.finishedAt || event.finishedAt > event.timestamp) return false;
    if (!embeddedRoundAnchorsValid(event, ledgerAddress)) return false;
    const forfeited = new Set(event.disconnects.map((info) => info.peerId));
    const eligible = new Set(event.ranking.filter((peer) => !forfeited.has(peer)));
    const digest =
      ledgerAddress === undefined
        ? signingDigest(event)
        : ledgerSigningDigest(ledgerAddress, event);
    const checked = checkSignerSignatures(event.signatures, digest, eligible);
    if ('reject' in checked) return false;
    return checked.distinct >= matchResultRequiredQuorum(event);
  } catch {
    return false;
  }
}

/**
 * race-consensus-anchor 首播收件：timestamp ±30s、canonical presentPeers，且
 * signatures 必須是 presentPeers 的嚴格多數；嵌入 MatchResult 後另驗 grid/tail/roster。
 */
export function verifyRaceConsensusAnchorSignatureSet(
  event: RaceConsensusAnchorEvent,
  ledgerAddress?: string,
): boolean {
  try {
    if (event.presentPeers.length === 0) return false;
    const canonical = sortedUniquePeers(event.presentPeers);
    if (
      canonical.length !== event.presentPeers.length ||
      canonical.some((peer, index) => peer !== event.presentPeers[index])
    )
      return false;
    const digest =
      ledgerAddress === undefined
        ? signingDigest(event)
        : ledgerSigningDigest(ledgerAddress, event);
    const checked = checkSignerSignatures(event.signatures, digest, new Set(event.presentPeers));
    return (
      !('reject' in checked) && checked.distinct >= consensusAnchorQuorum(event.presentPeers.length)
    );
  } catch {
    return false;
  }
}

/** 驗證 race anchor 的幀、roster、多數簽章與每 signer 唯一性。 */
export function validateRaceConsensusAnchor(
  event: RaceConsensusAnchorEvent,
  localNow: Timestamp,
  ledgerAddress?: string,
): ReceiveVerdict {
  const ts = validateEventTimestamp(event, localNow);
  if (ts.kind !== 'accept') return ts;
  if (!verifyRaceConsensusAnchorSignatureSet(event, ledgerAddress))
    return { kind: 'reject', reason: 'insufficient-quorum' };
  return ACCEPT;
}
