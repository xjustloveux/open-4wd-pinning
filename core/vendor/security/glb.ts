/**
 * 最小 GLB（glTF-Binary 2.0）解析 — sanitize 專用、零依賴
 * 只涵蓋檢核所需：容器 chunk、POSITION／indices accessor 解碼、影像位元組、canonical 重打包
 * 惡意輸入以 throw 收斂（呼叫端轉 parse-error）；POSITION 保留來源數值、不在解析器猜單位
 */
import { Protocol } from '@open4wd/system-constants';

const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const GLB_MAGIC = 0x46546c67; // ASCII 文字為 `glTF`
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

// componentType（glTF 列舉值）
const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

/** glTF buffer 的 sanitizer 所需最小 wire 欄位。 */
export interface GltfBuffer {
  uri?: string;
  byteLength?: number;
}
/** glTF bufferView 的位移、長度與 stride 描述。 */
export interface GltfBufferView {
  buffer?: number;
  byteOffset?: number;
  byteLength?: number;
  byteStride?: number;
}
/** 解碼 POSITION 與 indices 所需的 glTF accessor 欄位。 */
export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType?: number;
  count?: number;
  type?: string;
  sparse?: unknown;
  min?: number[];
  max?: number[];
}
/** sanitizer 會巡覽與重建的 glTF primitive 欄位。 */
export interface GltfPrimitive {
  attributes?: Record<string, number>;
  material?: number;
  /** morph target attributes；POSITION 在 uniform spatial transform 時視為位移 delta 一起縮放 */
  targets?: Record<string, number>[];
  indices?: number;
  mode?: number;
  extensions?: Record<string, unknown>;
}
/** 一組待檢查 primitives 的 glTF mesh。 */
export interface GltfMesh {
  primitives?: GltfPrimitive[];
}
/** 內嵌或外部影像來源的 glTF 描述。 */
export interface GltfImage {
  uri?: string;
  bufferView?: number;
  mimeType?: string;
}
/** sanitizer 接受並依上限巡覽的 glTF JSON 文件子集。 */
export interface GltfDoc {
  asset?: { version?: string };
  extras?: unknown;
  buffers?: GltfBuffer[];
  bufferViews?: GltfBufferView[];
  accessors?: GltfAccessor[];
  meshes?: GltfMesh[];
  images?: GltfImage[];
  nodes?: unknown[];
  textures?: unknown[];
  samplers?: unknown[];
  materials?: unknown[];
  scene?: number;
  scenes?: { extras?: unknown; nodes?: number[] }[];
  animations?: unknown[];
  skins?: unknown[];
  cameras?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

/** 已拆解的 GLB JSON 文件與可選 BIN chunk。 */
export interface GlbContainer {
  doc: GltfDoc;
  bin: Uint8Array | null;
}

const GLTF_COLLECTION_KEYS = Object.keys(
  Protocol.security.SANITIZE_GLTF_COLLECTION_MAX,
) as (keyof typeof Protocol.security.SANITIZE_GLTF_COLLECTION_MAX)[];

function validateDocumentStructure(doc: GltfDoc): void {
  for (const key of GLTF_COLLECTION_KEYS) {
    const value = doc[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new Error(`glTF ${key} must be an array`);
    const maximum = Protocol.security.SANITIZE_GLTF_COLLECTION_MAX[key];
    if (value.length > maximum) throw new Error(`glTF ${key} count exceeds ${maximum}`);
  }

  let primitives = 0;
  for (const mesh of doc.meshes ?? []) {
    if (mesh === null || typeof mesh !== 'object') throw new Error('bad glTF mesh');
    if (mesh.primitives !== undefined && !Array.isArray(mesh.primitives))
      throw new Error('glTF primitives must be an array');
    primitives += mesh.primitives?.length ?? 0;
    if (primitives > Protocol.security.SANITIZE_GLTF_PRIMITIVES_MAX)
      throw new Error('glTF primitive count exceeds limit');
  }

  let entries = 0;
  const stack: { value: unknown; depth: number }[] = [{ value: doc, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > Protocol.security.SANITIZE_DOCUMENT_MAX_DEPTH)
      throw new Error('glTF document nesting exceeds limit');
    if (typeof current.value !== 'object' || current.value === null) continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    entries += children.length;
    if (entries > Protocol.security.SANITIZE_DOCUMENT_MAX_ENTRIES)
      throw new Error('glTF document traversal exceeds limit');
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
}

/**
 * GLB 容器解析：驗 magic／version／長度與結構界限，取 JSON＋BIN chunk。
 *
 * @param buffer 不可信 GLB bytes。
 * @returns 已通過結構 admission 的 JSON document 與第一個 BIN chunk。
 * @throws 當容器、UTF-8、JSON 或結構超出安全界限時拋出 Error。
 */
export function parseGlbContainer(buffer: ArrayBuffer): GlbContainer {
  if (buffer.byteLength < HEADER_BYTES + CHUNK_HEADER_BYTES) throw new Error('GLB too small');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('bad GLB magic');
  if (view.getUint32(4, true) !== GLB_VERSION) throw new Error('unsupported GLB version');
  const total = view.getUint32(8, true);
  if (total > buffer.byteLength || total < HEADER_BYTES) throw new Error('bad GLB length');

  let offset = HEADER_BYTES;
  let jsonBytes: Uint8Array | null = null;
  let bin: Uint8Array | null = null;
  while (offset + CHUNK_HEADER_BYTES <= total) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + CHUNK_HEADER_BYTES;
    if (start + length > total) throw new Error('chunk out of bounds');
    if (type === CHUNK_JSON && !jsonBytes) {
      if (length > Protocol.security.SANITIZE_JSON_CHUNK_MAX_BYTES)
        throw new Error('JSON chunk exceeds limit');
      jsonBytes = new Uint8Array(buffer, start, length);
    } else if (type === CHUNK_BIN && !bin) bin = new Uint8Array(buffer, start, length);
    offset = start + length + ((4 - (length % 4)) % 4); // 寬容非 4 對齊的 chunk
  }
  if (!jsonBytes) throw new Error('missing JSON chunk');

  const doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes)) as GltfDoc;
  if (typeof doc !== 'object' || doc === null || doc.asset === undefined)
    throw new Error('not a glTF document');
  validateDocumentStructure(doc);
  return { doc, bin };
}

/**
 * GLB bytes → root extras（物理烘焙值所在）。慣例＝預設 scene 的 extras（匯出落點）、
 * 缺席退回 glTF 根物件 extras；解析失敗／兩處皆無非物件 extras＝null（fail-soft）。
 */
export function readGlbRootExtras(buffer: ArrayBuffer): Record<string, unknown> | null {
  let doc: GltfDoc;
  try {
    doc = parseGlbContainer(buffer).doc;
  } catch {
    return null;
  }
  const sceneExtras = doc.scenes?.[doc.scene ?? 0]?.extras;
  if (sceneExtras && typeof sceneExtras === 'object') return sceneExtras as Record<string, unknown>;
  if (doc.extras && typeof doc.extras === 'object') return doc.extras as Record<string, unknown>;
  return null;
}

/** canonical 重打包：JSON chunk（空白補齊 4B）＋BIN chunk（零補齊）、重算長度；非標 chunk／尾端垃圾一律剔除 */
export function rebuildGlb(doc: GltfDoc, bin: Uint8Array | null): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(doc));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binLength = bin ? bin.length : 0;
  const binPad = (4 - (binLength % 4)) % 4;
  const total =
    HEADER_BYTES +
    CHUNK_HEADER_BYTES +
    jsonBytes.length +
    jsonPad +
    (bin ? CHUNK_HEADER_BYTES + binLength + binPad : 0);

  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length + jsonPad, true);
  view.setUint32(16, CHUNK_JSON, true);
  bytes.set(jsonBytes, HEADER_BYTES + CHUNK_HEADER_BYTES);
  bytes.fill(
    0x20, // JSON chunk padding＝空白
    HEADER_BYTES + CHUNK_HEADER_BYTES + jsonBytes.length,
    HEADER_BYTES + CHUNK_HEADER_BYTES + jsonBytes.length + jsonPad,
  );
  if (bin) {
    const binHeader = HEADER_BYTES + CHUNK_HEADER_BYTES + jsonBytes.length + jsonPad;
    view.setUint32(binHeader, binLength + binPad, true);
    view.setUint32(binHeader + 4, CHUNK_BIN, true);
    bytes.set(bin, binHeader + CHUNK_HEADER_BYTES); // binPad 預設即為 0
  }
  return out;
}

function bufferViewBytes(
  doc: GltfDoc,
  bin: Uint8Array | null,
  viewIndex: number,
): { bytes: Uint8Array; byteStride: number | undefined } {
  const bufferView = doc.bufferViews?.[viewIndex];
  if (!bufferView || bufferView.buffer !== 0 || !bin)
    throw new Error(`bad bufferView ${viewIndex}`);
  const offset = bufferView.byteOffset ?? 0;
  const length = bufferView.byteLength ?? 0;
  if (offset < 0 || length < 0 || offset + length > bin.length)
    throw new Error(`bufferView ${viewIndex} out of bounds`);
  return { bytes: bin.subarray(offset, offset + length), byteStride: bufferView.byteStride };
}

/** POSITION accessor（float32 VEC3）→ 緊湊 Float32Array（xyz 連續）；sparse 不支援 */
export function readPositions(
  doc: GltfDoc,
  bin: Uint8Array | null,
  accessorIndex: number,
): Float32Array {
  const accessor = doc.accessors?.[accessorIndex];
  if (!accessor || accessor.componentType !== FLOAT || accessor.type !== 'VEC3')
    throw new Error(`accessor ${accessorIndex} is not float VEC3`);
  if (accessor.sparse !== undefined) throw new Error('sparse accessor unsupported');
  if (accessor.bufferView === undefined) throw new Error('accessor without bufferView');
  const count = accessor.count ?? 0;
  if (!Number.isInteger(count) || count < 0) throw new Error('bad accessor count');

  const { bytes, byteStride } = bufferViewBytes(doc, bin, accessor.bufferView);
  const stride = byteStride ?? 12;
  if (stride < 12) throw new Error('bad byteStride');
  const start = accessor.byteOffset ?? 0;
  if (count > 0 && start + (count - 1) * stride + 12 > bytes.length)
    throw new Error('POSITION accessor out of bounds');

  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const base = start + i * stride;
    out[i * 3] = dataView.getFloat32(base, true);
    out[i * 3 + 1] = dataView.getFloat32(base + 4, true);
    out[i * 3 + 2] = dataView.getFloat32(base + 8, true);
  }
  return out;
}

/** indices accessor（u8／u16／u32 SCALAR、緊湊排列）→ Uint32Array */
export function readIndices(
  doc: GltfDoc,
  bin: Uint8Array | null,
  accessorIndex: number,
): Uint32Array {
  const accessor = doc.accessors?.[accessorIndex];
  if (!accessor || accessor.type !== 'SCALAR')
    throw new Error(`accessor ${accessorIndex} is not SCALAR`);
  if (accessor.sparse !== undefined) throw new Error('sparse accessor unsupported');
  if (accessor.bufferView === undefined) throw new Error('accessor without bufferView');
  const count = accessor.count ?? 0;
  if (!Number.isInteger(count) || count < 0) throw new Error('bad accessor count');

  const elementSize =
    accessor.componentType === UNSIGNED_BYTE
      ? 1
      : accessor.componentType === UNSIGNED_SHORT
        ? 2
        : accessor.componentType === UNSIGNED_INT
          ? 4
          : 0;
  if (elementSize === 0) throw new Error('bad index componentType');

  const { bytes } = bufferViewBytes(doc, bin, accessor.bufferView);
  const start = accessor.byteOffset ?? 0;
  if (start + count * elementSize > bytes.length) throw new Error('index accessor out of bounds');

  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const base = start + i * elementSize;
    out[i] =
      elementSize === 1
        ? dataView.getUint8(base)
        : elementSize === 2
          ? dataView.getUint16(base, true)
          : dataView.getUint32(base, true);
  }
  return out;
}

/** 影像位元組：bufferView 內嵌或 data: URI（僅取表頭所需前綴）；取不到（含 bufferView 越界）＝null */
export function imageHeaderBytes(
  doc: GltfDoc,
  bin: Uint8Array | null,
  image: GltfImage,
): Uint8Array | null {
  if (image.bufferView !== undefined) {
    try {
      const { bytes } = bufferViewBytes(doc, bin, image.bufferView);
      return bytes;
    } catch {
      return null;
    }
  }
  const uri = image.uri;
  if (uri?.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma < 0 || !uri.slice(0, comma).includes(';base64')) return null;
    const head = uri.slice(comma + 1, comma + 1 + 96); // 表頭嗅探只需 ~64B
    try {
      const decoded = atob(head.slice(0, head.length - (head.length % 4)));
      return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  }
  return null;
}

/** PNG／JPEG／KTX2 表頭嗅探尺寸；未知格式＝null（fail-safe） */
export function sniffImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG：8B 簽名＋IHDR（width BE @16、height BE @20）
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }
  // KTX2：12B 識別碼、pixelWidth LE 位於 20、pixelHeight LE 位於 24
  if (
    bytes.length >= 28 &&
    bytes[0] === 0xab &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x54 &&
    bytes[3] === 0x58 &&
    bytes[4] === 0x20 &&
    bytes[5] === 0x32 &&
    bytes[6] === 0x30 &&
    bytes[7] === 0xbb
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(20, true), height: view.getUint32(24, true) };
  }
  // JPEG：FF D8 起、掃 SOFn marker（height BE @+5、width BE @+7）
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1] ?? 0;
      if (marker === 0xff) {
        i++;
        continue;
      }
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { width: view.getUint16(i + 7, false), height: view.getUint16(i + 5, false) };
      }
      const segmentLength = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
      if (segmentLength < 2) return null;
      i += 2 + segmentLength;
    }
    return null;
  }
  return null;
}
