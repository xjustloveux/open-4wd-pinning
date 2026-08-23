/**
 * OrbitDB event-only intrinsic admission：只做不依賴牆鐘／本地狀態的決定性檢查，
 * 拒絕畸形、超大或無效事件。entry-bound PoW／canonical raw bytes／CID 由
 * ledger-entry-admission 與 persistence boundary 負責；本層本身不是完整 anti-spam 邊界。
 */
import * as dagCbor from '@ipld/dag-cbor';
import { Protocol } from '@open4wd/system-constants';
import type { BaseEvent, PeerId, Signature } from '@open4wd/interfaces';
import { peerIdToPublicKey, verifyMessage } from '../key-manager/ed25519';
import { MULTISIG_EVENT_TYPES } from './derived-state';
import {
  verifyMatchResultSignatureSet,
  verifyRaceConsensusAnchorSignatureSet,
} from './receive-validation';
import { verifyEventSignature } from './receive-validation';
import type { MatchResultEvent, RaceConsensusAnchorEvent } from './events';
import { isExactLedgerEvent } from './ledger-event-schema';
import { ledgerSigningDigest } from './ledger-signing';
import { signingDigest } from './serialize';

/** 單筆 ledger event 的 canonical DAG-CBOR 硬上限。 */
export const LEDGER_EVENT_MAX_BYTES = 65_536;
/** 單筆 ledger event 的容器深度硬上限。 */
export const LEDGER_EVENT_MAX_DEPTH = 16;
/** 單筆 ledger event 的物件欄位＋陣列元素總數硬上限。 */
export const LEDGER_EVENT_MAX_ENTRIES = 2048;

/**
 * Ledger v1 的封閉事件目錄。未列入者（包括尚未完成安全設計的
 * asset-version-upgrade）不得先以「前向相容 no-op」進入 append-only log。
 */
export const LEDGER_EVENT_TYPES: ReadonlySet<string> = new Set([
  'match-result',
  'race-consensus-anchor',
  'race-leave',
  'race-abort-evidence',
  'desync',
  'ugc-maintenance',
  'ledger-checkpoint',
  'slot-purchase',
  'ugc-sponsor-burn',
  'config-update',
  'ugc-upload',
  'ugc-metadata-update',
  'ugc-fork',
  'ugc-rate',
  'ugc-rate-revoke',
  'report',
  'report-revoke',
  'arbitration-vote',
  'arbitration-result',
  'blacklist-cid',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasBoundedShape(root: unknown): boolean {
  let entries = 0;
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > LEDGER_EVENT_MAX_DEPTH) return false;
    const value = current.value;
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'bigint' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      value instanceof Uint8Array
    )
      continue;
    if (typeof value === 'string') {
      if (new TextEncoder().encode(value).byteLength > LEDGER_EVENT_MAX_BYTES) return false;
      continue;
    }
    if (typeof value !== 'object') return false;
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    entries += children.length;
    if (entries > LEDGER_EVENT_MAX_ENTRIES) return false;
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}

function isBaseEvent(value: unknown): value is BaseEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value['type'] === 'string' &&
    value['type'].length > 0 &&
    value['type'].length <= 128 &&
    Number.isSafeInteger(value['timestamp']) &&
    typeof value['peerId'] === 'string' &&
    value['peerId'].length > 0 &&
    value['peerId'].length <= Protocol.security.P2P_MESSAGE_SIGNER_MAX_CHARS &&
    value['signature'] instanceof Uint8Array
  );
}

function verifyByPeer(peer: PeerId, digest: Uint8Array, signature: Signature): boolean {
  const publicKey = peerIdToPublicKey(peer);
  return publicKey !== null && verifyMessage(publicKey, digest, signature);
}

function ledgerDigest(event: object, ledgerAddress?: string): Uint8Array {
  return ledgerAddress === undefined
    ? signingDigest(event)
    : ledgerSigningDigest(ledgerAddress, event);
}

function verifyDesyncSignatureSet(event: Record<string, unknown>, ledgerAddress?: string): boolean {
  const peers = event['participatingPeers'];
  const signatures = event['signatures'];
  if (!Array.isArray(peers) || !Array.isArray(signatures)) return false;
  const available = new Set(peers as PeerId[]);
  const digest = ledgerDigest(event, ledgerAddress);
  for (const raw of signatures) {
    if (!(raw instanceof Uint8Array)) return false;
    let signer: PeerId | null = null;
    for (const peer of available)
      if (verifyByPeer(peer, digest, raw as Signature)) {
        signer = peer;
        break;
      }
    if (signer === null) return false;
    available.delete(signer);
  }
  return true;
}

function verifyConfigSignatureSet(event: Record<string, unknown>, ledgerAddress?: string): boolean {
  const signers = event['signers'];
  const signatures = event['signatures'];
  if (!Array.isArray(signers) || !Array.isArray(signatures) || signers.length !== signatures.length)
    return false;
  const digest = ledgerDigest(event, ledgerAddress);
  return signers.every(
    (signer, index) =>
      typeof signer === 'string' &&
      signatures[index] instanceof Uint8Array &&
      verifyByPeer(signer as PeerId, digest, signatures[index] as Signature),
  );
}

function verifyArbitrationAttestations(event: Record<string, unknown>): boolean {
  const signatures = event['panelSignatures'];
  const arbiters = event['arbiters'];
  if (!Array.isArray(signatures) || !Array.isArray(arbiters)) return false;
  if (arbiters.length === 0) return signatures.length === 0;
  const digest = signingDigest({
    type: 'arbitration-result-attest',
    reportEventId: event['reportEventId'],
    target: event['target'],
    result: event['result'],
    passRatioX100: event['passRatioX100'],
  });
  const panel = new Set(arbiters);
  return signatures.every(
    (item) =>
      isRecord(item) &&
      typeof item['signer'] === 'string' &&
      panel.has(item['signer']) &&
      item['sig'] instanceof Uint8Array &&
      verifyByPeer(item['signer'] as PeerId, digest, item['sig'] as Signature),
  );
}

/**
 * @param payload OrbitDB Events database oplog payload。
 * @returns operation shape、成本上限與 timeless 基本簽章皆合法時為 true。
 */
export function ledgerOperationAdmissionFailure(
  payload: unknown,
  ledgerAddress?: string,
): string | null {
  if (!isRecord(payload)) return 'operation is not a record';
  const keys = Object.keys(payload);
  if (
    keys.length !== 3 ||
    !keys.every((key) => key === 'op' || key === 'key' || key === 'value') ||
    payload['op'] !== 'ADD' ||
    payload['key'] !== null ||
    !hasBoundedShape(payload['value']) ||
    !isBaseEvent(payload['value'])
  )
    return 'operation or event shape is invalid';
  try {
    if (dagCbor.encode(payload['value']).byteLength > LEDGER_EVENT_MAX_BYTES)
      return 'event exceeds encoded byte limit';
    const event = payload['value'];
    if (!LEDGER_EVENT_TYPES.has(event.type)) return 'event type is not admitted';
    if (MULTISIG_EVENT_TYPES.has(event.type)) {
      const signatures = (event as unknown as Record<string, unknown>)['signatures'];
      if (
        Array.isArray(signatures) &&
        signatures.some((item) => {
          const raw = item instanceof Uint8Array ? item : isRecord(item) ? item['sig'] : item;
          return (
            !(raw instanceof Uint8Array) ||
            raw.byteLength !== Protocol.security.ED25519_SIGNATURE_BYTES
          );
        })
      )
        return 'multisig member is invalid';
    }
    if (!isExactLedgerEvent(event)) return 'event schema is invalid';
    if (!MULTISIG_EVENT_TYPES.has(event.type)) {
      if (
        event.signature.byteLength !== Protocol.security.ED25519_SIGNATURE_BYTES ||
        !verifyEventSignature(event, ledgerAddress)
      )
        return 'single signature is invalid';
      if (
        event.type === 'arbitration-result' &&
        !verifyArbitrationAttestations(event as unknown as Record<string, unknown>)
      )
        return 'arbitration attestation set is invalid';
      return null;
    }
    if (event.signature.byteLength !== 0) return 'multisig event has a base signature';
    if (event.type === 'match-result')
      return verifyMatchResultSignatureSet(event as unknown as MatchResultEvent, ledgerAddress)
        ? null
        : 'match signature set is invalid';
    if (event.type === 'race-consensus-anchor')
      return verifyRaceConsensusAnchorSignatureSet(
        event as unknown as RaceConsensusAnchorEvent,
        ledgerAddress,
      )
        ? null
        : 'consensus anchor signature set is invalid';
    if (event.type === 'desync')
      return verifyDesyncSignatureSet(event as unknown as Record<string, unknown>, ledgerAddress)
        ? null
        : 'desync signature set is invalid';
    if (event.type === 'config-update')
      return verifyConfigSignatureSet(event as unknown as Record<string, unknown>, ledgerAddress)
        ? null
        : 'config signature set is invalid';
    // 其餘多簽事件的完整有效性需 checkpoint/governance/race context；本層仍要求
    // signatures 容器存在且每個裸簽章或 {sig} 都是 Ed25519 固定長度。
    const signatures = (event as unknown as Record<string, unknown>)['signatures'];
    if (!Array.isArray(signatures) || signatures.length === 0 || signatures.length > 64)
      return 'multisig container is invalid';
    return signatures.every((item) => {
      const signature = item instanceof Uint8Array ? item : isRecord(item) ? item['sig'] : item;
      return (
        signature instanceof Uint8Array &&
        signature.byteLength === Protocol.security.ED25519_SIGNATURE_BYTES
      );
    })
      ? null
      : 'multisig member is invalid';
  } catch {
    return 'event encoding failed';
  }
}

/** @returns deterministic admission 通過時為 true。 */
export function isLedgerOperationAdmissible(payload: unknown): boolean {
  return ledgerOperationAdmissionFailure(payload) === null;
}
