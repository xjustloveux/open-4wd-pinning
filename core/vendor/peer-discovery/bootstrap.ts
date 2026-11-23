import { multiaddr } from '@multiformats/multiaddr';

/**
 * Bootstrap 候選驗證刻意保持 pure。探索來源由 `assembleSelectedNetworkServices` 選擇；
 * 此模組絕不下載隱藏／預設節點清單。
 */
const DEFAULT_MAX_ENTRIES = 64;
const MAX_ENTRIES = 64;
const DEFAULT_MAX_LINES = 256;
const MAX_LINES = 1_024;

/** 已選定 bootstrap 候選集合的有界驗證與洗牌選項。 */
export interface BootstrapCandidateOptions {
  /** 最多採用的 unique valid 節點；預設與上限皆為 64。 */
  readonly maxEntries?: number;
  /** 原始行數上限；預設 256、最高 1024，超限視為無效清單。 */
  readonly maxLines?: number;
  /** Fisher–Yates 取樣器；有效回傳範圍為 `[0, 1)`，越界值安全地視為 0。 */
  readonly random?: () => number;
}

/** 將可選正數限制為整數與安全上限。 */
function boundedPositive(value: number | undefined, fallback: number, ceiling: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.min(Math.floor(value), ceiling);
}

function resolvedOptions(options: BootstrapCandidateOptions): Required<BootstrapCandidateOptions> {
  return {
    maxEntries: boundedPositive(options.maxEntries, DEFAULT_MAX_ENTRIES, MAX_ENTRIES),
    maxLines: boundedPositive(options.maxLines, DEFAULT_MAX_LINES, MAX_LINES),
    random: options.random ?? Math.random,
  };
}

/** 驗證 discovery multiaddr 必須同時具有 peer id 與 browser websocket transport。 */
function isBootstrapMultiaddr(value: string): boolean {
  try {
    const protocols = new Set(
      multiaddr(value)
        .getComponents()
        .map((component) => component.name),
    );
    return protocols.has('p2p') && (protocols.has('ws') || protocols.has('wss'));
  } catch {
    return false;
  }
}

/** 過濾、去重並限制不可信 raw/bootstrap 設定。 */
function validUniqueEntries(
  entries: readonly string[],
  maxEntries: number,
  maxLines: number,
): string[] {
  if (entries.length > maxLines) return [];
  const unique = new Set<string>();
  for (const entry of entries) {
    const value = entry.trim();
    if (value.length === 0 || unique.has(value) || !isBootstrapMultiaddr(value)) continue;
    unique.add(value);
    if (unique.size === maxEntries) break;
  }
  return [...unique];
}

function shuffle<T>(values: T[], random: () => number): T[] {
  for (let index = values.length - 1; index > 0; index--) {
    const sample = random();
    const safeSample = Number.isFinite(sample) && sample >= 0 && sample < 1 ? sample : 0;
    const randomIndex = Math.floor(safeSample * (index + 1));
    [values[index], values[randomIndex]] = [values[randomIndex]!, values[index]!];
  }
  return values;
}

/**
 * 驗證並隨機排列已選定的有限 bootstrap 候選集合。
 *
 * registry 載入、來源模式 gate、手動排序與邀請接受都發生於此邊界之前。
 * 空或無效集合保持為空，使 client 可維持本機／離線。
 */
export async function resolveBootstrapNodes(input: {
  configured: readonly string[];
  options?: BootstrapCandidateOptions;
}): Promise<readonly string[]> {
  const options = resolvedOptions(input.options ?? {});
  const configured = validUniqueEntries(input.configured, options.maxEntries, options.maxLines);
  return Object.freeze(shuffle(configured, options.random));
}
