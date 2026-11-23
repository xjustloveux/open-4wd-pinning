/**
 * DMCA 六端點的 HTTP 綁定層（案卷提交到 admin 裁決的完整流程）：
 *   POST /api/dmca/notice                          公開，受 per-IP 速率與 payload 上限保護
 *   GET  /api/dmca/notice/:id[?token=]              公開；帶 token 時先嘗試 confirmEmail 再回狀態
 *   POST /api/dmca/counter-notice                   公開，同上兩道防濫用關卡
 *   GET  /api/dmca/transparency                     公開
 *   GET  /api/dmca/admin/notices[?status=&cursor=&limit=] admin，Bearer 驗證、安全摘要分頁
 *   GET  /api/dmca/admin/notices/:id                 admin，Bearer 驗證、完整案卷 DTO
 *   POST /api/dmca/admin/notice/:id/decision         admin，Bearer 驗證
 *   GET  /admin/docs、/admin/assets/*                 選配 self-host Swagger（固定資產白名單）
 *
 * 表單的 email 確認連結是一次性 GET（email 用戶端多半只可靠支援點擊 GET 連結），沒有獨立
 * 掛出第七個端點：notice 與 counter-notice 共用同一個 store／同一組 _id，query token 存在時
 * 一律先嘗試對它做 confirmEmail，語意上仍落在「查詢／確認這筆案卷狀態」之內，六端點數不變。
 *
 * mountDmcaRoutes 只認得上述 API 與明示啟用的 Swagger 路徑；其它請求完全不動 res（不寫入、
 * 不 end），讓呼叫端
 * 可以另外掛其他 handler 共用同一個 server——但同一顆 raw http.Server 上多個 'request'
 * listener 之間彼此不知道對方有沒有處理過請求，若呼叫端自己的 handler 對「六端點以外的路徑」
 * 也一律回應，兩邊都可能對同一個 request 寫入而衝突；本檔在動手前一律先檢查
 * res.headersSent，盡量降低這類共存風險；若這裡註冊的 handler 真的被同時掛成兩個獨立的
 * 'request' listener，這個風險仍無法完全消除——這是 raw http.Server 多重 listener 組合
 * 的固有限制。實際作法是把本檔註冊的 handler 整包擷取成單一函式，交由唯一真正掛上 server
 * 的那一方以直接呼叫的方式委派執行，而不是另外疊掛第二個 listener；如此全程只有一個
 * listener 在監聽，也統一由那一方對六端點以外的路徑兜底 404。
 */
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { checkFixedWindowRate, type RateWindow } from './rate-limit';
import { dmcaOpenApiDocument } from './openapi';
import type { DmcaInboxCrypto } from './signed-inbox';
import {
  DmcaInvalidActionError,
  DmcaInvalidCounterNoticeError,
  DmcaInvalidHoldEvidenceError,
  DmcaInvalidOperatorError,
  DmcaInvalidReasonError,
  DmcaInvalidTransitionError,
  DmcaNotFoundError,
  type DmcaService,
} from './service';
import type {
  CounterNoticeSubmissionV1,
  DmcaAdminAction,
  DmcaNoticeStatus,
  DMCANotice,
  LitigationHoldEvidence,
} from './types';

/**
 * mountDmcaRoutes 接受的最小 server 介面——結構上與 node:http.Server 相容（只需要
 * on('request', ...)）；刻意不要求完整 http.Server 型別，讓測試可以用同構的假物件替換，
 * 也不強制依賴任何特定框架。
 */
export interface MountableServer {
  on(event: 'request', listener: (req: IncomingMessage, res: ServerResponse) => void): void;
}

// DMCA 表單是純文字內容（無附件），256 KiB 已相當寬裕；純本模組自訂上限，未依賴任何外部常數。
const MAX_BODY_BYTES = 262_144;
const MAX_INBOX_BODY_BYTES = 65_536;
// 每 IP 每分鐘至多 5 次公開 POST（notice／counter-notice 合計同一個桶）；防灌信同時不擋正常使用者。
const RATE_LIMIT_PER_MIN = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

const SWAGGER_UI_DIST_DIR = dirname(
  createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'),
);
const SWAGGER_ASSETS: Readonly<Record<string, { readonly file: string; readonly type: string }>> = {
  '/admin/assets/swagger-ui.css': { file: 'swagger-ui.css', type: 'text/css; charset=utf-8' },
  '/admin/assets/swagger-ui-bundle.js': {
    file: 'swagger-ui-bundle.js',
    type: 'text/javascript; charset=utf-8',
  },
};
const ADMIN_DOCS_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join('; ');
const ADMIN_DOCS_HTML = `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Open4WD DMCA Admin API</title>
    <link rel="stylesheet" href="/admin/assets/swagger-ui.css">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/admin/assets/swagger-ui-bundle.js"></script>
    <script src="/admin/assets/swagger-initializer.js"></script>
  </body>
</html>`;
const ADMIN_DOCS_INITIALIZER = `window.ui = SwaggerUIBundle({
  url: '/api/dmca/openapi.json',
  dom_id: '#swagger-ui',
  deepLinking: true,
  persistAuthorization: false,
  validatorUrl: null,
  presets: [SwaggerUIBundle.presets.apis],
  layout: 'BaseLayout'
});\n`;

const ADMIN_ACTIONS: ReadonlySet<string> = new Set([
  'take_down',
  'reject',
  'restore',
  'hold',
  'release_hold',
]);
const DMCA_STATUSES: ReadonlySet<string> = new Set([
  'pending-email-confirm',
  'pending-identity-review',
  'received',
  'taken_down',
  'rejected_by_admin',
  'restored_after_counter',
]);
function isDmcaAdminAction(x: unknown): x is DmcaAdminAction {
  return typeof x === 'string' && ADMIN_ACTIONS.has(x);
}

class PayloadTooLargeError extends Error {}
class InvalidJsonError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function sendAdminDocsText(
  res: ServerResponse,
  type: string,
  body: string,
  cacheControl: string,
): void {
  if (res.headersSent) return;
  res.writeHead(200, {
    'cache-control': cacheControl,
    'content-security-policy': ADMIN_DOCS_CSP,
    'content-type': type,
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function handleAdminDocs(path: string, res: ServerResponse): Promise<void> {
  if (path === '/admin/docs') {
    sendAdminDocsText(res, 'text/html; charset=utf-8', ADMIN_DOCS_HTML, 'no-store');
    return;
  }
  if (path === '/admin/assets/swagger-initializer.js') {
    sendAdminDocsText(res, 'text/javascript; charset=utf-8', ADMIN_DOCS_INITIALIZER, 'no-store');
    return;
  }
  const asset = SWAGGER_ASSETS[path];
  if (asset === undefined) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const bytes = await readFile(join(SWAGGER_UI_DIST_DIR, asset.file));
  if (res.headersSent) return;
  res.writeHead(200, {
    'cache-control': 'public, max-age=86400, immutable',
    'content-length': bytes.byteLength,
    'content-security-policy': ADMIN_DOCS_CSP,
    'content-type': asset.type,
    'x-content-type-options': 'nosniff',
  });
  res.end(bytes);
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

// admin token 比對改用 constant-time：字元逐一比對的 `===` 會依「第幾個字元不同」提早結束、
// 讓耗時隨錯誤前綴長度洩露資訊，給時序攻擊可乘之機。timingSafeEqual 要求兩個 buffer 長度
// 相同、長度不同會直接拋例外——故先做長度守門，長度不同本身已經足夠判定不相等，不需要
// （也不能）餵給 timingSafeEqual。
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// notice／counter-notice 兩支公開 POST 共用：client 自己填的 ipAddress／userAgent 完全不可信
// （照抄一個假位址就能偽造來源，汙染 repeat-infringer／濫用追查證據），一律在呼叫 service 之前
// 用伺服器實際觀測到的連線資訊覆寫同名欄位。counter-notice 目前的 DMCACounterNotice 型別未收
// 這兩欄，這裡仍統一覆寫是防禦性作法：擋掉 client 塞入偽造鍵值後被原樣序列化進 payload、未來
// 若被誤當「已驗證的伺服器觀測值」讀取的風險。
function withServerObservedContact(
  req: IncomingMessage,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...body,
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'],
  };
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        // 刻意不呼叫 req.destroy()：req 與 res 共用同一條底層 socket，直接 destroy 會連
        // 還沒送出的 413 回應一起打斷（client 只會看到連線中斷，收不到狀態碼）。這裡只
        // 停止累積後續 chunk（記憶體不會無界成長），讓呼叫端能把 413 正常寫回去；剩餘的
        // request body 由 Node 在背景自然讀完丟棄。
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new InvalidJsonError());
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** 將公開與營運者 DMCA 路由掛載至共用 HTTP 請求分派器。 */
export function mountDmcaRoutes(
  server: MountableServer,
  service: DmcaService,
  adminToken: string,
  adminOperatorId = 'self-hosted-admin',
  trustCloudflareAccessIdentity = false,
  adminDocsEnabled = false,
  inboxCrypto?: DmcaInboxCrypto,
): void {
  const rateWindows = new Map<string, RateWindow>();

  const checkPublicRate = (req: IncomingMessage): boolean => {
    const ip = clientIp(req);
    const result = checkFixedWindowRate(
      rateWindows.get(ip),
      Date.now(),
      RATE_LIMIT_PER_MIN,
      RATE_LIMIT_WINDOW_MS,
    );
    rateWindows.set(ip, result.window);
    return result.allowed;
  };

  const checkAdmin = (req: IncomingMessage): 'ok' | 'missing' | 'invalid' => {
    const header = req.headers.authorization;
    const prefix = 'Bearer ';
    if (header === undefined || !header.startsWith(prefix)) return 'missing';
    const provided = header.slice(prefix.length);
    return constantTimeEquals(provided, adminToken) ? 'ok' : 'invalid';
  };

  const operatorId = (req: IncomingMessage): string => {
    if (!trustCloudflareAccessIdentity) return adminOperatorId;
    const email = req.headers['cf-access-authenticated-user-email'];
    if (typeof email !== 'string') return adminOperatorId;
    const normalized = email.trim().toLowerCase();
    return normalized !== '' && normalized.length <= 193 ? `access:${normalized}` : adminOperatorId;
  };

  const handlePublicPost = async (
    req: IncomingMessage,
    res: ServerResponse,
    onBody: (body: Record<string, unknown>) => Promise<void>,
  ): Promise<void> => {
    if (!checkPublicRate(req)) {
      sendJson(res, 429, { error: 'rate_limited' });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: 'payload_too_large' });
        return;
      }
      if (err instanceof InvalidJsonError) {
        sendJson(res, 400, { error: 'invalid_json' });
        return;
      }
      throw err;
    }
    if (typeof body !== 'object' || body === null) {
      sendJson(res, 400, { error: 'invalid_body' });
      return;
    }
    await onBody(body as Record<string, unknown>);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (adminDocsEnabled && path.startsWith('/admin/')) {
      if (method !== 'GET') {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      await handleAdminDocs(path, res);
      return;
    }

    if (method === 'POST' && path === '/api/dmca/notice') {
      await handlePublicPost(req, res, async (body) => {
        const result = await service.submitNotice(
          withServerObservedContact(req, body) as unknown as DMCANotice,
        );
        sendJson(res, 200, result);
      });
      return;
    }

    if (method === 'POST' && path === '/api/dmca/inbox') {
      if (inboxCrypto === undefined) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      if (!checkPublicRate(req)) {
        sendJson(res, 429, { error: 'rate_limited' });
        return;
      }
      try {
        const raw = await readJsonBody(req, MAX_INBOX_BODY_BYTES);
        const requester = inboxCrypto.verifyRequest(raw);
        if (requester === null) {
          sendJson(res, 401, { error: 'invalid_signature' });
          return;
        }
        const generatedAt = Date.now();
        const entries = await service.uploaderInbox(requester.subjectPeerId);
        sendJson(
          res,
          200,
          await inboxCrypto.signResponse({
            type: 'open4wd-provider-dmca-inbox',
            providerId: inboxCrypto.providerId,
            subjectPeerId: requester.subjectPeerId,
            generatedAt,
            entries,
          }),
        );
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: 'payload_too_large' });
          return;
        }
        if (err instanceof InvalidJsonError) {
          sendJson(res, 400, { error: 'invalid_json' });
          return;
        }
        throw err;
      }
      return;
    }

    const noticePrefix = '/api/dmca/notice/';
    if (method === 'GET' && path.startsWith(noticePrefix)) {
      const id = path.slice(noticePrefix.length);
      if (id === '' || id.includes('/')) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      const token = url.searchParams.get('token');
      if (token !== null) {
        // 一次性確認連結：token 無效／已用過就靜默忽略，不影響下面照常回報狀態。
        await service.confirmEmail(token).catch(() => undefined);
      }
      const record = await service.getNotice(id);
      if (record === undefined) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, {
        id: record._id,
        type: record.type,
        status: record.status,
        waitingPeriodEndDate: record.waitingPeriodEndDate,
      });
      return;
    }

    if (method === 'POST' && path === '/api/dmca/counter-notice') {
      await handlePublicPost(req, res, async (body) => {
        try {
          let verifiedSigner: string | undefined;
          if (body['mode'] === 'signed-uploader') {
            const signed = inboxCrypto?.verifySignedRequest(body['signed']);
            if (signed === null || signed === undefined) {
              sendJson(res, 401, { error: 'invalid_signature' });
              return;
            }
            verifiedSigner = signed.signer;
          }
          const result = await service.submitCounter(
            body as unknown as CounterNoticeSubmissionV1,
            verifiedSigner,
          );
          sendJson(res, 200, result);
        } catch (err) {
          if (err instanceof DmcaNotFoundError) {
            sendJson(res, 404, { error: 'not_found' });
            return;
          }
          if (err instanceof DmcaInvalidCounterNoticeError) {
            sendJson(res, 400, { error: 'invalid_body' });
            return;
          }
          throw err;
        }
      });
      return;
    }

    if (method === 'GET' && path === '/api/dmca/transparency') {
      sendJson(res, 200, await service.transparency());
      return;
    }

    if (method === 'GET' && path === '/api/dmca/openapi.json') {
      sendJson(res, 200, dmcaOpenApiDocument());
      return;
    }

    if (method === 'GET' && path === '/api/dmca/admin/notices') {
      const auth = checkAdmin(req);
      if (auth === 'missing') {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (auth === 'invalid') {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      const status = url.searchParams.get('status');
      if (status !== null && !DMCA_STATUSES.has(status)) {
        sendJson(res, 400, { error: 'invalid_status' });
        return;
      }
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? 25 : Number.parseInt(limitRaw, 10);
      if (
        !Number.isInteger(limit) ||
        String(limit) !== (limitRaw ?? '25') ||
        limit < 1 ||
        limit > 100
      ) {
        sendJson(res, 400, { error: 'invalid_limit' });
        return;
      }
      sendJson(
        res,
        200,
        await service.adminList({
          status: (status ?? undefined) as DmcaNoticeStatus | undefined,
          cursor: url.searchParams.get('cursor') ?? undefined,
          limit,
        }),
      );
      return;
    }

    const adminDetailPrefix = '/api/dmca/admin/notices/';
    if (method === 'GET' && path.startsWith(adminDetailPrefix)) {
      const auth = checkAdmin(req);
      if (auth === 'missing') {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (auth === 'invalid') {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      const id = path.slice(adminDetailPrefix.length);
      if (id === '' || id.includes('/')) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      const detail = await service.adminGet(id);
      sendJson(res, detail === undefined ? 404 : 200, detail ?? { error: 'not_found' });
      return;
    }

    const decisionPrefix = '/api/dmca/admin/notice/';
    const decisionSuffix = '/decision';
    if (method === 'POST' && path.startsWith(decisionPrefix) && path.endsWith(decisionSuffix)) {
      const auth = checkAdmin(req);
      if (auth === 'missing') {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (auth === 'invalid') {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      const id = path.slice(decisionPrefix.length, path.length - decisionSuffix.length);
      if (id === '' || id.includes('/')) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      try {
        const rawBody = await readJsonBody(req, MAX_BODY_BYTES);
        const body = (rawBody ?? {}) as {
          action?: unknown;
          reason?: unknown;
          evidence?: unknown;
        };
        const keys = Object.keys(body);
        const expectedKeys = body.action === 'hold' ? 3 : 2;
        if (
          !isDmcaAdminAction(body.action) ||
          typeof body.reason !== 'string' ||
          keys.length !== expectedKeys ||
          !keys.every((key) => ['action', 'reason', 'evidence'].includes(key))
        ) {
          sendJson(res, 400, { error: 'invalid_body' });
          return;
        }
        const record = await service.adminDecide(
          id,
          body.action,
          body.reason,
          operatorId(req),
          body.evidence as LitigationHoldEvidence | undefined,
        );
        sendJson(res, 200, await service.adminGet(record._id));
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: 'payload_too_large' });
          return;
        }
        if (err instanceof InvalidJsonError) {
          sendJson(res, 400, { error: 'invalid_json' });
          return;
        }
        if (err instanceof DmcaNotFoundError) {
          sendJson(res, 404, { error: 'not_found' });
          return;
        }
        if (err instanceof DmcaInvalidActionError) {
          sendJson(res, 400, { error: 'invalid_action' });
          return;
        }
        if (
          err instanceof DmcaInvalidReasonError ||
          err instanceof DmcaInvalidOperatorError ||
          err instanceof DmcaInvalidHoldEvidenceError
        ) {
          sendJson(res, 400, { error: 'invalid_body' });
          return;
        }
        if (err instanceof DmcaInvalidTransitionError) {
          sendJson(res, 409, { error: 'invalid_transition' });
          return;
        }
        throw err;
      }
      return;
    }

    const identityPrefix = '/api/dmca/admin/counter-notice/';
    const identitySuffix = '/identity-decision';
    if (method === 'POST' && path.startsWith(identityPrefix) && path.endsWith(identitySuffix)) {
      const auth = checkAdmin(req);
      if (auth === 'missing') {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (auth === 'invalid') {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      const id = path.slice(identityPrefix.length, path.length - identitySuffix.length);
      if (id === '' || id.includes('/')) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      try {
        const rawBody = await readJsonBody(req, MAX_BODY_BYTES);
        if (typeof rawBody !== 'object' || rawBody === null) {
          sendJson(res, 400, { error: 'invalid_body' });
          return;
        }
        const body = rawBody as Record<string, unknown>;
        if (
          Object.keys(body).length !== 2 ||
          !['accept', 'reject'].includes(String(body['action'])) ||
          typeof body['reason'] !== 'string'
        ) {
          sendJson(res, 400, { error: 'invalid_body' });
          return;
        }
        const record = await service.adminIdentityDecide(
          id,
          body['action'] as 'accept' | 'reject',
          body['reason'],
          operatorId(req),
        );
        sendJson(res, 200, await service.adminGet(record._id));
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: 'payload_too_large' });
          return;
        }
        if (err instanceof InvalidJsonError || err instanceof DmcaInvalidReasonError) {
          sendJson(res, 400, { error: 'invalid_body' });
          return;
        }
        if (err instanceof DmcaNotFoundError) {
          sendJson(res, 404, { error: 'not_found' });
          return;
        }
        if (err instanceof DmcaInvalidTransitionError) {
          sendJson(res, 409, { error: 'invalid_transition' });
          return;
        }
        throw err;
      }
      return;
    }

    // 六端點之外一律不處理——完全不動 res，見檔頭說明。
  };

  server.on('request', (req, res) => {
    void handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: 'internal_error' });
      console.error('[dmca/routes] 未預期錯誤', err);
    });
  });
}
