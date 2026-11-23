import { CID } from 'multiformats/cid';
import { base58btc } from 'multiformats/bases/base58';

/** 重啟時可恢復的 outbox entry 及其需防 eviction parent hashes。 */
export interface RestorableLedgerOutboxProtection {
  readonly cid: string;
  readonly parentHashes: readonly string[];
}

function canonicalCid(value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('invalid entry CID');
  let parsed: CID;
  try {
    parsed = CID.parse(value, base58btc);
  } catch {
    throw new TypeError('invalid entry CID');
  }
  const canonical = parsed.toString(base58btc);
  if (canonical !== value) throw new TypeError('non-canonical entry CID');
  return canonical;
}

function validOwner(owner: string): string {
  if (typeof owner !== 'string' || owner.length === 0)
    throw new TypeError('invalid protection owner');
  return owner;
}

function normalizedHashes(hashes: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(hashes)) throw new TypeError('invalid protected CID list');
  return new Set(hashes.map(canonicalCid));
}

/** 暫態準備工作與持久 outbox recovery 共用的 owner／ref-count registry。 */
export class LedgerEntryProtectionRegistry {
  /** Owner 至其持有 protected hashes 的映射。 */
  readonly #owners = new Map<string, ReadonlySet<string>>();
  /** 每個 hash 被多少 prepare/outbox owners 持有的 ref count。 */
  readonly #counts = new Map<string, number>();

  /** 以指定擁有者保護一組內容雜湊，避免 outbox 完成前被清理。 */
  hold(owner: string, hashes: readonly string[]): void {
    const normalizedOwner = validOwner(owner);
    const normalized = normalizedHashes(hashes);
    if (this.#owners.has(normalizedOwner)) throw new Error('protection owner already exists');
    this.#owners.set(normalizedOwner, normalized);
    for (const hash of normalized) this.#counts.set(hash, (this.#counts.get(hash) ?? 0) + 1);
  }

  /** 將既有內容保護權由一個擁有者原子移轉給另一個擁有者。 */
  transfer(from: string, to: string): void {
    const sourceOwner = validOwner(from);
    const targetOwner = validOwner(to);
    const hashes = this.#owners.get(sourceOwner);
    if (hashes === undefined) throw new Error('source protection owner does not exist');
    if (this.#owners.has(targetOwner)) throw new Error('target protection owner already exists');
    this.#owners.set(targetOwner, hashes);
    this.#owners.delete(sourceOwner);
  }

  /** 釋放指定擁有者持有的全部內容保護，回傳是否實際移除資料。 */
  release(owner: string): boolean {
    const hashes = this.#owners.get(owner);
    if (hashes === undefined) return false;
    this.#owners.delete(owner);
    for (const hash of hashes) {
      const count = this.#counts.get(hash);
      if (count === undefined || count < 1)
        throw new Error('protection ref-count invariant failed');
      if (count === 1) this.#counts.delete(hash);
      else this.#counts.set(hash, count - 1);
    }
    return true;
  }

  /** 依持久 outbox 紀錄重建內容保護集合，避免重新啟動後提早清理。 */
  restoreOutbox(records: readonly RestorableLedgerOutboxProtection[]): void {
    if (!Array.isArray(records)) throw new TypeError('invalid outbox protection records');
    const prepared = records.map((record) => {
      if (typeof record !== 'object' || record === null)
        throw new TypeError('invalid outbox protection record');
      const cid = canonicalCid(record.cid);
      return { owner: `outbox:${cid}`, hashes: normalizedHashes(record.parentHashes) };
    });
    const owners = new Set<string>();
    for (const item of prepared) {
      if (owners.has(item.owner) || this.#owners.has(item.owner))
        throw new Error('outbox protection owner already exists');
      owners.add(item.owner);
    }
    for (const item of prepared) this.hold(item.owner, [...item.hashes]);
  }

  /** 判斷指定內容雜湊是否仍被任一未完成工作保護。 */
  isProtected(hash: string): boolean {
    return (this.#counts.get(hash) ?? 0) > 0;
  }

  /** 建立目前所有受保護內容雜湊的排序快照，避免暴露可變集合。 */
  protectedHashes(): readonly string[] {
    return Object.freeze([...this.#counts.keys()].sort());
  }
}
