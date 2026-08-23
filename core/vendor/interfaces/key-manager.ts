/**
 * KeyManager — 身分與簽章的可替換抽象（助記詞→Ed25519；私鑰永不離開模組）
 */
import type { PeerId, Result, Signature } from './shared';

/** 身分 profile、解鎖、簽章與硬體金鑰的安全邊界。 */
export interface KeyManager {
  hasProfile(): Promise<boolean>;
  listProfiles(): Promise<ProfileMetadata[]>;
  /** 預設 24 詞（256-bit）；恢復接受 12／24 詞 */
  generateMnemonic(): Mnemonic;
  createProfile(opts: {
    mnemonic: Mnemonic;
    pin: string;
    nickname: string;
  }): Promise<ProfileMetadata>;
  /** PIN 解鎖；錯誤＝結構化 KeyManagerError（暴力鎖計次） */
  unlockProfile(profileId: string, pin: string): Promise<Result<KeyPair, KeyManagerError>>;
  lock(): void;
  /** 以當前解鎖身分簽章 */
  sign(message: Uint8Array): Promise<Signature>;
  verify(message: Uint8Array, signature: Signature, peerId: PeerId): Promise<boolean>;
  getPeerId(): PeerId;
  recoverFromMnemonic(mnemonic: Mnemonic, newPin: string): Promise<KeyPair>;
  /** 純 PIN 再確認；不解鎖、不更新嘗試次數或 lastUsedAt。 */
  verifyProfilePin(profileId: string, pin: string): Promise<Result<void, KeyManagerError>>;
  /** 純紙本備份比對；只回相符與否，不建立、切換或修改 profile。 */
  verifyMnemonicForProfile(
    profileId: string,
    mnemonic: Mnemonic,
  ): Promise<Result<boolean, KeyManagerError>>;
  /** 需先解鎖（未解鎖＝throw）；oldPin 錯誤回 pin-invalid、不計暴力鎖次數 */
  changePin(oldPin: string, newPin: string): Promise<Result<void, KeyManagerError>>;
  setHardwareProvider(provider: HardwareKeyProvider | null): void;
  /** 以 PIN 驗證後刪除（不計次）；刪除當前解鎖身分時同步 lock */
  deleteProfile(profileId: string, pin: string): Promise<Result<void, KeyManagerError>>;
  /** 目前解鎖中的 profile；鎖定時為 null。 */
  currentProfile(): Promise<ProfileMetadata | null>;
  /** 只允許更新玩家可變 metadata，身分主鍵與鎖定計數不在此入口修改。 */
  updateCurrentProfile(patch: ProfileMetadataPatch): Promise<Result<void, KeyManagerError>>;
}

/** BIP39 詞組、空白分隔（12 或 24 詞） */
export type Mnemonic = string;

/** Ed25519 金鑰對（32／32 bytes）；解鎖後僅存記憶體 */
export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** 可持久化但不含私鑰的玩家 profile metadata。 */
export interface ProfileMetadata {
  profileId: string;
  nickname: string;
  peerId: PeerId;
  createdAt: number;
  lastUsedAt: number;
  pinAttempts: number;
  lockedUntil: number;
  onboarding: OnboardingProgress;
}

/** 一個 profile 已完成的新手流程里程碑。 */
export interface OnboardingProgress {
  identityCreated: boolean;
  backupVerified: boolean;
  firstVehicleBuilt: boolean;
  localRaceCompleted: boolean;
  chainUnlocked: boolean;
}

/** 玩家可修改且不會改變身分主鍵的 profile 欄位。 */
export type ProfileMetadataPatch = Partial<Pick<ProfileMetadata, 'nickname' | 'onboarding'>>;

/** PIN 家族領域錯誤——模組不產文案；UI 以 code 映射 i18n 字串並插值參數 */
export type KeyManagerError =
  | { readonly code: 'profile-not-found' }
  | { readonly code: 'pin-invalid'; readonly attemptsLeft: number | null } // null＝不計次路徑（changePin／deleteProfile）
  | { readonly code: 'pin-locked'; readonly remainingMinutes: number }
  | { readonly code: 'pin-locked-now'; readonly lockMinutes: number }
  | { readonly code: 'nickname-invalid' }
  | { readonly code: 'nickname-too-long' }
  // 底層儲存（IndexedDB）讀寫失敗：配額用盡／私密模式／transaction abort——非 PIN 錯誤、不計暴力鎖次數
  | { readonly code: 'storage-error' };

/** 硬體簽章裝置抽象；啟用後 sign 委派硬體、私鑰永不離開安全元件 */
export interface HardwareKeyProvider {
  readonly type: 'webauthn' | 'ledger' | 'trezor' | 'yubikey';
  isAvailable(): Promise<boolean>;
  enroll(): Promise<{ publicKey: Uint8Array; credentialId: Uint8Array }>;
  sign(message: Uint8Array): Promise<Signature>;
  getPublicKey(): Promise<Uint8Array>;
}

/**
 * P2P 即時訊息的簽章封裝（跨模組共用）——timestamp 與 nonce 必在簽章涵蓋範圍內（防竄改時戳重放）；
 * 帳本事件不用此封裝（走 BaseEvent.signature）
 */
export interface SignedPayload<T> {
  payload: T;
  /** 毫秒 epoch。 */
  timestamp: number;
  /** 16 bytes 隨機值（防重放） */
  nonce: Uint8Array;
  signer: PeerId;
  signature: Signature;
}
