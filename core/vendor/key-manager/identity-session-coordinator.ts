/** 同源分頁傳播身分鎖定與啟用訊息的 BroadcastChannel 名稱。 */
export const IDENTITY_SESSION_CHANNEL = 'open4wd:identity-session:v1';
/** durable storage 中保存最新身分撤銷 token 的鍵。 */
export const IDENTITY_LOCK_EPOCH_KEY = 'open4wd:identity-lock-epoch:v1';
/** 持久化或 broadcast 輸入接受的 UTF-16 token 長度上限。 */
export const MAX_IDENTITY_LOCK_TOKEN_LENGTH = 512;
const MAX_IDENTITY_ACTIVATION_FIELD_LENGTH = 512;
const MAX_IDENTITY_DURABLE_VALUE_LENGTH = 4096;
const MAX_SEEN_IDENTITY_LOCK_TOKENS = 256;

/** 同源鎖定 token 傳播使用的最小持久 key/value surface。 */
export interface IdentitySessionStorage {
  /**
   * @param key - 持久 token key。
   * @returns 最新 token；缺少時為 `null`。
   * @throws 原樣拋出 host 儲存讀取失敗。
   */
  getItem(key: string): string | null;
  /**
   * @param key - 持久 token key。
   * @param value - 新的不透明撤銷 token。
   * @returns 無。
   * @throws 原樣拋出 host 儲存失敗。
   */
  setItem(key: string, value: string): void;
}

/** 最小瀏覽器生命週期事件 surface；SSR 與受限 host 會省略。 */
export interface IdentitySessionEventSource {
  /**
   * @param type - Host 生命週期事件名稱。
   * @param listener - 要附加的 listener。
   * @returns 無。
   * @throws 原樣拋出 host listener 註冊失敗。
   */
  addEventListener(type: string, listener: (event: unknown) => void): void;
  /**
   * @param type - Host 生命週期事件名稱。
   * @param listener - 先前附加的 listener。
   * @returns 無。
   * @throws 原樣拋出 host listener 移除失敗。
   */
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** 用於通知已開啟同源分頁的最小 BroadcastChannel surface。 */
export interface IdentitySessionBroadcastChannel {
  /**
   * @param message - 要發布的鎖定 envelope。
   * @returns 無。
   * @throws 原樣拋出 host channel 失敗。
   */
  postMessage(message: unknown): void;
  /**
   * @param type - 固定為 `message`。
   * @param listener - 要附加的 listener。
   * @returns 無。
   * @throws 原樣拋出 host listener 註冊失敗。
   */
  addEventListener(type: 'message', listener: (event: unknown) => void): void;
  /**
   * @param type - 固定為 `message`。
   * @param listener - 先前附加的 listener。
   * @returns 無。
   * @throws 原樣拋出 host listener 移除失敗。
   */
  removeEventListener(type: 'message', listener: (event: unknown) => void): void;
  /**
   * @returns 無。
   * @throws 原樣拋出 host channel 清理失敗。
   */
  close(): void;
}

/** identity session coordinator 使用的 host 能力與確定性 seam。 */
export interface IdentitySessionCoordinatorOptions {
  /** 用於忽略此 coordinator 自身 broadcast 的每文件識別碼。 */
  sourceId: string;
  /** 可選用的持久同源傳播路徑。 */
  storage?: IdentitySessionStorage | null;
  /** 可選用的即時同源傳播路徑。 */
  channel?: IdentitySessionBroadcastChannel | null;
  /** storage 與 pageshow 重新整理可選用的類 window 來源。 */
  pageEvents?: IdentitySessionEventSource | null;
  /** visibility 重新整理可選用的類 document 來源。 */
  visibilityEvents?: IdentitySessionEventSource | null;
  /** 回報 visibility 重新整理是否應讀取持久狀態。 */
  isVisible?: () => boolean;
  /** entropy seam；production 呼叫端應省略，改用安全瀏覽器 generator。 */
  makeToken?: () => string;
}

type LockMessage = Readonly<{ type: 'lock'; epoch: string; sourceId: string }>;
type ActivationMessage = Readonly<{
  type: 'activate';
  epoch: string;
  sourceId: string;
  profileId: string;
  peerId: string;
}>;
type SessionMessage = LockMessage | ActivationMessage;

function parseEpoch(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_IDENTITY_LOCK_TOKEN_LENGTH) return null;
  const token = value.trim();
  return token !== '' ? token : null;
}

function parseActivationField(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_IDENTITY_ACTIVATION_FIELD_LENGTH) return null;
  const field = value.trim();
  return field !== '' ? field : null;
}

function parseSessionMessage(value: unknown): SessionMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as {
    type?: unknown;
    epoch?: unknown;
    sourceId?: unknown;
    profileId?: unknown;
    peerId?: unknown;
  };
  const epoch = parseEpoch(candidate.epoch);
  const sourceId = parseActivationField(candidate.sourceId);
  if (epoch === null || sourceId === null) return null;
  if (candidate.type === 'lock') return { type: 'lock', epoch, sourceId };
  if (candidate.type !== 'activate') return null;
  const profileId = parseActivationField(candidate.profileId);
  const peerId = parseActivationField(candidate.peerId);
  if (profileId === null || peerId === null) return null;
  return { type: 'activate', epoch, sourceId, profileId, peerId };
}

function parseDurableEpoch(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_IDENTITY_DURABLE_VALUE_LENGTH) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!trimmed.startsWith('{')) return parseEpoch(value);
  try {
    return parseSessionMessage(JSON.parse(trimmed))?.epoch ?? null;
  } catch {
    return null;
  }
}

/**
 * 同源撤銷權威。持久化的 `epoch` 值是不透明且不重複的鎖定 token，
 * 不是 read-modify-write counter 或單分頁 lease。
 */
export class IdentitySessionCoordinator {
  /** 本文件識別碼，用於忽略自身廣播。 */
  readonly #sourceId: string;
  /** 可選的 durable 同源 token 傳播介面。 */
  readonly #storage: IdentitySessionStorage | null;
  /** 可選的即時跨分頁訊息介面。 */
  readonly #channel: IdentitySessionBroadcastChannel | null;
  /** storage 與 pageshow 事件來源。 */
  readonly #pageEvents: IdentitySessionEventSource | null;
  /** visibilitychange 事件來源。 */
  readonly #visibilityEvents: IdentitySessionEventSource | null;
  /** 判斷頁面恢復可見時是否應刷新 durable token。 */
  readonly #isVisible: () => boolean;
  /** 產生唯一、不可預測撤銷 token 的來源。 */
  readonly #makeToken: () => string;
  /** 收到遠端新 epoch 時通知本地鎖定流程的 listeners。 */
  readonly #listeners = new Set<(epoch: string) => void>();
  /** 有界保存已處理 epoch，避免重複通知與訊息迴圈。 */
  readonly #seenEpochs = new Set<string>();
  /** 本 coordinator 已接受的最新 opaque epoch。 */
  #epoch = '';
  /** 關閉後阻止任何遠端訊息或刷新再次改變狀態。 */
  #closed = false;

  /** 接收其他分頁廣播並驗證 envelope。 */
  readonly #onMessage = (event: unknown): void => {
    const data = (event as { data?: unknown } | null)?.data;
    const message = parseSessionMessage(data);
    if (message === null || message.sourceId === this.#sourceId) return;
    this.#acceptRemote(message.epoch);
  };

  /** 在 durable storage key 異動時接受或重新讀取 epoch。 */
  readonly #onStorage = (event: unknown): void => {
    const storageEvent = event as { key?: unknown; newValue?: unknown } | null;
    if (storageEvent?.key !== IDENTITY_LOCK_EPOCH_KEY) return;
    const epoch = parseDurableEpoch(storageEvent.newValue);
    if (epoch === null) this.refresh();
    else this.#acceptRemote(epoch);
  };

  /** bfcache 恢復時重新比對 durable epoch。 */
  readonly #onPageShow = (): void => this.refresh();
  /** 頁面重新可見時重新比對 durable epoch。 */
  readonly #onVisibility = (): void => {
    if (this.#isVisible()) this.refresh();
  };

  /**
   * @param options - Host 傳播能力與確定性測試 seam。
   */
  constructor(options: IdentitySessionCoordinatorOptions) {
    this.#sourceId = options.sourceId;
    this.#storage = options.storage ?? null;
    this.#channel = options.channel ?? null;
    this.#pageEvents = options.pageEvents ?? null;
    this.#visibilityEvents = options.visibilityEvents ?? null;
    this.#isVisible = options.isVisible ?? (() => true);
    this.#makeToken = options.makeToken ?? (() => `${this.#sourceId}:${makeRandomId()}`);
    this.#epoch = this.#readDurableEpoch() ?? '';
    if (this.#epoch !== '') this.#remember(this.#epoch);
    try {
      this.#channel?.addEventListener('message', this.#onMessage);
    } catch {
      // BroadcastChannel may be exposed but denied by the host; local locking still works.
    }
    try {
      this.#pageEvents?.addEventListener('storage', this.#onStorage);
    } catch {
      // Optional browser event sources must not disable local revocation.
    }
    try {
      this.#pageEvents?.addEventListener('pageshow', this.#onPageShow);
    } catch {
      // Optional browser event sources must not disable local revocation.
    }
    try {
      this.#visibilityEvents?.addEventListener('visibilitychange', this.#onVisibility);
    } catch {
      // Optional browser event sources must not disable local revocation.
    }
  }

  /**
   * @returns 最新的本機產生或遠端接受不透明撤銷 token。
   */
  currentEpoch(): string {
    return this.#epoch;
  }

  /**
   * @param listener - 每次接受新遠端 token 時呼叫的 callback。
   * @returns 冪等 unsubscribe callback；已關閉 coordinator 回傳 no-op。
   */
  onRemoteLock(listener: (epoch: string) => void): () => void {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * 撤銷目前本機 generation，並將新 token 發布至每個已設定的同源路徑。
   * 僅本機／SSR coordinator 沒有發布要求。
   *
   * @returns 新產生的 token；已關閉時回傳最後 token。
   * @throws entropy 失敗、token 無效／不重複性不足，或所有已設定發布路徑皆失敗時拋出。
   * 回報發布失敗前，記憶體內 token 已完成撤銷。
   */
  bumpLockEpoch(): string {
    if (this.#closed) return this.#epoch;
    const epoch = parseEpoch(this.#makeToken());
    if (epoch === null || this.#seenEpochs.has(epoch))
      throw new Error('Identity lock token must be unique and non-empty');
    this.#epoch = epoch;
    this.#remember(epoch);
    const publicationFailures: unknown[] = [];
    let configuredPaths = 0;
    let successfulPaths = 0;
    if (this.#storage !== null) {
      configuredPaths += 1;
      try {
        this.#storage.setItem(IDENTITY_LOCK_EPOCH_KEY, this.#epoch);
        successfulPaths += 1;
      } catch (cause) {
        publicationFailures.push(cause);
      }
    }
    if (this.#channel !== null) {
      configuredPaths += 1;
      try {
        this.#channel.postMessage({ type: 'lock', epoch: this.#epoch, sourceId: this.#sourceId });
        successfulPaths += 1;
      } catch (cause) {
        publicationFailures.push(cause);
      }
    }
    if (configuredPaths > 0 && successfulPaths === 0)
      throwCleanupFailures(publicationFailures, 'Identity lock token publication failed');
    return this.#epoch;
  }

  /**
   * 宣告此 origin 唯一作用中身分，並在啟動前驗證持久化勝出者。
   * 競爭分頁後續啟用仍會透過 `onRemoteLock` 交付。
   */
  claimActivation(profileId: string, peerId: string): string {
    if (this.#closed) throw new Error('Identity session coordinator is closed');
    const normalizedProfileId = parseActivationField(profileId);
    const normalizedPeerId = parseActivationField(peerId);
    if (normalizedProfileId === null || normalizedPeerId === null)
      throw new Error('Identity activation fields must be non-empty and bounded');
    const epoch = parseEpoch(this.#makeToken());
    if (epoch === null || this.#seenEpochs.has(epoch))
      throw new Error('Identity lock token must be unique and non-empty');
    const envelope: ActivationMessage = {
      type: 'activate',
      epoch,
      sourceId: this.#sourceId,
      profileId: normalizedProfileId,
      peerId: normalizedPeerId,
    };
    this.#epoch = epoch;
    this.#remember(epoch);
    const failures: unknown[] = [];
    let configuredPaths = 0;
    let successfulPaths = 0;
    let durablePublished = false;
    if (this.#storage !== null) {
      configuredPaths += 1;
      try {
        this.#storage.setItem(IDENTITY_LOCK_EPOCH_KEY, JSON.stringify(envelope));
        durablePublished = true;
        successfulPaths += 1;
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (this.#channel !== null) {
      configuredPaths += 1;
      try {
        this.#channel.postMessage(envelope);
        successfulPaths += 1;
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (configuredPaths > 0 && successfulPaths === 0)
      throwCleanupFailures(failures, 'Identity activation publication failed');
    if (durablePublished) {
      let winner: string | null;
      try {
        winner = parseDurableEpoch(this.#storage?.getItem(IDENTITY_LOCK_EPOCH_KEY) ?? null);
      } catch (cause) {
        throw new Error('Identity activation readback failed', { cause });
      }
      if (winner !== epoch) {
        if (winner !== null) this.#acceptRemote(winner);
        throw new Error('Identity activation was superseded');
      }
    }
    return epoch;
  }

  /**
   * 有持久 token 時加以擷取；storage 缺少／遭阻擋不代表撤銷。
   *
   * @returns 無。
   * @throws 原樣拋出已註冊 remote-lock listener 失敗。
   */
  refresh(): void {
    if (this.#closed) return;
    const epoch = this.#readDurableEpoch();
    if (epoch !== null) this.#acceptRemote(epoch);
  }

  /**
   * 盡力分離所有 host 資源。
   *
   * @returns 無。
   * @throws 原始清理失敗；多個分離操作失敗時拋出 AggregateError。
   * 即使清理降級，coordinator 仍保持關閉。
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    const failures: unknown[] = [];
    try {
      this.#channel?.removeEventListener('message', this.#onMessage);
    } catch (cause) {
      failures.push(cause);
    }
    try {
      this.#pageEvents?.removeEventListener('storage', this.#onStorage);
    } catch (cause) {
      failures.push(cause);
    }
    try {
      this.#pageEvents?.removeEventListener('pageshow', this.#onPageShow);
    } catch (cause) {
      failures.push(cause);
    }
    try {
      this.#visibilityEvents?.removeEventListener('visibilitychange', this.#onVisibility);
    } catch (cause) {
      failures.push(cause);
    }
    try {
      this.#channel?.close();
    } catch (cause) {
      failures.push(cause);
    }
    throwCleanupFailures(failures, 'Identity session coordinator cleanup failed');
  }

  /** 防禦性讀取並解析 durable epoch；host 失敗視為不可用。 */
  #readDurableEpoch(): string | null {
    try {
      return parseDurableEpoch(this.#storage?.getItem(IDENTITY_LOCK_EPOCH_KEY) ?? null);
    } catch {
      return null;
    }
  }

  /** 接受未見的遠端 epoch 並同步通知所有本地 listeners。 */
  #acceptRemote(epoch: string): void {
    if (this.#closed || this.#seenEpochs.has(epoch)) return;
    this.#epoch = epoch;
    this.#remember(epoch);
    for (const listener of this.#listeners) listener(epoch);
  }

  /** 以 insertion order 維護固定容量的已處理 epoch 集合。 */
  #remember(epoch: string): void {
    while (this.#seenEpochs.size >= MAX_SEEN_IDENTITY_LOCK_TOKENS) {
      const oldest = this.#seenEpochs.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#seenEpochs.delete(oldest);
    }
    this.#seenEpochs.add(epoch);
  }
}

function throwCleanupFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

function makeRandomId(): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    if (typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 建立瀏覽器 adapter；SSR 與受限 host 會取得完整可用的僅本機 coordinator，
 * 在本機 token 存在前，其重新整理為 no-op。
 *
 * @returns 管理所有成功取得 channel 與生命週期 listener 的 coordinator。
 * @throws 建立每文件來源識別碼時發生的 host entropy 失敗。
 */
export function makeBrowserIdentitySessionCoordinator(): IdentitySessionCoordinator {
  const hasWindow = typeof window !== 'undefined';
  const sourceId = `session-${makeRandomId()}`;
  let channel: BroadcastChannel | null = null;
  if (hasWindow && typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(IDENTITY_SESSION_CHANNEL);
    } catch {
      channel = null;
    }
  }
  let storage: Storage | null = null;
  if (hasWindow) {
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
  }
  return new IdentitySessionCoordinator({
    sourceId,
    storage,
    channel:
      channel === null
        ? null
        : {
            postMessage: (message) => channel.postMessage(message),
            addEventListener: (_type, listener) =>
              channel.addEventListener('message', listener as EventListener),
            removeEventListener: (_type, listener) =>
              channel.removeEventListener('message', listener as EventListener),
            close: () => channel.close(),
          },
    pageEvents: hasWindow
      ? {
          addEventListener: (type, listener) =>
            window.addEventListener(type, listener as EventListener),
          removeEventListener: (type, listener) =>
            window.removeEventListener(type, listener as EventListener),
        }
      : null,
    visibilityEvents:
      typeof document === 'undefined'
        ? null
        : {
            addEventListener: (type, listener) =>
              document.addEventListener(type, listener as EventListener),
            removeEventListener: (type, listener) =>
              document.removeEventListener(type, listener as EventListener),
          },
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
  });
}
