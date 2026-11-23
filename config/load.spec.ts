import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, toApiConfig } from './load';

// 每個 yaml fixture 落在獨立暫存目錄，測後清掉——不污染工作區、不同案例之間互不干擾。
const scratchDirs: string[] = [];
afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function writeYaml(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'o4wd-pinning-config-'));
  scratchDirs.push(dir);
  const path = join(dir, 'config.yaml');
  writeFileSync(path, `genesis_timestamp: 1785168000000\n${contents}`, 'utf8');
  return path;
}

// 帳本位址與 genesis time 都是必填 trust roots；其餘案例由這個最小 env 起手。
const minimalEnv: NodeJS.ProcessEnv = {
  LEDGER_DB_ADDRESS: '/orbitdb/zPlaceholder',
  GENESIS_TIMESTAMP: '1785168000000',
};

describe('loadConfig：預設值全形', () => {
  it('只給必填 ledger trust roots 時，其餘全部取預設值', () => {
    const config = loadConfig(minimalEnv);

    expect(config.port).toBe(8000);
    expect(config.dataDir).toBe('./data');
    expect(config.ledgerDbAddress).toBe('/orbitdb/zPlaceholder');
    expect(config.genesisTimestamp).toBe(1785168000000);
    expect(config.listenWs).toEqual(['/ip4/0.0.0.0/tcp/4001/ws']);
    expect(config.bootstrap).toEqual([]);
    expect(config.relayEnabled).toBe(true);
    // 治理 trust root 未設定＝空集（fail-closed：自動 pin 採納閘保持關閉）。
    expect(config.governanceSigners).toEqual([]);
    expect(config.clusterApiUrl).toBe('http://127.0.0.1:9094');
    expect(config.kuboApiUrl).toBe('http://127.0.0.1:5001');
    expect(config.auth.authorizedSigners).toEqual([]);
    expect(config.auth.reputationThreshold).toBeUndefined();
    expect(config.quotas).toEqual({
      perSignerMaxPins: 10000,
      perSignerMaxSizeGb: 50,
      globalMaxSizeTb: 0.0625,
    });
    expect(config.rateLimit).toEqual({ capacity: 20, refillPerSec: 1 });
    expect(config.signerRateLimit).toEqual({ capacity: 20, refillPerSec: 1 });
    expect(config.provider).toEqual({
      ugcReadEnabled: true,
      ugcWriteEnabled: true,
      transparencyEnabled: true,
      designatedAgentRegistration: 'not-declared',
      policies: {},
    });
    expect(config.dmca.enable).toBe(false);
    expect(config.dmca.adminDocsEnabled).toBe(false);
    expect(config.dmca.adminToken).toBeUndefined();
    expect(config.dmca.adminOperatorId).toBe('self-hosted-admin');
    expect(config.dmca.trustCloudflareAccessIdentity).toBe(false);
    expect(config.dmca.smtpUrl).toBeUndefined();
    expect(config.dmca.agentEmail).toBeUndefined();
    expect(config.metrics).toEqual({ enabled: false, host: '127.0.0.1', port: 9464 });
  });
});

describe('loadConfig：env 覆蓋 yaml', () => {
  it('env 有值處以 env 為準；env 缺處退回 yaml；兩者皆缺退預設', () => {
    const yamlPath = writeYaml(
      [
        'port: 9001',
        'data_dir: /var/lib/pinning',
        'ledger_db_address: /orbitdb/zFromYaml',
        'relay_enabled: false',
        'cluster_api_url: http://cluster.yaml:9094',
        'auth:',
        '  authorized_signers: ["12D3KooWyaml"]',
        '  reputation_threshold: 700',
        'quotas:',
        '  per_signer_max_pins: 123',
        '  global_max_size_tb: 9',
        'rate_limit:',
        '  capacity: 50',
        'signer_rate_limit:',
        '  capacity: 7',
      ].join('\n'),
    );

    const config = loadConfig(
      {
        PORT: '9100',
        LEDGER_DB_ADDRESS: '/orbitdb/zFromEnv',
        AUTHORIZED_SIGNERS: '12D3KooWenvA, 12D3KooWenvB',
        QUOTA_PER_SIGNER_MAX_PINS: '456',
        SIGNER_RATE_LIMIT_REFILL_PER_SEC: '3',
      },
      yamlPath,
    );

    // env 覆蓋 yaml
    expect(config.port).toBe(9100);
    expect(config.ledgerDbAddress).toBe('/orbitdb/zFromEnv');
    expect(config.auth.authorizedSigners).toEqual(['12D3KooWenvA', '12D3KooWenvB']);
    expect(config.quotas.perSignerMaxPins).toBe(456);

    // env 缺、yaml 有 → 取 yaml
    expect(config.dataDir).toBe('/var/lib/pinning');
    expect(config.relayEnabled).toBe(false);
    expect(config.clusterApiUrl).toBe('http://cluster.yaml:9094');
    expect(config.auth.reputationThreshold).toBe(700);
    expect(config.quotas.globalMaxSizeTb).toBe(9);
    expect(config.rateLimit.capacity).toBe(50);
    expect(config.signerRateLimit).toEqual({ capacity: 7, refillPerSec: 3 });

    // env 與 yaml 皆缺 → 預設
    expect(config.kuboApiUrl).toBe('http://127.0.0.1:5001');
    expect(config.quotas.perSignerMaxSizeGb).toBe(50);
    expect(config.rateLimit.refillPerSec).toBe(1);
    expect(config.listenWs).toEqual(['/ip4/0.0.0.0/tcp/4001/ws']);
  });

  it('global quota 接受正數小數 TiB，讓小型部署保留 Kubo 與 volume headroom', () => {
    expect(
      loadConfig({ ...minimalEnv, QUOTA_GLOBAL_MAX_SIZE_TB: '0.0625' }).quotas.globalMaxSizeTb,
    ).toBe(0.0625);
  });

  it('yamlPath 指向不存在的檔案時靜默忽略、退回 env＋預設（main 可無條件帶預設路徑）', () => {
    const config = loadConfig(minimalEnv, join(tmpdir(), 'o4wd-does-not-exist-xyz', 'config.yaml'));
    expect(config.port).toBe(8000);
    expect(config.dataDir).toBe('./data');
  });
});

describe('loadConfig：治理 trust root（governance_signers）', () => {
  it('env GOVERNANCE_SIGNERS 逗號分隔、trim 後採用', () => {
    const config = loadConfig({
      ...minimalEnv,
      GOVERNANCE_SIGNERS: '12D3KooWgovA , 12D3KooWgovB ,12D3KooWgovC',
    });
    expect(config.governanceSigners).toEqual(['12D3KooWgovA', '12D3KooWgovB', '12D3KooWgovC']);
  });

  it('env 缺席時退回 yaml governance_signers；env 有值則覆蓋 yaml', () => {
    const yamlPath = writeYaml(
      ['ledger_db_address: /orbitdb/zY', 'governance_signers: ["12D3KooWyamlGov"]'].join('\n'),
    );
    expect(loadConfig({}, yamlPath).governanceSigners).toEqual(['12D3KooWyamlGov']);
    expect(
      loadConfig({ GOVERNANCE_SIGNERS: '12D3KooWenvGov' }, yamlPath).governanceSigners,
    ).toEqual(['12D3KooWenvGov']);
  });

  it('env 全為空白項時退回 yaml／預設（不誤採空字串 signer）', () => {
    expect(loadConfig({ ...minimalEnv, GOVERNANCE_SIGNERS: ' , ,  ' }).governanceSigners).toEqual(
      [],
    );
  });
});

describe('loadConfig：DMCA_ENABLE 嚴格比對 "true"', () => {
  it('env DMCA_ENABLE 恰為字串 "true" 才啟用', () => {
    expect(
      loadConfig({ ...minimalEnv, DMCA_ENABLE: 'true', DMCA_ADMIN_TOKEN: 'secret-token' }).dmca
        .enable,
    ).toBe(true);
    expect(loadConfig({ ...minimalEnv, DMCA_ENABLE: '1' }).dmca.enable).toBe(false);
    expect(loadConfig({ ...minimalEnv, DMCA_ENABLE: 'TRUE' }).dmca.enable).toBe(false);
    expect(loadConfig({ ...minimalEnv, DMCA_ENABLE: 'yes' }).dmca.enable).toBe(false);
    expect(loadConfig({ ...minimalEnv, DMCA_ENABLE: '' }).dmca.enable).toBe(false);
  });

  it('DMCA 附屬欄位（token／smtp／agent）以 env 帶入', () => {
    const config = loadConfig({
      ...minimalEnv,
      DMCA_ENABLE: 'true',
      DMCA_ADMIN_TOKEN: 'secret-token',
      DMCA_ADMIN_DOCS_ENABLE: 'true',
      SMTP_URL: 'smtp://user:pass@mail.example.org:587',
      DMCA_AGENT_EMAIL: 'dmca@example.org',
    });
    expect(config.dmca).toEqual({
      enable: true,
      adminDocsEnabled: true,
      adminToken: 'secret-token',
      adminOperatorId: 'self-hosted-admin',
      trustCloudflareAccessIdentity: false,
      smtpUrl: 'smtp://user:pass@mail.example.org:587',
      agentEmail: 'dmca@example.org',
      deliveryRetryBaseMs: 60_000,
      deliveryRetryMaxMs: 86_400_000,
      businessDayHolidays: [],
    });
  });

  it('DMCA delivery retry 可由 env 設定，無效值退回安全預設', () => {
    expect(
      loadConfig({
        ...minimalEnv,
        DMCA_DELIVERY_RETRY_BASE_MS: '2500',
        DMCA_DELIVERY_RETRY_MAX_MS: '9000',
      }).dmca,
    ).toMatchObject({ deliveryRetryBaseMs: 2500, deliveryRetryMaxMs: 9000 });
    expect(
      loadConfig({
        ...minimalEnv,
        DMCA_DELIVERY_RETRY_BASE_MS: '0',
        DMCA_DELIVERY_RETRY_MAX_MS: 'invalid',
      }).dmca,
    ).toMatchObject({ deliveryRetryBaseMs: 60_000, deliveryRetryMaxMs: 86_400_000 });
  });

  it('DMCA 工作日可明示排除假日', () => {
    expect(
      loadConfig({
        ...minimalEnv,
        DMCA_BUSINESS_DAY_HOLIDAYS: '2026-12-25, 2027-01-01',
      }).dmca.businessDayHolidays,
    ).toEqual(['2026-12-25', '2027-01-01']);
  });

  it('env DMCA_ENABLE 缺席時退回 yaml 的布林值', () => {
    const yamlPath = writeYaml(
      [
        'ledger_db_address: /orbitdb/zY',
        'dmca:',
        '  enable: true',
        '  admin_token: secret-token',
      ].join('\n'),
    );
    expect(loadConfig({}, yamlPath).dmca.enable).toBe(true);
    // env 明確 "false" 覆蓋 yaml 的 true
    expect(loadConfig({ DMCA_ENABLE: 'false' }, yamlPath).dmca.enable).toBe(false);
  });

  it('DMCA 啟用但未設定 DMCA_ADMIN_TOKEN 時拒絕啟動', () => {
    expect(() => loadConfig({ ...minimalEnv, DMCA_ENABLE: 'true' })).toThrow(/DMCA_ADMIN_TOKEN/);
  });

  it('DMCA_ADMIN_DOCS_ENABLE 僅接受嚴格字串 true，預設保持關閉', () => {
    expect(
      loadConfig({ ...minimalEnv, DMCA_ADMIN_DOCS_ENABLE: 'true' }).dmca.adminDocsEnabled,
    ).toBe(true);
    expect(
      loadConfig({ ...minimalEnv, DMCA_ADMIN_DOCS_ENABLE: 'TRUE' }).dmca.adminDocsEnabled,
    ).toBe(false);
  });
});

describe('loadConfig：provider capability 與 DMCA 正交', () => {
  it('UGC read/write 可獨立停用，不受 DMCA_ENABLE 影響', () => {
    const config = loadConfig({
      ...minimalEnv,
      PROVIDER_UGC_READ_ENABLE: 'false',
      PROVIDER_UGC_WRITE_ENABLE: 'true',
      PROVIDER_TRANSPARENCY_ENABLE: 'false',
      DMCA_DESIGNATED_AGENT_REGISTRATION: 'registered',
    });

    expect(config.provider).toEqual({
      ugcReadEnabled: false,
      ugcWriteEnabled: true,
      transparencyEnabled: false,
      designatedAgentRegistration: 'registered',
      policies: {},
    });
    expect(config.dmca.enable).toBe(false);
  });

  it('拒絕未知的指定代理人登記聲明', () => {
    expect(() =>
      loadConfig({ ...minimalEnv, DMCA_DESIGNATED_AGENT_REGISTRATION: 'probably' }),
    ).toThrow(/DMCA_DESIGNATED_AGENT_REGISTRATION/);
  });

  it('從 env 與 yaml 載入可選的公開政策 URL，且 env 優先', () => {
    const yamlPath = writeYaml(
      [
        'ledger_db_address: /orbitdb/zFromYaml',
        'provider:',
        '  policies:',
        '    ugc: https://pin.example/yaml/ugc',
        '    legal: https://pin.example/yaml/legal',
        '    privacy: https://pin.example/yaml/privacy',
        '    retention: https://pin.example/yaml/retention',
      ].join('\n'),
    );

    expect(
      loadConfig({ PROVIDER_POLICY_LEGAL_URL: 'https://pin.example/env/legal' }, yamlPath).provider
        .policies,
    ).toEqual({
      ugc: 'https://pin.example/yaml/ugc',
      legal: 'https://pin.example/env/legal',
      privacy: 'https://pin.example/yaml/privacy',
      retention: 'https://pin.example/yaml/retention',
    });
  });

  it.each([
    'http://pin.example/legal',
    'https://user:pass@pin.example/legal',
    'https://pin.example/legal?token=secret',
    'https://pin.example/legal#section',
  ])('拒絕不安全的 provider policy URL：%s', (legal) => {
    expect(() => loadConfig({ ...minimalEnv, PROVIDER_POLICY_LEGAL_URL: legal })).toThrow(
      /PROVIDER_POLICY_LEGAL_URL/,
    );
  });

  it('拒絕 provider policies 的未知鍵', () => {
    const yamlPath = writeYaml(
      [
        'ledger_db_address: /orbitdb/zFromYaml',
        'provider:',
        '  policies:',
        '    terms: https://pin.example/terms',
      ].join('\n'),
    );
    expect(() => loadConfig({}, yamlPath)).toThrow(/provider\.policies/);
  });
});

describe('loadConfig：private metrics 預設關閉', () => {
  it('只有 METRICS_ENABLE=true 才開啟，listener host/port 可由部署覆寫', () => {
    const config = loadConfig({
      ...minimalEnv,
      METRICS_ENABLE: 'true',
      METRICS_HOST: '0.0.0.0',
      METRICS_PORT: '9555',
    });
    expect(config.metrics).toEqual({ enabled: true, host: '0.0.0.0', port: 9555 });
    expect(loadConfig({ ...minimalEnv, METRICS_ENABLE: 'TRUE' }).metrics.enabled).toBe(false);
  });
});

describe('loadConfig：quota 非法值退預設（形制比照 signaling readInt）', () => {
  it('非數值／零／負值一律退回預設', () => {
    const config = loadConfig({
      ...minimalEnv,
      QUOTA_PER_SIGNER_MAX_PINS: 'abc',
      QUOTA_PER_SIGNER_MAX_SIZE_GB: '0',
      QUOTA_GLOBAL_MAX_SIZE_TB: '-5',
    });
    expect(config.quotas).toEqual({
      perSignerMaxPins: 10000,
      perSignerMaxSizeGb: 50,
      globalMaxSizeTb: 0.0625,
    });
  });

  it('合法數值正常採用', () => {
    const config = loadConfig({
      ...minimalEnv,
      QUOTA_PER_SIGNER_MAX_PINS: '25',
      RATE_LIMIT_CAPACITY: '7',
      RATE_LIMIT_REFILL_PER_SEC: '3',
      PORT: 'not-a-number',
    });
    expect(config.quotas.perSignerMaxPins).toBe(25);
    expect(config.rateLimit).toEqual({ capacity: 7, refillPerSec: 3 });
    // PORT 非法 → 退預設
    expect(config.port).toBe(8000);
  });
});

describe('loadConfig：LEDGER_DB_ADDRESS 缺＝硬錯', () => {
  it('env 與 yaml 皆無 ledger address 時拋錯（帳本 peer 無位址不可啟動）', () => {
    expect(() => loadConfig({})).toThrow(/LEDGER_DB_ADDRESS/);
  });

  it('空字串／純空白同樣視為缺席而拋錯', () => {
    expect(() => loadConfig({ LEDGER_DB_ADDRESS: '' })).toThrow(/LEDGER_DB_ADDRESS/);
    expect(() => loadConfig({ LEDGER_DB_ADDRESS: '   ' })).toThrow(/LEDGER_DB_ADDRESS/);
  });

  it('僅 yaml 提供 ledger address 亦可（env 缺席不算硬錯）', () => {
    const yamlPath = writeYaml('ledger_db_address: /orbitdb/zOnlyYaml');
    expect(loadConfig({}, yamlPath).ledgerDbAddress).toBe('/orbitdb/zOnlyYaml');
  });
});

describe('loadConfig：GENESIS_TIMESTAMP 是 ledger trust root', () => {
  it('env 與 yaml 皆無時拒絕啟動設定', () => {
    expect(() => loadConfig({ LEDGER_DB_ADDRESS: '/orbitdb/zMissingTime' })).toThrow(
      /GENESIS_TIMESTAMP/,
    );
  });

  it.each(['0', '-1', '1.5', '123abc', '9007199254740992'])(
    '拒絕不合法或不安全的 env 值 %s，且不退回 yaml',
    (value) => {
      const yamlPath = writeYaml('ledger_db_address: /orbitdb/zYamlTime');
      expect(() => loadConfig({ GENESIS_TIMESTAMP: value }, yamlPath)).toThrow(/GENESIS_TIMESTAMP/);
    },
  );

  it('env 缺席時採用 public receipt 對應的 yaml 值', () => {
    const yamlPath = writeYaml('ledger_db_address: /orbitdb/zYamlTime');
    expect(loadConfig({}, yamlPath).genesisTimestamp).toBe(1785168000000);
  });
});

describe('loadConfig：CORS_ALLOWED_ORIGINS 明示 allowlist', () => {
  it('預設為空清單，跨來源能力 fail-closed', () => {
    const config = loadConfig(minimalEnv);
    expect(config.corsAllowedOrigins).toEqual([]);
  });

  it('env 逗號清單覆蓋 yaml，並正規化 scheme、host、預設 port 與重複項', () => {
    const yamlPath = writeYaml(
      ['ledger_db_address: /orbitdb/zY', 'cors_allowed_origins: ["https://yaml.example"]'].join(
        '\n',
      ),
    );
    const config = loadConfig(
      {
        CORS_ALLOWED_ORIGINS:
          'HTTPS://PLAY.OPEN4WD.ORG:443, https://play.open4wd.org, http://localhost:4200',
      },
      yamlPath,
    );
    expect(config.corsAllowedOrigins).toEqual([
      'https://play.open4wd.org',
      'http://localhost:4200',
    ]);
  });

  it('明示空 env 不退回 yaml，而是關閉 CORS', () => {
    const yamlPath = writeYaml(
      ['ledger_db_address: /orbitdb/zY', 'cors_allowed_origins: ["https://yaml.example"]'].join(
        '\n',
      ),
    );
    const config = loadConfig({ CORS_ALLOWED_ORIGINS: ' , ' }, yamlPath);
    expect(config.corsAllowedOrigins).toEqual([]);
  });

  it.each([
    '*',
    'https://user:secret@example.org',
    'https://example.org/path',
    'https://example.org/?query=1',
    'https://example.org/#fragment',
    'ftp://example.org',
  ])('拒絕不安全或非 origin 值：%s', (value) => {
    expect(() => loadConfig({ ...minimalEnv, CORS_ALLOWED_ORIGINS: value })).toThrow(
      /CORS_ALLOWED_ORIGINS/,
    );
  });

  it('錯誤訊息不回顯 credentials 等 origin 以外的敏感內容', () => {
    expect(() =>
      loadConfig({
        ...minimalEnv,
        CORS_ALLOWED_ORIGINS: 'https://private-user:secret-pass@example.org',
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining('secret-pass'),
      }),
    );
  });

  it('toApiConfig 將正規化 allowlist 實際傳入 API 組裝設定', () => {
    const config = loadConfig({
      ...minimalEnv,
      CORS_ALLOWED_ORIGINS: 'https://play.open4wd.org',
    });
    expect(toApiConfig(config).corsAllowedOrigins).toEqual(['https://play.open4wd.org']);
  });
});
