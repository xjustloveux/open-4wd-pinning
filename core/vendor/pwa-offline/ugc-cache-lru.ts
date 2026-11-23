/**
 * UGC 本地快取 LRU——只自管「哪些 CID 保留 pin／何時 unpin」，block 移除交給
 * Helia 原生 GC（pins.rm→gc）。pin 分類保留優先級：builtin／mine／loadout／
 * race-lock＝永不 evict（race lock 硬規：比賽期間 unpin 賽用 CID＝物理算崩潰）、
 * lru＝quota 超觸發線後最舊先 evict。一般離線不 GC（unpin 後重抓不到——改讓 quota
 * 警示、連線後再 GC）；僅啟動時 storage 已達 critical 才允許離線回收。meta 純本地
 * 牆鐘、不入帳本。
 */
import { waitForTransactionRequest } from './idb-transaction';
import { STORAGE_CRITICAL_USAGE_RATIO } from './storage';
import { ugcCacheUsagePolicy, type UgcCacheUsagePolicy } from './ugc-contribution-policy';
import { browserOriginStorageLock } from './origin-storage-lock';

/** 控制快取 UGC 根是否可淘汰的所有權分類。 */
export type UgcPinCategory = 'builtin' | 'mine' | 'loadout' | 'library' | 'race-lock' | 'lru';

/** 作用中使用期間保持賽事資產 pinned 的每分頁可到期 claim。 */
export interface UgcRaceLockLease {
  ownerId: string;
  count: number;
  expiresAt: number;
}

/** 單一快取 UGC 根的持久所有權、大小與最近使用中繼資料。 */
export interface UgcCacheMeta {
  cid: string;
  pinCategory: UgcPinCategory;
  sizeBytes: number;
  /** 供 UX 與 protocol 限制使用的完整重建 GLB 大小。 */
  logicalSizeBytes?: number;
  /** 根可達 block 集合持有的編碼 bytes；`sizeBytes` 為 GC 鏡像此值。 */
  physicalBlockBytes?: number;
  lastUsedAt: number;
  pinnedAt: number;
  basePinCategories: readonly UgcBasePinCategory[];
  raceLockCount: number;
  raceLockLeases: readonly UgcRaceLockLease[];
}

/** 邏輯資產大小與去重後實體 block footprint。 */
export interface UgcCacheMeasurement {
  readonly logicalSizeBytes: number;
  readonly physicalBlockBytes: number;
}

type UgcBasePinCategory = Exclude<UgcPinCategory, 'race-lock' | 'lru'>;

interface PinOwnership {
  base: Set<UgcBasePinCategory>;
  raceLeases: Map<string, UgcRaceLockLease>;
}

type UgcCacheMetaWithoutOwnership = Omit<
  UgcCacheMeta,
  'basePinCategories' | 'raceLockCount' | 'raceLockLeases'
> &
  Partial<Pick<UgcCacheMeta, 'basePinCategories' | 'raceLockCount' | 'raceLockLeases'>>;

const ownershipOf = (meta: UgcCacheMeta, now: number): PinOwnership => {
  const raceLeases = new Map<string, UgcRaceLockLease>();
  for (const lease of meta.raceLockLeases)
    if (lease.count > 0 && lease.expiresAt > now) raceLeases.set(lease.ownerId, lease);
  return {
    base: new Set(meta.basePinCategories),
    raceLeases,
  };
};

const effectiveCategory = (ownership: PinOwnership): UgcPinCategory => {
  if (ownership.raceLeases.size > 0) return 'race-lock';
  for (const category of BASE_PIN_PRIORITY) if (ownership.base.has(category)) return category;
  return 'lru';
};

const withOwnership = (
  meta: UgcCacheMetaWithoutOwnership,
  ownership: PinOwnership,
): UgcCacheMeta => ({
  ...meta,
  pinCategory: effectiveCategory(ownership),
  basePinCategories: [...ownership.base],
  raceLockCount: [...ownership.raceLeases.values()].reduce((sum, lease) => sum + lease.count, 0),
  raceLockLeases: [...ownership.raceLeases.values()],
});

/** 快取管理使用的 pin、中繼資料、儲存、連線與鎖定 port。 */
export interface UgcCacheLruDeps {
  pins: {
    add(cid: string): Promise<void>;
    rm(cid: string): Promise<void>;
  };
  gc(): Promise<void>;
  estimate(): Promise<{ usage?: number; quota?: number }>;
  meta: {
    get(cid: string): Promise<UgcCacheMeta | null>;
    put(meta: UgcCacheMeta): Promise<void>;
    delete(cid: string): Promise<void>;
    all(): Promise<readonly UgcCacheMeta[]>;
  };
  verifyConnectivity(): Promise<boolean>;
  /** 即時本機政策：下架 UGC 可留在快取，但不得保留永久所有權。 */
  isTakedown?(cid: string): boolean;
  now(): number;
  /**
   * 每次 GC 擷取一次目前貢獻等級／平台對應的原子門檻組合；省略＝desktop off。
   *
   * @returns 同次 GC 必須共用的 trigger／target 原子 snapshot。
   */
  usagePolicy?(): UgcCacheUsagePolicy;
  /** 每分頁 lease 身分；測試可注入確定性值。 */
  raceLeaseOwnerId?: string;
  raceLeaseDurationMs?: number;
  scheduleRaceLeaseHeartbeat?(run: () => void, intervalMs: number): () => void;
  /** 選用測試／host 權威；瀏覽器可用時退回 Web Locks。 */
  withExclusiveLock?<T>(run: () => Promise<T>): Promise<T>;
  /** 每 CID owner liveness；共用 hold 可跨凍結 timer 存活，exclusive GC 絕不等待。 */
  raceLocks?: {
    holdShared(cid: string): Promise<() => void>;
    withExclusiveIfAvailable<T>(cid: string, run: () => Promise<T>): Promise<T | undefined>;
  };
}

/** 序列化 UGC 所有權變更，並安全淘汰無主且最久未使用的根。 */
export class UgcCacheLruService {
  /** 操作序列化尾端（pin／reclassify 與 evict 迭代互斥——快照期升類不得被覆滅） */
  #queue: Promise<unknown> = Promise.resolve();
  /** 附加至此分頁可到期賽事鎖 lease 的穩定身分。 */
  readonly #raceLeaseOwnerId: string;
  /** 每個重新整理賽事鎖 lease 取得的生命期。 */
  readonly #raceLeaseDurationMs: number;
  /** 此服務 instance 目前擁有賽事 lease 的 CID。 */
  readonly #ownedRaceCids = new Set<string>();
  /** 此分頁使用賽事資產期間持有的共用鎖 release callback。 */
  readonly #raceGuardReleases = new Map<string, () => void>();
  /** 停止作用中的 lease 更新 timer。 */
  #stopHeartbeat: (() => void) | null = null;
  /** orderly shutdown 開始後拒絕新操作。 */
  #shutdownRequested = false;
  /** 冪等 orderly shutdown 流程共用的 promise。 */
  #shutdownPromise: Promise<void> | null = null;

  constructor(
    /** 所有序列化快取操作使用的 runtime port 與政策。 */
    private readonly deps: UgcCacheLruDeps,
  ) {
    this.#raceLeaseOwnerId =
      deps.raceLeaseOwnerId ??
      globalThis.crypto?.randomUUID?.() ??
      `lru-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.#raceLeaseDurationMs = deps.raceLeaseDurationMs ?? 30_000;
  }

  /** 擷取並驗證單次 GC 執行的原子 trigger／target 政策。 */
  #usagePolicy(): UgcCacheUsagePolicy {
    const fallback = ugcCacheUsagePolicy('off', false);
    try {
      const policy = this.deps.usagePolicy?.() ?? fallback;
      if (
        policy.targetUsageRatio >= 0 &&
        policy.targetUsageRatio < policy.triggerUsageRatio &&
        policy.triggerUsageRatio < STORAGE_CRITICAL_USAGE_RATIO
      )
        return policy;
    } catch {
      // An unavailable live setting must retain the established desktop-off behavior.
    }
    return fallback;
  }

  /** 全部公開操作走單佇列：讀改寫不交錯（併發 pin×evict／雙 GC 的競態一律消除） */
  private serial<T>(op: () => Promise<T>): Promise<T> {
    if (this.#shutdownRequested)
      return Promise.reject(new Error('errors.storage.cache-lru-shutdown'));
    const guarded = (): Promise<T> => this.#withOriginLock(op);
    const run = this.#queue.then(guarded, guarded);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 在跨分頁 origin 儲存鎖下執行排隊 mutation。 */
  #withOriginLock<T>(op: () => Promise<T>): Promise<T> {
    if (this.deps.withExclusiveLock !== undefined) return this.deps.withExclusiveLock(op);
    return browserOriginStorageLock().runExclusive(op);
  }

  /** 建立保護單一賽事資產 CID 的 Web Locks 名稱。 */
  #raceLockName(cid: string): string {
    return `open4wd:ugc-cache-lru:race:${cid}`;
  }

  /** 在此分頁賽事 lease 生命期持有共用每 CID guard。 */
  async #acquireRaceGuard(cid: string): Promise<void> {
    if (this.#raceGuardReleases.has(cid)) return;
    if (this.deps.raceLocks !== undefined) {
      this.#raceGuardReleases.set(cid, await this.deps.raceLocks.holdShared(cid));
      return;
    }
    const locks = globalThis.navigator?.locks;
    if (locks === undefined) throw new Error('errors.storage.origin-lock-unavailable');
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let acquiredResolve!: () => void;
    let acquiredReject!: (error: unknown) => void;
    const acquired = new Promise<void>((resolve, reject) => {
      acquiredResolve = resolve;
      acquiredReject = reject;
    });
    let started = false;
    const request = locks.request(this.#raceLockName(cid), { mode: 'shared' }, async () => {
      started = true;
      acquiredResolve();
      await released;
    });
    void request.catch((error: unknown) => {
      if (!started) acquiredReject(error);
    });
    await acquired;
    this.#raceGuardReleases.set(cid, release);
  }

  /** 此分頁最後賽事 lease 結束後釋放共用 guard。 */
  #releaseRaceGuard(cid: string): void {
    const release = this.#raceGuardReleases.get(cid);
    if (release === undefined) return;
    this.#raceGuardReleases.delete(cid);
    release();
  }

  /** 不等待存活賽事 owner，嘗試非阻塞 exclusive CID 清理。 */
  #withRaceExclusiveIfAvailable<T>(cid: string, run: () => Promise<T>): Promise<T | undefined> {
    if (this.deps.raceLocks !== undefined)
      return this.deps.raceLocks.withExclusiveIfAvailable(cid, run);
    const locks = globalThis.navigator?.locks;
    if (locks === undefined) throw new Error('errors.storage.origin-lock-unavailable');
    return locks.request(
      this.#raceLockName(cid),
      { mode: 'exclusive', ifAvailable: true },
      (lock) => (lock === null ? undefined : run()),
    );
  }

  /** 移除目前下架政策禁止的永久玩家所有權。 */
  #normalizeOwnership(cid: string, ownership: PinOwnership): PinOwnership {
    if (this.deps.isTakedown?.(cid) === true) {
      ownership.base.delete('mine');
      ownership.base.delete('loadout');
      ownership.base.delete('library');
    }
    return ownership;
  }

  /** 重建即時所有權，同時丟棄過期 lease 與禁止 pin。 */
  #normalizedOwnershipOf(meta: UgcCacheMeta, now: number): PinOwnership {
    return this.#normalizeOwnership(meta.cid, ownershipOf(meta, now));
  }

  /** 一般 mutation 保留持久 lease；只有 exclusive CID 清理可套用 TTL。 */
  #ownershipForMutation(meta: UgcCacheMeta, now: number): PinOwnership {
    const ownership = this.#normalizedOwnershipOf(meta, now);
    for (const lease of meta.raceLockLeases)
      if (lease.count > 0) ownership.raceLeases.set(lease.ownerId, lease);
    return ownership;
  }

  /** 依此分頁擁有的賽事 CID 啟停定期更新。 */
  #syncHeartbeat(): void {
    if (this.#shutdownRequested || this.#ownedRaceCids.size === 0) {
      this.#stopHeartbeat?.();
      this.#stopHeartbeat = null;
      return;
    }
    if (this.#stopHeartbeat !== null) return;
    const intervalMs = Math.max(1, Math.floor(this.#raceLeaseDurationMs / 3));
    const run = (): void => void this.heartbeatRaceLocks().catch(() => undefined);
    if (this.deps.scheduleRaceLeaseHeartbeat !== undefined) {
      this.#stopHeartbeat = this.deps.scheduleRaceLeaseHeartbeat(run, intervalMs);
      return;
    }
    const handle = globalThis.setInterval(run, intervalMs);
    (handle as unknown as { unref?: () => void }).unref?.();
    this.#stopHeartbeat = () => globalThis.clearInterval(handle);
  }

  /** 只更新仍由此分頁共用 liveness guard 支持的 lease。 */
  heartbeatRaceLocks(): Promise<void> {
    if (this.#shutdownRequested) return Promise.resolve();
    return this.serial(async () => {
      if (this.#shutdownRequested) return;
      const now = this.deps.now();
      for (const cid of [...this.#ownedRaceCids]) {
        const meta = await this.deps.meta.get(cid);
        if (meta === null) {
          this.#ownedRaceCids.delete(cid);
          this.#releaseRaceGuard(cid);
          continue;
        }
        const ownership = this.#ownershipForMutation(meta, now);
        const lease = ownership.raceLeases.get(this.#raceLeaseOwnerId);
        if (lease === undefined) {
          this.#ownedRaceCids.delete(cid);
          this.#releaseRaceGuard(cid);
          continue;
        }
        ownership.raceLeases.set(this.#raceLeaseOwnerId, {
          ...lease,
          expiresAt: now + this.#raceLeaseDurationMs,
        });
        await this.deps.meta.put(withOwnership(meta, ownership));
      }
      this.#syncHeartbeat();
    });
  }

  /**
   * 冪等生命週期停止。既有 owner lease 維持持久化並依 TTL 到期；shutdown 會停止更新、
   * 等待已接受操作，再釋放瀏覽器自有 liveness guard。
   */
  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== null) return this.#shutdownPromise;
    this.#shutdownRequested = true;
    this.#stopHeartbeat?.();
    this.#stopHeartbeat = null;
    const releaseOwned = (): void => {
      for (const cid of this.#raceGuardReleases.keys()) this.#releaseRaceGuard(cid);
      this.#ownedRaceCids.clear();
    };
    this.#shutdownPromise = this.#queue.then(releaseOwned, releaseOwned);
    this.#queue = this.#shutdownPromise;
    return this.#shutdownPromise;
  }

  /** 使用觸點（載入該 CID 時呼）：更新 lastUsedAt */
  touch(cid: string): Promise<void> {
    return this.serial(async () => {
      const meta = await this.deps.meta.get(cid);
      if (meta === null) return;
      const now = this.deps.now();
      await this.deps.meta.put(
        withOwnership({ ...meta, lastUsedAt: now }, this.#ownershipForMutation(meta, now)),
      );
    });
  }

  /** pin＋記帳（已 pin＝升類與 touch；分類不自動降級——降級走 reclassify） */
  pin(
    cid: string,
    category: UgcPinCategory,
    measurement: number | UgcCacheMeasurement,
  ): Promise<void> {
    return this.serial(async () => {
      const logicalSizeBytes =
        typeof measurement === 'number' ? measurement : measurement.logicalSizeBytes;
      const physicalBlockBytes =
        typeof measurement === 'number' ? measurement : measurement.physicalBlockBytes;
      const hadRaceGuard = this.#raceGuardReleases.has(cid);
      if (category === 'race-lock') await this.#acquireRaceGuard(cid);
      try {
        const now = this.deps.now();
        const existing = await this.deps.meta.get(cid);
        if (existing === null) {
          await this.deps.pins.add(cid);
          const ownership = this.#normalizeOwnership(cid, {
            base: new Set(
              category === 'builtin' ||
                category === 'mine' ||
                category === 'loadout' ||
                category === 'library'
                ? [category]
                : [],
            ),
            raceLeases: new Map(),
          });
          if (category === 'race-lock')
            ownership.raceLeases.set(this.#raceLeaseOwnerId, {
              ownerId: this.#raceLeaseOwnerId,
              count: 1,
              expiresAt: now + this.#raceLeaseDurationMs,
            });
          await this.deps.meta.put(
            withOwnership(
              {
                cid,
                pinCategory: 'lru',
                sizeBytes: physicalBlockBytes,
                logicalSizeBytes,
                physicalBlockBytes,
                lastUsedAt: now,
                pinnedAt: now,
              },
              ownership,
            ),
          );
          if (category === 'race-lock') {
            this.#ownedRaceCids.add(cid);
            this.#syncHeartbeat();
          }
          return;
        }
        const ownership = this.#ownershipForMutation(existing, now);
        if (category !== 'lru') await this.deps.pins.add(cid);
        if (category === 'race-lock') {
          const lease = ownership.raceLeases.get(this.#raceLeaseOwnerId);
          ownership.raceLeases.set(this.#raceLeaseOwnerId, {
            ownerId: this.#raceLeaseOwnerId,
            count: (lease?.count ?? 0) + 1,
            expiresAt: now + this.#raceLeaseDurationMs,
          });
          this.#ownedRaceCids.add(cid);
        } else if (category !== 'lru') {
          ownership.base.add(category);
          this.#normalizeOwnership(cid, ownership);
        }
        await this.deps.meta.put(
          withOwnership(
            {
              ...existing,
              sizeBytes: Math.max(existing.sizeBytes, physicalBlockBytes),
              logicalSizeBytes: Math.max(existing.logicalSizeBytes ?? 0, logicalSizeBytes),
              physicalBlockBytes: Math.max(
                existing.physicalBlockBytes ?? existing.sizeBytes,
                physicalBlockBytes,
              ),
              lastUsedAt: now,
            },
            ownership,
          ),
        );
        this.#syncHeartbeat();
      } catch (error) {
        if (category === 'race-lock' && !hadRaceGuard) {
          this.#ownedRaceCids.delete(cid);
          this.#releaseRaceGuard(cid);
        }
        throw error;
      }
    });
  }

  /** 分類轉移（loadout 切換／race lock 解除＝降「最近使用」lru） */
  reclassify(cid: string, category: UgcPinCategory): Promise<void> {
    return this.serial(async () => {
      const hadRaceGuard = this.#raceGuardReleases.has(cid);
      if (category === 'race-lock') await this.#acquireRaceGuard(cid);
      try {
        const meta = await this.deps.meta.get(cid);
        if (meta === null) {
          if (category === 'race-lock' && !hadRaceGuard) this.#releaseRaceGuard(cid);
          return;
        }
        const now = this.deps.now();
        if (category !== 'lru') await this.deps.pins.add(cid);
        const current = this.#ownershipForMutation(meta, now);
        const ownership = this.#normalizeOwnership(cid, {
          base: new Set(
            category === 'builtin' ||
              category === 'mine' ||
              category === 'loadout' ||
              category === 'library'
              ? [category]
              : [],
          ),
          raceLeases: current.raceLeases,
        });
        if (category === 'race-lock') {
          ownership.raceLeases.set(this.#raceLeaseOwnerId, {
            ownerId: this.#raceLeaseOwnerId,
            count: 1,
            expiresAt: now + this.#raceLeaseDurationMs,
          });
          this.#ownedRaceCids.add(cid);
        } else {
          ownership.raceLeases.delete(this.#raceLeaseOwnerId);
          this.#ownedRaceCids.delete(cid);
        }
        await this.deps.meta.put(withOwnership({ ...meta, lastUsedAt: now }, ownership));
        if (category !== 'race-lock') this.#releaseRaceGuard(cid);
        this.#syncHeartbeat();
      } catch (error) {
        if (category === 'race-lock' && !hadRaceGuard) {
          this.#ownedRaceCids.delete(cid);
          this.#releaseRaceGuard(cid);
        }
        throw error;
      }
    });
  }

  /** 與快取清理原子式協調所有持久配裝 CID 的聯集。 */
  reconcileLoadoutPins(currentRefs: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const next = new Set(currentRefs);
      const now = this.deps.now();
      for (const cid of next) {
        const meta = await this.deps.meta.get(cid);
        if (meta === null) {
          await this.deps.pins.add(cid);
          await this.deps.meta.put(
            withOwnership(
              {
                cid,
                pinCategory: 'lru',
                sizeBytes: 0,
                lastUsedAt: now,
                pinnedAt: now,
              },
              this.#normalizeOwnership(cid, {
                base: new Set(['loadout']),
                raceLeases: new Map(),
              }),
            ),
          );
        } else {
          await this.deps.pins.add(cid);
          const ownership = this.#ownershipForMutation(meta, now);
          ownership.base.add('loadout');
          this.#normalizeOwnership(cid, ownership);
          await this.deps.meta.put(withOwnership({ ...meta, lastUsedAt: now }, ownership));
        }
      }
      for (const meta of await this.deps.meta.all()) {
        if (next.has(meta.cid)) continue;
        const persistedBase = ownershipOf(meta, now).base;
        const ownership = this.#ownershipForMutation(meta, now);
        ownership.base.delete('loadout');
        const baseChanged =
          persistedBase.size !== ownership.base.size ||
          [...persistedBase].some((category) => !ownership.base.has(category));
        if (!baseChanged) continue;
        await this.deps.meta.put(withOwnership({ ...meta, lastUsedAt: now }, ownership));
      }
    });
  }

  /** 協調身分資產庫聯集，且不干擾 mine／loadout／race 所有權。 */
  reconcileLibraryPins(currentRefs: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const next = new Set(currentRefs);
      const now = this.deps.now();
      for (const cid of next) {
        const meta = await this.deps.meta.get(cid);
        if (meta === null) {
          if (this.deps.isTakedown?.(cid) === true) continue;
          await this.deps.pins.add(cid);
          await this.deps.meta.put(
            withOwnership(
              {
                cid,
                pinCategory: 'lru',
                sizeBytes: 0,
                lastUsedAt: now,
                pinnedAt: now,
              },
              this.#normalizeOwnership(cid, {
                base: new Set(['library']),
                raceLeases: new Map(),
              }),
            ),
          );
        } else {
          const ownership = this.#ownershipForMutation(meta, now);
          if (this.deps.isTakedown?.(cid) !== true) {
            await this.deps.pins.add(cid);
            ownership.base.add('library');
          }
          this.#normalizeOwnership(cid, ownership);
          await this.deps.meta.put(withOwnership({ ...meta, lastUsedAt: now }, ownership));
        }
      }
      for (const meta of await this.deps.meta.all()) {
        if (next.has(meta.cid)) continue;
        const persistedBase = ownershipOf(meta, now).base;
        const ownership = this.#ownershipForMutation(meta, now);
        ownership.base.delete('library');
        const baseChanged =
          persistedBase.size !== ownership.base.size ||
          [...persistedBase].some((category) => !ownership.base.has(category));
        if (!baseChanged) continue;
        await this.deps.meta.put(withOwnership({ ...meta, lastUsedAt: now }, ownership));
      }
    });
  }

  /** 依持久賽事鎖恢復受保護 UGC 項目，避免重啟後在賽事結束前被 LRU 清理。 */
  restoreRaceLock(cid: string, stillReferencedByLoadout: boolean): Promise<void> {
    return this.serial(async () => {
      const meta = await this.deps.meta.get(cid);
      if (meta === null) return;
      const now = this.deps.now();
      const ownership = this.#ownershipForMutation(meta, now);
      const lease = ownership.raceLeases.get(this.#raceLeaseOwnerId);
      if (lease === undefined) {
        this.#ownedRaceCids.delete(cid);
        this.#releaseRaceGuard(cid);
        return;
      }
      if (lease.count <= 1) {
        ownership.raceLeases.delete(this.#raceLeaseOwnerId);
        this.#ownedRaceCids.delete(cid);
      } else {
        ownership.raceLeases.set(this.#raceLeaseOwnerId, {
          ...lease,
          count: lease.count - 1,
          expiresAt: now + this.#raceLeaseDurationMs,
        });
      }
      if (stillReferencedByLoadout) {
        ownership.base.add('loadout');
        this.#normalizeOwnership(cid, ownership);
      } else ownership.base.delete('loadout');
      await this.deps.meta.put(withOwnership({ ...meta, lastUsedAt: now }, ownership));
      if (!ownership.raceLeases.has(this.#raceLeaseOwnerId)) this.#releaseRaceGuard(cid);
      this.#syncHeartbeat();
    });
  }

  /**
   * 啟動／GC 清掃只移除已過期 owner lease。另一個 tab 的 live lease 必須保留。
   */
  releaseAllRaceLocks(): Promise<number> {
    return this.serial(async () => {
      const now = this.deps.now();
      let released = 0;
      for (const meta of await this.deps.meta.all()) {
        const before = meta.raceLockLeases.length;
        if (before === 0 && meta.pinCategory !== 'race-lock') continue;
        const ownership = this.#normalizedOwnershipOf(meta, now);
        const after = ownership.raceLeases.size;
        if (after === before && meta.pinCategory === effectiveCategory(ownership)) continue;
        const result = await this.#withRaceExclusiveIfAvailable(meta.cid, async () => {
          const fresh = await this.deps.meta.get(meta.cid);
          if (fresh === null) return 0;
          const freshBefore = fresh.raceLockLeases.length;
          const freshOwnership = this.#normalizedOwnershipOf(fresh, this.deps.now());
          const freshAfter = freshOwnership.raceLeases.size;
          if (freshAfter === freshBefore && fresh.pinCategory === effectiveCategory(freshOwnership))
            return 0;
          await this.deps.meta.put(
            withOwnership({ ...fresh, lastUsedAt: this.deps.now() }, freshOwnership),
          );
          return freshAfter < freshBefore ||
            (freshBefore === 0 && fresh.pinCategory === 'race-lock')
            ? 1
            : 0;
        });
        released += result ?? 0;
      }
      return released;
    });
  }

  /** LRU GC：quota 超觸發線＝回收 lru 類至目標線（最舊先）；僅啟動 critical 可離線 GC。 */
  maybeRunGc(
    options: { forceWhenCritical?: boolean } = {},
  ): Promise<{ ranGc: boolean; freedBytes: number }> {
    return this.serial(async () => {
      const policy = this.#usagePolicy();
      const online = await this.deps.verifyConnectivity();
      if (options.forceWhenCritical !== true && !online) return { ranGc: false, freedBytes: 0 };
      const estimate = await this.deps.estimate();
      const usage = estimate.usage ?? 0;
      const quota = estimate.quota ?? 0;
      const ratio = quota > 0 ? usage / quota : 0;
      if (quota <= 0 || ratio <= policy.triggerUsageRatio) return { ranGc: false, freedBytes: 0 };
      if (options.forceWhenCritical === true && ratio <= STORAGE_CRITICAL_USAGE_RATIO && !online)
        return { ranGc: false, freedBytes: 0 };
      const freed = await this.evictLru(usage - quota * policy.targetUsageRatio);
      await this.deps.gc();
      return { ranGc: true, freedBytes: freed };
    });
  }

  /** 設定頁「清空快取」：強制回收全部 lru 類（不看用量；離線亦可——使用者明示） */
  clearLruCache(): Promise<number> {
    return this.serial(async () => {
      const freed = await this.evictLru(Number.POSITIVE_INFINITY);
      await this.deps.gc();
      return freed;
    });
  }

  /** 在每 CID 鎖下重查所有權，並由最舊開始淘汰合格根。 */
  private async evictLru(needFreeBytes: number): Promise<number> {
    const now = this.deps.now();
    const normalized: UgcCacheMeta[] = [];
    for (const meta of await this.deps.meta.all()) {
      const next = withOwnership(meta, this.#normalizedOwnershipOf(meta, now));
      if (
        next.pinCategory !== meta.pinCategory ||
        (next.raceLockLeases?.length ?? 0) !== (meta.raceLockLeases?.length ?? 0)
      ) {
        const guarded = await this.#withRaceExclusiveIfAvailable(meta.cid, async () => {
          const fresh = await this.deps.meta.get(meta.cid);
          if (fresh === null) return null;
          const current = withOwnership(fresh, this.#normalizedOwnershipOf(fresh, this.deps.now()));
          await this.deps.meta.put(current);
          return current;
        });
        if (guarded === undefined) {
          normalized.push(meta);
          continue;
        }
        if (guarded !== null) normalized.push(guarded);
        continue;
      }
      normalized.push(next);
    }
    const evictable = normalized
      .filter((meta) => meta.pinCategory === 'lru')
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    let remaining = needFreeBytes;
    let freed = 0;
    for (const meta of evictable) {
      if (remaining <= 0) break;
      const evicted = await this.#withRaceExclusiveIfAvailable(meta.cid, async () => {
        // 快照期可能升類（race-lock）——exclusive CID guard 下重讀，非 lru 即跳過。
        const fresh = await this.deps.meta.get(meta.cid);
        if (fresh === null) return 0;
        const current = withOwnership(fresh, this.#normalizedOwnershipOf(fresh, this.deps.now()));
        if (current.pinCategory !== fresh.pinCategory) await this.deps.meta.put(current);
        if (current.pinCategory !== 'lru') return 0;
        try {
          await this.deps.pins.rm(meta.cid);
        } catch {
          return 0; // rm 失敗＝不刪帳、不計回收量（避免高估）
        }
        try {
          await this.deps.meta.delete(meta.cid);
        } catch {
          // 刪帳失敗（IDB 瞬時錯）：pin 已移除、block 仍會被 gc 回收＝計 freed；
          // 殘留 meta 下輪重讀重刪，不中斷本輪回收
        }
        return current.sizeBytes;
      });
      const freedNow = evicted ?? 0;
      freed += freedNow;
      remaining -= freedNow;
    }
    return freed;
  }
}

const BASE_PIN_PRIORITY: readonly UgcBasePinCategory[] = ['builtin', 'mine', 'loadout', 'library'];

/** ugc-cache-meta 的統一 DB 真件（每操作開關連線——長持連線擋版本升級） */
export function idbUgcCacheMeta(open: () => Promise<IDBDatabase>): UgcCacheLruDeps['meta'] {
  const run = async <T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const database = await open();
    try {
      const transaction = database.transaction('ugc-cache-meta', mode);
      const request = work(transaction.objectStore('ugc-cache-meta'));
      return await waitForTransactionRequest(transaction, request, 'ugc-cache-meta');
    } finally {
      database.close();
    }
  };
  return {
    get: async (cid) =>
      ((await run('readonly', (store) => store.get(cid))) as UgcCacheMeta | undefined) ?? null,
    put: async (meta) => {
      await run('readwrite', (store) => store.put(meta));
    },
    delete: async (cid) => {
      await run('readwrite', (store) => store.delete(cid));
    },
    all: async () => (await run('readonly', (store) => store.getAll())) as UgcCacheMeta[],
  };
}
