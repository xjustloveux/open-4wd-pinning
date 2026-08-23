/**
 * 服務設定載入——三層解析：預設值 → yaml（選填檔）→ 環境變數，後者覆蓋前者。
 *
 * 數值欄位形制比照 signaling 的 readInt：非數值／零／負值一律退回「下一層」（yaml 有效值，
 * 否則預設）；`DMCA_ENABLE` 採嚴格字串比對（恰為 "true" 才啟用，避免 "1"／"yes" 之類被誤判
 * 成開啟這個涉及個資與法務流程的模組）。`LEDGER_DB_ADDRESS` 為必填——帳本 replica peer 沒有
 * 帳本位址就無從決定要複寫哪一條鏈，缺席即硬錯、不允許以隱性預設起動。位址的 wire 格式
 * （`/orbitdb/<CIDv1-base58btc>`）正確性不在本層驗證：交由帳本節點開啟時的既有驗證處理，
 * 本層只保證「有值」。
 *
 * yaml 鍵採 snake_case（對齊部署文件的設定範例）；env 覆蓋鍵採 UPPER_SNAKE（對齊部署 env 表）。
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { ApiConfig, DesignatedAgentRegistration, ProviderPolicyUrls } from '../api';

/** 定義由預設值、YAML 與環境組成的已驗證服務設定。 */
export interface AppConfig {
  readonly port: number;
  /**
   * 瀏覽器可跨來源呼叫管理 API 的明示 origin allowlist。空集＝fail-closed；每個值皆已正規化
   * 為 scheme + host (+ 非預設 port)，不含 path/query/fragment/credentials。
   */
  readonly corsAllowedOrigins: readonly string[];
  readonly dataDir: string;
  /** 帳本 OrbitDB 位址（必填）；格式驗證留給帳本節點開啟時處理，本層僅保證有值。 */
  readonly ledgerDbAddress: string;
  readonly listenWs: readonly string[];
  readonly bootstrap: readonly string[];
  readonly relayEnabled: boolean;
  /**
   * 治理 trust root——checkpoint 多簽採納授權 signer set（PeerId 清單）。replica 節點的
   * DerivedState 不推進 economyConfig（reducer 組合不含治理 reducer），無從自帳本 derive 出當前
   * signer set，故由部署 config 顯式注入。未設定＝空集＝fail-closed：checkpoint 驅動的自動 pin
   * 採納閘保持關閉（本地無法提案、遠端 announcement 拒收），服務其餘職責（授權 pin／DMCA 等）
   * 照常運作。格式（`/orbitdb` 那類 wire 檢核）不在本層驗證，交由帳本節點開啟時處理。
   */
  readonly governanceSigners: readonly string[];
  /** public genesis receipt 的單次 UTC 毫秒值。 */
  readonly genesisTimestamp: number;
  readonly clusterApiUrl: string;
  readonly kuboApiUrl: string;
  readonly auth: {
    readonly authorizedSigners: readonly string[];
    /** 未設定＝停用信譽授權模式（只認白名單）。 */
    readonly reputationThreshold?: number;
  };
  readonly quotas: {
    readonly perSignerMaxPins: number;
    readonly perSignerMaxSizeGb: number;
    readonly globalMaxSizeTb: number;
  };
  readonly rateLimit: {
    readonly capacity: number;
    readonly refillPerSec: number;
  };
  readonly signerRateLimit: {
    readonly capacity: number;
    readonly refillPerSec: number;
  };
  readonly provider: {
    readonly ugcReadEnabled: boolean;
    readonly ugcWriteEnabled: boolean;
    readonly transparencyEnabled: boolean;
    readonly designatedAgentRegistration: DesignatedAgentRegistration;
    readonly policies: ProviderPolicyUrls;
  };
  readonly metrics: {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
  };
  readonly dmca: {
    readonly enable: boolean;
    /** Self-host Swagger UI；預設關閉，OpenAPI JSON 不受此開關影響。 */
    readonly adminDocsEnabled: boolean;
    readonly adminToken?: string;
    /** 管理裁決稽核紀錄使用的部署端操作者標籤；不可由 request body 提供。 */
    readonly adminOperatorId: string;
    /** 僅在 origin 封閉於 Cloudflare Tunnel/Access 時啟用，否則 header 可被 client 偽造。 */
    readonly trustCloudflareAccessIdentity: boolean;
    readonly smtpUrl?: string;
    readonly agentEmail?: string;
    readonly deliveryRetryBaseMs: number;
    readonly deliveryRetryMaxMs: number;
    readonly businessDayHolidays: readonly string[];
  };
}

const DEFAULT_PORT = 8000;
const DEFAULT_DATA_DIR = './data';
const DEFAULT_LISTEN_WS: readonly string[] = ['/ip4/0.0.0.0/tcp/4001/ws'];
const DEFAULT_CLUSTER_API_URL = 'http://127.0.0.1:9094';
const DEFAULT_KUBO_API_URL = 'http://127.0.0.1:5001';
const DEFAULT_PER_SIGNER_MAX_PINS = 10000;
const DEFAULT_PER_SIGNER_MAX_SIZE_GB = 50;
// 公版直接啟動範本的容量關係：64 GiB app quota < 80 GB Kubo StorageMax < 100 Gi PVC。
// 營運者可整組放大或縮小，但必須保留 repo metadata／GC 的 headroom。
const DEFAULT_GLOBAL_MAX_SIZE_TB = 0.0625;
const DEFAULT_RATE_LIMIT_CAPACITY = 20;
const DEFAULT_RATE_LIMIT_REFILL_PER_SEC = 1;
const DEFAULT_SIGNER_RATE_LIMIT_CAPACITY = 20;
const DEFAULT_SIGNER_RATE_LIMIT_REFILL_PER_SEC = 1;
const DEFAULT_METRICS_HOST = '127.0.0.1';
const DEFAULT_METRICS_PORT = 9464;
const DEFAULT_DMCA_DELIVERY_RETRY_BASE_MS = 60_000;
const DEFAULT_DMCA_DELIVERY_RETRY_MAX_MS = 86_400_000;

// ── env 取值 helpers ──

/** 環境變數的有效字串值（trim 後非空）；未設定或純空白回 undefined。 */
function envStr(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/** 逗號分隔清單；未設定或全為空白回 undefined，讓上層退回 yaml／預設。 */
function envList(env: NodeJS.ProcessEnv, key: string): string[] | undefined {
  const value = envStr(env, key);
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length > 0 ? items : undefined;
}

/**
 * CORS allowlist 與一般清單不同：部署端若明示空值，代表刻意關閉跨來源，不可退回 yaml 中可能
 * 過期的允許項目。因此只要 env key 存在就回陣列（空白＝空陣列）；key 缺席才回 undefined。
 */
function envCorsOrigins(env: NodeJS.ProcessEnv): string[] | undefined {
  const value = env['CORS_ALLOWED_ORIGINS'];
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** true/false 明確字串；其餘（含未設定、無法辨識）回 undefined，讓上層退回 yaml／預設。 */
function envBool(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const value = envStr(env, key);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** 比照 signaling readInt：非數值／零／負值退回 fallback。 */
function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 正有限數（允許小數）：全域 TiB quota 需要能表達小於 1 TiB 的小型部署。 */
function readPositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 選填正整數：env 有效值優先，否則退回 base（可為 undefined＝該模式停用）。 */
function readOptionalInt(value: string | undefined, base: number | undefined): number | undefined {
  if (value === undefined) return base;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : base;
}

/**
 * Ledger genesis time is a consensus trust root, not an ordinary tunable integer.  An explicit
 * malformed env value must not silently fall back to YAML, and strings such as `123abc` must not
 * be accepted by parseInt.
 */
function readGenesisTimestamp(envValue: string | undefined, yamlValue: unknown): number {
  const raw = envValue ?? yamlValue;
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^[1-9]\d*$/u.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(
      'GENESIS_TIMESTAMP 為必填正整數：必須與 ledger genesis public receipt 的 genesisTimestamp 完全一致',
    );
  return parsed;
}

// ── yaml 取值 helpers ──

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function yamlStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function yamlPosInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function yamlBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function yamlStrList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim());
  return items;
}

function normalizeCorsAllowedOrigins(values: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    if (value === '*') {
      throw new Error('CORS_ALLOWED_ORIGINS 不允許 wildcard "*"；必須逐一列出可信 origin');
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('CORS_ALLOWED_ORIGINS 含無效 origin');
    }

    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search !== '' ||
      url.hash !== '' ||
      url.origin === 'null'
    ) {
      throw new Error(
        'CORS_ALLOWED_ORIGINS 只接受 scheme + host (+ port)，不可含 credentials/path/query/fragment',
      );
    }
    normalized.add(url.origin);
  }
  return [...normalized];
}

const PROVIDER_POLICY_KEYS = ['ugc', 'legal', 'privacy', 'retention'] as const;

function loadProviderPolicies(
  env: NodeJS.ProcessEnv,
  providerYaml: Record<string, unknown>,
): ProviderPolicyUrls {
  const policiesYaml = asRecord(providerYaml['policies']);
  const unknownKey = Object.keys(policiesYaml).find(
    (key) => !PROVIDER_POLICY_KEYS.includes(key as (typeof PROVIDER_POLICY_KEYS)[number]),
  );
  if (unknownKey !== undefined) {
    throw new Error(`provider.policies 含未知鍵：${unknownKey}`);
  }

  const policies: Record<string, string> = {};
  for (const key of PROVIDER_POLICY_KEYS) {
    const envName = `PROVIDER_POLICY_${key.toUpperCase()}_URL`;
    const value = envStr(env, envName) ?? yamlStr(policiesYaml[key]);
    if (value === undefined) continue;

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${envName} 必須是有效 HTTPS URL`);
    }
    if (
      value.length > 2_048 ||
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error(`${envName} 只接受不含 credentials/query/fragment 的 HTTPS URL`);
    }
    policies[key] = url.toString();
  }
  return policies;
}

/** 讀取 yaml 檔並解析成頂層 record；檔案不存在／無法解析／內容非物件一律回空 record
 *  （讓 main 可無條件帶一個預設設定路徑，操作者尚未建立檔案時不至於啟動失敗）。 */
function loadYamlRoot(yamlPath: string | undefined): Record<string, unknown> {
  if (yamlPath === undefined) return {};
  let raw: string;
  try {
    raw = readFileSync(yamlPath, 'utf8');
  } catch {
    return {};
  }
  try {
    return asRecord(parseYaml(raw));
  } catch {
    return {};
  }
}

/** 載入設定，並以環境值覆寫選用 YAML 與內建預設值。 */
export function loadConfig(env: NodeJS.ProcessEnv, yamlPath?: string): AppConfig {
  const root = loadYamlRoot(yamlPath);
  const authYaml = asRecord(root['auth']);
  const quotasYaml = asRecord(root['quotas']);
  const rateLimitYaml = asRecord(root['rate_limit']);
  const signerRateLimitYaml = asRecord(root['signer_rate_limit']);
  const dmcaYaml = asRecord(root['dmca']);
  const metricsYaml = asRecord(root['metrics']);
  const providerYaml = asRecord(root['provider']);

  const ledgerDbAddress = envStr(env, 'LEDGER_DB_ADDRESS') ?? yamlStr(root['ledger_db_address']);
  if (ledgerDbAddress === undefined) {
    throw new Error(
      'LEDGER_DB_ADDRESS 為必填：帳本 replica peer 需要帳本位址才能決定複寫哪一條鏈（設定 env 或 yaml ledger_db_address）',
    );
  }
  const genesisTimestamp = readGenesisTimestamp(
    envStr(env, 'GENESIS_TIMESTAMP'),
    root['genesis_timestamp'],
  );

  const dmcaEnable =
    env['DMCA_ENABLE'] !== undefined
      ? env['DMCA_ENABLE'] === 'true'
      : (yamlBool(dmcaYaml['enable']) ?? false);
  const designatedAgentRegistration =
    envStr(env, 'DMCA_DESIGNATED_AGENT_REGISTRATION') ??
    yamlStr(dmcaYaml['designated_agent_registration']) ??
    'not-declared';
  if (!['not-declared', 'registered'].includes(designatedAgentRegistration)) {
    throw new Error(
      'DMCA_DESIGNATED_AGENT_REGISTRATION 只接受 not-declared 或 registered；這是營運者聲明，不代表安全港資格',
    );
  }
  const dmcaAdminToken = envStr(env, 'DMCA_ADMIN_TOKEN') ?? yamlStr(dmcaYaml['admin_token']);
  if (dmcaEnable && dmcaAdminToken === undefined) {
    throw new Error(
      'DMCA_ENABLE=true 時 DMCA_ADMIN_TOKEN 為必填；拒絕以不可操作或不明確的管理憑證啟動',
    );
  }

  return {
    port: readInt(envStr(env, 'PORT'), yamlPosInt(root['port']) ?? DEFAULT_PORT),
    corsAllowedOrigins: normalizeCorsAllowedOrigins(
      envCorsOrigins(env) ?? yamlStrList(root['cors_allowed_origins']) ?? [],
    ),
    dataDir: envStr(env, 'DATA_DIR') ?? yamlStr(root['data_dir']) ?? DEFAULT_DATA_DIR,
    ledgerDbAddress,
    listenWs: envList(env, 'LISTEN_WS') ?? yamlStrList(root['listen_ws']) ?? [...DEFAULT_LISTEN_WS],
    bootstrap: envList(env, 'BOOTSTRAP') ?? yamlStrList(root['bootstrap']) ?? [],
    relayEnabled: envBool(env, 'RELAY_ENABLE') ?? yamlBool(root['relay_enabled']) ?? true,
    governanceSigners:
      envList(env, 'GOVERNANCE_SIGNERS') ?? yamlStrList(root['governance_signers']) ?? [],
    genesisTimestamp,
    clusterApiUrl:
      envStr(env, 'CLUSTER_API_URL') ?? yamlStr(root['cluster_api_url']) ?? DEFAULT_CLUSTER_API_URL,
    kuboApiUrl:
      envStr(env, 'KUBO_API_URL') ?? yamlStr(root['kubo_api_url']) ?? DEFAULT_KUBO_API_URL,
    auth: {
      authorizedSigners:
        envList(env, 'AUTHORIZED_SIGNERS') ?? yamlStrList(authYaml['authorized_signers']) ?? [],
      reputationThreshold: readOptionalInt(
        envStr(env, 'REPUTATION_THRESHOLD'),
        yamlPosInt(authYaml['reputation_threshold']),
      ),
    },
    quotas: {
      perSignerMaxPins: readInt(
        envStr(env, 'QUOTA_PER_SIGNER_MAX_PINS'),
        yamlPosInt(quotasYaml['per_signer_max_pins']) ?? DEFAULT_PER_SIGNER_MAX_PINS,
      ),
      perSignerMaxSizeGb: readInt(
        envStr(env, 'QUOTA_PER_SIGNER_MAX_SIZE_GB'),
        yamlPosInt(quotasYaml['per_signer_max_size_gb']) ?? DEFAULT_PER_SIGNER_MAX_SIZE_GB,
      ),
      globalMaxSizeTb: readPositiveNumber(
        envStr(env, 'QUOTA_GLOBAL_MAX_SIZE_TB'),
        yamlPosInt(quotasYaml['global_max_size_tb']) ?? DEFAULT_GLOBAL_MAX_SIZE_TB,
      ),
    },
    rateLimit: {
      capacity: readInt(
        envStr(env, 'RATE_LIMIT_CAPACITY'),
        yamlPosInt(rateLimitYaml['capacity']) ?? DEFAULT_RATE_LIMIT_CAPACITY,
      ),
      refillPerSec: readInt(
        envStr(env, 'RATE_LIMIT_REFILL_PER_SEC'),
        yamlPosInt(rateLimitYaml['refill_per_sec']) ?? DEFAULT_RATE_LIMIT_REFILL_PER_SEC,
      ),
    },
    signerRateLimit: {
      capacity: readInt(
        envStr(env, 'SIGNER_RATE_LIMIT_CAPACITY'),
        yamlPosInt(signerRateLimitYaml['capacity']) ?? DEFAULT_SIGNER_RATE_LIMIT_CAPACITY,
      ),
      refillPerSec: readInt(
        envStr(env, 'SIGNER_RATE_LIMIT_REFILL_PER_SEC'),
        yamlPosInt(signerRateLimitYaml['refill_per_sec']) ??
          DEFAULT_SIGNER_RATE_LIMIT_REFILL_PER_SEC,
      ),
    },
    provider: {
      ugcReadEnabled:
        envBool(env, 'PROVIDER_UGC_READ_ENABLE') ??
        yamlBool(providerYaml['ugc_read_enabled']) ??
        true,
      ugcWriteEnabled:
        envBool(env, 'PROVIDER_UGC_WRITE_ENABLE') ??
        yamlBool(providerYaml['ugc_write_enabled']) ??
        true,
      transparencyEnabled:
        envBool(env, 'PROVIDER_TRANSPARENCY_ENABLE') ??
        yamlBool(providerYaml['transparency_enabled']) ??
        true,
      designatedAgentRegistration: designatedAgentRegistration as DesignatedAgentRegistration,
      policies: loadProviderPolicies(env, providerYaml),
    },
    metrics: {
      enabled:
        env['METRICS_ENABLE'] !== undefined
          ? env['METRICS_ENABLE'] === 'true'
          : (yamlBool(metricsYaml['enabled']) ?? false),
      host: envStr(env, 'METRICS_HOST') ?? yamlStr(metricsYaml['host']) ?? DEFAULT_METRICS_HOST,
      port: readInt(
        envStr(env, 'METRICS_PORT'),
        yamlPosInt(metricsYaml['port']) ?? DEFAULT_METRICS_PORT,
      ),
    },
    dmca: {
      enable: dmcaEnable,
      adminDocsEnabled:
        env['DMCA_ADMIN_DOCS_ENABLE'] !== undefined
          ? env['DMCA_ADMIN_DOCS_ENABLE'] === 'true'
          : (yamlBool(dmcaYaml['admin_docs_enabled']) ?? false),
      adminToken: dmcaAdminToken,
      adminOperatorId:
        envStr(env, 'DMCA_ADMIN_OPERATOR_ID') ??
        yamlStr(dmcaYaml['admin_operator_id']) ??
        'self-hosted-admin',
      trustCloudflareAccessIdentity:
        env['DMCA_TRUST_CLOUDFLARE_ACCESS_IDENTITY'] !== undefined
          ? env['DMCA_TRUST_CLOUDFLARE_ACCESS_IDENTITY'] === 'true'
          : (yamlBool(dmcaYaml['trust_cloudflare_access_identity']) ?? false),
      smtpUrl: envStr(env, 'SMTP_URL') ?? yamlStr(dmcaYaml['smtp_url']),
      agentEmail: envStr(env, 'DMCA_AGENT_EMAIL') ?? yamlStr(dmcaYaml['agent_email']),
      deliveryRetryBaseMs: readInt(
        envStr(env, 'DMCA_DELIVERY_RETRY_BASE_MS'),
        yamlPosInt(dmcaYaml['delivery_retry_base_ms']) ?? DEFAULT_DMCA_DELIVERY_RETRY_BASE_MS,
      ),
      deliveryRetryMaxMs: readInt(
        envStr(env, 'DMCA_DELIVERY_RETRY_MAX_MS'),
        yamlPosInt(dmcaYaml['delivery_retry_max_ms']) ?? DEFAULT_DMCA_DELIVERY_RETRY_MAX_MS,
      ),
      businessDayHolidays:
        envList(env, 'DMCA_BUSINESS_DAY_HOLIDAYS') ??
        yamlStrList(dmcaYaml['business_day_holidays']) ??
        [],
    },
  };
}

/** 把服務層設定收斂為 API server 真正使用的欄位，避免啟動組裝漏傳 CORS allowlist。 */
export function toApiConfig(config: AppConfig): ApiConfig {
  return {
    port: config.port,
    corsAllowedOrigins: config.corsAllowedOrigins,
    auth: config.auth,
    rateLimit: config.rateLimit,
    signerRateLimit: config.signerRateLimit,
    provider: {
      ...config.provider,
      legalNoticeEnabled: config.dmca.enable,
      counterNoticeEnabled: config.dmca.enable,
      transparencyEnabled: config.dmca.enable && config.provider.transparencyEnabled,
    },
  };
}
