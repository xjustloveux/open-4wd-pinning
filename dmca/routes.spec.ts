import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSignedMessage, publicKeyToPeerId, verifySignedPayload, type PeerId } from '../core';
import {
  cleanupAll,
  confirmedNotice,
  makeService,
  validCounter,
  validNotice,
} from './dmca.test-support';
import { mountDmcaRoutes } from './routes';
import { createDmcaInboxCrypto, decodeSignedInboxWire, type DmcaInboxCrypto } from './signed-inbox';
import type { DmcaService } from './service';
import type { DMCANotice } from './types';

afterEach(async () => {
  await cleanupAll();
});

const ADMIN_TOKEN = 'secret-admin-token';

/** 建一顆完全不掛任何其他 handler 的 http.Server，路由全交給 mountDmcaRoutes，避免與其他
 * request listener 互相搶著回應同一個請求（見 routes.ts 檔頭關於多重 listener 共存的說明）。 */
function buildServer(svc: DmcaService, inboxCrypto?: DmcaInboxCrypto): Server {
  const server = createServer();
  mountDmcaRoutes(
    server,
    svc,
    ADMIN_TOKEN,
    'access:operator@example.org',
    false,
    false,
    inboxCrypto,
  );
  return server;
}

function buildAccessTrustedServer(svc: DmcaService): Server {
  const server = createServer();
  mountDmcaRoutes(server, svc, ADMIN_TOKEN, 'self-hosted-admin', true);
  return server;
}

function buildAdminDocsServer(svc: DmcaService): Server {
  const server = createServer();
  mountDmcaRoutes(server, svc, ADMIN_TOKEN, 'self-hosted-admin', false, true);
  return server;
}

async function listen(server: Server): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('DMCA routes', () => {
  it('POST inbox 要求 requester 驗簽並回 provider-signed 最小通知', async () => {
    const { svc, executor } = await makeService();
    const providerKey = await generateKeyPair('Ed25519');
    const providerId = publicKeyToPeerId(providerKey.publicKey.raw) as PeerId;
    const requesterKey = await generateKeyPair('Ed25519');
    const requesterId = publicKeyToPeerId(requesterKey.publicKey.raw) as PeerId;
    executor.uploaderPeerIds.set('cid-inbox', requesterId);
    await confirmedNotice(svc, ['cid-inbox'], 'untrusted-form-peer');
    const inboxCrypto = createDmcaInboxCrypto({
      providerId,
      now: () => Date.now(),
      randomNonce: () => randomBytes(16),
      sign: (message) => Promise.resolve(providerKey.sign(message)),
    });
    const payload = {
      type: 'open4wd-provider-dmca-inbox-request' as const,
      providerId,
      subjectPeerId: requesterId,
    };
    const timestamp = Date.now();
    const nonce = randomBytes(16);
    const signature = await requesterKey.sign(
      buildSignedMessage(payload, timestamp, nonce, requesterId),
    );
    const { port, close } = await listen(buildServer(svc, inboxCrypto));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dmca/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload,
          timestamp,
          nonceHex: Buffer.from(nonce).toString('hex'),
          signer: requesterId,
          signatureHex: Buffer.from(signature).toString('hex'),
        }),
        signal: AbortSignal.timeout(1_000),
      });
      expect(res.status).toBe(200);
      const raw: unknown = await res.json();
      const signed = decodeSignedInboxWire(raw);
      expect(signed?.signer).toBe(providerId);
      expect(signed === null ? false : verifySignedPayload(signed)).toBe(true);
      expect(JSON.stringify(raw)).toContain('cid-inbox');
      expect(JSON.stringify(raw)).not.toContain('claimant@example.org');
      expect(JSON.stringify(raw)).not.toContain('untrusted-form-peer');
    } finally {
      await close();
    }
  });

  it('反通知驗證完整 payload 簽章、freshness 與 nonce replay，manual 則進人工覆核', async () => {
    const { svc, executor } = await makeService();
    const providerKey = await generateKeyPair('Ed25519');
    const providerId = publicKeyToPeerId(providerKey.publicKey.raw) as PeerId;
    const requesterKey = await generateKeyPair('Ed25519');
    const requesterId = publicKeyToPeerId(requesterKey.publicKey.raw) as PeerId;
    executor.uploaderPeerIds.set('cid-counter-route', requesterId);
    const noticeId = await confirmedNotice(svc, ['cid-counter-route']);
    const now = Date.now();
    const inboxCrypto = createDmcaInboxCrypto({
      providerId,
      now: () => now,
      randomNonce: () => randomBytes(16),
      sign: (message) => Promise.resolve(providerKey.sign(message)),
    });
    const payload = validCounter(noticeId, ['cid-counter-route']);
    const makeWire = async (timestamp: number, nonce: Uint8Array) => ({
      payload,
      timestamp,
      nonceHex: Buffer.from(nonce).toString('hex'),
      signer: requesterId,
      signatureHex: Buffer.from(
        await requesterKey.sign(buildSignedMessage(payload, timestamp, nonce, requesterId)),
      ).toString('hex'),
    });
    const nonce = randomBytes(16);
    const wire = await makeWire(now, nonce);
    const { port, close } = await listen(buildServer(svc, inboxCrypto));
    try {
      const submit = (body: unknown) =>
        fetch(`http://127.0.0.1:${port}/api/dmca/counter-notice`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const accepted = await submit({ mode: 'signed-uploader', signed: wire });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({
        status: 'received',
        identityStatus: 'verified-uploader-signature',
      });
      expect((await submit({ mode: 'signed-uploader', signed: wire })).status).toBe(401);
      const staleWire = await makeWire(now - 6 * 60_000, randomBytes(16));
      expect((await submit({ mode: 'signed-uploader', signed: staleWire })).status).toBe(401);
      const manual = await submit({ mode: 'manual-review', payload });
      expect(manual.status).toBe(200);
      expect(await manual.json()).toMatchObject({
        status: 'pending-identity-review',
        identityStatus: 'pending-identity-review',
      });
    } finally {
      await close();
    }
  });

  it('啟用時以本機資產提供 Swagger，且不持久化或預載 Admin token', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildAdminDocsServer(svc));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/docs`, {
        signal: AbortSignal.timeout(2_000),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      const html = await res.text();
      expect(html).toContain('/admin/assets/swagger-ui.css');
      expect(html).toContain('/admin/assets/swagger-ui-bundle.js');
      expect(html).toContain('/admin/assets/swagger-initializer.js');
      expect(html).not.toMatch(/https?:\/\//);
      expect(html).not.toContain(ADMIN_TOKEN);

      const initializer = await fetch(
        `http://127.0.0.1:${port}/admin/assets/swagger-initializer.js`,
      );
      expect(initializer.status).toBe(200);
      const script = await initializer.text();
      expect(script).toContain("url: '/api/dmca/openapi.json'");
      expect(script).toContain('persistAuthorization: false');
      expect(script).toContain('validatorUrl: null');
      expect(script).not.toContain('preauthorizeApiKey');
      expect(script).not.toContain(ADMIN_TOKEN);
    } finally {
      await close();
    }
  });

  it('Swagger 靜態資產只允許明確清單，不接受任意路徑', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildAdminDocsServer(svc));
    try {
      const css = await fetch(`http://127.0.0.1:${port}/admin/assets/swagger-ui.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get('content-type')).toContain('text/css');
      expect((await css.text()).length).toBeGreaterThan(1_000);

      const unknown = await fetch(`http://127.0.0.1:${port}/admin/assets/../package.json`);
      expect(unknown.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('GET /api/dmca/openapi.json 提供可供 Swagger/Postman 匯入的契約', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildServer(svc));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dmca/openapi.json`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ openapi: '3.1.0' });
    } finally {
      await close();
    }
  });

  it('admin 端點缺 Authorization header → 401', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildServer(svc));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dmca/admin/notices`);
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('admin 端點 token 錯誤 → 403', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildServer(svc));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dmca/admin/notices`, {
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(403);
    } finally {
      await close();
    }
  });

  it('admin 端點帶正確 Bearer token → 200', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildServer(svc));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dmca/admin/notices`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ cases: [] });
    } finally {
      await close();
    }
  });

  it('admin 清單拒絕無效 status／limit，避免無界或不明確查詢', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildServer(svc));
    try {
      for (const query of ['status=unknown', 'limit=0', 'limit=101']) {
        const res = await fetch(`http://127.0.0.1:${port}/api/dmca/admin/notices?${query}`, {
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        expect(res.status).toBe(400);
      }
    } finally {
      await close();
    }
  });

  it('admin 詳情使用獨立受保護端點，且不洩漏一次性確認 token', async () => {
    const { svc } = await makeService();
    const { noticeId } = await svc.submitNotice(validNotice('detail@example.org'));
    const { port, close } = await listen(buildServer(svc));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dmca/admin/notices/${noticeId}`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).toContain('detail@example.org');
      expect(raw).not.toContain('confirmToken');
    } finally {
      await close();
    }
  });

  it('只有明確信任 Access/Tunnel 時才採用 Cloudflare 注入的操作者身分', async () => {
    const { svc, mail } = await makeService();
    const { noticeId } = await svc.submitNotice(validNotice());
    await svc.confirmEmail(mail.lastConfirmToken());
    const { port, close } = await listen(buildAccessTrustedServer(svc));
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/dmca/admin/notice/${noticeId}/decision`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            'content-type': 'application/json',
            'cf-access-authenticated-user-email': 'operator@example.org',
          },
          body: JSON.stringify({ action: 'restore', reason: 'erroneous notice reversal' }),
        },
      );
      expect(res.status).toBe(200);
      expect((await svc.getNotice(noticeId))?.decisionLog.at(-1)?.operatorId).toBe(
        'access:operator@example.org',
      );
    } finally {
      await close();
    }
  });

  it('GET /api/dmca/transparency → 200', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildServer(svc));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dmca/transparency`);
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ notices: 0, removed: 0 });
    } finally {
      await close();
    }
  });

  it('公開 POST 超過 payload 上限 → 413', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildServer(svc));
    try {
      const oversized = 'x'.repeat(300_000);
      const res = await fetch(`http://127.0.0.1:${port}/api/dmca/notice`, {
        method: 'POST',
        body: oversized,
      });
      expect(res.status).toBe(413);
    } finally {
      await close();
    }
  });

  it('公開 POST 逾 per-IP 速率上限 → 429（前 5 次照常受理、第 6 次才擋）', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildServer(svc));
    try {
      const body = JSON.stringify(validNotice());
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/api/dmca/notice`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses[5]).toBe(429);
    } finally {
      await close();
    }
  });

  it('POST /api/dmca/notice 成功受理，回傳 pending-email-confirm', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildServer(svc));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dmca/notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validNotice()),
      });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({
        status: 'pending-email-confirm',
        estimatedProcessingTimeHours: 48,
      });
    } finally {
      await close();
    }
  });

  it('GET /api/dmca/notice/:id 帶 token 觸發確認並自動轉為 taken_down', async () => {
    const { svc, mail } = await makeService();
    const { port, close } = await listen(buildServer(svc));
    try {
      const submitRes = await fetch(`http://127.0.0.1:${port}/api/dmca/notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validNotice()),
      });
      const { noticeId } = (await submitRes.json()) as { noticeId: string };
      const token = mail.lastConfirmToken();

      const res = await fetch(
        `http://127.0.0.1:${port}/api/dmca/notice/${noticeId}?token=${token}`,
      );
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ id: noticeId, status: 'taken_down' });
    } finally {
      await close();
    }
  });

  it('GET /api/dmca/notice/:id 查無案卷 → 404', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildServer(svc));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dmca/notice/does-not-exist`);
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('POST /api/dmca/notice：client 偽填 ipAddress／userAgent 會被伺服器觀測值覆寫', async () => {
    const { svc } = await makeService();
    const { port, close } = await listen(buildServer(svc));
    try {
      const spoofed = { ...validNotice(), ipAddress: '198.51.100.1', userAgent: 'spoofed-agent' };
      const res = await fetch(`http://127.0.0.1:${port}/api/dmca/notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(spoofed),
      });
      expect(res.status).toBe(200);
      const { noticeId } = (await res.json()) as { noticeId: string };
      const record = await svc.getNotice(noticeId);
      const payload = record?.payload as DMCANotice;
      // store 落的必須是伺服器觀測值，不是 client 偽填的假值。
      expect(payload.ipAddress).not.toBe('198.51.100.1');
      expect(payload.userAgent).not.toBe('spoofed-agent');
      expect(payload.ipAddress).toBeDefined();
    } finally {
      await close();
    }
  });
});
