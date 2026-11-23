/**
 * PinningProvider — pinning 節點的可替換抽象（社群／自架；玩家設定頁可自選）
 */
import type { CID, Result, Timestamp } from './shared';

/** 已驗證公開 pin API 接受的封閉詞彙。 */
export const PIN_REQUEST_CATEGORIES = ['part', 'track'] as const;

/** HTTP 507 pinning 回應送出的完整封閉詞彙。 */
export const PINNING_QUOTA_REASONS = [
  'signer-pins',
  'signer-size',
  'global-size',
  'in-flight',
  'reservation-exceeded',
  'accounting-unavailable',
] as const;

/** 已驗證公開 pin API 接受的 UGC 根分類。 */
export type PinRequestCategory = (typeof PIN_REQUEST_CATEGORIES)[number];

/** pinning 服務回傳的機器可讀額度拒絕。 */
export type PinningQuotaReason = (typeof PINNING_QUOTA_REASONS)[number];

/** 由獨立選定 provider 實作的可替換 pinning 節點 contract。 */
export interface PinningProvider {
  /** 顯示給玩家的人工可讀 provider 標籤。 */
  readonly nodeName: string;
  /** 正規化管理 API base URL。 */
  readonly nodeUrl: string;
  /** 選擇來源；這是路由 provenance，絕非信任或法律標籤。 */
  readonly source: 'manual' | 'session' | 'community';
  /** provider 目前是否有 cluster peer 與可用 Kubo 容量。 */
  isAvailable(): Promise<boolean>;
  /** 回傳 provider 自有的正交能力宣告。 */
  getDescriptor(): Promise<Result<PinningProviderDescriptor>>;
  /** 驗證並提交完整 pin 請求。 */
  pin(request: PinRequest): Promise<Result<void>>;
  /** 驗證並移除指定 CID 的 pin。 */
  unpin(cid: CID): Promise<Result<void>>;
  /** 回傳嚴格解析的節點、容量、cluster 與同步統計。 */
  getStats(): Promise<Result<PinningStats>>;
  /** HTTP gateway URL（CDN-style fallback 取用內容） */
  getGatewayUrl(cid: CID): string;
}

/** provider 自有能力與宣告；client 絕不推斷法律 eligibility。 */
export interface PinningProviderDescriptor {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly capabilities: {
    readonly ugcRead: { readonly enabled: boolean };
    readonly ugcWrite: {
      readonly enabled: boolean;
      readonly authorization: 'operator-policy';
    };
    readonly legalNotice: { readonly enabled: boolean };
    readonly counterNotice: { readonly enabled: boolean };
    readonly transparency: { readonly enabled: boolean };
  };
  readonly declarations: {
    readonly designatedAgentRegistration: 'not-declared' | 'registered';
    readonly safeHarborEligibility: 'not-asserted';
  };
  readonly policies: {
    readonly ugc?: string;
    readonly legal?: string;
    readonly privacy?: string;
    readonly retention?: string;
  };
}

/** pinning 節點管理 API 回傳的統計。 */
export interface PinningStats {
  /** 穩定節點識別碼，通常為 PeerId。 */
  readonly nodeId: string;
  /** pinning 服務軟體版本。 */
  readonly version: string;
  /** 節點目前 pinned 的 CID 數量。 */
  readonly totalPinnedCount: number;
  /** 歸屬目前 pin set 的總 bytes。 */
  readonly totalSizeBytes: number;
  /** provider 額度帳本目前是否准入另一個 pin。 */
  readonly acceptingPins: boolean;
  /** 歸屬 provider 全域額度的實體 bytes。 */
  readonly quotaUsedBytes: number;
  /** 已設定的 provider 全域額度 bytes。 */
  readonly quotaLimitBytes: number;
  /** Kubo repository 剩餘容量 bytes。 */
  readonly availableSpaceBytes: number;
  /** 此節點可見的 IPFS Cluster peer 數量。 */
  readonly ipfsClusterPeers: number;
  /** 服務運作秒數。 */
  readonly uptime: number;
  /** 最近帳本同步的 UNIX 毫秒時間戳。 */
  readonly lastSyncTimestamp: Timestamp;
}

/** 送至既有 pinning HTTP API 的請求欄位。 */
export interface PinRequest {
  /** 要保存的內容識別碼。 */
  readonly cid: CID;
  /** 與內容關聯的伺服器中繼資料分類。 */
  readonly category: PinRequestCategory;
  /** client 宣告且用於准入控制的 byte 估算。 */
  readonly sizeHintBytes: number;
}
