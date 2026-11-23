/**
 * Service Worker 註冊與升版編排——註冊 /service-worker.js（dev 不註冊＝不干擾
 * HMR）；升版循環＝每 UPDATE_CHECK_INTERVAL_MS 檢查（reg.update→waiting 偵測）：
 * minor＝通知 UI 後 2 分鐘自動套用、major＝通知 UI 立即更新；套用一律過 idle
 * guard（比賽／房間／編輯中延後），24h 軟性寬限後轉強制（仍過 guard——只延後
 * 不豁免）。
 */
import { Network } from '@open4wd/system-constants';
import {
  UpdateChecker,
  forceReload,
  type SwRegistrationLike,
  type UpdateInfo,
} from '../versioning/client-version';

/** minor 更新的自動套用延遲（啟動橫幅「2 分鐘後自動套用」） */
export const UPDATE_AUTO_APPLY_DELAY_MS = 120_000;

/** 註冊 SW（SSR／dev／不支援＝false 不註冊） */
export async function registerServiceWorker(enabled: boolean): Promise<boolean> {
  if (!enabled) return false;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register(new URL('service-worker.js', document.baseURI).pathname);
    return true;
  } catch {
    return false;
  }
}

/** 寬限錨持久鍵（重載不歸零＝每日重開者 24h 強制仍生效） */
const FIRST_SEEN_KEY = 'o4-update-first-seen';

/** UpdateChecker 瀏覽器真埠（isIdle＝套用時機 guard 注入；預設恆可） */
export function makeBrowserUpdateChecker(isIdle?: () => boolean): UpdateChecker | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return new UpdateChecker({
    getRegistration: async () =>
      ((await navigator.serviceWorker.getRegistration()) ?? null) as SwRegistrationLike | null,
    fetchVersionJson: async () => {
      try {
        const response = await fetch(new URL('version.json', document.baseURI), {
          cache: 'no-cache',
        });
        return response.ok ? ((await response.json()) as { client_version?: unknown }) : null;
      } catch {
        return null;
      }
    },
    reload: () => location.reload(),
    ...(isIdle === undefined ? {} : { isIdle }),
    firstSeenStore: {
      get: () => {
        try {
          const raw = localStorage.getItem(FIRST_SEEN_KEY);
          if (raw === null) return null;
          const parsed: unknown = JSON.parse(raw);
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            typeof (parsed as { version?: unknown }).version === 'string' &&
            typeof (parsed as { ts?: unknown }).ts === 'number' &&
            Number.isFinite((parsed as { ts: number }).ts)
          ) {
            return parsed as { version: string; ts: number };
          }
          return null;
        } catch {
          return null;
        }
      },
      set: (value) => {
        try {
          if (value === null) localStorage.removeItem(FIRST_SEEN_KEY);
          else localStorage.setItem(FIRST_SEEN_KEY, JSON.stringify(value));
        } catch {
          // 私隱模式等 storage 不可用＝退記憶體錨（行為同舊）
        }
      },
    },
  });
}

/** 設定頁「強制更新」瀏覽器真埠：unregister 全 SW＋清全 caches＋reload */
export async function browserForceReload(): Promise<void> {
  await forceReload({
    getRegistrations: async () =>
      typeof navigator !== 'undefined' && 'serviceWorker' in navigator
        ? ((await navigator.serviceWorker.getRegistrations()) as readonly SwRegistrationLike[])
        : [],
    cacheKeys: () => (typeof caches === 'undefined' ? Promise.resolve([]) : caches.keys()),
    deleteCache: (name) =>
      typeof caches === 'undefined' ? Promise.resolve(false) : caches.delete(name),
    reload: () => location.reload(),
  });
}

/** 定期 service worker 更新迴圈所用的排程與通知介面。 */
export interface UpdateLoopDeps {
  timers: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  /** UI 通知（啟動橫幅：minor＝「N 分鐘後自動套用」、major＝「請立即更新」） */
  onUpdateAvailable?: (info: UpdateInfo) => void;
  checkIntervalMs?: number;
  autoApplyDelayMs?: number;
}

/**
 * 升版循環：定期檢查→有更新即通知 UI；minor（或寬限已到）＝延遲後自動套用
 * （idle guard 不過＝下輪重試）；major＝只通知、由 UI 觸發 applyUpdate。
 * 回傳停止函數。
 */
export function startUpdateLoop(checker: UpdateChecker, deps: UpdateLoopDeps): () => void {
  const interval = deps.checkIntervalMs ?? Network.versioning.UPDATE_CHECK_INTERVAL_MS;
  const applyDelay = deps.autoApplyDelayMs ?? UPDATE_AUTO_APPLY_DELAY_MS;
  let stopped = false;
  const handles = new Set<unknown>();
  const later = (fn: () => void, ms: number): void => {
    if (stopped) return;
    const handle = deps.timers.setTimeout(() => {
      handles.delete(handle);
      if (!stopped) fn();
    }, ms);
    handles.add(handle);
  };
  const tick = async (): Promise<void> => {
    const info = await checker.checkForUpdate().catch(() => null);
    if (stopped) return;
    if (info !== null) {
      deps.onUpdateAvailable?.(info);
      if (!info.isMajor || checker.shouldForceUpdate())
        later(() => void checker.applyUpdate(), applyDelay);
    }
    later(() => void tick(), interval);
  };
  later(() => void tick(), 0);
  return () => {
    stopped = true;
    for (const handle of handles) deps.timers.clearTimeout(handle);
    handles.clear();
  };
}
