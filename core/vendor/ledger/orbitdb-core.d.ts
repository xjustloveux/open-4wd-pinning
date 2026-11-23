/**
 * @orbitdb/core 4.x 無官方型別——此處聲明本專案用到的最小 API 面
 * （比照 vendored 型別策略：面窄、severity 保守、升版時對 src/ 逐項複核）。
 */
declare module '@orbitdb/core' {
  /** OrbitDB storage 協定（MemoryStorage/LevelStorage/LRUStorage/Composed 皆符合） */
  export interface OrbitStorage {
    put(key: string, value: Uint8Array): Promise<void>;
    get(key: string): Promise<Uint8Array | undefined>;
    del?(key: string): Promise<void>;
    iterator?(options?: {
      amount?: number;
      reverse?: boolean;
    }): AsyncIterable<[string, Uint8Array]>;
    merge?(other: OrbitStorage): Promise<void>;
    clear?(): Promise<void>;
    close?(): Promise<void>;
  }
  export function MemoryStorage(): Promise<OrbitStorage>;
  export function LevelStorage(options?: {
    path?: string;
    valueEncoding?: string;
  }): Promise<OrbitStorage>;
  export function LRUStorage(options?: { size?: number }): Promise<OrbitStorage>;
  export function ComposedStorage(
    primary: OrbitStorage,
    fallback: OrbitStorage,
  ): Promise<OrbitStorage>;
  export function Log(identity: unknown, options?: Record<string, unknown>): Promise<unknown>;
  export const Entry: {
    create(
      identity: unknown,
      id: string,
      payload: unknown,
      encryptPayloadFn?: unknown,
      clock?: { id: string; time: number } | null,
      next?: readonly string[],
      refs?: readonly string[],
    ): Promise<OrbitLogBaseEntry>;
    decode(bytes: Uint8Array, decryptEntry?: unknown, decryptPayload?: unknown): Promise<unknown>;
    encode(entry: unknown): Promise<{ hash: string; bytes: Uint8Array }>;
    verify(identity: unknown, entry: unknown): Promise<boolean>;
  };
  export function IPFSBlockStorage(options: {
    ipfs: unknown;
    pin?: boolean;
    timeout?: number;
  }): Promise<OrbitStorage>;

  export interface OrbitKeyStore {
    close(): Promise<void>;
  }
  export function KeyStore(options?: {
    storage?: OrbitStorage;
    path?: string;
  }): Promise<OrbitKeyStore>;

  export interface OrbitIdentities {
    keystore: OrbitKeyStore;
  }
  export function Identities(options?: {
    keystore?: OrbitKeyStore;
    storage?: OrbitStorage;
    ipfs?: unknown;
    path?: string;
  }): Promise<OrbitIdentities>;

  /** AccessController 工廠（open() 的 AccessController 參數吃工廠本身） */
  export type OrbitAccessControllerFactory = unknown;
  export function useAccessController(factory: OrbitAccessControllerFactory): void;
  export function IPFSAccessController(options?: {
    write?: string[];
    storage?: OrbitStorage;
  }): OrbitAccessControllerFactory;

  export interface OrbitLogBaseEntry {
    id: string;
    payload: { op: string; key: string | null; value: unknown };
    clock: { id: string; time: number };
    next: string[];
    refs: string[];
    v: 2;
    key: string;
    identity: string;
    sig: string;
  }

  export interface OrbitLogEntry extends OrbitLogBaseEntry {
    hash: string;
    admission: { version: 1; workNonce: Uint8Array };
  }

  export interface OrbitPreparedLedgerEntry {
    readonly baseEntry: OrbitLogBaseEntry;
    readonly baseEntryBytes: Uint8Array;
    readonly baseDigest: Uint8Array;
    readonly requiredBits: number;
    readonly parentHashes: readonly string[];
    readonly protectionOwner: string;
  }

  export interface OrbitEventsDb {
    address: string;
    name: string;
    type: string;
    access: {
      type: string;
      write?: readonly string[];
      canAppend?(entry: OrbitLogEntry): Promise<boolean>;
    };
    add(value: unknown): Promise<string>;
    prepare(value: unknown): Promise<OrbitPreparedLedgerEntry>;
    commitPrepared(
      bytes: Uint8Array,
      cid: string,
    ): Promise<{ hash: string; alreadyPresent: boolean }>;
    releasePrepared(owner: string): Promise<void>;
    get(hash: string): Promise<unknown>;
    iterator(options?: {
      gt?: string;
      gte?: string;
      lt?: string;
      lte?: string;
      amount?: number;
    }): AsyncIterable<{ hash: string; value: unknown }>;
    all(): Promise<{ hash: string; value: unknown }[]>;
    log: {
      heads(): Promise<OrbitLogEntry[]>;
      get(hash: string): Promise<OrbitLogEntry | undefined>;
    };
    events: {
      on(name: 'update', handler: (entry: OrbitLogEntry) => void): unknown;
      off(name: 'update', handler: (entry: OrbitLogEntry) => void): unknown;
    };
    close(): Promise<void>;
    drop(): Promise<void>;
  }

  export interface OrbitDBInstance {
    identity: unknown;
    open(
      address: string,
      options?: {
        type?: 'events' | 'documents' | 'keyvalue';
        sync?: boolean;
        entryStorage?: OrbitStorage;
        headsStorage?: OrbitStorage;
        indexStorage?: OrbitStorage;
        AccessController?: OrbitAccessControllerFactory;
        meta?: unknown;
        referencesCount?: number;
        Database?: unknown;
      },
    ): Promise<OrbitEventsDb>;
    stop(): Promise<void>;
    ipfs: unknown;
  }
  export function createOrbitDB(options: {
    ipfs: unknown;
    id?: string;
    identity?: unknown;
    identities?: OrbitIdentities;
    directory?: string;
  }): Promise<OrbitDBInstance>;
}

declare module '@orbitdb/core/src/sync.js' {
  const Sync: (options: Record<string, unknown>) => Promise<unknown>;
  export default Sync;
}
