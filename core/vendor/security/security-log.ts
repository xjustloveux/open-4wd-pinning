/**
 * 本地安全事件記錄 — 環形上限 500、只存本機不上傳（玩家隱私）；設定頁可查看／匯出
 */
import type { Unsubscribe } from '@open4wd/interfaces';

/** 經允許清單與遮罩後可留存在本機的安全事件。 */
export interface SecurityEvent {
  type: 'sanitize-fail' | 'sig-verify-fail' | 'pin-attempt' | 'session-expired' | 'csp-violation';
  timestamp: number;
  details: Record<string, unknown>;
}

function shortString(value: unknown, max = 96): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function redactedUri(value: unknown): string | null {
  const text = shortString(value, 2_048);
  if (text === null) return null;
  try {
    const url = new URL(text);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ? url.origin : url.protocol;
  } catch {
    return /^[a-z-]{1,64}$/i.test(text) ? text : 'redacted';
  }
}

function redactedDetails(event: SecurityEvent): Record<string, unknown> {
  const reason = shortString(event.details['reason']);
  if (event.type === 'sanitize-fail' || event.type === 'sig-verify-fail')
    return reason === null ? {} : { reason };
  if (event.type === 'pin-attempt') {
    const outcome = shortString(event.details['outcome'], 32);
    return {
      ...(outcome === null ? {} : { outcome }),
      ...(reason === null ? {} : { reason }),
    };
  }
  if (event.type === 'session-expired') return reason === null ? {} : { reason };
  const blockedURI = redactedUri(event.details['blockedURI']);
  const sourceFile = redactedUri(event.details['sourceFile']);
  const violatedDirective = shortString(event.details['violatedDirective'], 64);
  const rawLine = event.details['lineNumber'];
  const lineNumber = Number.isSafeInteger(rawLine) && (rawLine as number) >= 0 ? rawLine : null;
  return {
    ...(blockedURI === null ? {} : { blockedURI }),
    ...(violatedDirective === null ? {} : { violatedDirective }),
    ...(sourceFile === null ? {} : { sourceFile }),
    ...(lineNumber === null ? {} : { lineNumber }),
  };
}

/** 固定容量、僅記憶體保存且匯出前已遮罩的安全日誌。 */
export class LocalSecurityLog {
  /** 限制本機安全事件保留筆數，避免診斷紀錄無界成長。 */
  private static readonly MAX_ENTRIES = 500;
  /** 依發生順序保存、超過容量即移除最舊項目的環形內容。 */
  private readonly events: SecurityEvent[] = [];

  /** 正規化並加入安全事件，超過容量時淘汰最舊紀錄。 */
  log(event: SecurityEvent): void {
    this.events.push({
      type: event.type,
      timestamp: Number.isSafeInteger(event.timestamp) ? event.timestamp : Date.now(),
      details: redactedDetails(event),
    });
    if (this.events.length > LocalSecurityLog.MAX_ENTRIES) this.events.shift();
  }

  /** 依時間由新到舊列出安全事件的不可變快照。 */
  list(): readonly SecurityEvent[] {
    return this.events.map((event) => ({ ...event, details: { ...event.details } }));
  }

  /** 清除全部本機安全事件，不影響其他應用資料。 */
  clear(): void {
    this.events.length = 0;
  }

  /** 將目前安全事件輸出為不含執行期物件的格式化 JSON。 */
  exportJson(): string {
    return JSON.stringify({ version: 1, events: this.list() }, null, 2);
  }
}

/** 瀏覽器 bundle 單一 app-scope local-only 記錄；不接任何遠端 transport。 */
export const APP_SECURITY_LOG = new LocalSecurityLog();

/** 掛 CSP 違規監聽 → 落本地日誌；回傳解除函式 */
export function attachCspViolationListener(
  log: LocalSecurityLog,
  target: EventTarget = document,
): Unsubscribe {
  const handler = (event: Event): void => {
    const violation = event as SecurityPolicyViolationEvent;
    log.log({
      type: 'csp-violation',
      timestamp: Date.now(),
      details: {
        blockedURI: violation.blockedURI,
        violatedDirective: violation.violatedDirective,
        sourceFile: violation.sourceFile,
        lineNumber: violation.lineNumber,
      },
    });
  };
  target.addEventListener('securitypolicyviolation', handler);
  return () => target.removeEventListener('securitypolicyviolation', handler);
}
