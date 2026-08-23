/**
 * security — 資安實作：Mesh Sanitize（隔離 Worker）／P2P 驗簽／本地安全日誌／SRI 工具
 */
export {
  SANITIZE_LIMITS,
  sanitizeMesh,
  type MeshStats,
  type SanitizeFailReason,
  type SanitizeRequest,
  type SanitizeResult,
} from './sanitize-core';
export { MeshSanitizer } from './mesh-sanitizer';
export { NonceSet } from './nonce-set';
export {
  verifyP2PMessage,
  verifyP2PMessageAuthenticity,
  verifyP2PMessageWithoutNonceCommit,
  type P2pRejectReason,
} from './verify-p2p';
export {
  APP_SECURITY_LOG,
  LocalSecurityLog,
  attachCspViolationListener,
  type SecurityEvent,
} from './security-log';
export { computeSRI } from './sri';
export {
  imageHeaderBytes,
  parseGlbContainer,
  readGlbRootExtras,
  readIndices,
  readPositions,
  rebuildGlb,
  sniffImageSize,
  type GlbContainer,
  type GltfAccessor,
  type GltfBuffer,
  type GltfBufferView,
  type GltfDoc,
  type GltfImage,
  type GltfMesh,
  type GltfPrimitive,
} from './glb';
