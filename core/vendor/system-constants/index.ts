/**
 * system-constants — 地基常數（四層：protocol／network／ui／economy-config）
 * 使用鐵則：禁 hardcode、一律從本套件取；常數名與設計文件同名＝雙向對照鍵
 */
export * as Protocol from './protocol';
export * as Network from './network';
export * as UI from './ui';
export * as EconomyConfig from './economy-config';
export type {
  ProtocolVersion,
  NetworkVersion,
  ClientVersion,
  EconomyConfigEpoch,
  Meter,
  SquareMeter,
  CubicMeter,
  Gram,
  X1000,
  X100,
  MinorUnits,
  PeerId,
  CID,
  Signature,
  ConsistencyLevel,
} from './brands';
export {
  meters,
  squareMeters,
  cubicMeters,
  grams,
  x1000,
  x100,
  minorUnits,
  protocolVersion,
  clientVersion,
  economyConfigEpoch,
  peerId,
  cid,
  signature,
} from './brands';
export { checkInvariants } from './invariants';
