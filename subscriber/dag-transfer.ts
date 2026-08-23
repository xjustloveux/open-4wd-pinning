/**
 * DAG 搬遷：從帳本自己的 blocks port 讀出以 CID 為根的內容，依 CID codec 將 raw 視為 leaf、
 * 對 dag-cbor 遞迴走訪 links，再逐塊灌進 kubo。kubo 已有某塊只略過該塊的 block/put，仍會
 * 從可信 source 讀取並遍歷 links，不能把 parent exists 誤當成完整子樹。checkpoint 訂閱與
 * 授權 pin API 共用這個搬遷邏輯；cluster pin 前 kubo 必須已有完整內容。
 */
import * as dagCbor from '@ipld/dag-cbor';
import * as dagPb from '@ipld/dag-pb';
import * as raw from 'multiformats/codecs/raw';
import { varint } from 'multiformats';
import { CID as MultiformatsCID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { Protocol, type BlockAccess } from '../core';
import type { KuboClient } from '../pinning';

/** 單塊向帳本 blocks port 要塊的逾時（ms）——量級比照帳本內部慣用的 block fetch 逾時，
 * 讓單一過慢的鄰居不會拖住整個搬遷；非跨模組硬性同步的常數，各自獨立調整不影響正確性。 */
const BLOCK_FETCH_TIMEOUT_MS = 10_000;

/** kubo block/put 的 `cid-codec` 查參值。 */
const DAG_CBOR_CID_CODEC = 'dag-cbor';
const DAG_PB_CID_CODEC = 'dag-pb';
const RAW_CID_CODEC = 'raw';
const { UGC_CHUNK_BYTES, UGC_LOGICAL_MAX_BYTES, UGC_MAX_UNIXFS_LINKS } = Protocol.ugc;

/** 表示 DAG 走訪超出已設定的大小、深度或區塊限制。 */
export class DagTransferLimitError extends Error {}

/** BlockAccess.get 的 CID 參數型別——以型別推導取得，避免為此擴充 core barrel 的匯出面。 */
type BlockCid = Parameters<BlockAccess['get']>[0];
/** 定義 DAG 搬遷只需使用的可信區塊讀取連接埠。 */
export type DagBlockSource = Pick<BlockAccess, 'get'>;

/**
 * 遞迴走訪一個已解碼的 dag-cbor 值，把其中所有 CID link（`CID.asCID` 判定非 null 者）
 * 收集進 out。命中 link 的節點不繼續往下鑽（link 本身沒有子欄位可走）；Uint8Array（例如
 * 簽章欄位）也不當成一般物件遞迴，避免逐 byte 誤走訪二進位內容。
 */
export interface DagTransferLimits {
  readonly maxBytes: number;
  readonly maxBlocks: number;
  readonly maxDepth: number;
  readonly maxLinksPerBlock: number;
  readonly maxIpldNesting: number;
}

/** 提供內容 DAG 搬遷與完整性量測的保守預設上限。 */
export const DEFAULT_DAG_TRANSFER_LIMITS: DagTransferLimits = {
  maxBytes: 2 * 1024 ** 3,
  maxBlocks: 4096,
  maxDepth: 128,
  maxLinksPerBlock: 1024,
  maxIpldNesting: 64,
};

function resolvedLimits(overrides: Partial<DagTransferLimits> | undefined): DagTransferLimits {
  return { ...DEFAULT_DAG_TRANSFER_LIMITS, ...overrides };
}

function collectLinks(value: unknown, maxLinks: number, maxNesting: number): MultiformatsCID[] {
  const out: MultiformatsCID[] = [];
  const stack: { value: unknown; nesting: number }[] = [{ value, nesting: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const link = MultiformatsCID.asCID(current.value);
    if (link !== null) {
      out.push(link);
      if (out.length > maxLinks) {
        throw new DagTransferLimitError('transferDag：超過 maxLinksPerBlock');
      }
      continue;
    }
    const isContainer =
      Array.isArray(current.value) ||
      (current.value !== null &&
        typeof current.value === 'object' &&
        !(current.value instanceof Uint8Array));
    if (!isContainer) continue;
    if (current.nesting > maxNesting) {
      throw new DagTransferLimitError('transferDag：超過 maxIpldNesting');
    }
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) stack.push({ value: child, nesting: current.nesting + 1 });
  }
  return out;
}

interface UnixFsFilePlan {
  readonly links: readonly { cid: MultiformatsCID; sizeBytes: number }[];
  readonly logicalSizeBytes: number;
}

function readVarint(bytes: Uint8Array, offset: number): readonly [number, number] {
  const [value, length] = varint.decode(bytes.subarray(offset));
  if (!Number.isSafeInteger(value) || length <= 0) throw new Error('invalid UnixFS varint');
  return [value, offset + length];
}

/** Decodes the deliberately small canonical UnixFS Data subset without accepting metadata fields. */
function canonicalUnixFsFile(bytes: Uint8Array, node: dagPb.PBNode): UnixFsFilePlan {
  let offset = 0;
  let type: number | undefined;
  let fileSize: number | undefined;
  const blockSizes: number[] = [];
  while (offset < bytes.byteLength) {
    const [tag, afterTag] = readVarint(bytes, offset);
    offset = afterTag;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) {
      if (type !== undefined) throw new Error('duplicate UnixFS type');
      [type, offset] = readVarint(bytes, offset);
      continue;
    }
    if (field === 3 && wire === 0) {
      if (fileSize !== undefined) throw new Error('duplicate UnixFS filesize');
      [fileSize, offset] = readVarint(bytes, offset);
      continue;
    }
    if (field === 4 && wire === 0) {
      let size: number;
      [size, offset] = readVarint(bytes, offset);
      blockSizes.push(size);
      continue;
    }
    if (field === 4 && wire === 2) {
      const [length, dataStart] = readVarint(bytes, offset);
      const end = dataStart + length;
      if (end > bytes.byteLength) throw new Error('truncated UnixFS blocksizes');
      offset = dataStart;
      while (offset < end) {
        let size: number;
        [size, offset] = readVarint(bytes, offset);
        blockSizes.push(size);
      }
      continue;
    }
    throw new Error('non-canonical UnixFS metadata');
  }
  if (
    type !== 2 ||
    fileSize === undefined ||
    fileSize > UGC_LOGICAL_MAX_BYTES ||
    node.Links.length === 0 ||
    node.Links.length > UGC_MAX_UNIXFS_LINKS ||
    blockSizes.length !== node.Links.length ||
    blockSizes.some((size) => size < 0 || size > UGC_CHUNK_BYTES) ||
    blockSizes.reduce((sum, size) => sum + size, 0) !== fileSize
  )
    throw new Error('non-canonical UnixFS file');
  const links = node.Links.map((link, index) => {
    const sizeBytes = blockSizes[index]!;
    if (
      link.Hash.code !== raw.code ||
      (link.Name !== undefined && link.Name !== '') ||
      (link.Tsize !== undefined && link.Tsize !== sizeBytes)
    )
      throw new Error('non-canonical UnixFS link');
    return { cid: link.Hash, sizeBytes };
  });
  return { links, logicalSizeBytes: fileSize };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error('transferDag aborted');
}

/** 彙整一次完整 DAG 搬遷的 logical 與新增實體用量。 */
export interface TransferDagResult {
  blockCount: number;
  logicalDagBytes: number;
  newPhysicalBytes: number;
  blocks: readonly DagBlockMeasurement[];
  logicalContentBytes?: number;
  complete: true;
}

/** 記錄 DAG 中單一已驗證區塊的 CID 與位元組大小。 */
export interface DagBlockMeasurement {
  readonly cid: string;
  readonly sizeBytes: number;
}

async function bytesMatchCid(cid: MultiformatsCID, bytes: Uint8Array): Promise<boolean> {
  if (cid.version !== 1 || cid.multihash.code !== sha256.code) return false;
  const digest = await sha256.digest(bytes);
  return MultiformatsCID.createV1(cid.code, digest).equals(cid);
}

/** 彙整 Kubo 內既有完整 DAG 的量測結果。 */
export interface CompleteDagMeasurement {
  readonly blockCount: number;
  readonly logicalDagBytes: number;
  readonly blocks: readonly DagBlockMeasurement[];
  readonly logicalContentBytes?: number;
}

/** 從 Kubo 量測完整且符合內容規範的 DAG，缺塊或不合法時回傳空值。 */
export async function measureCompleteDag(opts: {
  root: string;
  kubo: KuboClient;
  limits?: Partial<DagTransferLimits>;
  signal?: AbortSignal;
}): Promise<CompleteDagMeasurement | null> {
  if (opts.kubo.blockGet === undefined) return null;
  const limits = resolvedLimits(opts.limits);
  const visited = new Set<string>();
  const rootCid = MultiformatsCID.parse(opts.root);
  const ugcMode = rootCid.code === raw.code || rootCid.code === dagPb.code;
  const queue: { cid: string; depth: number; expectedSize?: number }[] = [
    { cid: opts.root, depth: 0 },
  ];
  let logicalDagBytes = 0;
  let logicalContentBytes: number | undefined;
  const measuredBlocks: DagBlockMeasurement[] = [];

  while (queue.length > 0) {
    try {
      throwIfAborted(opts.signal);
    } catch {
      return null;
    }
    const next = queue.shift();
    if (next === undefined || visited.has(next.cid)) continue;
    const { cid: value, depth, expectedSize } = next;
    if (depth > limits.maxDepth || visited.size >= limits.maxBlocks) return null;
    visited.add(value);

    let cid: MultiformatsCID;
    let bytes: Uint8Array;
    try {
      cid = MultiformatsCID.parse(value);
      bytes = await opts.kubo.blockGet(value);
    } catch {
      return null;
    }
    logicalDagBytes += bytes.byteLength;
    if (logicalDagBytes > limits.maxBytes) return null;
    if (!(await bytesMatchCid(cid, bytes))) return null;
    measuredBlocks.push({ cid: value, sizeBytes: bytes.byteLength });
    if (cid.code === raw.code) {
      if (expectedSize !== undefined && bytes.byteLength !== expectedSize) return null;
      if (depth === 0 && ugcMode) {
        if (bytes.byteLength > UGC_CHUNK_BYTES) return null;
        logicalContentBytes = bytes.byteLength;
      }
      continue;
    }
    if (cid.code === dagPb.code && ugcMode) {
      if (depth !== 0 || bytes.byteLength > UGC_CHUNK_BYTES) return null;
      try {
        const node = dagPb.decode(bytes);
        if (node.Data === undefined) return null;
        const plan = canonicalUnixFsFile(node.Data, node);
        logicalContentBytes = plan.logicalSizeBytes;
        for (const link of plan.links)
          queue.push({ cid: link.cid.toString(), depth: depth + 1, expectedSize: link.sizeBytes });
      } catch {
        return null;
      }
      continue;
    }
    if (cid.code !== dagCbor.code || ugcMode) return null;

    try {
      const links = collectLinks(
        dagCbor.decode(bytes),
        limits.maxLinksPerBlock,
        limits.maxIpldNesting,
      );
      for (const link of links) queue.push({ cid: link.toString(), depth: depth + 1 });
    } catch {
      return null;
    }
  }

  return {
    blockCount: visited.size,
    logicalDagBytes,
    blocks: measuredBlocks,
    ...(logicalContentBytes === undefined ? {} : { logicalContentBytes }),
  };
}

/** 判斷 Kubo 是否已持有完整且符合內容規範的指定 DAG。 */
export async function hasCompleteDag(opts: {
  root: string;
  kubo: KuboClient;
  limits?: Partial<DagTransferLimits>;
  signal?: AbortSignal;
}): Promise<boolean> {
  return (await measureCompleteDag(opts)) !== null;
}

/**
 * 自 `root` 起 BFS 走訪 codec-aware DAG（帳本 blocks port 讀取），逐塊灌進 kubo。raw 是
 * opaque leaf；dag-cbor 解析 IPLD links；其他 codec fail-closed，留待其 canonical profile
 * 與 decoder 一起加入。
 * 每次灌入後把 kubo 回傳的 CID 與請求的 CID 做恆等斷言：兩者不一致代表 kubo 端算出來的
 * 雜湊與帳本端不同，寧可直接拋錯，也不要默默把內容存進一個錯的 CID 底下。抓不到某個 CID
 * （帳本 blocks port 逾時或缺塊）同樣直接拋錯——呼叫端（reconcile）負責把單筆失敗收斂成
 * 警告，這裡不吞任何錯誤。
 */
export async function transferDag(opts: {
  root: string;
  blocks: DagBlockSource;
  kubo: KuboClient;
  limits?: Partial<DagTransferLimits>;
  signal?: AbortSignal;
}): Promise<TransferDagResult> {
  const { root, blocks, kubo } = opts;
  const limits = resolvedLimits(opts.limits);
  const visited = new Set<string>();
  const rootCid = MultiformatsCID.parse(root);
  const ugcMode = rootCid.code === raw.code || rootCid.code === dagPb.code;
  const queue: { cid: string; depth: number; expectedSize?: number }[] = [{ cid: root, depth: 0 }];
  let blockCount = 0;
  let logicalDagBytes = 0;
  let newPhysicalBytes = 0;
  let logicalContentBytes: number | undefined;
  const measuredBlocks: DagBlockMeasurement[] = [];

  while (queue.length > 0) {
    throwIfAborted(opts.signal);
    const next = queue.shift();
    if (next === undefined || visited.has(next.cid)) continue;
    const { cid, depth, expectedSize } = next;
    if (depth > limits.maxDepth) throw new DagTransferLimitError('transferDag：超過 maxDepth');
    if (blockCount >= limits.maxBlocks) {
      throw new DagTransferLimitError('transferDag：超過 maxBlocks');
    }
    visited.add(cid);

    const bytes = await blocks.get(cid as BlockCid, BLOCK_FETCH_TIMEOUT_MS);
    throwIfAborted(opts.signal);
    if (bytes === null) {
      throw new Error(`transferDag：帳本 blocks port 抓不到區塊（逾時或缺塊）：${cid}`);
    }

    if (logicalDagBytes + bytes.byteLength > limits.maxBytes) {
      throw new DagTransferLimitError('transferDag：超過 maxBytes');
    }

    let parsedCid: MultiformatsCID;
    try {
      parsedCid = MultiformatsCID.parse(cid);
    } catch {
      throw new Error(`transferDag：無效 CID：${cid}`);
    }
    if (!(await bytesMatchCid(parsedCid, bytes))) {
      throw new Error(`transferDag：區塊 bytes 與 CID 不符：${cid}`);
    }
    measuredBlocks.push({ cid, sizeBytes: bytes.byteLength });
    const cidCodec =
      parsedCid.code === raw.code
        ? RAW_CID_CODEC
        : parsedCid.code === dagCbor.code
          ? DAG_CBOR_CID_CODEC
          : parsedCid.code === dagPb.code
            ? DAG_PB_CID_CODEC
            : undefined;
    if (cidCodec === undefined) {
      throw new Error(`transferDag：不支援的 CID codec：${parsedCid.code}`);
    }

    blockCount += 1;
    logicalDagBytes += bytes.byteLength;

    if (!(await kubo.hasBlock(cid))) {
      throwIfAborted(opts.signal);
      const putCid = await kubo.blockPut(bytes, cidCodec);
      throwIfAborted(opts.signal);
      if (putCid !== cid) {
        throw new Error(`transferDag：kubo 回傳 CID 與預期不符（預期 ${cid}、實得 ${putCid}）`);
      }
      newPhysicalBytes += bytes.byteLength;
    }

    if (parsedCid.code === raw.code) {
      if (expectedSize !== undefined && bytes.byteLength !== expectedSize)
        throw new Error('transferDag：UnixFS child size 不符');
      if (depth === 0 && ugcMode) {
        if (bytes.byteLength > UGC_CHUNK_BYTES)
          throw new DagTransferLimitError('transferDag：raw UGC 超過 canonical chunk');
        logicalContentBytes = bytes.byteLength;
      }
      continue;
    }

    if (parsedCid.code === dagPb.code && ugcMode) {
      if (depth !== 0 || bytes.byteLength > UGC_CHUNK_BYTES)
        throw new Error('transferDag：非 canonical UnixFS depth/block');
      const node = dagPb.decode(bytes);
      if (node.Data === undefined) throw new Error('transferDag：UnixFS Data 缺失');
      const plan = canonicalUnixFsFile(node.Data, node);
      logicalContentBytes = plan.logicalSizeBytes;
      for (const link of plan.links)
        queue.push({ cid: link.cid.toString(), depth: depth + 1, expectedSize: link.sizeBytes });
      continue;
    }

    if (parsedCid.code !== dagCbor.code || ugcMode)
      throw new Error(`transferDag：不支援的 CID codec：${parsedCid.code}`);

    const links = collectLinks(
      dagCbor.decode(bytes),
      limits.maxLinksPerBlock,
      limits.maxIpldNesting,
    );
    for (const link of links) queue.push({ cid: link.toString(), depth: depth + 1 });
  }

  return {
    blockCount,
    logicalDagBytes,
    newPhysicalBytes,
    blocks: measuredBlocks,
    ...(logicalContentBytes === undefined ? {} : { logicalContentBytes }),
    complete: true,
  };
}
