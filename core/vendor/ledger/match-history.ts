import type { PeerId } from '@open4wd/interfaces';
import type { ColdMatchPartition, MatchRecord } from './derived-state';
import type { ColdPartitionKey } from './derive-utils';

/** 未指定時的玩家賽事歷史單頁筆數。 */
export const MATCH_HISTORY_DEFAULT_PAGE_SIZE = 20;
/** 單頁 API 邊界允許的最大筆數。 */
export const MATCH_HISTORY_MAX_PAGE_SIZE = 50;
/** 單次請求最多延遲載入的 cold quarters 數。 */
export const MATCH_HISTORY_MAX_PARTITIONS_PER_PAGE = 4;

declare const matchHistoryCursorBrand: unique symbol;
/** 呼叫端只可保存及回傳、不可解讀的玩家賽事歷史游標。 */
export type MatchHistoryCursor = string & { readonly [matchHistoryCursorBrand]: true };

/** 定義帳本邊界交換的訊息欄位與約束。 */
export interface MatchHistoryPageRequest {
  readonly limit?: number;
  readonly cursor?: MatchHistoryCursor | null;
}

/** 定義帳本流程交換的 MatchHistoryPage 資料欄位與約束。 */
export interface MatchHistoryPage {
  readonly records: readonly MatchRecord[];
  readonly status: 'complete' | 'partial' | 'failure';
  readonly nextCursor: MatchHistoryCursor | null;
  readonly failedPartitions: readonly ColdPartitionKey[];
}

interface CursorPayload {
  readonly v: 1;
  readonly p: PeerId;
  readonly o: number;
  readonly t: number | null;
  readonly m: string | null;
}

/** 描述帳本流程尚未驗證的輸入資料。 */
export interface CollectMatchHistoryPageInput {
  readonly peerId: PeerId;
  readonly hotRecords: ReadonlyMap<string, MatchRecord>;
  readonly coldPartitionKeys: readonly ColdPartitionKey[];
  readonly loadPartition: (key: ColdPartitionKey) => Promise<ColdMatchPartition | null>;
  readonly request?: MatchHistoryPageRequest;
}

const compareRecords = (left: MatchRecord, right: MatchRecord): number =>
  right.finishedAt - left.finishedAt || left.matchId.localeCompare(right.matchId);

const isAfterCursor = (record: MatchRecord, cursor: CursorPayload): boolean =>
  cursor.t === null ||
  record.finishedAt < cursor.t ||
  (record.finishedAt === cursor.t && cursor.m !== null && record.matchId > cursor.m);

function pageSizeOf(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MATCH_HISTORY_DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MATCH_HISTORY_MAX_PAGE_SIZE, Math.floor(limit)));
}

function encodeCursor(
  peerId: PeerId,
  partitionOffset: number,
  after: MatchRecord | null,
): MatchHistoryCursor {
  const payload: CursorPayload = {
    v: 1,
    p: peerId,
    o: partitionOffset,
    t: after?.finishedAt ?? null,
    m: after?.matchId ?? null,
  };
  return `mh1.${encodeURIComponent(JSON.stringify(payload))}` as MatchHistoryCursor;
}

function decodeCursor(
  peerId: PeerId,
  cursor: MatchHistoryCursor | null | undefined,
): CursorPayload {
  if (cursor === undefined || cursor === null) return { v: 1, p: peerId, o: 0, t: null, m: null };
  try {
    if (!cursor.startsWith('mh1.')) throw new Error('prefix');
    const parsed = JSON.parse(decodeURIComponent(cursor.slice(4))) as Partial<CursorPayload>;
    if (
      parsed.v !== 1 ||
      parsed.p !== peerId ||
      !Number.isSafeInteger(parsed.o) ||
      parsed.o! < 0 ||
      !(
        (parsed.t === null && parsed.m === null) ||
        (typeof parsed.t === 'number' &&
          Number.isSafeInteger(parsed.t) &&
          typeof parsed.m === 'string' &&
          parsed.m.length > 0)
      )
    )
      throw new Error('shape');
    return parsed as CursorPayload;
  } catch {
    throw new RangeError('invalid match history cursor');
  }
}

/** 合併 hot 與有界 lazy cold partition，產生可續載且不靜默截斷的決定性頁面。 */
export async function collectMatchHistoryPage(
  input: CollectMatchHistoryPageInput,
): Promise<MatchHistoryPage> {
  const size = pageSizeOf(input.request?.limit);
  const cursor = decodeCursor(input.peerId, input.request?.cursor);
  const keys = [...input.coldPartitionKeys].sort().reverse();
  if (cursor.o > keys.length) throw new RangeError('invalid match history cursor');
  const records = new Map<string, MatchRecord>();
  const add = (candidates: Iterable<MatchRecord>): void => {
    for (const record of candidates)
      if (
        record.ranking.includes(input.peerId) &&
        isAfterCursor(record, cursor) &&
        !records.has(record.matchId)
      )
        records.set(record.matchId, record);
  };
  const ordered = (): MatchRecord[] => [...records.values()].sort(compareRecords);
  const pageFromOverflow = (resumeOffset: number): MatchHistoryPage | null => {
    const candidates = ordered();
    if (candidates.length < size) return null;
    const page = candidates.slice(0, size);
    const hasMoreInLoaded = candidates.length > size;
    const nextOffset = hasMoreInLoaded ? cursor.o : resumeOffset;
    const hasMore = hasMoreInLoaded || resumeOffset < keys.length;
    return {
      records: page,
      status: hasMore ? 'partial' : 'complete',
      nextCursor: hasMore ? encodeCursor(input.peerId, nextOffset, page.at(-1)!) : null,
      failedPartitions: [],
    };
  };

  if (cursor.o === 0) add(input.hotRecords.values());
  const hotPage = pageFromOverflow(0);
  if (hotPage !== null) return hotPage;

  let nextOffset = cursor.o;
  let scanned = 0;
  while (nextOffset < keys.length && scanned < MATCH_HISTORY_MAX_PARTITIONS_PER_PAGE) {
    const key = keys[nextOffset]!;
    let partition: ColdMatchPartition | null;
    try {
      partition = await input.loadPartition(key);
    } catch {
      partition = null;
    }
    if (partition === null) {
      const page = ordered();
      return {
        records: page,
        status: page.length === 0 ? 'failure' : 'partial',
        nextCursor: encodeCursor(input.peerId, nextOffset, page.at(-1) ?? null),
        failedPartitions: [key],
      };
    }
    add(partition.matchRecords.values());
    nextOffset += 1;
    scanned += 1;
    const filled = pageFromOverflow(nextOffset);
    if (filled !== null) return filled;
  }

  const page = ordered();
  if (nextOffset < keys.length)
    return {
      records: page,
      status: 'partial',
      nextCursor: encodeCursor(input.peerId, nextOffset, null),
      failedPartitions: [],
    };
  return { records: page, status: 'complete', nextCursor: null, failedPartitions: [] };
}
