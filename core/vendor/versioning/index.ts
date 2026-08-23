/**
 * versioning — B 軸資產 schema 版本邏輯核（loadout 閘／降版目標／動態最低支援版
 * 推導／開賽前驗證兩提示；v1 紀元＝無破壞牆恆通過、升版事件隨首道破壞牆落地）
 * ＋A 軸 client 版本（六欄位 ClientVersionInfo／相容性檢查／開賽前收集＝收齊性
 * 把關／SW 升版檢查 UpdateChecker／forceReload）。
 */
export {
  EMPTY_WALLS,
  EMPTY_YANKED,
  deriveMinSupported,
  downgradeTargetFor,
  isPinnedCheckpointFresh,
  makeAssetVersionGate,
  preRaceVersionCheck,
  type AssetVersionGate,
  type AssetVersionResolver,
  type BreakingWalls,
  type PreRaceVersionReport,
  type YankedVersions,
} from './asset-versions';
export { resolveLineageNode } from './lineage-node';
export {
  CLIENT_VERSION_REGEX,
  UpdateChecker,
  checkCompatibility,
  collectVersionsFromAllPeers,
  forceReload,
  isClientVersionInfo,
  parseClientVersion,
  preRaceClientVersionCheck,
  serveVersionRequests,
  versionInfoOf,
  type ClientVersionInfo,
  type SwRegistrationLike,
  type UpdateCheckerDeps,
  type UpdateInfo,
  type VersionBuildInfo,
  type VersionCollectDeps,
  type VersionWire,
  type VersionWireMessage,
} from './client-version';
