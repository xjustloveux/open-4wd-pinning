/**
 * Profile 儲存 — 抽象介面＋IndexedDB 實作（runtime）＋記憶體實作（測試）
 * 私鑰 seed 只以 EncryptedSeed 形態落地；解鎖後的 KeyPair 僅存記憶體
 */
import type { PeerId, ProfileMetadata } from '@open4wd/interfaces';
import { waitForTransactionRequest } from '../pwa-offline/idb-transaction';
import type { EncryptedSeed } from './seed-crypto';
import type { SealedIdentityDomain } from './identity-domain-crypto';

/** 可持久化的 profile metadata 與加密 seed。 */
export interface StoredProfile extends ProfileMetadata {
  encryptedSeed: EncryptedSeed;
}

/** 依 PeerId 保存、以 revision CAS 更新的加密 domain 集合。 */
export interface StoredIdentityContainer {
  schemaVersion: 1;
  peerId: PeerId;
  revision: number;
  domains: Readonly<Record<string, SealedIdentityDomain>>;
}

/** profile 與身分 container 持久化所需的原子操作契約。 */
export interface ProfileStore {
  get(profileId: string): Promise<StoredProfile | null>;
  findByPeerId(peerId: PeerId): Promise<StoredProfile | null>;
  list(): Promise<StoredProfile[]>;
  /** 原子式加入單一 PeerId 一次，同時允許相同 origin 的其他 PeerId。 */
  claimProfile(profile: StoredProfile): Promise<StoredProfile>;
  put(profile: StoredProfile): Promise<void>;
  update(profileId: string, patch: Partial<StoredProfile>): Promise<void>;
  delete(profileId: string): Promise<void>;
  getIdentityContainer(peerId: PeerId): Promise<StoredIdentityContainer | null>;
  compareAndSwapIdentityContainer(
    peerId: PeerId,
    expectedRevision: number | null,
    next: StoredIdentityContainer,
  ): Promise<boolean>;
}

/** 測試／本機測試用：純記憶體 */
export class MemoryProfileStore implements ProfileStore {
  /** 測試用 profile 記憶體表。 */
  private readonly profiles = new Map<string, StoredProfile>();
  /** 測試用 PeerId 至身分 container 記憶體表。 */
  private readonly containers = new Map<PeerId, StoredIdentityContainer>();

  /** 依 profile 識別讀取完整加密紀錄；不存在時回傳空值。 */
  get(profileId: string): Promise<StoredProfile | null> {
    return Promise.resolve(this.profiles.get(profileId) ?? null);
  }
  /** 依節點識別尋找對應 profile；不存在時回傳空值。 */
  findByPeerId(peerId: PeerId): Promise<StoredProfile | null> {
    for (const p of this.profiles.values()) if (p.peerId === peerId) return Promise.resolve(p);
    return Promise.resolve(null);
  }
  /** 列出所有已保存 profile 紀錄，供選擇與管理介面使用。 */
  list(): Promise<StoredProfile[]> {
    return Promise.resolve([...this.profiles.values()]);
  }
  /** 在節點識別與 profile 識別皆未被占用時原子登記新 profile，衝突時拒絕。 */
  claimProfile(profile: StoredProfile): Promise<StoredProfile> {
    const same = [...this.profiles.values()].find(
      (candidate) => candidate.peerId === profile.peerId,
    );
    if (same !== undefined) return Promise.resolve(same);
    this.profiles.set(profile.profileId, profile);
    return Promise.resolve(profile);
  }
  /** 寫入完整 profile 紀錄，供已驗證的建立或重新加密流程使用。 */
  put(profile: StoredProfile): Promise<void> {
    this.profiles.set(profile.profileId, profile);
    return Promise.resolve();
  }
  /** 只更新指定 profile 的允許欄位，保留未包含於 patch 的加密資料。 */
  async update(profileId: string, patch: Partial<StoredProfile>): Promise<void> {
    const existing = this.profiles.get(profileId);
    if (!existing) throw new Error(`profile not found: ${profileId}`);
    this.profiles.set(profileId, { ...existing, ...patch });
  }
  /** 移除指定 profile 及其附屬資料；不存在時維持冪等完成。 */
  delete(profileId: string): Promise<void> {
    const profile = this.profiles.get(profileId);
    this.profiles.delete(profileId);
    if (profile !== undefined) this.containers.delete(profile.peerId);
    return Promise.resolve();
  }
  /** 取得目前 profile 的加密身分容器與修訂版；尚未建立時回傳空值。 */
  getIdentityContainer(peerId: PeerId): Promise<StoredIdentityContainer | null> {
    return Promise.resolve(this.containers.get(peerId) ?? null);
  }
  /** 只在目前修訂版符合預期時原子替換加密身分容器，回傳是否成功寫入。 */
  compareAndSwapIdentityContainer(
    peerId: PeerId,
    expectedRevision: number | null,
    next: StoredIdentityContainer,
  ): Promise<boolean> {
    const existing = this.containers.get(peerId);
    if ((existing?.revision ?? null) !== expectedRevision || next.peerId !== peerId)
      return Promise.resolve(false);
    this.containers.set(peerId, next);
    return Promise.resolve(true);
  }
}

const DB_NAME = 'open4wd-keys';
const DB_VERSION = 1;
const STORE = 'profiles';
const CONTAINER_STORE = 'identity-containers';

/** Runtime 用：IndexedDB（store 'profiles'、keyPath 'profileId'、index nickname／peerId） */
export class IndexedDbProfileStore implements ProfileStore {
  /** 延遲建立並重用的 IndexedDB connection promise。 */
  private dbPromise: Promise<IDBDatabase> | null = null;

  /** 開啟或升級 profile database，並快取成功的連線 promise。 */
  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'profileId' });
          store.createIndex('nickname', 'nickname');
          store.createIndex('peerId', 'peerId');
        }
        if (!db.objectStoreNames.contains(CONTAINER_STORE))
          db.createObjectStore(CONTAINER_STORE, { keyPath: 'peerId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    });
    return this.dbPromise;
  }

  /** 在指定 IndexedDB 模式中執行 profile 儲存操作，交易失敗時整批回滾。 */
  private async tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    return waitForTransactionRequest(transaction, request, 'profile store');
  }

  /** 依 profile 識別讀取完整加密紀錄；不存在時回傳空值。 */
  async get(profileId: string): Promise<StoredProfile | null> {
    return (
      ((await this.tx('readonly', (s) => s.get(profileId))) as StoredProfile | undefined) ?? null
    );
  }
  /** 依節點識別尋找對應 profile；不存在時回傳空值。 */
  async findByPeerId(peerId: PeerId): Promise<StoredProfile | null> {
    return (
      ((await this.tx('readonly', (s) => s.index('peerId').get(peerId))) as
        StoredProfile | undefined) ?? null
    );
  }
  /** 列出所有已保存 profile 紀錄，供選擇與管理介面使用。 */
  async list(): Promise<StoredProfile[]> {
    return (await this.tx('readonly', (s) => s.getAll())) as StoredProfile[];
  }
  /** 在節點識別與 profile 識別皆未被占用時原子登記新 profile，衝突時拒絕。 */
  async claimProfile(profile: StoredProfile): Promise<StoredProfile> {
    const db = await this.open();
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    return new Promise<StoredProfile>((resolve, reject) => {
      let claimed: StoredProfile | null = null;
      let failure: Error | null = null;
      const request = store.index('peerId').get(profile.peerId) as IDBRequest<
        StoredProfile | undefined
      >;
      request.onsuccess = () => {
        const existing = request.result;
        if (existing !== undefined) {
          claimed = existing;
          return;
        }
        claimed = profile;
        const add = store.add(profile);
        add.onerror = () => {
          failure = add.error ?? new Error('profile claim write failed');
        };
      };
      request.onerror = () => reject(request.error ?? new Error('profile claim read failed'));
      transaction.onerror = () =>
        reject(failure ?? transaction.error ?? new Error('profile claim transaction failed'));
      transaction.onabort = () =>
        reject(failure ?? transaction.error ?? new Error('profile claim transaction aborted'));
      transaction.oncomplete = () => {
        if (claimed === null) return reject(new Error('profile claim produced no result'));
        resolve(claimed);
      };
    });
  }
  /** 寫入完整 profile 紀錄，供已驗證的建立或重新加密流程使用。 */
  async put(profile: StoredProfile): Promise<void> {
    await this.tx('readwrite', (s) => s.put(profile));
  }
  /** 只更新指定 profile 的允許欄位，保留未包含於 patch 的加密資料。 */
  async update(profileId: string, patch: Partial<StoredProfile>): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    await new Promise<void>((resolve, reject) => {
      let failure: Error | null = null;
      const request = store.get(profileId) as IDBRequest<StoredProfile | undefined>;
      request.onsuccess = () => {
        const existing = request.result;
        if (existing === undefined) {
          failure = new Error(`profile not found: ${profileId}`);
          transaction.abort();
          return;
        }
        const put = store.put({ ...existing, ...patch });
        put.onerror = () => {
          failure = put.error ?? new Error('profile update write failed');
        };
      };
      request.onerror = () => {
        failure = request.error ?? new Error('profile update read failed');
      };
      transaction.onerror = () =>
        reject(failure ?? transaction.error ?? new Error('profile update transaction failed'));
      transaction.onabort = () =>
        reject(failure ?? transaction.error ?? new Error('profile update transaction aborted'));
      transaction.oncomplete = () => resolve();
    });
  }
  /** 移除指定 profile 及其附屬資料；不存在時維持冪等完成。 */
  async delete(profileId: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction([STORE, CONTAINER_STORE], 'readwrite');
    const profiles = transaction.objectStore(STORE);
    const containers = transaction.objectStore(CONTAINER_STORE);
    await new Promise<void>((resolve, reject) => {
      const request = profiles.get(profileId) as IDBRequest<StoredProfile | undefined>;
      request.onsuccess = () => {
        profiles.delete(profileId);
        if (request.result !== undefined) containers.delete(request.result.peerId);
      };
      request.onerror = () => reject(request.error ?? new Error('profile delete read failed'));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('profile/container delete transaction failed'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('profile/container delete transaction aborted'));
      transaction.oncomplete = () => resolve();
    });
  }

  /** 取得目前 profile 的加密身分容器與修訂版；尚未建立時回傳空值。 */
  async getIdentityContainer(peerId: PeerId): Promise<StoredIdentityContainer | null> {
    const db = await this.open();
    const transaction = db.transaction(CONTAINER_STORE, 'readonly');
    const request = transaction.objectStore(CONTAINER_STORE).get(peerId) as IDBRequest<
      StoredIdentityContainer | undefined
    >;
    return (await waitForTransactionRequest(transaction, request, 'identity container')) ?? null;
  }

  /** 只在目前修訂版符合預期時原子替換加密身分容器，回傳是否成功寫入。 */
  async compareAndSwapIdentityContainer(
    peerId: PeerId,
    expectedRevision: number | null,
    next: StoredIdentityContainer,
  ): Promise<boolean> {
    if (next.peerId !== peerId) return false;
    const db = await this.open();
    const transaction = db.transaction(CONTAINER_STORE, 'readwrite');
    const store = transaction.objectStore(CONTAINER_STORE);
    return new Promise<boolean>((resolve, reject) => {
      let matched = false;
      const request = store.get(peerId) as IDBRequest<StoredIdentityContainer | undefined>;
      request.onsuccess = () => {
        if ((request.result?.revision ?? null) !== expectedRevision) return;
        matched = true;
        store.put(next);
      };
      request.onerror = () =>
        reject(request.error ?? new Error('identity container CAS read failed'));
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('identity container CAS transaction failed'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('identity container CAS transaction aborted'));
      transaction.oncomplete = () => resolve(matched);
    });
  }
}
