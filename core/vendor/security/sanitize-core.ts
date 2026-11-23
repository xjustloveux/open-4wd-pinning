/**
 * UGC Mesh Sanitize 核心 — 所有不可信 GLB 首次解析的結構安全「絕對天花板」
 * 只擋任何 type 都不可能合法的 GLB；per-type 幾何／質量／密度檢核歸 Stage 1–3 pipeline，此處不重複設限
 * 純函式（無 DOM／無 network），由 sanitize.worker 於隔離 context 執行
 */
import { Protocol } from '@open4wd/system-constants';
import type { Vec3 } from '@open4wd/interfaces';
import {
  imageHeaderBytes,
  parseGlbContainer,
  readIndices,
  readPositions,
  rebuildGlb,
  sniffImageSize,
  type GltfDoc,
  type GltfPrimitive,
} from './glb';

/** 送入隔離 Worker 的不可信 GLB buffer。 */
export interface SanitizeRequest {
  /** GLB（管線唯一格式） */
  meshBuffer: ArrayBuffer;
}

/** sanitize 絕對天花板與格式檢查的穩定失敗分類。 */
export type SanitizeFailReason =
  | 'parse-error'
  | 'external-url-ref'
  | 'malicious-extras'
  | 'invalid-coordinates'
  | 'too-many-triangles'
  | 'texture-too-large';

/** sanitize 後供診斷與後續 pipeline 使用的幾何摘要。 */
export interface MeshStats {
  triangleCount: number;
  vertexCount: number;
  /** 僅供診斷的 raw 來源空間邊界；此處不套用物理單位政策。 */
  sourceBoundingBox: { min: Vec3; max: Vec3 };
}

/** sanitize 成功輸出或帶分類與細節的失敗結果。 */
export type SanitizeResult =
  | { ok: true; sanitized: ArrayBuffer; stats: MeshStats }
  | { ok: false; reason: SanitizeFailReason; details: string };

/** 絕對天花板＝全 type 最大值（場地）；per-type 上限由 pipeline 檢核 */
export const SANITIZE_LIMITS = {
  MAX_GLB_BYTES: Protocol.ugc.TRACK_GLB_SIZE_MAX_MB * 1024 * 1024,
  MAX_TRIANGLES: Protocol.ugc.TRACK_VISUAL_TRIANGLE_COUNT_MAX,
  MAX_TEXTURE_EDGE_PX: Protocol.security.SOURCE_TEXTURE_EDGE_MAX_PX,
  MAX_JSON_BYTES: Protocol.security.SANITIZE_JSON_CHUNK_MAX_BYTES,
  MAX_DOCUMENT_ENTRIES: Protocol.security.SANITIZE_DOCUMENT_MAX_ENTRIES,
  MAX_DOCUMENT_DEPTH: Protocol.security.SANITIZE_DOCUMENT_MAX_DEPTH,
  MAX_DECODED_GEOMETRY_BYTES: Protocol.security.SANITIZE_DECODED_GEOMETRY_MAX_BYTES,
  MAX_DECODED_GEOMETRY_ELEMENTS: Protocol.security.SANITIZE_DECODED_GEOMETRY_MAX_ELEMENTS,
  MAX_EXTRAS_BYTES: Protocol.security.SANITIZE_EXTRAS_MAX_BYTES,
  MAX_EXTRAS_DEPTH: Protocol.security.SANITIZE_EXTRAS_MAX_DEPTH,
} as const;

interface DecodeBudget {
  bytes: number;
  elements: number;
}

function reserveDecodedGeometry(budget: DecodeBudget, elements: number): void {
  const bytes = elements * 4;
  if (!Number.isSafeInteger(elements) || elements < 0 || !Number.isSafeInteger(bytes))
    throw new Error('bad decoded geometry allocation');
  if (
    budget.bytes + bytes > SANITIZE_LIMITS.MAX_DECODED_GEOMETRY_BYTES ||
    budget.elements + elements > SANITIZE_LIMITS.MAX_DECODED_GEOMETRY_ELEMENTS
  )
    throw new Error('decoded geometry allocation exceeds limit');
  budget.bytes += bytes;
  budget.elements += elements;
}

function accessorStorageKey(
  doc: GltfDoc,
  accessorIndex: number,
  kind: 'position' | 'index',
): string {
  const accessor = doc.accessors?.[accessorIndex];
  const view =
    accessor?.bufferView === undefined ? undefined : doc.bufferViews?.[accessor.bufferView];
  return [
    kind,
    accessor?.bufferView ?? -1,
    view?.buffer ?? -1,
    view?.byteOffset ?? 0,
    view?.byteLength ?? -1,
    view?.byteStride ?? 0,
    accessor?.byteOffset ?? 0,
    accessor?.componentType ?? -1,
    accessor?.count ?? -1,
    accessor?.type ?? '',
  ].join(':');
}

const fail = (reason: SanitizeFailReason, details: string): SanitizeResult => ({
  ok: false,
  reason,
  details,
});

/** 非 data: 的 uri＝外部參照（BIN 內嵌與 data: URI 才是自足的） */
function hasExternalUri(doc: GltfDoc): boolean {
  const uris = [...(doc.buffers ?? []).map((b) => b.uri), ...(doc.images ?? []).map((i) => i.uri)];
  return uris.some((uri) => uri !== undefined && !uri.startsWith('data:'));
}

/** 迭代走訪（防深巢遞迴爆棧）：回傳所有 extras 子樹＋各自子樹深度 */
function collectExtras(root: unknown): { serialized: string; depth: number }[] {
  const found: { serialized: string; depth: number }[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== 'object' || value === null) continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'extras')
        found.push({ serialized: JSON.stringify(child) ?? '', depth: subtreeDepth(child) });
      else stack.push(child);
    }
  }
  return found;
}

function subtreeDepth(root: unknown): number {
  let max = 0;
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (depth > max) max = depth;
    if (typeof value !== 'object' || value === null) continue;
    for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
  }
  return max;
}

/** extras 三閘：總量／巢狀深度／可執行 payload 啟發式 */
function extrasProblem(doc: GltfDoc): string | null {
  const all = collectExtras(doc);
  let totalBytes = 0;
  for (const { serialized, depth } of all) {
    totalBytes += new TextEncoder().encode(serialized).length;
    if (depth > SANITIZE_LIMITS.MAX_EXTRAS_DEPTH)
      return `extras depth ${depth} > ${SANITIZE_LIMITS.MAX_EXTRAS_DEPTH}`;
    if (/<script\b|javascript:/i.test(serialized)) return 'executable payload in extras';
  }
  if (totalBytes > SANITIZE_LIMITS.MAX_EXTRAS_BYTES)
    return `extras total ${totalBytes}B > ${SANITIZE_LIMITS.MAX_EXTRAS_BYTES}B`;
  return null;
}

/** 以 accessor metadata 計三角形總數（解碼前即可擋爆量）；不足 3 整除＝malformed */
function countTriangles(doc: GltfDoc): number {
  let total = 0;
  for (const mesh of doc.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const mode = primitive.mode ?? 4;
      if (mode !== 4) continue; // 只有 TRIANGLES 計入
      const accessorIndex = primitive.indices ?? primitive.attributes?.['POSITION'];
      if (accessorIndex === undefined) continue;
      const count = doc.accessors?.[accessorIndex]?.count ?? 0;
      if (!Number.isInteger(count) || count < 0) throw new Error('bad primitive accessor count');
      if (count % 3 !== 0) throw new Error('triangle vertex count not divisible by 3');
      total += count / 3;
    }
  }
  return total;
}

interface DracoPrimitive {
  readonly bufferView: number;
  readonly attributes: Readonly<Record<string, number>>;
}

/**
 * Draco 內容不可在 sanitizer 內直接當未壓縮 accessor 解讀；先嚴格驗 extension metadata、
 * backing bufferView 與宣告的 decoded accessor 上限，讓正式 KHR_draco 輸出可通過、畸形
 * 結構仍 fail-closed。真正解碼留給既有 Draco runtime；輸出配置由 accessor count/min/max
 * 約束，避免以巨大宣告誘發 parser allocation。
 */
function readDracoPrimitive(
  doc: GltfDoc,
  bin: Uint8Array | null,
  primitive: GltfPrimitive,
): DracoPrimitive | null {
  const raw = primitive.extensions?.['KHR_draco_mesh_compression'];
  if (raw === undefined) return null;
  if (typeof raw !== 'object' || raw === null) throw new Error('bad Draco extension');
  const record = raw as Record<string, unknown>;
  const bufferView = record['bufferView'];
  const attributes = record['attributes'];
  if (!Number.isInteger(bufferView) || (bufferView as number) < 0)
    throw new Error('bad Draco bufferView');
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes))
    throw new Error('bad Draco attributes');
  const attributeMap = attributes as Record<string, unknown>;
  if (attributeMap['POSITION'] === undefined) throw new Error('Draco POSITION missing');
  for (const [semantic, attributeId] of Object.entries(attributeMap)) {
    if (!Number.isInteger(attributeId) || (attributeId as number) < 0)
      throw new Error(`bad Draco attribute ${semantic}`);
    if (!Number.isInteger(primitive.attributes?.[semantic]))
      throw new Error(`Draco accessor ${semantic} missing`);
  }
  const view = doc.bufferViews?.[bufferView as number];
  const offset = view?.byteOffset ?? 0;
  const length = view?.byteLength;
  if (
    view === undefined ||
    view.buffer !== 0 ||
    bin === null ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(length) ||
    length === undefined ||
    length < 0 ||
    offset + length > bin.byteLength
  )
    throw new Error('Draco bufferView out of bounds');
  return { bufferView: bufferView as number, attributes: attributeMap as Record<string, number> };
}

function compressedPositionBounds(
  doc: GltfDoc,
  accessorIndex: number,
): { count: number; min: [number, number, number]; max: [number, number, number] } {
  const accessor = doc.accessors?.[accessorIndex];
  if (
    accessor?.componentType !== 5126 ||
    accessor.type !== 'VEC3' ||
    !Number.isInteger(accessor.count) ||
    accessor.count === undefined ||
    accessor.count < 0 ||
    accessor.count > SANITIZE_LIMITS.MAX_TRIANGLES * 3 ||
    accessor.min?.length !== 3 ||
    accessor.max?.length !== 3 ||
    !accessor.min.every(Number.isFinite) ||
    !accessor.max.every(Number.isFinite) ||
    accessor.min.some((value, axis) => value > accessor.max![axis]!)
  )
    throw new Error('bad Draco POSITION accessor');
  return {
    count: accessor.count,
    min: [accessor.min[0]!, accessor.min[1]!, accessor.min[2]!],
    max: [accessor.max[0]!, accessor.max[1]!, accessor.max[2]!],
  };
}

/**
 * 檢查順序：大小 → 容器解析 → 外部 URI／extras → 三角形數 → NaN／Inf → source 貼圖 → 正規化重打包。
 * raw coordinates 尚未完成來源單位正規化與 scene transform 解算，不在此套物理 AABB／面積規則。
 * 質量／密度不在此檢核（材質 Stage 2 才指派）；non-manifold 不拒收（volume 解析有 voxel 備援）
 */
export function sanitizeMesh(request: SanitizeRequest): SanitizeResult {
  // 0a. 輸入大小（parse 前擋，防解壓炸彈進 parser）
  if (request.meshBuffer.byteLength > SANITIZE_LIMITS.MAX_GLB_BYTES)
    return fail('parse-error', `GLB ${request.meshBuffer.byteLength}B > absolute ceiling`);

  let doc: GltfDoc;
  let bin: Uint8Array | null;
  try {
    ({ doc, bin } = parseGlbContainer(request.meshBuffer));
  } catch (error) {
    return fail('parse-error', String(error));
  }

  // 0b. GLB 結構：拒外部 URL 參照、拒惡意 extras
  if (hasExternalUri(doc)) return fail('external-url-ref', 'embedded external URI');
  const extrasIssue = extrasProblem(doc);
  if (extrasIssue) return fail('malicious-extras', extrasIssue);

  // 1. 三角形數（絕對天花板；metadata 即擋、不先解碼）
  let triangleCount: number;
  try {
    triangleCount = countTriangles(doc);
  } catch (error) {
    return fail('parse-error', String(error));
  }
  if (triangleCount > SANITIZE_LIMITS.MAX_TRIANGLES)
    return fail('too-many-triangles', `${triangleCount} > ${SANITIZE_LIMITS.MAX_TRIANGLES}`);

  // 解碼各 primitive 的 POSITION（同 accessor 只解一次）與 indices
  const positionsByAccessor = new Map<number, Float32Array>();
  const positionsByStorage = new Map<string, Float32Array>();
  const indicesByAccessor = new Map<number, Uint32Array>();
  const indicesByStorage = new Map<string, Uint32Array>();
  const decodeBudget: DecodeBudget = { bytes: 0, elements: 0 };
  const compressedBoundsByAccessor = new Map<
    number,
    { count: number; min: [number, number, number]; max: [number, number, number] }
  >();
  try {
    for (const mesh of doc.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) {
        const draco = readDracoPrimitive(doc, bin, primitive);
        const positionIndex = primitive.attributes?.['POSITION'];
        if (positionIndex === undefined) continue;
        if (draco !== null) {
          if (!compressedBoundsByAccessor.has(positionIndex))
            compressedBoundsByAccessor.set(
              positionIndex,
              compressedPositionBounds(doc, positionIndex),
            );
          if (primitive.indices !== undefined) {
            const indexAccessor = doc.accessors?.[primitive.indices];
            if (
              indexAccessor?.type !== 'SCALAR' ||
              ![5121, 5123, 5125].includes(indexAccessor.componentType ?? -1) ||
              !Number.isInteger(indexAccessor.count) ||
              indexAccessor.count === undefined ||
              indexAccessor.count < 0 ||
              indexAccessor.count > SANITIZE_LIMITS.MAX_TRIANGLES * 3
            )
              throw new Error('bad Draco index accessor');
          }
          continue;
        }
        if ((primitive.mode ?? 4) !== 4) continue;
        let positions = positionsByAccessor.get(positionIndex);
        if (!positions) {
          const storageKey = accessorStorageKey(doc, positionIndex, 'position');
          positions = positionsByStorage.get(storageKey);
          if (!positions) {
            const count = doc.accessors?.[positionIndex]?.count;
            if (!Number.isInteger(count) || count === undefined || count < 0)
              throw new Error('bad POSITION accessor count');
            reserveDecodedGeometry(decodeBudget, count * 3);
            positions = readPositions(doc, bin, positionIndex);
            positionsByStorage.set(storageKey, positions);
          }
          positionsByAccessor.set(positionIndex, positions);
        }
        let indices: Uint32Array | null = null;
        if (primitive.indices !== undefined) {
          indices = indicesByAccessor.get(primitive.indices) ?? null;
          if (indices === null) {
            const storageKey = accessorStorageKey(doc, primitive.indices, 'index');
            indices = indicesByStorage.get(storageKey) ?? null;
            if (indices === null) {
              const count = doc.accessors?.[primitive.indices]?.count;
              if (!Number.isInteger(count) || count === undefined || count < 0)
                throw new Error('bad index accessor count');
              reserveDecodedGeometry(decodeBudget, count);
              indices = readIndices(doc, bin, primitive.indices);
              indicesByStorage.set(storageKey, indices);
            }
            indicesByAccessor.set(primitive.indices, indices);
          }
        }
        if (indices)
          for (const index of indices)
            if (index * 3 >= positions.length) throw new Error('index out of range');
      }
    }
  } catch (error) {
    return fail('parse-error', String(error));
  }

  // 2. 座標 NaN／Infinity
  const uniquePositions = new Set(positionsByAccessor.values());
  for (const positions of uniquePositions)
    for (const component of positions)
      if (!Number.isFinite(component)) return fail('invalid-coordinates', 'NaN or Infinity vertex');

  // 3. Raw source-space bounds（只回 diagnostics；不可在 normalization 前套物理尺寸政策）
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let vertexCount = 0;
  for (const positions of uniquePositions) {
    vertexCount += positions.length / 3;
    for (let i = 0; i < positions.length; i += 3)
      for (let axis = 0; axis < 3; axis++) {
        const v = positions[i + axis]!;
        if (v < min[axis]!) min[axis] = v;
        if (v > max[axis]!) max[axis] = v;
      }
  }
  for (const bounds of compressedBoundsByAccessor.values()) {
    vertexCount += bounds.count;
    for (let axis = 0; axis < 3; axis++) {
      if (bounds.min[axis]! < min[axis]!) min[axis] = bounds.min[axis]!;
      if (bounds.max[axis]! > max[axis]!) max[axis] = bounds.max[axis]!;
    }
  }
  if (vertexCount === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }
  // 4. Source texture 邊長（PNG／JPEG／KTX2 表頭嗅探；未知格式 fail-safe 拒收）
  for (const image of doc.images ?? []) {
    let header: Uint8Array | null;
    try {
      header = imageHeaderBytes(doc, bin, image);
    } catch (error) {
      return fail('parse-error', String(error));
    }
    const size = header ? sniffImageSize(header) : null;
    if (!size) return fail('parse-error', 'image format not recognized');
    if (Math.max(size.width, size.height) > SANITIZE_LIMITS.MAX_TEXTURE_EDGE_PX)
      return fail(
        'texture-too-large',
        `${size.width}x${size.height} > ${SANITIZE_LIMITS.MAX_TEXTURE_EDGE_PX}px`,
      );
  }

  // 5. 通過 → 結構正規化重打包（剔除非標 chunk 與尾端垃圾；尚非 canonical asset）
  return {
    ok: true,
    sanitized: rebuildGlb(doc, bin),
    stats: {
      triangleCount,
      vertexCount,
      sourceBoundingBox: { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] },
    },
  };
}
