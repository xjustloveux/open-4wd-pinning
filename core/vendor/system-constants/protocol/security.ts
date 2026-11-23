/**
 * protocol/security — 安全常數（跨 peer 共識必須一致）
 */

export const SANITIZE_TIMEOUT_MS = 5000;
export const SANITIZE_WORKER_VERSION = 'v1'; // JSON／結構 admission schema；live 後破壞性變更才升版
export const SANITIZE_JSON_CHUNK_MAX_BYTES = 16_777_216; // 16 MiB，TextDecoder／JSON.parse 前限制
export const SANITIZE_DOCUMENT_MAX_ENTRIES = 250_000; // 解析後全文件遍歷成本上限
export const SANITIZE_DOCUMENT_MAX_DEPTH = 64;
export const SANITIZE_GLTF_COLLECTION_MAX = {
  nodes: 50_000,
  meshes: 10_000,
  accessors: 100_000,
  bufferViews: 100_000,
  buffers: 64,
  images: 4096,
  textures: 4096,
  samplers: 4096,
  materials: 4096,
  scenes: 64,
  animations: 1024,
  skins: 4096,
  cameras: 4096,
  extensionsUsed: 128,
  extensionsRequired: 128,
} as const;
export const SANITIZE_GLTF_PRIMITIVES_MAX = 50_000;
export const SANITIZE_DECODED_GEOMETRY_MAX_BYTES = 80 * 1024 * 1024;
export const SANITIZE_DECODED_GEOMETRY_MAX_ELEMENTS = SANITIZE_DECODED_GEOMETRY_MAX_BYTES / 4;
/** 首次來源 admission 可接受的 encoded image 最大邊；canonical 成品仍限制 4096px。 */
export const SOURCE_TEXTURE_EDGE_MAX_PX = 8192;
/** 完成 texture canonicalization 後允許的最終最大邊。 */
export const CANONICAL_TEXTURE_EDGE_MAX_PX = 4096;
export const SANITIZE_EXTRAS_MAX_BYTES = 16_777_216; // 16 MB；extras JSON 總量、非 GLB 檔案大小（初估）
export const SANITIZE_EXTRAS_MAX_DEPTH = 8; // 初估
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;
export const P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC = 30;
export const P2P_MESSAGE_NONCE_BYTES = 16;
export const P2P_MESSAGE_SIGNER_MAX_CHARS = 256;
export const P2P_NONCE_SET_MAX_ENTRIES = 8192;
export const TEXT_BLACKLIST_VERSION = 'v1'; // 格式版本；庫資料隨 client minor 出貨
