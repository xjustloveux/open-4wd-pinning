/**
 * 線上偵測——navigator.onLine 事件流＋主動 ping（onLine=true 只代表有網卡、
 * 不代表連得到 signaling）。埠注入＝SSR／測試安全；瀏覽器真埠 browserOnlineDeps。
 */

export interface OnlineStatusDeps {
  isOnline(): boolean;
  /** window online／offline 事件（回退訂）；SSR＝no-op */
  subscribe(handler: (online: boolean) => void): () => void;
  /** 主動連通性驗證（/api/health HEAD、3s timeout）；失敗＝false */
  ping(): Promise<boolean>;
}

/** 發布瀏覽器連線狀態事件，並提供明確的連線探測功能。 */
export class OnlineStatusService {
  /** 由 navigator 取得的最新上線狀態。 */
  private online: boolean;
  /** 瀏覽器上線狀態變更時要通知的訂閱者。 */
  private readonly listeners = new Set<(online: boolean) => void>();
  /** 清理由外部注入之瀏覽器事件訂閱的回呼。 */
  private readonly unsubscribe: () => void;

  constructor(
    /** 保存瀏覽器 online 狀態與事件訂閱邊界，供測試替換。 */ private readonly deps: OnlineStatusDeps,
  ) {
    this.online = deps.isOnline();
    this.unsubscribe = deps.subscribe((online) => {
      this.online = online;
      for (const listener of [...this.listeners]) listener(online);
    });
  }

  /** 取得目前已知的瀏覽器連線布林狀態。 */
  current(): boolean {
    return this.online;
  }

  /** 訂閱 online 狀態變更並回傳解除監聽函式。 */
  onChange(handler: (online: boolean) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** 主動 ping 確認真能連上（GC 前置、離線 UI 的嚴格判定） */
  async verifyConnectivity(): Promise<boolean> {
    if (!this.online) return false;
    return this.deps.ping();
  }

  /** 解除瀏覽器 online／offline 監聽並停止後續通知。 */
  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }
}

/** 瀏覽器真埠（SSR＝恆 online、no-op 訂閱——伺服端不出離線 UI） */
export function browserOnlineDeps(): OnlineStatusDeps {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      isOnline: () => true,
      subscribe: () => () => undefined,
      ping: () => Promise.resolve(true),
    };
  }
  return {
    isOnline: () => navigator.onLine,
    subscribe: (handler) => {
      const onOnline = (): void => handler(true);
      const onOffline = (): void => handler(false);
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      return () => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      };
    },
    ping: async () => {
      // 目標＝/version.json（同源必在、SW network-only 不吃快取）——靜態部署無 /api
      try {
        await fetch(new URL('version.json', document.baseURI), {
          method: 'HEAD',
          cache: 'no-cache',
          signal: AbortSignal.timeout(3000),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
