/**
 * Open4wdKeyManager — KeyManager 契約的目前實作
 * 身分＝助記詞→Ed25519→PeerId；私鑰 seed 只以密文落地、解鎖後僅存記憶體、lock() 歸零
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { Protocol } from '@open4wd/system-constants';
import type {
  HardwareKeyProvider,
  KeyManager,
  KeyManagerError,
  KeyPair,
  Mnemonic,
  PeerId,
  ProfileMetadata,
  ProfileMetadataPatch,
  Result,
  Signature,
  SignedPayload,
} from '@open4wd/interfaces';
import { err, ok } from '@open4wd/interfaces';
import {
  deriveKeyPair,
  peerIdToPublicKey,
  publicKeyToPeerId,
  signMessage,
  verifyMessage,
} from './ed25519';
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from './mnemonic';
import { DEFAULT_ARGON2, decryptSeed, encryptSeed, type Argon2Params } from './seed-crypto';
import {
  IndexedDbProfileStore,
  type ProfileStore,
  type StoredIdentityContainer,
  type StoredProfile,
} from './profile-store';
import { tryUnlock } from './pin-guard';
import { buildSignedMessage } from './signed-payload';
import {
  openIdentityDomain as decryptIdentityDomain,
  sealIdentityDomain as encryptIdentityDomain,
  type SealedIdentityDomain,
} from './identity-domain-crypto';
import {
  resolveDisplayIdentity,
  validateNicknameSnapshot,
  type NicknameValidation,
} from '../identity/display-identity';

/** Key manager 的持久層、本地時鐘與 KDF 測試 seam。 */
export interface Open4wdKeyManagerOptions {
  store?: ProfileStore;
  /** 本地 UI 時鐘（暴力鎖／metadata 用、非共識） */
  now?: () => number;
  /** 測試可注入低成本 KDF 參數 */
  kdfParams?: Argon2Params;
}

/** 僅用於刪除前協調 sealed domain，且經 PIN 驗證、以 callback 為 scope 的存取。 */
export interface ProfileDeletionContext {
  readonly peerId: PeerId;
  openDomain(domain: string): Promise<Uint8Array | null>;
}

/** profile 資料刪除後執行外部清理的延後 callback。 */
export type ProfileDeletionFinalizer = () => Promise<void>;

const toMetadata = (p: StoredProfile): ProfileMetadata => ({
  profileId: p.profileId,
  nickname: p.nickname,
  peerId: p.peerId,
  createdAt: p.createdAt,
  lastUsedAt: p.lastUsedAt,
  pinAttempts: p.pinAttempts,
  lockedUntil: p.lockedUntil,
  onboarding: { ...p.onboarding },
});

const newIdentityOnboarding = (backupVerified: boolean): ProfileMetadata['onboarding'] => ({
  identityCreated: true,
  backupVerified,
  firstVehicleBuilt: false,
  localRaceCompleted: false,
  chainUnlocked: false,
});

function nicknameError(
  validation: Extract<NicknameValidation, { readonly ok: false }>,
): 'nickname-invalid' | 'nickname-too-long' {
  return validation.reason === 'too-long' ? 'nickname-too-long' : 'nickname-invalid';
}

function requireNicknameSnapshot(value: string): string {
  const validation = validateNicknameSnapshot(value);
  if (!validation.ok) throw new Error(`errors.keyManager.${nicknameError(validation)}`);
  return validation.value;
}

/** 管理加密 profile、解鎖身分與所有 master-key 簽署操作。 */
export class Open4wdKeyManager implements KeyManager {
  /** 加密 profile 與身分 container 的持久層。 */
  private readonly store: ProfileStore;
  /** PIN lock 與 profile metadata 使用的本地時鐘。 */
  private readonly now: () => number;
  /** 新建或重加密 seed 使用的 Argon2id 參數。 */
  private readonly kdfParams: Argon2Params;
  /** 僅記憶體保存的目前解鎖 profile 與 key pair。 */
  private current: { profile: ProfileMetadata; keyPair: KeyPair } | null = null;
  /** 可選的硬體簽署 provider；存在時優先處理支援的操作。 */
  private hardware: HardwareKeyProvider | null = null;

  constructor(options: Open4wdKeyManagerOptions = {}) {
    this.store = options.store ?? new IndexedDbProfileStore();
    this.now = options.now ?? Date.now;
    this.kdfParams = options.kdfParams ?? DEFAULT_ARGON2;
  }

  /** 判斷本機是否至少存在一個可供解鎖的身分 profile。 */
  async hasProfile(): Promise<boolean> {
    return (await this.store.list()).length > 0;
  }

  /** 列出本機 profile 的非敏感中繼資料，不回傳私鑰或已解密網域內容。 */
  async listProfiles(): Promise<ProfileMetadata[]> {
    return (await this.store.list()).map(toMetadata);
  }

  /** 產生可用來恢復同一金鑰對的助記詞，呼叫端必須要求使用者離線保存。 */
  generateMnemonic(): Mnemonic {
    return generateMnemonic();
  }

  /** 由新助記詞建立加密 profile，使用 PIN 衍生金鑰封存私鑰後只回傳中繼資料。 */
  async createProfile(opts: {
    mnemonic: Mnemonic;
    pin: string;
    nickname: string;
  }): Promise<ProfileMetadata> {
    if (!validateMnemonic(opts.mnemonic)) throw new Error('助記詞不合法');
    const nickname = requireNicknameSnapshot(opts.nickname);
    const seed = mnemonicToSeed(opts.mnemonic);
    const peerId = publicKeyToPeerId(deriveKeyPair(seed).publicKey);
    if (await this.store.findByPeerId(peerId)) {
      throw new Error('此身分已存在——請改用助記詞恢復');
    }
    const encryptedSeed = await encryptSeed(seed, opts.pin, this.kdfParams);
    seed.fill(0); // 建檔不解鎖——明文 seed 用畢即歸零
    const profile: StoredProfile = {
      profileId: crypto.randomUUID(),
      nickname,
      peerId,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      pinAttempts: 0,
      lockedUntil: 0,
      onboarding: newIdentityOnboarding(false),
      encryptedSeed,
    };
    const claimed = await this.store.claimProfile(profile);
    if (claimed.profileId !== profile.profileId) throw new Error('此身分已存在——請改用助記詞恢復');
    return toMetadata(profile);
  }

  /** 以 PIN 解密指定 profile 的私鑰並設為目前身分；驗證失敗時不改變既有解鎖狀態。 */
  async unlockProfile(profileId: string, pin: string): Promise<Result<KeyPair, KeyManagerError>> {
    const result = await tryUnlock(this.store, profileId, pin, this.now);
    if (!result.ok) return result;
    try {
      const stored = await this.store.get(profileId);
      if (!stored) return err({ code: 'profile-not-found' });
      await this.store.update(profileId, { lastUsedAt: this.now() });
      this.lock(); // 換鑰前先歸零前一把
      this.current = { profile: toMetadata(stored), keyPair: result.value };
      return ok(result.value);
    } catch {
      return err({ code: 'storage-error' });
    }
  }

  /** 清除記憶體中的解鎖金鑰與目前 profile，使簽章及身分網域操作立即失效。 */
  lock(): void {
    if (this.current) this.current.keyPair.privateKey.fill(0); // 記憶體歸零
    this.current = null;
  }

  /** 使用目前已解鎖私鑰簽署訊息；未解鎖時拒絕而不嘗試存取持久資料。 */
  async sign(message: Uint8Array): Promise<Signature> {
    if (this.hardware) return this.hardware.sign(message);
    return signMessage(this.requireUnlocked().keyPair.privateKey, message);
  }

  /** 以指定節點公鑰驗證訊息簽章，回傳布林結果且不改變任何金鑰狀態。 */
  async verify(message: Uint8Array, signature: Signature, peerId: PeerId): Promise<boolean> {
    const publicKey = peerIdToPublicKey(peerId);
    if (!publicKey) return false;
    return verifyMessage(publicKey, message, signature);
  }

  /** 取得目前已解鎖 profile 的節點識別；未解鎖時拒絕。 */
  getPeerId(): PeerId {
    return this.requireUnlocked().profile.peerId;
  }

  /** 取得目前已解鎖 profile 的自報暱稱快照；未解鎖時拒絕。 */
  getNicknameSnapshot(): string {
    return this.requireUnlocked().profile.nickname;
  }

  /** 使用目前 profile 的網域分離金鑰加密資料，使密文只可在同一身分與網域開啟。 */
  sealIdentityDomain(domain: string, plaintext: Uint8Array): Promise<SealedIdentityDomain> {
    const current = this.requireUnlocked();
    return encryptIdentityDomain(
      current.keyPair.privateKey,
      current.profile.peerId,
      domain,
      plaintext,
    );
  }

  /** 驗證網域綁定並解密身分資料；驗證標籤、nonce 或密文不符時拒絕。 */
  openIdentityDomain(domain: string, sealed: SealedIdentityDomain): Promise<Uint8Array> {
    const current = this.requireUnlocked();
    return decryptIdentityDomain(
      current.keyPair.privateKey,
      current.profile.peerId,
      domain,
      sealed,
    );
  }

  /** 取得目前 profile 的加密身分容器與修訂版；尚未建立時回傳空值。 */
  getIdentityContainer(): Promise<StoredIdentityContainer | null> {
    const current = this.requireUnlocked();
    return this.store.getIdentityContainer(current.profile.peerId);
  }

  /** 只在目前修訂版符合預期時原子替換加密身分容器，回傳是否成功寫入。 */
  compareAndSwapIdentityContainer(
    expectedRevision: number | null,
    next: StoredIdentityContainer,
  ): Promise<boolean> {
    const current = this.requireUnlocked();
    if (next.peerId !== current.profile.peerId)
      throw new Error('Identity container owner does not match unlocked identity');
    return this.store.compareAndSwapIdentityContainer(
      current.profile.peerId,
      expectedRevision,
      next,
    );
  }

  /** 由助記詞重建原金鑰對，以新 PIN 建立可解鎖 profile，且不沿用舊 PIN 密文。 */
  async recoverFromMnemonic(
    mnemonic: Mnemonic,
    newPin: string,
    nickname?: string,
  ): Promise<KeyPair> {
    if (!validateMnemonic(mnemonic)) throw new Error('助記詞不合法');
    const validatedNickname =
      nickname === undefined ? undefined : requireNicknameSnapshot(nickname);
    const seed = mnemonicToSeed(mnemonic);
    const keyPair = deriveKeyPair(seed);
    const peerId = publicKeyToPeerId(keyPair.publicKey);
    const encryptedSeed = await encryptSeed(seed, newPin, this.kdfParams);

    const existing = await this.store.findByPeerId(peerId);
    if (existing) {
      // 既有身分 → 重設 PIN、清暴力鎖
      const onboarding = {
        ...newIdentityOnboarding(true),
        ...existing.onboarding,
        identityCreated: true,
        backupVerified: true,
      };
      onboarding.chainUnlocked =
        onboarding.identityCreated &&
        onboarding.backupVerified &&
        onboarding.firstVehicleBuilt &&
        onboarding.localRaceCompleted;
      await this.store.update(existing.profileId, {
        encryptedSeed,
        pinAttempts: 0,
        lockedUntil: 0,
        lastUsedAt: this.now(),
        onboarding,
      });
      this.lock(); // 換鑰前先歸零前一把
      this.current = { profile: toMetadata({ ...existing, encryptedSeed, onboarding }), keyPair };
      return keyPair;
    }
    const profile: StoredProfile = {
      profileId: crypto.randomUUID(),
      nickname: validatedNickname ?? resolveDisplayIdentity(peerId).label,
      peerId,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      pinAttempts: 0,
      lockedUntil: 0,
      onboarding: newIdentityOnboarding(true),
      encryptedSeed,
    };
    const claimed = await this.store.claimProfile(profile);
    if (claimed.profileId !== profile.profileId) {
      const onboarding = {
        ...newIdentityOnboarding(true),
        ...claimed.onboarding,
        identityCreated: true,
        backupVerified: true,
      };
      onboarding.chainUnlocked =
        onboarding.identityCreated &&
        onboarding.backupVerified &&
        onboarding.firstVehicleBuilt &&
        onboarding.localRaceCompleted;
      await this.store.update(claimed.profileId, {
        encryptedSeed,
        pinAttempts: 0,
        lockedUntil: 0,
        lastUsedAt: this.now(),
        onboarding,
      });
      this.lock();
      this.current = {
        profile: toMetadata({ ...claimed, encryptedSeed, onboarding }),
        keyPair,
      };
      return keyPair;
    }
    this.lock(); // 換鑰前先歸零前一把
    this.current = { profile: toMetadata(profile), keyPair };
    return keyPair;
  }

  /** 驗證舊 PIN 後以新 PIN 重新封裝 profile 種子；身分容器使用 profile 網域金鑰，因此不需逐筆重加密。 */
  async changePin(oldPin: string, newPin: string): Promise<Result<void, KeyManagerError>> {
    const current = this.requireUnlocked(); // 未解鎖＝throw（介面文件化行為）、不收斂為 Result
    try {
      const stored = await this.store.get(current.profile.profileId);
      if (!stored) return err({ code: 'profile-not-found' });
      const decrypted = await decryptSeed(stored.encryptedSeed, oldPin);
      if (!decrypted.ok) return err({ code: 'pin-invalid', attemptsLeft: null });
      const encryptedSeed = await encryptSeed(decrypted.value, newPin, this.kdfParams);
      decrypted.value.fill(0); // 明文 seed 用畢即歸零
      await this.store.update(current.profile.profileId, {
        encryptedSeed,
        pinAttempts: 0,
        lockedUntil: 0,
      });
      return ok(undefined);
    } catch {
      return err({ code: 'storage-error' });
    }
  }

  /** 以指定 PIN 嘗試解封 profile 金鑰，僅回傳是否匹配且不改變目前解鎖狀態。 */
  async verifyProfilePin(profileId: string, pin: string): Promise<Result<void, KeyManagerError>> {
    try {
      const stored = await this.store.get(profileId);
      if (!stored) return err({ code: 'profile-not-found' });
      const decrypted = await decryptSeed(stored.encryptedSeed, pin);
      if (!decrypted.ok) return err({ code: 'pin-invalid', attemptsLeft: null });
      decrypted.value.fill(0);
      return ok(undefined);
    } catch {
      return err({ code: 'storage-error' });
    }
  }

  /** 由助記詞重建公鑰並比對指定 profile，僅回傳是否屬於同一身分。 */
  async verifyMnemonicForProfile(
    profileId: string,
    mnemonic: Mnemonic,
  ): Promise<Result<boolean, KeyManagerError>> {
    try {
      const stored = await this.store.get(profileId);
      if (!stored) return err({ code: 'profile-not-found' });
      const normalized = mnemonic.trim().toLowerCase().split(/\s+/u).join(' ');
      if (!validateMnemonic(normalized)) return ok(false);
      const seed = mnemonicToSeed(normalized);
      try {
        const keyPair = deriveKeyPair(seed);
        return ok(publicKeyToPeerId(keyPair.publicKey) === stored.peerId);
      } finally {
        seed.fill(0);
      }
    } catch {
      return err({ code: 'storage-error' });
    }
  }

  /** 設定後續金鑰操作使用的硬體提供者；不會自動搬移既有軟體金鑰。 */
  setHardwareProvider(provider: HardwareKeyProvider | null): void {
    this.hardware = provider;
  }

  /** 驗證 PIN 並完成刪除前回呼後移除 profile 與其身分容器；任一步驟失敗時保留資料。 */
  async deleteProfile(
    profileId: string,
    pin: string,
    beforeDelete?: (context: ProfileDeletionContext) => Promise<ProfileDeletionFinalizer | void>,
  ): Promise<Result<void, KeyManagerError>> {
    try {
      const stored = await this.store.get(profileId);
      if (!stored) return err({ code: 'profile-not-found' });
      const decrypted = await decryptSeed(stored.encryptedSeed, pin);
      if (!decrypted.ok) return err({ code: 'pin-invalid', attemptsLeft: null });
      // deriveKeyPair 刻意將 seed view 保留為 private key；刪除前必須先建立獨立且以
      // callback 為 scope 的副本，再清零解密 seed。
      const deletionKey = new Uint8Array(deriveKeyPair(decrypted.value).privateKey);
      decrypted.value.fill(0);
      let closed = false;
      const context: ProfileDeletionContext = {
        peerId: stored.peerId,
        openDomain: async (domain) => {
          if (closed) throw new Error('Profile deletion context expired');
          const container = await this.store.getIdentityContainer(stored.peerId);
          const sealed = container?.domains[domain];
          return sealed === undefined
            ? null
            : decryptIdentityDomain(deletionKey, stored.peerId, domain, sealed);
        },
      };
      let finalize: ProfileDeletionFinalizer | void;
      try {
        finalize = await beforeDelete?.(context);
      } finally {
        closed = true;
        deletionKey.fill(0);
      }
      await this.store.delete(profileId);
      await finalize?.();
      if (this.current?.profile.profileId === profileId) this.lock();
      return ok(undefined);
    } catch {
      return err({ code: 'storage-error' });
    }
  }

  /** 取得目前已解鎖 profile 的非敏感中繼資料；未解鎖或資料不存在時回傳空值。 */
  currentProfile(): Promise<ProfileMetadata | null> {
    const profile = this.current?.profile;
    return Promise.resolve(profile === undefined ? null : structuredClone(profile));
  }

  /** 更新目前 profile 可變中繼資料；未解鎖或持久化失敗時回傳具體錯誤。 */
  async updateCurrentProfile(patch: ProfileMetadataPatch): Promise<Result<void, KeyManagerError>> {
    const current = this.current;
    if (current === null) return err({ code: 'profile-not-found' });
    const nicknameValidation =
      patch.nickname === undefined ? null : validateNicknameSnapshot(patch.nickname);
    if (nicknameValidation !== null && !nicknameValidation.ok)
      return err({ code: nicknameError(nicknameValidation) });
    const safePatch: ProfileMetadataPatch = {
      ...(nicknameValidation === null ? {} : { nickname: nicknameValidation.value }),
      ...(patch.onboarding === undefined ? {} : { onboarding: structuredClone(patch.onboarding) }),
    };
    try {
      await this.store.update(current.profile.profileId, safePatch);
      current.profile = { ...current.profile, ...safePatch };
      return ok(undefined);
    } catch {
      return err({ code: 'storage-error' });
    }
  }

  /**
   * libp2p 節點鑰 seed＝master 私鑰複本（節點 PeerId 與身分 PeerId 一致——canon
   * 單一 PeerId derive 鏈）；僅供本機 libp2p 節點建構、不落盤不出程序
   */
  exportLibp2pSeed(): Uint8Array {
    return new Uint8Array(this.requireUnlocked().keyPair.privateKey);
  }

  /** 每場 ephemeral 子簽章鑰：同（master, raceId）確定性派生；賽後丟棄、避免 long-term key 暴露於高頻賽內封包 */
  deriveRaceSignKey(raceId: string): KeyPair {
    const master = this.requireUnlocked().keyPair.privateKey;
    const seed = sha256(
      new Uint8Array([
        ...master,
        ...new TextEncoder().encode('open4wd-race-sign'),
        ...new TextEncoder().encode(raceId),
      ]),
    );
    return deriveKeyPair(seed);
  }

  /** 以當前身分產生 P2P 簽章封裝（timestamp／nonce 皆入簽章範圍） */
  async signPayload<T>(payload: T): Promise<SignedPayload<T>> {
    const timestamp = this.now();
    const nonce = crypto.getRandomValues(new Uint8Array(Protocol.security.P2P_MESSAGE_NONCE_BYTES));
    const signer = this.getPeerId();
    const signature = await this.sign(buildSignedMessage(payload, timestamp, nonce, signer));
    return { payload, timestamp, nonce, signer, signature };
  }

  /** 取得目前解鎖材料，未解鎖時 fail closed。 */
  private requireUnlocked(): { profile: ProfileMetadata; keyPair: KeyPair } {
    if (!this.current) throw new Error('未解鎖');
    return this.current;
  }
}
