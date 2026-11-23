import { connect } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as raw from 'multiformats/codecs/raw';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiServer, PinResourceLimitError, type PinExecutor } from './server';
import { makeSigner, signedPin, signedUnpin, stubDeps } from './api.test-support';

let base = '';
let deps: ReturnType<typeof stubDeps>;
let server: Awaited<ReturnType<typeof createApiServer>>;

beforeAll(async () => {
  deps = stubDeps();
  server = createApiServer(deps);
  base = `http://127.0.0.1:${await server.ready}`;
});
afterAll(() => server.close());

describe('管理 API', () => {
  it.each([
    ['成功回應', '/provider', 200],
    ['錯誤回應', '/not-found', 404],
  ] as const)('%s 套用 canonical pinning security headers', async (_name, path, status) => {
    const response = await fetch(`${base}${path}`);

    expect(response.status).toBe(status);
    expect(Object.fromEntries(response.headers.entries())).toMatchObject({
      'content-security-policy':
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'geolocation=(), microphone=(), camera=()',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
  });

  it('GET /stats 回 quota admission 可觀測欄位', async () => {
    const body = (await (await fetch(`${base}/stats`)).json()) as Record<string, unknown>;
    for (const k of [
      'node_id',
      'version',
      'uptime',
      'total_pinned_count',
      'total_size_bytes',
      'available_space_bytes',
      'ipfs_cluster_peers',
      'last_sync_timestamp',
      'accepting_pins',
      'quota_used_bytes',
      'quota_limit_bytes',
    ])
      expect(body).toHaveProperty(k);
  });

  it('GET /provider 公開正交能力，DMCA disabled 不影響 UGC', async () => {
    const response = await fetch(`${base}/provider`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schema_version: 1,
      provider_id: 'test-node',
      capabilities: {
        ugc_read: {
          enabled: true,
          content_profile: {
            id: 'open4wd-unixfs-1m-balanced-v1',
            root_codecs: ['raw', 'dag-pb'],
            multihash: 'sha2-256',
            chunk_bytes: 1_048_576,
            max_logical_bytes: 83_886_080,
            max_blocks: 81,
          },
          retrieval: {
            root_scoped_block_api: true,
            path_template: '/api/ugc/{rootCid}/blocks/{blockCid}',
            car_v1: false,
            cors: 'operator-allowlist',
          },
        },
        ugc_write: { enabled: true, authorization: 'operator-policy' },
        legal_notice: { enabled: false },
        counter_notice: { enabled: false },
        transparency: { enabled: false },
      },
      declarations: {
        designated_agent_registration: 'not-declared',
        safe_harbor_eligibility: 'not-asserted',
      },
      policies: {},
    });
  });

  it('UGC write disabled 只拒絕 /pin，仍允許 /unpin 清理', async () => {
    const localDeps = stubDeps({
      config: {
        provider: {
          ugcReadEnabled: true,
          ugcWriteEnabled: false,
          legalNoticeEnabled: false,
          counterNoticeEnabled: false,
          transparencyEnabled: false,
          designatedAgentRegistration: 'not-declared',
        },
      },
    });
    const localServer = createApiServer(localDeps);
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      const pin = await fetch(`${localBase}/pin`, {
        method: 'POST',
        body: JSON.stringify(await signedPin(localDeps.whitelisted, 'bafyDisabled')),
      });
      const unpin = await fetch(`${localBase}/unpin`, {
        method: 'POST',
        body: JSON.stringify(await signedUnpin(localDeps.whitelisted, 'bafyDisabled')),
      });

      expect(pin.status).toBe(403);
      await expect(pin.json()).resolves.toEqual({ error: 'CAPABILITY_DISABLED' });
      expect(unpin.status).toBe(200);
    } finally {
      await localServer.close();
    }
  });

  it('POST /pin：合法簽章＋白名單＝200 且 cluster 收到 metadata（signer/source=api）', async () => {
    const res = await fetch(`${base}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(deps.whitelisted, 'bafyOK')),
    });
    expect(res.status).toBe(200);
    expect(deps.cluster.pinned[0]).toMatchObject({
      cid: 'bafyOK',
      meta: {
        source: 'api',
        signer: deps.whitelisted.peerId,
        logicalSizeBytes: 1024,
        physicalSizeBytes: 1024,
      },
    });
    expect(deps.quota.recordPinCalls.at(-1)).toMatchObject({
      cid: 'bafyOK',
      meta: { logicalSizeBytes: 1024, physicalSizeBytes: 1024 },
    });
  });

  it('未授權 signer＝403 NOT_AUTHORIZED；黑名單 CID＝403 BLACKLISTED；壞簽章＝403 SIG_INVALID', async () => {
    expect(
      (
        await fetch(`${base}/pin`, {
          method: 'POST',
          body: JSON.stringify(await signedPin(deps.stranger, 'bafyOK')),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/pin`, {
          method: 'POST',
          body: JSON.stringify(await signedPin(deps.whitelisted, deps.blacklistedCid)),
        })
      ).status,
    ).toBe(403);
    const bad = await signedPin(deps.whitelisted, 'bafyOK');
    (bad as { signatureHex: string }).signatureHex = '00'.repeat(64);
    expect((await fetch(`${base}/pin`, { method: 'POST', body: JSON.stringify(bad) })).status).toBe(
      403,
    );
  });

  it('超配額＝507；body 超 1 MiB＝413；每 IP 逾率＝429', async () => {
    deps.quota.nextVerdict = { allowed: false, reason: 'global-size' };
    expect(
      (
        await fetch(`${base}/pin`, {
          method: 'POST',
          body: JSON.stringify(await signedPin(deps.whitelisted, 'bafyOK')),
        })
      ).status,
    ).toBe(507);
    expect(
      (await fetch(`${base}/pin`, { method: 'POST', body: 'x'.repeat(1_048_577) })).status,
    ).toBe(413);
  });

  it('GET /list 不再公開，回 404 且不得列舉 cluster inventory', async () => {
    const listCallsBefore = deps.cluster.listCalls;
    const response = await fetch(`${base}/list`);

    await expect(response.json()).resolves.toEqual({ error: 'NOT_FOUND' });
    expect(response.status).toBe(404);
    expect(deps.cluster.listCalls).toBe(listCallsBefore);
  });
});

describe('root-scoped UGC retrieval', () => {
  async function fixture(label: string): Promise<{ cid: string; bytes: Uint8Array }> {
    const bytes = new TextEncoder().encode(label);
    return { cid: CID.createV1(raw.code, await sha256.digest(bytes)).toString(), bytes };
  }

  it('只有啟用 read、合法 root traversal membership 且未被 deny 的 block 能讀取', async () => {
    const root = await fixture('root block');
    const child = await fixture('child block');
    const outsider = await fixture('other root block');
    const baseDeps = stubDeps();
    const blockGet = vi.fn(async (cid: string) => {
      if (cid === root.cid) return root.bytes;
      if (cid === child.cid) return child.bytes;
      throw new Error('missing');
    });
    const localDeps = {
      ...baseDeps,
      quota: {
        ...baseDeps.quota,
        hasRootBlock: (rootCid: string, blockCid: string) =>
          rootCid === root.cid && (blockCid === root.cid || blockCid === child.cid),
      },
      kubo: { ...baseDeps.kubo, blockGet },
    };
    const localServer = createApiServer(localDeps);
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      const allowed = await fetch(`${localBase}/api/ugc/${root.cid}/blocks/${child.cid}`);
      expect(allowed.status).toBe(200);
      expect(new Uint8Array(await allowed.arrayBuffer())).toEqual(child.bytes);

      expect((await fetch(`${localBase}/api/ugc/${outsider.cid}/blocks/${child.cid}`)).status).toBe(
        404,
      );
      expect((await fetch(`${localBase}/api/ugc/${root.cid}/blocks/${outsider.cid}`)).status).toBe(
        404,
      );
      expect(blockGet).toHaveBeenCalledTimes(1);
    } finally {
      await localServer.close();
    }
  });

  it('ugc_read disabled、blacklisted root、無效 CID 與 Kubo miss 都 fail closed', async () => {
    const root = await fixture('disabled root');
    const disabledDeps = stubDeps({
      config: {
        provider: {
          ugcReadEnabled: false,
          ugcWriteEnabled: true,
          legalNoticeEnabled: false,
          counterNoticeEnabled: false,
          transparencyEnabled: false,
          designatedAgentRegistration: 'not-declared',
        },
      },
    });
    const localServer = createApiServer({
      ...disabledDeps,
      quota: { ...disabledDeps.quota, hasRootBlock: () => true },
      kubo: {
        ...disabledDeps.kubo,
        blockGet: async () => {
          throw new Error('missing');
        },
      },
    });
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      expect((await fetch(`${localBase}/api/ugc/${root.cid}/blocks/${root.cid}`)).status).toBe(403);
    } finally {
      await localServer.close();
    }

    const enabledBase = stubDeps();
    const enabledServer = createApiServer({
      ...enabledBase,
      denyList: { isBlacklisted: (cid) => cid === root.cid },
      quota: { ...enabledBase.quota, hasRootBlock: () => true },
      kubo: {
        ...enabledBase.kubo,
        blockGet: async () => {
          throw new Error('missing');
        },
      },
    });
    const enabledUrl = `http://127.0.0.1:${await enabledServer.ready}`;
    try {
      expect((await fetch(`${enabledUrl}/api/ugc/not-a-cid/blocks/${root.cid}`)).status).toBe(400);
      expect((await fetch(`${enabledUrl}/api/ugc/${root.cid}/blocks/${root.cid}`)).status).toBe(
        404,
      );

      const other = await fixture('not blacklisted');
      expect((await fetch(`${enabledUrl}/api/ugc/${other.cid}/blocks/${other.cid}`)).status).toBe(
        404,
      );
    } finally {
      await enabledServer.close();
    }
  });
});

describe('管理 API metrics', () => {
  it('在 response finish 後以封閉 route/status class 記錄，不攜帶 CID 或 IP', async () => {
    const recordApi = vi.fn();
    const localServer = createApiServer({
      ...stubDeps(),
      metrics: {
        recordApi,
        recordDmcaSweep: vi.fn(),
        recordDmcaDelivery: vi.fn(),
        recordCluster: vi.fn(),
        setCapacity: vi.fn(),
        render: () => '',
      },
    });
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      expect((await fetch(`${localBase}/stats`)).status).toBe(200);
      expect((await fetch(`${localBase}/unknown`)).status).toBe(404);
      expect(recordApi).toHaveBeenCalledWith('stats', '2xx', expect.any(Number));
      expect(recordApi).toHaveBeenCalledWith('not_found', '4xx', expect.any(Number));
    } finally {
      await localServer.close();
    }
  });
});

// 以下為補充測試，涵蓋上面『管理 API』區塊沒有測到、但屬於本模組行為契約一部分的情境
// （429 邊界、逾時 504、unpin 授權規則、連線層硬化）。每一組各自起獨立的 server／stubDeps
// 實例，避免與上面共用同一顆 server 的『管理 API』區塊互相汙染限流狀態或 nonce 快取。

describe('POST /pin：每 IP 速率限制（token bucket 邊界，HTTP 層 wiring 驗證）', () => {
  // 邊界案用 refillPerSec 0：第三次請求必為 429，不再依賴三次 HTTP 請求合計在一次補充間隔內完成
  // （server 以真實時鐘補充；補充計算本身已由 rate-limit.spec 以注入的 now 決定性覆蓋）。
  let edgeDeps: ReturnType<typeof stubDeps>;
  let edgeServer: Awaited<ReturnType<typeof createApiServer>>;
  let edgeBase = '';
  // 恢復案用 capacity 1、refillPerSec 50：等得夠久後必可再通過，runner 停頓只會讓它更成立。
  let refillDeps: ReturnType<typeof stubDeps>;
  let refillServer: Awaited<ReturnType<typeof createApiServer>>;
  let refillBase = '';

  beforeAll(async () => {
    edgeDeps = stubDeps({ config: { rateLimit: { capacity: 2, refillPerSec: 0 } } });
    edgeServer = createApiServer(edgeDeps);
    edgeBase = `http://127.0.0.1:${await edgeServer.ready}`;
    refillDeps = stubDeps({ config: { rateLimit: { capacity: 1, refillPerSec: 50 } } });
    refillServer = createApiServer(refillDeps);
    refillBase = `http://127.0.0.1:${await refillServer.ready}`;
  });
  afterAll(async () => {
    await edgeServer.close();
    await refillServer.close();
  });

  it('容量耗盡後再打一次＝429，且不隨請求耗時改變', async () => {
    const s1 = await fetch(`${edgeBase}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(edgeDeps.whitelisted, 'bafyRate1')),
    });
    const s2 = await fetch(`${edgeBase}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(edgeDeps.whitelisted, 'bafyRate2')),
    });
    const s3 = await fetch(`${edgeBase}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(edgeDeps.whitelisted, 'bafyRate3')),
    });
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(s3.status).toBe(429);
  });

  it('耗盡後等待補充再打可過', async () => {
    const s1 = await fetch(`${refillBase}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(refillDeps.whitelisted, 'bafyRate4')),
    });
    expect(s1.status).toBe(200);
    // refillPerSec=50 → 每 20 毫秒補一顆；等 100 毫秒必補回至少一顆（桶上限 1）。
    await new Promise((resolve) => setTimeout(resolve, 100));
    const s2 = await fetch(`${refillBase}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(refillDeps.whitelisted, 'bafyRate5')),
    });
    expect(s2.status).toBe(200);
  });
});

describe('限流順序：rate limit 在 body 解析前執行', () => {
  let localDeps: ReturnType<typeof stubDeps>;
  let localServer: Awaited<ReturnType<typeof createApiServer>>;
  let localBase = '';

  beforeAll(async () => {
    localDeps = stubDeps({ config: { rateLimit: { capacity: 1, refillPerSec: 0 } } });
    localServer = createApiServer(localDeps);
    localBase = `http://127.0.0.1:${await localServer.ready}`;
  });
  afterAll(() => localServer.close());

  it('耗盡唯一 token 後，即使 body 超過 1 MiB 上限也回 429（而非 413）——證明限流先於 body 讀取', async () => {
    const first = await fetch(`${localBase}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(localDeps.whitelisted, 'bafyBudget')),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${localBase}/pin`, {
      method: 'POST',
      body: 'x'.repeat(1_048_577),
    });
    expect(second.status).toBe(429);
  });
});

describe('驗章後 per-signer 限流與實量配額複查', () => {
  it('同一 signer 即使 IP 桶尚有額度仍被自己的桶限制，不影響另一 signer', async () => {
    const signerA = makeSigner(31);
    const signerB = makeSigner(32);
    const localDeps = stubDeps({
      config: {
        auth: { authorizedSigners: [signerA.peerId, signerB.peerId] },
        rateLimit: { capacity: 100, refillPerSec: 100 },
        signerRateLimit: { capacity: 1, refillPerSec: 0 },
      },
    });
    const localServer = createApiServer(localDeps);
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      expect(
        (
          await fetch(`${localBase}/pin`, {
            method: 'POST',
            body: JSON.stringify(await signedPin(signerA, 'bafySignerA1')),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${localBase}/pin`, {
            method: 'POST',
            body: JSON.stringify(await signedPin(signerA, 'bafySignerA2')),
          })
        ).status,
      ).toBe(429);
      // pin 與 unpin 分桶：pin flood 不得阻止同一身分自清內容。
      expect(
        (
          await fetch(`${localBase}/unpin`, {
            method: 'POST',
            body: JSON.stringify(await signedUnpin(signerA, 'bafySignerA1')),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${localBase}/pin`, {
            method: 'POST',
            body: JSON.stringify(await signedPin(signerB, 'bafySignerB1')),
          })
        ).status,
      ).toBe(200);
    } finally {
      await localServer.close();
    }
  });

  it('executor 回報超過 signed reservation 的實量時不 cluster.pin，並釋放 reservation', async () => {
    const overReporter: PinExecutor = {
      async preparePin({ sizeHintBytes }) {
        return {
          logicalSizeBytes: sizeHintBytes + 1,
          newPhysicalSizeBytes: sizeHintBytes + 1,
          blocks: [{ cid: 'over-reported', sizeBytes: sizeHintBytes + 1 }],
        };
      },
      unpin: () => Promise.resolve(),
    };
    const localDeps = stubDeps({ pinExecutor: overReporter });
    const localServer = createApiServer(localDeps);
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      const response = await fetch(`${localBase}/pin`, {
        method: 'POST',
        body: JSON.stringify(
          await signedPin(localDeps.whitelisted, 'bafyMeasuredTooLarge', { sizeHintBytes: 10 }),
        ),
      });
      expect(response.status).toBe(507);
      expect(localDeps.cluster.pinned).toEqual([]);
      expect(localDeps.quota.activeReservations).toBe(0);
    } finally {
      await localServer.close();
    }
  });

  it('結構／bytes 硬上限有獨立 413，不誤報成網路逾時', async () => {
    const limited: PinExecutor = {
      async preparePin() {
        throw new PinResourceLimitError('maxBytes');
      },
      unpin: () => Promise.resolve(),
    };
    const localDeps = stubDeps({ pinExecutor: limited });
    const localServer = createApiServer(localDeps);
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      const response = await fetch(`${localBase}/pin`, {
        method: 'POST',
        body: JSON.stringify(await signedPin(localDeps.whitelisted, 'bafyLimit')),
      });
      expect(response.status).toBe(413);
      expect(localDeps.quota.activeReservations).toBe(0);
    } finally {
      await localServer.close();
    }
  });
});

describe('POST /pin：body 恰為 1 MiB 不觸發 413（邊界另一側）', () => {
  let localDeps: ReturnType<typeof stubDeps>;
  let localServer: Awaited<ReturnType<typeof createApiServer>>;
  let localBase = '';

  beforeAll(async () => {
    localDeps = stubDeps();
    localServer = createApiServer(localDeps);
    localBase = `http://127.0.0.1:${await localServer.ready}`;
  });
  afterAll(() => localServer.close());

  it('恰好 1_048_576 bytes（非合法 JSON）不是 413，而是走到 JSON 解析失敗＝403 SIG_INVALID', async () => {
    const res = await fetch(`${localBase}/pin`, { method: 'POST', body: 'x'.repeat(1_048_576) });
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(403);
  });
});

describe('pinExecutor 逾時：整筆失敗回 504、不記入配額（不半 pin）', () => {
  it('逾時＝504 且 quota.recordPin 未被呼叫', async () => {
    const hangingExecutor: PinExecutor = {
      // 永不 resolve/reject，模擬 DAG 從 mesh 抓不齊而卡住——刻意的空 executor。
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      preparePin: () => new Promise(() => {}),
      // 本案不會呼叫到 unpin，僅為滿足 PinExecutor 介面形。
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      unpin: async () => {},
    };
    const localDeps = stubDeps({ config: { pinTimeoutMs: 30 }, pinExecutor: hangingExecutor });
    const localServer = createApiServer(localDeps);
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      const res = await fetch(`${localBase}/pin`, {
        method: 'POST',
        body: JSON.stringify(await signedPin(localDeps.whitelisted, 'bafyTimeout')),
      });
      expect(res.status).toBe(504);
      expect(localDeps.quota.recordPinCalls).toEqual([]);
      expect(localDeps.quota.activeReservations).toBe(0);
    } finally {
      await localServer.close();
    }
  });
});

describe('POST /pin：repeat-infringer 一票否決（403 REPEAT_INFRINGER，且不影響 unpin）', () => {
  const infringer = makeSigner(9);
  let localDeps: ReturnType<typeof stubDeps>;
  let localServer: Awaited<ReturnType<typeof createApiServer>>;
  let localBase = '';

  beforeAll(async () => {
    localDeps = stubDeps({
      config: { auth: { authorizedSigners: [infringer.peerId] } },
      authDeps: {
        reputationOf: () => undefined,
        isRepeatInfringer: (signer) => signer === infringer.peerId,
      },
    });
    localServer = createApiServer(localDeps);
    localBase = `http://127.0.0.1:${await localServer.ready}`;
  });
  afterAll(() => localServer.close());

  it('pin 被一票否決＝403 REPEAT_INFRINGER', async () => {
    const res = await fetch(`${localBase}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(infringer, 'bafyInfringer')),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'REPEAT_INFRINGER' });
  });

  it('unpin 不受 repeat-infringer 否決影響（白名單身分本身即可 unpin）', async () => {
    const res = await fetch(`${localBase}/unpin`, {
      method: 'POST',
      body: JSON.stringify(await signedUnpin(infringer, 'bafySomethingElse')),
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /unpin：只有原 signer 或白名單成員可 unpin', () => {
  const admin = makeSigner(10); // 白名單成員
  const selfServicer = makeSigner(11); // 非白名單，靠信譽門檻可以 pin，但只能 unpin 自己 pin 過的
  const outsider = makeSigner(12); // 與這筆 CID 完全無關的第三人
  let localDeps: ReturnType<typeof stubDeps>;
  let localServer: Awaited<ReturnType<typeof createApiServer>>;
  let localBase = '';

  beforeAll(async () => {
    localDeps = stubDeps({
      config: { auth: { authorizedSigners: [admin.peerId], reputationThreshold: 500 } },
      authDeps: {
        reputationOf: (signer) => (signer === selfServicer.peerId ? 600 : undefined),
        isRepeatInfringer: () => false,
      },
    });
    localServer = createApiServer(localDeps);
    localBase = `http://127.0.0.1:${await localServer.ready}`;
    // selfServicer 走完整 /pin 流程建立自己的一筆 pin（真實授權路徑：信譽達標，非白名單）。
    const pinRes = await fetch(`${localBase}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(selfServicer, 'bafyOwnedBySelfServicer')),
    });
    expect(pinRes.status).toBe(200);
  });
  afterAll(() => localServer.close());

  it('原 signer 本人可以 unpin 自己 pin 過的 CID', async () => {
    const res = await fetch(`${localBase}/unpin`, {
      method: 'POST',
      body: JSON.stringify(await signedUnpin(selfServicer, 'bafyOwnedBySelfServicer')),
    });
    expect(res.status).toBe(200);
    expect(localDeps.cluster.unpinned).toContain('bafyOwnedBySelfServicer');
  });

  it('非原 signer、非白名單的第三人不可 unpin＝403 NOT_AUTHORIZED（且未真的 unpin）', async () => {
    await fetch(`${localBase}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(selfServicer, 'bafyOwnedBySelfServicer2')),
    });
    const res = await fetch(`${localBase}/unpin`, {
      method: 'POST',
      body: JSON.stringify(await signedUnpin(outsider, 'bafyOwnedBySelfServicer2')),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'NOT_AUTHORIZED' });
    expect(localDeps.cluster.pinned.some((p) => p.cid === 'bafyOwnedBySelfServicer2')).toBe(true);
  });

  it('白名單成員可以 unpin 任何人的 CID（即使不是原 signer）', async () => {
    const res = await fetch(`${localBase}/unpin`, {
      method: 'POST',
      body: JSON.stringify(await signedUnpin(admin, 'bafyOwnedBySelfServicer2')),
    });
    expect(res.status).toBe(200);
  });
});

// 以下兩組覆蓋兩項授權面防護：re-pin 不得移轉既有 CID 的 signer 歸屬（防 unpin 授權
// 奪取），以及 unpin 的授權判定不得在授權成立前觸發整份 pinset 掃描。

describe('POST /pin：re-pin 不得移轉既有 CID 的 signer 歸屬（防 unpin 授權奪取，見 findPinRecord）', () => {
  const victim = makeSigner(20);
  const attacker = makeSigner(21); // 非白名單，但信譽達標——具備真正的 pin 資格，不是靠簽章硬闖
  let localDeps: ReturnType<typeof stubDeps>;
  let localServer: Awaited<ReturnType<typeof createApiServer>>;
  let localBase = '';

  beforeAll(async () => {
    localDeps = stubDeps({
      config: { auth: { authorizedSigners: [], reputationThreshold: 500 } },
      authDeps: {
        reputationOf: (signer) =>
          signer === victim.peerId || signer === attacker.peerId ? 600 : undefined,
        isRepeatInfringer: () => false,
      },
    });
    localServer = createApiServer(localDeps);
    localBase = `http://127.0.0.1:${await localServer.ready}`;
    const pinRes = await fetch(`${localBase}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(victim, 'bafyVictimOwned')),
    });
    expect(pinRes.status).toBe(200);
  });
  afterAll(() => localServer.close());

  it('(a) 攻擊者對受害者已 pin 的 CID re-pin：200 冪等回應，但 metadata 仍為受害者，攻擊者無法 unpin', async () => {
    const repinRes = await fetch(`${localBase}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(attacker, 'bafyVictimOwned')),
    });
    expect(repinRes.status).toBe(200); // 冪等成功——但沒有真的奪取
    expect(localDeps.cluster.pinned.find((p) => p.cid === 'bafyVictimOwned')).toMatchObject({
      meta: { signer: victim.peerId },
    });
    // 只有受害者最初那次 pin 記過帳，攻擊者的 re-pin 沒有再記一次（不讓重複 pin 灌配額帳）。
    expect(localDeps.quota.recordPinCalls.filter((r) => r.cid === 'bafyVictimOwned')).toHaveLength(
      1,
    );
    // re-pin 的所有權查詢走單筆查詢，不掃整份 pinset（與 /unpin 的授權判定共用同一個機制）。
    expect(localDeps.cluster.listCalls).toBe(0);

    const unpinRes = await fetch(`${localBase}/unpin`, {
      method: 'POST',
      body: JSON.stringify(await signedUnpin(attacker, 'bafyVictimOwned')),
    });
    expect(unpinRes.status).toBe(403);
    expect(await unpinRes.json()).toMatchObject({ error: 'NOT_AUTHORIZED' });
  });

  it('(b) 受害者在攻擊者 re-pin 嘗試後仍能 unpin 自己的 CID', async () => {
    const unpinRes = await fetch(`${localBase}/unpin`, {
      method: 'POST',
      body: JSON.stringify(await signedUnpin(victim, 'bafyVictimOwned')),
    });
    expect(unpinRes.status).toBe(200);
    expect(localDeps.cluster.unpinned).toContain('bafyVictimOwned');
  });
});

describe('POST /unpin：source=auto 的系統 pin 不因 re-pin 變成 api pin，只有白名單能動它', () => {
  const admin = makeSigner(22);
  const attacker = makeSigner(23); // 信譽達標，具備 pin 資格，但不是白名單
  let localDeps: ReturnType<typeof stubDeps>;
  let localServer: Awaited<ReturnType<typeof createApiServer>>;
  let localBase = '';

  beforeAll(async () => {
    localDeps = stubDeps({
      config: { auth: { authorizedSigners: [admin.peerId], reputationThreshold: 500 } },
      authDeps: {
        reputationOf: (signer) => (signer === attacker.peerId ? 600 : undefined),
        isRepeatInfringer: () => false,
      },
    });
    // 系統性 pin（例如 checkpoint）：直接種進 stub cluster，不經過 /pin——那是給玩家用的
    // 路徑，系統性 pin 由 reconcile 之類的內部流程直接對 cluster 下 pin，本測試只需要它
    //「已經存在」這個前提。
    localDeps.cluster.pinned.push({
      cid: 'bafyAutoCheckpoint',
      meta: { category: 'checkpoint', source: 'auto' },
    });
    localServer = createApiServer(localDeps);
    localBase = `http://127.0.0.1:${await localServer.ready}`;
  });
  afterAll(() => localServer.close());

  it('(c) 攻擊者 re-pin 系統性 pin 不會改變它的記錄，攻擊者仍無法 unpin＝403', async () => {
    const repinRes = await fetch(`${localBase}/pin`, {
      method: 'POST',
      body: JSON.stringify(await signedPin(attacker, 'bafyAutoCheckpoint')),
    });
    expect(repinRes.status).toBe(200); // 冪等成功
    expect(localDeps.cluster.pinned.find((p) => p.cid === 'bafyAutoCheckpoint')).toMatchObject({
      meta: { source: 'auto' },
    });

    const unpinRes = await fetch(`${localBase}/unpin`, {
      method: 'POST',
      body: JSON.stringify(await signedUnpin(attacker, 'bafyAutoCheckpoint')),
    });
    expect(unpinRes.status).toBe(403);
    expect(await unpinRes.json()).toMatchObject({ error: 'NOT_AUTHORIZED' });
  });

  it('(d) 白名單成員可以 unpin 系統性 pin', async () => {
    const unpinRes = await fetch(`${localBase}/unpin`, {
      method: 'POST',
      body: JSON.stringify(await signedUnpin(admin, 'bafyAutoCheckpoint')),
    });
    expect(unpinRes.status).toBe(200);
  });
});

describe('POST /unpin：授權判定不得在授權成立前觸發整份 pinset 掃描（DoS 放大防護）', () => {
  const admin = makeSigner(24); // 白名單成員
  const stranger = makeSigner(25); // 簽章合法，但既非白名單、對這個 CID 也非原 signer

  // 每個 it() 各自建立獨立的 localDeps／localServer（不共用 beforeAll）：listCalls／
  // getCalls 是整顆 stub cluster 累計的計數器，若兩個 it() 共用同一個 cluster 實例，前一個
  // 案例呼叫過 get() 的次數會殘留污染到下一個案例的斷言，讓斷言值取決於執行順序。

  it('非白名單、非原 signer 者 unpin 被拒：授權判定只呼叫單 CID 查詢一次，從未呼叫 list()', async () => {
    const localDeps = stubDeps({ config: { auth: { authorizedSigners: [admin.peerId] } } });
    localDeps.cluster.pinned.push({
      cid: 'bafySomeoneElseOwns',
      meta: { category: 'part', signer: 'someone-else', source: 'api' },
    });
    const localServer = createApiServer(localDeps);
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      const res = await fetch(`${localBase}/unpin`, {
        method: 'POST',
        body: JSON.stringify(await signedUnpin(stranger, 'bafySomeoneElseOwns')),
      });
      expect(res.status).toBe(403);
      expect(localDeps.cluster.listCalls).toBe(0);
      expect(localDeps.cluster.getCalls).toBe(1);
    } finally {
      await localServer.close();
    }
  });

  it('白名單者 unpin：完全不觸碰 cluster 的查詢方法（短路——白名單資格本身已足夠授權）', async () => {
    const localDeps = stubDeps({ config: { auth: { authorizedSigners: [admin.peerId] } } });
    localDeps.cluster.pinned.push({
      cid: 'bafySomeoneElseOwns',
      meta: { category: 'part', signer: 'someone-else', source: 'api' },
    });
    const localServer = createApiServer(localDeps);
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      const res = await fetch(`${localBase}/unpin`, {
        method: 'POST',
        body: JSON.stringify(await signedUnpin(admin, 'bafySomeoneElseOwns')),
      });
      expect(res.status).toBe(200);
      expect(localDeps.cluster.listCalls).toBe(0);
      expect(localDeps.cluster.getCalls).toBe(0);
    } finally {
      await localServer.close();
    }
  });
});

// 以下涵蓋 /api/dmca/* 命名空間的單一 dispatcher 委派（防止早退不寫 res 造成連線懸置）：
// 未注入 dmcaHandler 時回 404 並正常關閉；注入時委派給該處理器全權回應，且非 dmca 路徑
// 不受影響、不觸發委派。

describe('/api/dmca/* 委派：未注入 dmcaHandler（DMCA 關閉）＝404 且不懸置連線', () => {
  let localDeps: ReturnType<typeof stubDeps>;
  let localServer: Awaited<ReturnType<typeof createApiServer>>;
  let localBase = '';

  beforeAll(async () => {
    localDeps = stubDeps();
    localServer = createApiServer(localDeps);
    localBase = `http://127.0.0.1:${await localServer.ready}`;
  });
  afterAll(() => localServer.close());

  it('GET /api/dmca/notice/xyz＝404（回應正常送達，不 hang）', async () => {
    // 若仍是舊的「早退不寫 res」行為，這個 fetch 會一直等到逾時；能正常拿到回應即證明已修。
    const res = await fetch(`${localBase}/api/dmca/notice/xyz`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('POST /api/dmca/notice＝404（同樣正常關閉連線）', async () => {
    const res = await fetch(`${localBase}/api/dmca/notice`, {
      method: 'POST',
      body: JSON.stringify({ any: 'thing' }),
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(404);
  });
});

describe('/api/dmca/* 委派：注入 dmcaHandler（DMCA 開啟）＝委派給它全權回應', () => {
  const dmcaPaths: string[] = [];
  let localServer: Awaited<ReturnType<typeof createApiServer>>;
  let localBase = '';

  beforeAll(async () => {
    const dmcaHandler = (req: IncomingMessage, res: ServerResponse): void => {
      dmcaPaths.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ delegated: true, path: req.url }));
    };
    localServer = createApiServer({
      ...stubDeps({
        config: {
          provider: {
            ugcReadEnabled: true,
            ugcWriteEnabled: true,
            legalNoticeEnabled: true,
            counterNoticeEnabled: true,
            transparencyEnabled: true,
            designatedAgentRegistration: 'not-declared',
          },
        },
      }),
      dmcaHandler,
    });
    localBase = `http://127.0.0.1:${await localServer.ready}`;
  });
  afterAll(() => localServer.close());

  it('/api/dmca/* 交給注入的 handler 回應', async () => {
    const res = await fetch(`${localBase}/api/dmca/transparency`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.json()).toMatchObject({ delegated: true, path: '/api/dmca/transparency' });
    expect(dmcaPaths).toContain('/api/dmca/transparency');
  });

  it('非 dmca 路徑不觸發委派、照走本 server 路由（/stats 仍由 api 回）', async () => {
    const before = dmcaPaths.length;
    const res = await fetch(`${localBase}/stats`);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('node_id');
    expect(dmcaPaths.length).toBe(before); // 委派未被呼叫
  });

  it('透明度 capability 可關閉且不影響其他 DMCA 路由', async () => {
    const seen: string[] = [];
    const dmcaHandler = (req: IncomingMessage, res: ServerResponse): void => {
      seen.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{}');
    };
    const server = createApiServer({ ...stubDeps(), dmcaHandler });
    const base = `http://127.0.0.1:${await server.ready}`;
    try {
      expect((await fetch(`${base}/api/dmca/transparency`)).status).toBe(404);
      expect((await fetch(`${base}/api/dmca/notice/example`)).status).toBe(200);
      expect(seen).toEqual(['/api/dmca/notice/example']);
    } finally {
      await server.close();
    }
  });
});

describe('/admin Swagger 委派：必須另外明示啟用', () => {
  it('只有 dmcaAdminDocsEnabled=true 才把 /admin/docs 交給 DMCA handler', async () => {
    const seen: string[] = [];
    const dmcaHandler = (req: IncomingMessage, res: ServerResponse): void => {
      seen.push(req.url ?? '');
      res.writeHead(200, {
        'content-security-policy': "default-src 'self'",
        'content-type': 'text/html; charset=utf-8',
      });
      res.end('<!doctype html><title>DMCA Admin</title>');
    };

    const disabled = createApiServer({ ...stubDeps(), dmcaHandler });
    const disabledBase = `http://127.0.0.1:${await disabled.ready}`;
    try {
      const res = await fetch(`${disabledBase}/admin/docs`);
      expect(res.status).toBe(404);
      expect(seen).toEqual([]);
    } finally {
      await disabled.close();
    }

    const enabled = createApiServer({
      ...stubDeps(),
      dmcaHandler,
      dmcaAdminDocsEnabled: true,
    });
    const enabledBase = `http://127.0.0.1:${await enabled.ready}`;
    try {
      const res = await fetch(`${enabledBase}/admin/docs`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).toContain('DMCA Admin');
      expect(seen).toEqual(['/admin/docs']);
    } finally {
      await enabled.close();
    }
  });
});

describe('連線層硬化：用戶端中途斷線不得讓伺服器崩潰（socket error handler 置頂）', () => {
  let localDeps: ReturnType<typeof stubDeps>;
  let localServer: Awaited<ReturnType<typeof createApiServer>>;
  let localBase = '';
  let localPort = 0;

  beforeAll(async () => {
    localDeps = stubDeps();
    localServer = createApiServer(localDeps);
    localPort = await localServer.ready;
    localBase = `http://127.0.0.1:${localPort}`;
  });
  afterAll(() => localServer.close());

  it('送出 headers 後立刻摧毀連線，伺服器仍存活並可正常處理後續請求', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(localPort, '127.0.0.1', () => {
        socket.write('POST /pin HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1000000\r\n\r\n');
        socket.destroy();
        resolve();
      });
      socket.on('error', reject);
    });

    // 給伺服器一點時間處理這個連線中斷事件
    await new Promise((resolve) => setTimeout(resolve, 100));

    const res = await fetch(`${localBase}/stats`);
    expect(res.status).toBe(200);
  });
});

describe('瀏覽器跨來源 CORS：明示 allowlist、preflight 與安全預設', () => {
  const trustedOrigin = 'https://play.open4wd.org';

  function corsDeps(origins?: readonly string[]): ReturnType<typeof stubDeps> {
    const localDeps = stubDeps();
    if (origins !== undefined) {
      Object.assign(localDeps.config, { corsAllowedOrigins: origins });
    }
    return localDeps;
  }

  it('可信 origin 的 POST preflight 回 204，明示單一 origin、GET/POST 方法與 content-type header', async () => {
    const localServer = createApiServer(corsDeps([trustedOrigin]));
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      const res = await fetch(`${localBase}/pin`, {
        method: 'OPTIONS',
        headers: {
          origin: trustedOrigin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(trustedOrigin);
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST');
      expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
      expect(res.headers.get('vary')).toContain('Origin');
    } finally {
      await localServer.close();
    }
  });

  it('可信 origin 的 GET 與 POST 實際回應都帶 ACAO；不啟用 credentials', async () => {
    const localDeps = corsDeps([trustedOrigin]);
    const localServer = createApiServer(localDeps);
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      const getRes = await fetch(`${localBase}/stats`, {
        headers: { origin: trustedOrigin },
      });
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get('access-control-allow-origin')).toBe(trustedOrigin);
      expect(getRes.headers.get('access-control-allow-credentials')).toBeNull();

      const postRes = await fetch(`${localBase}/pin`, {
        method: 'POST',
        headers: { origin: trustedOrigin, 'content-type': 'application/json' },
        body: JSON.stringify(await signedPin(localDeps.whitelisted, 'bafyCors')),
      });
      expect(postRes.status).toBe(200);
      expect(postRes.headers.get('access-control-allow-origin')).toBe(trustedOrigin);
      expect(postRes.headers.get('access-control-allow-credentials')).toBeNull();
    } finally {
      await localServer.close();
    }
  });

  it('未列入 allowlist 的 origin preflight fail-closed，且不回 ACAO', async () => {
    const localServer = createApiServer(corsDeps([trustedOrigin]));
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      const res = await fetch(`${localBase}/pin`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://attacker.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('vary')).toContain('Origin');
    } finally {
      await localServer.close();
    }
  });

  it('空 allowlist 預設不開放跨來源；沒有 Origin 的同源請求維持正常', async () => {
    const localServer = createApiServer(corsDeps());
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      const crossOrigin = await fetch(`${localBase}/stats`, {
        headers: { origin: trustedOrigin },
      });
      expect(crossOrigin.status).toBe(200);
      expect(crossOrigin.headers.get('access-control-allow-origin')).toBeNull();

      const sameOrigin = await fetch(`${localBase}/stats`);
      expect(sameOrigin.status).toBe(200);
      expect(await sameOrigin.json()).toHaveProperty('node_id');
    } finally {
      await localServer.close();
    }
  });

  it('preflight 不消耗 API token bucket 配額', async () => {
    const localDeps = corsDeps([trustedOrigin]);
    Object.assign(localDeps.config, { rateLimit: { capacity: 1, refillPerSec: 0 } });
    const localServer = createApiServer(localDeps);
    const localBase = `http://127.0.0.1:${await localServer.ready}`;
    try {
      const preflight = await fetch(`${localBase}/stats`, {
        method: 'OPTIONS',
        headers: {
          origin: trustedOrigin,
          'access-control-request-method': 'GET',
        },
      });
      expect(preflight.status).toBe(204);

      const actual = await fetch(`${localBase}/stats`, {
        headers: { origin: trustedOrigin },
      });
      expect(actual.status).toBe(200);
    } finally {
      await localServer.close();
    }
  });

  it('直接組裝 ApiConfig 也拒絕 wildcard，不能繞過 loadConfig 開成全網域', () => {
    expect(() => createApiServer(corsDeps(['*']))).toThrow(/corsAllowedOrigins/);
  });

  it.each([
    {
      name: '非 GET/POST 方法',
      headers: {
        origin: trustedOrigin,
        'access-control-request-method': 'DELETE',
      },
    },
    {
      name: '未允許的 authorization header',
      headers: {
        origin: trustedOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      },
    },
  ] satisfies readonly { name: string; headers: Record<string, string> }[])(
    '$name 的 preflight fail-closed',
    async ({ headers }) => {
      const localServer = createApiServer(corsDeps([trustedOrigin]));
      const localBase = `http://127.0.0.1:${await localServer.ready}`;
      try {
        const res = await fetch(`${localBase}/pin`, {
          method: 'OPTIONS',
          headers: headers as Record<string, string>,
        });
        expect(res.status).toBe(403);
        expect(res.headers.get('access-control-allow-origin')).toBe(trustedOrigin);
      } finally {
        await localServer.close();
      }
    },
  );
});
