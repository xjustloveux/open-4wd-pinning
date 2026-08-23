/**
 * Ledger v1 事件的 stateless exact-schema gate。
 *
 * 這一層只檢查事件自身即可決定的事實；餘額、作者、前置事件、治理 epoch 等
 * state-dependent 規則仍由 deterministic reducer/live validator 判斷，避免各節點
 * 因本機同步進度不同而對同一 entry 作出不同 admission 決定。
 */
import { CID } from 'multiformats/cid';
import { base58btc } from 'multiformats/bases/base58';
import { Network, Protocol } from '@open4wd/system-constants';
import { peerIdToPublicKey, publicKeyToPeerId } from '../key-manager/ed25519';
import { isEconomyConfigShape, validateEconomyConfig } from '../economy/config';
import { batteryOutputWithinVolumeUm3 } from '../energy-contract';
import { deriveChipSlotCountFromVolumeUm3 } from '../chip-slot-contract';
import { verifyStartGridProof } from '../matchmaking/start-grid';
import { validateUgcPresentationMetadata } from '../ugc-fork/presentation';

const encoder = new TextEncoder();
const SHORT_BYTES = 256;
const TEXT_BYTES = 4096;
const MAX_LIST = 64;
const MAX_EVIDENCE = 16;
const MAX_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is RecordValue {
  if (!record(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
  );
}

function bytes(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    encoder.encode(value).byteLength <= max
  );
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function finite(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function amount(value: unknown): boolean {
  // dag-cbor 會把安全範圍 bigint 解回 number；兩者 canonical CBOR bytes 相同，
  // admission 必須同時接受原始本機事件與 Orbit roundtrip 後的等值 wire 形。
  return (typeof value === 'bigint' && value >= 0n && value <= MAX_AMOUNT) || integer(value);
}

function signature(
  value: unknown,
  length = Protocol.security.ED25519_SIGNATURE_BYTES,
): value is Uint8Array {
  return (
    typeof value === 'object' &&
    value !== null &&
    ArrayBuffer.isView(value) &&
    !(value instanceof DataView) &&
    value.byteLength === length
  );
}

/** 驗證 untrusted value 是可還原 Ed25519 公鑰的 canonical PeerId。 */
export function isCanonicalPeerId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > Protocol.security.P2P_MESSAGE_SIGNER_MAX_CHARS)
    return false;
  const publicKey = peerIdToPublicKey(value as never);
  return publicKey !== null && publicKeyToPeerId(publicKey) === value;
}

/** 驗證 untrusted value 是允許 codec/hash 的 canonical CID。 */
export function isCanonicalCid(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > SHORT_BYTES) return false;
  try {
    const parsed = CID.parse(value);
    return parsed.version === 1 && parsed.toString() === value;
  } catch {
    return false;
  }
}

/** Orbit oplog entry CID 使用 base58btc，與內容塊的 canonical base32 分軌。 */
export function isCanonicalEntryCid(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > SHORT_BYTES) return false;
  try {
    const parsed = CID.parse(value, base58btc);
    return parsed.version === 1 && parsed.toString(base58btc) === value;
  } catch {
    return false;
  }
}

function partRef(value: unknown): value is string {
  return (
    isCanonicalCid(value) ||
    (typeof value === 'string' && /^builtin:[a-z0-9][a-z0-9-]{0,127}$/.test(value))
  );
}

function peerList(value: unknown, allowEmpty = false): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.length <= MAX_LIST &&
    value.every(isCanonicalPeerId) &&
    new Set(value).size === value.length
  );
}

function cidList(value: unknown, allowEmpty = true): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.length <= MAX_LIST &&
    value.every(isCanonicalCid) &&
    new Set(value).size === value.length
  );
}

function stringList(value: unknown, maxItems: number, maxBytes: number): value is string[] {
  return (
    Array.isArray(value) && value.length <= maxItems && value.every((item) => bytes(item, maxBytes))
  );
}

const BASE_KEYS = ['type', 'timestamp', 'peerId', 'signature'] as const;
const BASE_OPTIONAL = ['parentEventCid'] as const;

function eventExact(
  event: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): event is RecordValue {
  return exact(event, [...BASE_KEYS, ...fields], [...BASE_OPTIONAL, ...optional]);
}

function baseFields(event: RecordValue): boolean {
  return (
    bytes(event['type'], SHORT_BYTES) &&
    integer(event['timestamp']) &&
    isCanonicalPeerId(event['peerId']) &&
    signature(
      event['signature'],
      event['signature'] instanceof Uint8Array ? event['signature'].byteLength : -1,
    ) &&
    (!Object.hasOwn(event, 'parentEventCid') || isCanonicalEntryCid(event['parentEventCid']))
  );
}

function signerSignature(value: unknown): value is RecordValue {
  return (
    exact(value, ['signer', 'sig']) && isCanonicalPeerId(value['signer']) && signature(value['sig'])
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function strictlyOrdered<T>(values: readonly T[], compare: (a: T, b: T) => number): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) < 0);
}

function raceAbortFrameSummaries(value: unknown): value is RecordValue[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) return false;
  if (
    !value.every(
      (item) =>
        exact(item, ['roundIndex', 'frame', 'checksum']) &&
        integer(item['roundIndex']) &&
        integer(item['frame']) &&
        bytes(item['checksum'], SHORT_BYTES),
    )
  )
    return false;
  return strictlyOrdered(value, (a, b) =>
    (a['roundIndex'] as number) !== (b['roundIndex'] as number)
      ? (a['roundIndex'] as number) - (b['roundIndex'] as number)
      : (a['frame'] as number) !== (b['frame'] as number)
        ? (a['frame'] as number) - (b['frame'] as number)
        : compareText(a['checksum'] as string, b['checksum'] as string),
  );
}

const ABORT_MESSAGE_KINDS = new Set([
  'leave',
  'settlement-reject',
  'settlement-cancel',
  'checksum',
]);

function raceAbortMessageDigests(value: unknown): value is RecordValue[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) return false;
  if (
    !value.every(
      (item) =>
        exact(item, ['sender', 'kind', 'digest']) &&
        isCanonicalPeerId(item['sender']) &&
        typeof item['kind'] === 'string' &&
        ABORT_MESSAGE_KINDS.has(item['kind']) &&
        bytes(item['digest'], SHORT_BYTES),
    )
  )
    return false;
  return strictlyOrdered(value, (a, b) =>
    compareText(
      `${a['sender'] as string}\u0000${a['kind'] as string}\u0000${a['digest'] as string}`,
      `${b['sender'] as string}\u0000${b['kind'] as string}\u0000${b['digest'] as string}`,
    ),
  );
}

const ABORT_OBSERVATION_KINDS = new Set(['peer-left', 'no-quorum', 'desync', 'session-error']);

function raceAbortObservations(value: unknown): value is RecordValue[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) return false;
  if (
    !value.every(
      (item) =>
        exact(item, ['roundIndex', 'frame', 'kind'], ['subject']) &&
        integer(item['roundIndex']) &&
        integer(item['frame']) &&
        typeof item['kind'] === 'string' &&
        ABORT_OBSERVATION_KINDS.has(item['kind']) &&
        (!Object.hasOwn(item, 'subject') || isCanonicalPeerId(item['subject'])),
    )
  )
    return false;
  return strictlyOrdered(value, (a, b) => {
    const round = (a['roundIndex'] as number) - (b['roundIndex'] as number);
    if (round !== 0) return round;
    const frame = (a['frame'] as number) - (b['frame'] as number);
    if (frame !== 0) return frame;
    return compareText(
      `${a['kind'] as string}\u0000${(a['subject'] as string | undefined) ?? ''}`,
      `${b['kind'] as string}\u0000${(b['subject'] as string | undefined) ?? ''}`,
    );
  });
}

function signerSignatures(value: unknown, allowEmpty = false): value is RecordValue[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.length <= MAX_LIST &&
    value.every(signerSignature) &&
    new Set(value.map((item) => item['signer'])).size === value.length
  );
}

function consensusAnchor(value: unknown): value is RecordValue {
  if (
    !record(value) ||
    !baseFields(value) ||
    value['type'] !== 'race-consensus-anchor' ||
    !eventExact(value, [
      'matchId',
      'gridContextDigest',
      'gridSeed',
      'roundIndex',
      'frame',
      'checksum',
      'presentPeers',
      'signatures',
    ]) ||
    !bytes(value['matchId'], SHORT_BYTES) ||
    !/^[0-9a-f]{64}$/u.test(value['gridContextDigest'] as string) ||
    !/^[0-9a-f]{64}$/u.test(value['gridSeed'] as string) ||
    !integer(value['roundIndex']) ||
    !integer(value['frame']) ||
    value['frame'] % Network.sync.SNAPSHOT_INTERVAL_FRAMES !== 0 ||
    !bytes(value['checksum'], SHORT_BYTES) ||
    !peerList(value['presentPeers']) ||
    !strictlyOrdered(value['presentPeers'], compareText) ||
    !signerSignatures(value['signatures']) ||
    !(value['signature'] instanceof Uint8Array) ||
    value['signature'].byteLength !== 0
  )
    return false;
  const present = new Set(value['presentPeers']);
  return (
    value['signatures'].length >= Math.floor(value['presentPeers'].length / 2) + 1 &&
    value['signatures'].every((entry) => present.has(entry['signer'] as string))
  );
}

function anchorCandidateKey(value: RecordValue): string {
  return [
    value['matchId'],
    value['roundIndex'],
    value['frame'],
    value['checksum'],
    (value['presentPeers'] as string[]).join('\u0000'),
    value['timestamp'],
    value['peerId'],
    value['parentEventCid'] ?? '',
  ].join('\u0001');
}

function raceAnchorConflicts(value: unknown, matchId: unknown): value is RecordValue[] {
  if (!Array.isArray(value) || value.length > 1) return false;
  if (
    !value.every((item) => {
      if (
        !exact(item, ['roundIndex', 'first', 'second', 'equivocators']) ||
        !integer(item['roundIndex']) ||
        !consensusAnchor(item['first']) ||
        !consensusAnchor(item['second']) ||
        !peerList(item['equivocators'], true)
      )
        return false;
      const first = item['first'];
      const second = item['second'];
      const firstSignatures = first['signatures'] as RecordValue[];
      const secondSignatures = second['signatures'] as RecordValue[];
      const firstSigners = new Set(firstSignatures.map((entry) => entry['signer']));
      const expectedEquivocators = secondSignatures
        .map((entry) => entry['signer'] as string)
        .filter((peer) => firstSigners.has(peer))
        .sort(compareText);
      return (
        first['matchId'] === matchId &&
        second['matchId'] === matchId &&
        first['roundIndex'] === item['roundIndex'] &&
        second['roundIndex'] === item['roundIndex'] &&
        anchorCandidateKey(first) !== anchorCandidateKey(second) &&
        item['equivocators'].length === expectedEquivocators.length &&
        item['equivocators'].every((peer, index) => peer === expectedEquivocators[index])
      );
    })
  )
    return false;
  return strictlyOrdered(
    value,
    (a, b) => (a['roundIndex'] as number) - (b['roundIndex'] as number),
  );
}

function vec3Bigint(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (item) =>
        (typeof item === 'bigint' && item >= -MAX_AMOUNT && item <= MAX_AMOUNT) ||
        integer(item, -Number.MAX_SAFE_INTEGER),
    )
  );
}

function vec3Int(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => integer(item, -Number.MAX_SAFE_INTEGER))
  );
}

function physicsFingerprint(value: unknown, ugcType: string): boolean {
  if (!record(value) || typeof value['kind'] !== 'string') return false;
  if (value['kind'] === 'rigid')
    return (
      ['chassis', 'body', 'weapon'].includes(ugcType) &&
      exact(
        value,
        ['kind', 'mass_mg', 'com_um', 'inertia_mg_um2', 'surfaceArea_um2'],
        ['frontalArea_um2', 'weaponBranchHash'],
      ) &&
      amount(value['mass_mg']) &&
      vec3Bigint(value['com_um']) &&
      vec3Bigint(value['inertia_mg_um2']) &&
      amount(value['surfaceArea_um2']) &&
      (!Object.hasOwn(value, 'frontalArea_um2') || amount(value['frontalArea_um2'])) &&
      (!Object.hasOwn(value, 'weaponBranchHash') || bytes(value['weaponBranchHash'], SHORT_BYTES))
    );
  if (value['kind'] === 'rolling')
    return (
      ['tire', 'roller'].includes(ugcType) &&
      exact(value, ['kind', 'mass_mg', 'radius_um', 'width_um', 'rollingInertia_mg_um2']) &&
      amount(value['mass_mg']) &&
      amount(value['radius_um']) &&
      amount(value['width_um']) &&
      amount(value['rollingInertia_mg_um2'])
    );
  if (value['kind'] === 'functional')
    return (
      ['motor', 'battery'].includes(ugcType) &&
      exact(
        value,
        ['kind', 'subtype', 'mass_mg', 'volume_um3'],
        ['torqueRatio_pct', 'configuredOutputW'],
      ) &&
      value['subtype'] === ugcType &&
      amount(value['mass_mg']) &&
      amount(value['volume_um3']) &&
      (ugcType === 'motor'
        ? finite(value['torqueRatio_pct']) && !Object.hasOwn(value, 'configuredOutputW')
        : finite(value['configuredOutputW']) &&
          batteryOutputWithinVolumeUm3(
            value['configuredOutputW'] as number,
            value['volume_um3'] as bigint,
          ) &&
          !Object.hasOwn(value, 'torqueRatio_pct'))
    );
  if (value['kind'] === 'chip') {
    if (
      ugcType !== 'chip' ||
      !exact(value, ['kind', 'mass_mg', 'volume_um3', 'slotCount', 'skillSlots']) ||
      !amount(value['mass_mg']) ||
      !amount(value['volume_um3']) ||
      !integer(value['slotCount'], 0, 64) ||
      !Array.isArray(value['skillSlots']) ||
      value['slotCount'] !==
        deriveChipSlotCountFromVolumeUm3(value['volume_um3'] as bigint | number) ||
      value['skillSlots'].length > value['slotCount']
    )
      return false;
    const skills = new Set<string>();
    let allocationSum = 0;
    for (const slot of value['skillSlots']) {
      if (
        !exact(slot, ['skill', 'allocationPct']) ||
        ![
          'boost',
          'brake',
          'swerve_left',
          'swerve_right',
          'jump',
          'slam',
          'stabilize',
          'weapon',
        ].includes(String(slot['skill'])) ||
        !integer(slot['allocationPct'], 1, 100) ||
        skills.has(String(slot['skill']))
      )
        return false;
      skills.add(String(slot['skill']));
      allocationSum += slot['allocationPct'] as number;
    }
    return allocationSum <= 100;
  }
  return (
    value['kind'] === 'track' &&
    ugcType === 'track' &&
    exact(value, [
      'kind',
      'pathLength_mm',
      'avgWidth_mm',
      'turnCount',
      'surfaceArea_mm2',
      'elevationRange_mm',
      'checkpointCount',
    ]) &&
    amount(value['pathLength_mm']) &&
    amount(value['avgWidth_mm']) &&
    integer(value['turnCount']) &&
    amount(value['surfaceArea_mm2']) &&
    amount(value['elevationRange_mm']) &&
    integer(value['checkpointCount'])
  );
}

function meshFeatures(value: unknown): boolean {
  return (
    exact(value, [
      'vertexCount',
      'volume',
      'surfaceArea',
      'aabbDims',
      'barycenter',
      'pcaAxes',
      'isMirror',
    ]) &&
    integer(value['vertexCount']) &&
    amount(value['volume']) &&
    amount(value['surfaceArea']) &&
    vec3Int(value['aabbDims']) &&
    vec3Int(value['barycenter']) &&
    Array.isArray(value['pcaAxes']) &&
    value['pcaAxes'].length === 3 &&
    value['pcaAxes'].every(vec3Int) &&
    typeof value['isMirror'] === 'boolean'
  );
}

function meshFingerprint(value: unknown): boolean {
  return (
    exact(value, ['primary', 'features'], ['lshSignature']) &&
    typeof value['primary'] === 'string' &&
    /^[0-9a-f]{64}$/.test(value['primary']) &&
    meshFeatures(value['features']) &&
    (!Object.hasOwn(value, 'lshSignature') ||
      (value['lshSignature'] instanceof Uint8Array && value['lshSignature'].byteLength <= 256))
  );
}

function ugcMetadata(value: unknown): boolean {
  if (
    !exact(
      value,
      [
        'type',
        'copyright',
        'fingerprint',
        'fingerprintVersion',
        'physicsManifestVersion',
        'physicsManifestDigest',
        'parentCid',
      ],
      ['authorizationSource', 'diffStage1', 'diffStage2', 'meshFingerprint'],
    )
  )
    return false;
  const type = value['type'];
  if (
    typeof type !== 'string' ||
    !['chassis', 'body', 'tire', 'motor', 'battery', 'roller', 'chip', 'weapon', 'track'].includes(
      type,
    ) ||
    !['self-made', 'cc0', 'authorized'].includes(String(value['copyright'])) ||
    !physicsFingerprint(value['fingerprint'], type) ||
    !integer(value['fingerprintVersion'], 1) ||
    !integer(value['physicsManifestVersion'], 1) ||
    typeof value['physicsManifestDigest'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value['physicsManifestDigest']) ||
    !(value['parentCid'] === null || isCanonicalCid(value['parentCid']))
  )
    return false;
  if (
    Object.hasOwn(value, 'authorizationSource') &&
    !bytes(value['authorizationSource'], TEXT_BYTES)
  )
    return false;
  if (value['copyright'] === 'authorized' && !bytes(value['authorizationSource'], TEXT_BYTES))
    return false;
  if (Object.hasOwn(value, 'diffStage1') && !finite(value['diffStage1'], 0, 1)) return false;
  if (Object.hasOwn(value, 'diffStage2') && !finite(value['diffStage2'], 0, 1)) return false;
  return !Object.hasOwn(value, 'meshFingerprint') || meshFingerprint(value['meshFingerprint']);
}

function loadout(value: unknown): boolean {
  if (
    !exact(
      value,
      ['chassis', 'body', 'motor', 'battery', 'tires', 'rollers'],
      ['chip', 'weapon', 'passiveWeightSplitPct'],
    ) ||
    !['chassis', 'body', 'motor', 'battery'].every((key) => partRef(value[key])) ||
    !exact(value['tires'], ['FL', 'FR', 'RL', 'RR']) ||
    !Object.values(value['tires']).every(partRef) ||
    !exact(value['rollers'], [], ['FL', 'FR', 'CL', 'CR', 'RL', 'RR']) ||
    !Object.values(value['rollers']).every(partRef)
  )
    return false;
  return (
    (!Object.hasOwn(value, 'chip') || partRef(value['chip'])) &&
    (!Object.hasOwn(value, 'weapon') || partRef(value['weapon'])) &&
    (!Object.hasOwn(value, 'passiveWeightSplitPct') ||
      integer(value['passiveWeightSplitPct'], 0, 100))
  );
}

function matchParticipant(value: unknown): value is RecordValue {
  return (
    exact(value, ['peerId', 'carRotation']) &&
    isCanonicalPeerId(value['peerId']) &&
    Array.isArray(value['carRotation']) &&
    value['carRotation'].length > 0 &&
    value['carRotation'].length <= MAX_LIST &&
    value['carRotation'].every(loadout)
  );
}

function round(value: unknown): boolean {
  if (
    !exact(
      value,
      [
        'roundIndex',
        'trackRef',
        'lapCount',
        'endReason',
        'terminalFrame',
        'ranking',
        'finishTimes',
        'destructionCounts',
      ],
      ['disallowChip'],
    ) ||
    !integer(value['roundIndex']) ||
    !partRef(value['trackRef']) ||
    !integer(value['lapCount'], 1) ||
    !integer(value['terminalFrame']) ||
    (Object.hasOwn(value, 'disallowChip') && typeof value['disallowChip'] !== 'boolean') ||
    !['completed', 'eliminated', 'duration-limit'].includes(String(value['endReason'])) ||
    !peerList(value['ranking']) ||
    !record(value['finishTimes']) ||
    Object.keys(value['finishTimes']).length !== value['ranking'].length ||
    !record(value['destructionCounts']) ||
    Object.keys(value['destructionCounts']).length !== value['ranking'].length
  )
    return false;
  const finishTimes = value['finishTimes'];
  const destructionCounts = value['destructionCounts'];
  return value['ranking'].every(
    (peer) =>
      Object.hasOwn(finishTimes, peer) &&
      integer(finishTimes[peer]) &&
      Object.hasOwn(destructionCounts, peer) &&
      integer(destructionCounts[peer], 0),
  );
}

function versionInfo(value: unknown): boolean {
  return (
    exact(value, [
      'client_version',
      'rapier_version',
      'protocol_version',
      'derive_logic_version',
      'builtin_assets_version',
      'economy_config_version',
      'build_timestamp',
      'commit_hash',
    ]) &&
    bytes(value['client_version'], 64) &&
    bytes(value['rapier_version'], 64) &&
    bytes(value['protocol_version'], 64) &&
    integer(value['derive_logic_version']) &&
    integer(value['builtin_assets_version']) &&
    integer(value['economy_config_version']) &&
    integer(value['build_timestamp']) &&
    bytes(value['commit_hash'], 128)
  );
}

function matchResult(event: RecordValue): boolean {
  if (
    !eventExact(event, [
      'matchId',
      'gridProof',
      'ranking',
      'rounds',
      'roundAnchors',
      'loadouts',
      'loadoutSignatures',
      'matchRules',
      'disconnects',
      'startedAt',
      'finishedAt',
      'clientVersions',
      'signatures',
    ]) ||
    !bytes(event['matchId'], SHORT_BYTES) ||
    !verifyStartGridProof(event['gridProof'] as never).ok ||
    !peerList(event['ranking']) ||
    !Array.isArray(event['rounds']) ||
    event['rounds'].length === 0 ||
    event['rounds'].length > MAX_LIST ||
    !event['rounds'].every(round) ||
    !Array.isArray(event['roundAnchors']) ||
    event['roundAnchors'].length !== event['rounds'].length ||
    !event['roundAnchors'].every((anchor) => anchor === null || consensusAnchor(anchor)) ||
    !record(event['loadouts']) ||
    Object.keys(event['loadouts']).length > MAX_LIST ||
    !record(event['loadoutSignatures']) ||
    !exact(event['matchRules'], []) ||
    !Array.isArray(event['disconnects']) ||
    event['disconnects'].length > MAX_LIST ||
    !integer(event['startedAt']) ||
    !integer(event['finishedAt']) ||
    event['finishedAt'] < event['startedAt'] ||
    (event['finishedAt'] as number) > (event['timestamp'] as number) ||
    !record(event['clientVersions']) ||
    !signerSignatures(event['signatures'])
  )
    return false;
  for (const [peer, participant] of Object.entries(event['loadouts'])) {
    if (
      !isCanonicalPeerId(peer) ||
      !matchParticipant(participant) ||
      participant['peerId'] !== peer
    )
      return false;
    if (
      !Object.hasOwn(event['loadoutSignatures'], peer) ||
      !signature(event['loadoutSignatures'][peer])
    )
      return false;
  }
  if (Object.keys(event['loadoutSignatures']).length !== Object.keys(event['loadouts']).length)
    return false;
  if (
    !event['disconnects'].every(
      (item) =>
        exact(item, ['peerId', 'disconnectedAt', 'reason']) &&
        isCanonicalPeerId(item['peerId']) &&
        integer(item['disconnectedAt']) &&
        (item['reason'] === 'voluntary' || item['reason'] === 'network'),
    )
  )
    return false;
  return Object.entries(event['clientVersions']).every(
    ([peer, info]) => isCanonicalPeerId(peer) && versionInfo(info),
  );
}

function economyConfigExact(value: unknown): value is RecordValue {
  if (
    !isEconomyConfigShape(value) ||
    !validateEconomyConfig(value) ||
    !exact(value, [
      'epoch',
      'signedAt',
      'signers',
      'revShare',
      'forkDetection',
      'month_soft_cap_minor',
      'month_hard_cap_minor',
      'match_prize',
      'creator_royalty',
      'upload_costs',
      'expansion_costs',
      'sponsorship',
      'governanceSigners',
      'hot_match_quarters',
      'ugc_lifecycle',
    ]) ||
    !peerList(value['signers'], true) ||
    !peerList(value['governanceSigners']) ||
    value['governanceSigners'].length === 2 ||
    !exact(value['revShare'], [
      'currentTierPct',
      'parentTierPct',
      'grandparentTierPct',
      'maxDepth',
    ]) ||
    !exact(value['forkDetection'], ['stage1_geometry', 'stage2_physics']) ||
    !exact(value['forkDetection']['stage1_geometry'], ['passthrough_threshold']) ||
    !exact(value['forkDetection']['stage2_physics'], [
      'rigid',
      'rolling',
      'functional_mesh',
      'functional_sidecar',
      'chip_mesh',
      'chip_skill',
      'track',
    ]) ||
    !exact(value['match_prize'], [
      'base_amount_minor',
      'rank_multipliers_pct',
      'min_player_count',
      'combo_window_hours',
      'combo_max_matches_per_day',
      'player_prized_matches_per_day',
    ]) ||
    !Array.isArray(value['match_prize']['rank_multipliers_pct']) ||
    value['match_prize']['rank_multipliers_pct'].length > MAX_LIST ||
    !exact(value['creator_royalty'], ['base_per_use_minor', 'dedup_window_hours']) ||
    !exact(value['upload_costs'], [
      'part_upload_minor',
      'track_upload_minor',
      'metadata_update_minor',
    ]) ||
    !exact(value['expansion_costs'], ['vehicle_slot_minor']) ||
    !exact(value['sponsorship'], ['min_amount_minor']) ||
    !exact(value['ugc_lifecycle'], [
      'candidate_no_use_ms',
      'candidate_low_rating_threshold_x100',
      'candidate_low_rating_no_use_ms',
      'candidate_creator_gone_ms',
      'maintenance_grace_ms',
      'maintenance_burn_minor',
    ])
  )
    return false;
  return Object.values(value['forkDetection']['stage2_physics']).every((threshold) =>
    exact(threshold, ['strict', 'loose']),
  );
}

function target(value: unknown, kind: unknown): boolean {
  return kind === 'cid' ? isCanonicalCid(value) : kind === 'peer' && isCanonicalPeerId(value);
}

function schemaFor(event: RecordValue): boolean {
  switch (event['type']) {
    case 'ugc-maintenance':
      return (
        eventExact(event, ['cid', 'payer', 'burnAmount', 'reason']) &&
        isCanonicalCid(event['cid']) &&
        event['payer'] === event['peerId'] &&
        amount(event['burnAmount']) &&
        ['retire', 'renew', 'unretire'].includes(String(event['reason']))
      );
    case 'slot-purchase':
      return (
        eventExact(event, ['payer', 'amount', 'newSlotIndex']) &&
        event['payer'] === event['peerId'] &&
        amount(event['amount']) &&
        integer(event['newSlotIndex'], 1)
      );
    case 'ugc-sponsor-burn':
      return (
        eventExact(event, ['payer', 'targetCid', 'amount']) &&
        event['payer'] === event['peerId'] &&
        isCanonicalCid(event['targetCid']) &&
        amount(event['amount'])
      );
    case 'ugc-upload':
      return (
        eventExact(event, ['cid', 'metadata', 'presentation', 'similarityMatches']) &&
        isCanonicalCid(event['cid']) &&
        ugcMetadata(event['metadata']) &&
        validateUgcPresentationMetadata(event['presentation']) &&
        cidList(event['similarityMatches']) &&
        !event['similarityMatches'].includes(event['cid'])
      );
    case 'ugc-metadata-update':
      return (
        eventExact(event, ['cid', 'presentation', 'revision']) &&
        isCanonicalCid(event['cid']) &&
        validateUgcPresentationMetadata(event['presentation']) &&
        integer(event['revision'], 1)
      );
    case 'ugc-fork':
      return (
        eventExact(event, ['childCid', 'parentCid']) &&
        isCanonicalCid(event['childCid']) &&
        isCanonicalCid(event['parentCid']) &&
        event['childCid'] !== event['parentCid']
      );
    case 'ugc-rate':
      return (
        eventExact(event, ['rater', 'cid', 'score', 'useMatchId']) &&
        event['rater'] === event['peerId'] &&
        isCanonicalCid(event['cid']) &&
        integer(event['score'], 1, 5) &&
        bytes(event['useMatchId'], SHORT_BYTES)
      );
    case 'ugc-rate-revoke':
      return (
        eventExact(event, ['rateEventId', 'rater', 'cid']) &&
        bytes(event['rateEventId'], SHORT_BYTES) &&
        event['rater'] === event['peerId'] &&
        isCanonicalCid(event['cid'])
      );
    case 'report':
      return (
        eventExact(
          event,
          ['target', 'targetKind', 'reporter', 'reason'],
          ['details', 'evidence'],
        ) &&
        event['reporter'] === event['peerId'] &&
        target(event['target'], event['targetKind']) &&
        ['copyright-violation', 'griefing', 'inappropriate-content', 'other'].includes(
          String(event['reason']),
        ) &&
        (!Object.hasOwn(event, 'details') ||
          (typeof event['details'] === 'string' &&
            event['details'].length <= 500 &&
            bytes(event['details'], 2000, true))) &&
        (!Object.hasOwn(event, 'evidence') ||
          stringList(event['evidence'], MAX_EVIDENCE, TEXT_BYTES))
      );
    case 'report-revoke':
      return (
        eventExact(event, ['reportEventId', 'reporter', 'target']) &&
        bytes(event['reportEventId'], SHORT_BYTES) &&
        event['reporter'] === event['peerId'] &&
        (isCanonicalCid(event['target']) || isCanonicalPeerId(event['target']))
      );
    case 'arbitration-vote':
      return (
        eventExact(event, ['reportEventId', 'arbiter', 'vote']) &&
        bytes(event['reportEventId'], SHORT_BYTES) &&
        event['arbiter'] === event['peerId'] &&
        ['pass', 'reject', 'abstain'].includes(String(event['vote']))
      );
    case 'arbitration-result':
      return (
        eventExact(
          event,
          [
            'reportEventId',
            'result',
            'passRatioX100',
            'arbiters',
            'caseKind',
            'target',
            'targetKind',
            'reason',
            'anchoredAt',
            'panelSignatures',
          ],
          ['reporter'],
        ) &&
        bytes(event['reportEventId'], SHORT_BYTES) &&
        ['pass', 'reject', 'no-quorum'].includes(String(event['result'])) &&
        integer(event['passRatioX100'], 0, 100) &&
        peerList(event['arbiters'], true) &&
        ((event['arbiters'].length === 0 && event['result'] === 'no-quorum') ||
          event['arbiters'].length === Protocol.ledger.ARBITRATION_PANEL_SIZE) &&
        ['report', 'upload-pending'].includes(String(event['caseKind'])) &&
        target(event['target'], event['targetKind']) &&
        ['copyright-violation', 'griefing', 'inappropriate-content', 'other'].includes(
          String(event['reason']),
        ) &&
        integer(event['anchoredAt']) &&
        (event['caseKind'] === 'report'
          ? isCanonicalPeerId(event['reporter'])
          : !Object.hasOwn(event, 'reporter')) &&
        signerSignatures(event['panelSignatures'], event['arbiters'].length === 0)
      );
    case 'blacklist-cid':
      return (
        eventExact(event, ['cid', 'triggeredBy', 'triggeredAt']) &&
        isCanonicalCid(event['cid']) &&
        isCanonicalEntryCid(event['triggeredBy']) &&
        integer(event['triggeredAt'])
      );
    case 'race-consensus-anchor':
      return consensusAnchor(event);
    case 'race-leave':
      return (
        eventExact(event, ['matchId', 'roundIndex', 'reason']) &&
        bytes(event['matchId'], SHORT_BYTES) &&
        integer(event['roundIndex']) &&
        event['reason'] === 'voluntary'
      );
    case 'race-abort-evidence': {
      if (
        !eventExact(event, [
          'matchId',
          'reason',
          'frameSummaries',
          'receivedMessageDigests',
          'observations',
          'anchorConflicts',
        ]) ||
        !bytes(event['matchId'], SHORT_BYTES) ||
        !['settlement-no-quorum', 'consensus-invalid', 'session-error'].includes(
          event['reason'] as string,
        ) ||
        !raceAbortFrameSummaries(event['frameSummaries']) ||
        !raceAbortMessageDigests(event['receivedMessageDigests']) ||
        !raceAbortObservations(event['observations']) ||
        !raceAnchorConflicts(event['anchorConflicts'], event['matchId'])
      )
        return false;
      return (
        event['frameSummaries'].length +
          event['receivedMessageDigests'].length +
          event['observations'].length +
          event['anchorConflicts'].length >
        0
      );
    }
    case 'desync': {
      if (
        !eventExact(event, ['raceId', 'frame', 'participatingPeers', 'hashes', 'signatures']) ||
        !bytes(event['raceId'], SHORT_BYTES) ||
        !integer(event['frame']) ||
        !peerList(event['participatingPeers']) ||
        !record(event['hashes']) ||
        !Array.isArray(event['signatures'])
      )
        return false;
      const hashes = event['hashes'];
      return (
        Object.keys(hashes).length === event['participatingPeers'].length &&
        event['participatingPeers'].every(
          (peer) => Object.hasOwn(hashes, peer) && bytes(hashes[peer], SHORT_BYTES),
        ) &&
        event['signatures'].length > 0 &&
        event['signatures'].length <= event['participatingPeers'].length &&
        event['signatures'].every((item) => signature(item))
      );
    }
    case 'ledger-checkpoint':
      return (
        eventExact(event, ['checkpointCid', 'signatures']) &&
        isCanonicalCid(event['checkpointCid']) &&
        Array.isArray(event['signatures']) &&
        event['signatures'].length > 0 &&
        event['signatures'].length <= MAX_LIST &&
        event['signatures'].every((item) => signature(item))
      );
    case 'config-update':
      return (
        eventExact(event, [
          'epoch',
          'prevEpoch',
          'newConfig',
          'rationale',
          'signers',
          'signatures',
        ]) &&
        integer(event['epoch'], 1) &&
        integer(event['prevEpoch'], 1) &&
        event['epoch'] === event['prevEpoch'] + 1 &&
        economyConfigExact(event['newConfig']) &&
        event['newConfig']['epoch'] === event['epoch'] &&
        bytes(event['rationale'], TEXT_BYTES) &&
        peerList(event['signers']) &&
        Array.isArray(event['signatures']) &&
        event['signatures'].length === event['signers'].length &&
        event['signatures'].every((item) => signature(item))
      );
    case 'match-result':
      return matchResult(event);
    default:
      return false;
  }
}

/** @returns exact schema 與 intrinsic alias 通過；不讀本機 state。 */
export function isExactLedgerEvent(value: unknown): value is RecordValue {
  return record(value) && baseFields(value) && schemaFor(value);
}
