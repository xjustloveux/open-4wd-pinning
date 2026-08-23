/**
 * A 軸 client 版本——六欄位 ClientVersionInfo 收斂形＋相容性檢查（任一不同拒配對；
 * client_version 比 major、其餘全等）＋開賽前版本收集（收齊性檢查防靜默放行）＋
 * 升版檢查（SW waiting 偵測、24h 軟性寬限、套用前 idle guard——比賽／房間／編輯
 * 中不 reload）＋強制重整。economy_config_version＝鏈上治理 epoch（runtime 可變、
 * 讀點注入）；build_timestamp／commit_hash＝診斷欄（version.json build 產物）。
 */
import { Network } from '@open4wd/system-constants';
import type { PeerId, Result, Unsubscribe } from '@open4wd/interfaces';
import { err, ok } from '@open4wd/interfaces';

/** 六欄位＋診斷欄（ledger 開放形 Record 的收斂具體形） */
export interface ClientVersionInfo {
  client_version: string;
  rapier_version: string;
  protocol_version: string;
  derive_logic_version: number;
  builtin_assets_version: number;
  economy_config_version: number;
  build_timestamp: number;
  commit_hash: string;
}

/** X.Y.Z 三段非負整數（無預發布標記／build metadata；CI 驗證不符拒 deploy） */
export const CLIENT_VERSION_REGEX = /^\d+\.\d+\.\d+$/;

/** 解析受限的三段式 client 版本，格式不符時直接拒絕。 */
export function parseClientVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
} {
  if (!CLIENT_VERSION_REGEX.test(version)) throw new Error(`client_version 格式不符：${version}`);
  const [major, minor, patch] = version.split('.').map(Number);
  return { major: major!, minor: minor!, patch: patch! };
}

/** build 時固定的五欄（economy_config_version 為鏈上動態、呼叫端供給） */
export interface VersionBuildInfo {
  build_timestamp: number;
  commit_hash: string;
}

/** 組當前 client 的 VERSION_INFO（economyEpoch＝state.economyConfig.epoch 讀點） */
export function versionInfoOf(
  economyConfigVersion: number,
  build: VersionBuildInfo = { build_timestamp: 0, commit_hash: 'dev' },
): ClientVersionInfo {
  return {
    client_version: Network.versioning.CLIENT_VERSION_CURRENT,
    rapier_version: Network.versioning.RAPIER_VERSION_CURRENT,
    protocol_version: Network.versioning.PROTOCOL_VERSION_CURRENT,
    derive_logic_version: Network.versioning.DERIVE_LOGIC_VERSION_CURRENT,
    builtin_assets_version: Network.versioning.BUILTIN_ASSETS_VERSION_CURRENT,
    economy_config_version: economyConfigVersion,
    ...build,
  };
}

/** Ready wire 等不可信輸入共用的完整 ClientVersionInfo 形狀守門。 */
export function isClientVersionInfo(value: unknown): value is ClientVersionInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const info = value as Record<string, unknown>;
  if (
    Object.keys(info).length !== 8 ||
    typeof info['client_version'] !== 'string' ||
    !CLIENT_VERSION_REGEX.test(info['client_version']) ||
    typeof info['rapier_version'] !== 'string' ||
    typeof info['protocol_version'] !== 'string' ||
    !Number.isSafeInteger(info['derive_logic_version']) ||
    !Number.isSafeInteger(info['builtin_assets_version']) ||
    !Number.isSafeInteger(info['economy_config_version']) ||
    !Number.isFinite(info['build_timestamp']) ||
    typeof info['commit_hash'] !== 'string'
  )
    return false;
  return true;
}

/** 六欄位相容性：client_version 比 major 段、其餘全等；任一不同＝拒配對 */
export function checkCompatibility(
  mine: ClientVersionInfo,
  peerVersions: ReadonlyMap<PeerId, ClientVersionInfo>,
): { compatible: boolean; incompatible: { peer: PeerId; reasons: string[] }[] } {
  const myMajor = parseClientVersion(mine.client_version).major;
  const incompatible: { peer: PeerId; reasons: string[] }[] = [];
  for (const [peer, theirs] of peerVersions) {
    const reasons: string[] = [];
    let theirMajor: number | null = null;
    try {
      theirMajor = parseClientVersion(theirs.client_version).major;
    } catch {
      reasons.push('client_version 格式不符');
    }
    if (theirMajor !== null && theirMajor !== myMajor) reasons.push('client_version major');
    if (theirs.rapier_version !== mine.rapier_version) reasons.push('rapier');
    if (theirs.protocol_version !== mine.protocol_version) reasons.push('protocol');
    if (theirs.derive_logic_version !== mine.derive_logic_version) reasons.push('derive_logic');
    if (theirs.builtin_assets_version !== mine.builtin_assets_version)
      reasons.push('builtin_assets');
    if (theirs.economy_config_version !== mine.economy_config_version)
      reasons.push('economy_config');
    if (reasons.length > 0) incompatible.push({ peer, reasons });
  }
  return { compatible: incompatible.length === 0, incompatible };
}

// ── 開賽前版本收集（房間訊息埠；wire 形＝version-request／version-info） ──

/** 定義版本協議在節點間交換的目前版本與最低支援版本訊息。 */
export type VersionWireMessage =
  | { type: 'version-request'; sender: PeerId }
  | { type: 'version-info'; sender: PeerId; payload: ClientVersionInfo };

/** 從遠端版本描述檔解碼出的最小 wire 形。 */
export interface VersionWire {
  send(message: VersionWireMessage): void;
  /** handler 收傳輸層認證身分 from；冒名（sender≠from）由收件端丟棄（與 roster／結算同規） */
  onMessage(handler: (message: VersionWireMessage, from: PeerId) => void): Unsubscribe;
}

/** 收集房內 peer 版本資訊所需的傳輸與逾時依賴。 */
export interface VersionCollectDeps {
  timers: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  timeoutMs?: number;
  retry?: number;
}

/** 各 peer 回報自己的 VERSION_INFO（對端 version-request 的應答；host／member 都掛） */
export function serveVersionRequests(
  wire: VersionWire,
  myPeerId: PeerId,
  myInfo: () => ClientVersionInfo,
): Unsubscribe {
  return wire.onMessage((message, from) => {
    // sender≠from＝冒名丟棄（傳輸層已驗身分）；不應自己的 request
    if (message.type !== 'version-request' || message.sender !== from) return;
    if (message.sender === myPeerId) return;
    wire.send({ type: 'version-info', sender: myPeerId, payload: myInfo() });
  });
}

/**
 * 收集全房版本（1＋retry 次廣播、每次等 timeout）；回傳已收集集合——
 * 收齊性由 preRaceVersionCheck 把關（少任一 peer＝整體失敗、不得開賽）。
 */
export async function collectVersionsFromAllPeers(
  roomMembers: readonly PeerId[],
  wire: VersionWire,
  myPeerId: PeerId,
  myInfo: ClientVersionInfo,
  deps: VersionCollectDeps,
): Promise<Map<PeerId, ClientVersionInfo>> {
  const collected = new Map<PeerId, ClientVersionInfo>([[myPeerId, myInfo]]);
  const expected = roomMembers.filter((peer) => peer !== myPeerId);
  const unsubscribe = wire.onMessage((message, from) => {
    // sender≠from＝冒名丟棄：惡意成員不得在自己通道上冒他人回報版本
    if (message.type !== 'version-info' || message.sender !== from) return;
    if (!expected.includes(message.sender)) return;
    if (!collected.has(message.sender)) collected.set(message.sender, message.payload);
  });
  const timeoutMs = deps.timeoutMs ?? Network.versioning.VERSION_COLLECT_TIMEOUT_MS;
  const attempts = 1 + (deps.retry ?? Network.versioning.VERSION_COLLECT_RETRY);
  const complete = (): boolean => expected.every((peer) => collected.has(peer));
  for (let attempt = 0; attempt < attempts && !complete(); attempt++) {
    wire.send({ type: 'version-request', sender: myPeerId });
    // 收齊即提前結束（短輪詢；訊息 handler 不直接喚醒本 promise）
    await new Promise<void>((resolve) => {
      let settled = false;
      let pollHandle: unknown = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        deps.timers.clearTimeout(timer);
        if (pollHandle !== null) deps.timers.clearTimeout(pollHandle);
        resolve();
      };
      const timer = deps.timers.setTimeout(finish, timeoutMs);
      const poll = (): void => {
        if (settled) return;
        if (complete()) {
          finish();
          return;
        }
        pollHandle = deps.timers.setTimeout(poll, 50);
      };
      pollHandle = deps.timers.setTimeout(poll, 50);
    });
  }
  unsubscribe();
  return collected;
}

/** 開賽前 A 軸驗證：收齊（防靜默放行）→ 六欄位相容；err 訊息供 UI 顯示 */
export async function preRaceClientVersionCheck(
  roomMembers: readonly PeerId[],
  wire: VersionWire,
  myPeerId: PeerId,
  myInfo: ClientVersionInfo,
  deps: VersionCollectDeps,
): Promise<Result<Map<PeerId, ClientVersionInfo>>> {
  const all = await collectVersionsFromAllPeers(roomMembers, wire, myPeerId, myInfo, deps);
  const missing = roomMembers.filter((peer) => !all.has(peer));
  if (missing.length > 0)
    return err(
      new Error(`版本收集失敗，缺：${missing.map((peer) => String(peer).slice(-4)).join(', ')}`),
    );
  const verdict = checkCompatibility(myInfo, all);
  if (!verdict.compatible)
    return err(
      new Error(
        verdict.incompatible
          .map((entry) => `${String(entry.peer).slice(-4)}: ${entry.reasons.join('/')}`)
          .join('; '),
      ),
    );
  return ok(all);
}

// ── 升版檢查（SW waiting 偵測）＋強制重整 ──

/** 描述升版檢查需要的最小 service worker registration 介面。 */
export interface SwRegistrationLike {
  waiting: { postMessage(data: unknown): void } | null;
  update(): Promise<unknown>;
  unregister(): Promise<boolean>;
}

/** 已發現可套用更新的版本與 service-worker 狀態。 */
export interface UpdateInfo {
  hasUpdate: true;
  currentVersion: string;
  newVersion: string;
  isMajor: boolean;
}

/** 更新檢查器的時鐘、版本來源與 reload 邊界依賴。 */
export interface UpdateCheckerDeps {
  getRegistration(): Promise<SwRegistrationLike | null>;
  /** /version.json network-only 讀取（失敗＝null） */
  fetchVersionJson(): Promise<{ client_version?: unknown } | null>;
  reload(): void;
  /** 套用時機 guard：比賽／房間／編輯中＝false（延後至 idle）；省略＝恆可 */
  isIdle?: () => boolean;
  now?: () => number;
  /**
   * 寬限錨持久化（重載不歸零＝每日重開者 24h 強制仍生效）——⭐綁目標版本：連續快速
   * 部署換了 waiting 版即重新起算（不沿用前一版舊錨誤判寬限已滿）；省略＝記憶體。
   */
  firstSeenStore?: {
    get(): { version: string; ts: number } | null;
    set(value: { version: string; ts: number } | null): void;
  };
}

/**
 * 升版檢查：reg.update() 後有 waiting＝新版就緒；套用＝SKIP_WAITING＋reload
 * （先過 idle guard）。24h 軟性寬限後 shouldForceUpdate＝true（強制執行點同受
 * idle guard——guard 只延後、不豁免）。
 */
export class UpdateChecker {
  /** 首次偵測到可更新的時點（寬限計時錨；null＝目前無待套用更新） */
  private firstSeenAt: number | null = null;
  /** 寬限錨綁定的目標版本（換版＝錨重置、B 重新起算 24h） */
  private firstSeenVersion: string | null = null;

  constructor(
    /** 保存 service worker、版本資料、時鐘與寬限錨儲存依賴，供測試替換。 */ private readonly deps: UpdateCheckerDeps,
  ) {}

  /** 要求 service worker 檢查更新；有 waiting worker 時讀取版本並維護綁定目標版本的寬限錨。 */
  async checkForUpdate(): Promise<UpdateInfo | null> {
    const registration = await this.deps.getRegistration();
    if (registration === null) return null;
    try {
      await registration.update();
    } catch {
      return null;
    }
    if (registration.waiting === null) {
      this.firstSeenAt = null;
      this.firstSeenVersion = null;
      this.deps.firstSeenStore?.set(null);
      return null;
    }
    const data = await this.deps.fetchVersionJson();
    const newVersion = typeof data?.client_version === 'string' ? data.client_version : 'unknown';
    // 錨綁目標版本：跨 session（reload）或本 session 換版（B→C）皆重新起算寬限
    if (this.firstSeenAt === null || this.firstSeenVersion !== newVersion) {
      const stored = this.deps.firstSeenStore?.get() ?? null;
      this.firstSeenAt =
        stored !== null && stored.version === newVersion
          ? stored.ts
          : (this.deps.now ?? Date.now)();
      this.firstSeenVersion = newVersion;
    }
    this.deps.firstSeenStore?.set({ version: newVersion, ts: this.firstSeenAt });
    const current = Network.versioning.CLIENT_VERSION_CURRENT as string;
    return {
      hasUpdate: true,
      currentVersion: current,
      newVersion,
      // 新版號讀不到（version.json 不可達）＝走 minor 通知路，不誤觸「不相容請立即更新」
      isMajor:
        CLIENT_VERSION_REGEX.test(newVersion) && current.split('.')[0] !== newVersion.split('.')[0],
    };
  }

  /** 24h 軟性寬限已到（呼叫端據此改「立即套用」路徑；仍過 idle guard） */
  shouldForceUpdate(): boolean {
    if (this.firstSeenAt === null) return false;
    const now = (this.deps.now ?? Date.now)();
    return now - this.firstSeenAt >= Network.versioning.UPDATE_FORCE_GRACE_PERIOD_MS;
  }

  /** 套用更新（idle guard 不過＝false 未套用、呼叫端下個 idle 時點重試） */
  async applyUpdate(): Promise<boolean> {
    if (this.deps.isIdle !== undefined && !this.deps.isIdle()) return false;
    const registration = await this.deps.getRegistration();
    if (registration?.waiting == null) return false;
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    this.deps.reload();
    return true;
  }
}

/** 強制重整：unregister 全部 SW＋清全部 caches＋reload（設定頁「強制更新」） */
export async function forceReload(deps: {
  getRegistrations(): Promise<readonly SwRegistrationLike[]>;
  cacheKeys(): Promise<readonly string[]>;
  deleteCache(name: string): Promise<boolean>;
  reload(): void;
}): Promise<void> {
  for (const registration of await deps.getRegistrations())
    await registration.unregister().catch(() => false);
  for (const name of await deps.cacheKeys()) await deps.deleteCache(name).catch(() => false);
  deps.reload();
}
