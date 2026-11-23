import * as dagCbor from '@ipld/dag-cbor';
import type { PeerId } from '@open4wd/interfaces';
import type { Open4wdKeyManager } from './key-manager';
import type { StoredIdentityContainer } from './profile-store';

const MAX_DOMAIN_BYTES = 1024 * 1024;
const MAX_CAS_ATTEMPTS = 8;

/** 將解密後的 domain wire value 驗證並收斂為應用型別。 */
export type IdentityDomainDecoder<T> = (value: unknown) => T;

/**
 * 已解鎖且以身分為 scope 的 write-through workspace。加密記錄具有權威性；
 * revision CAS 可保護無關 domain 與並行分頁，避免遺失更新。
 */
export class IdentityContainerWorkspace {
  /** 提供目前解鎖身分與 domain 加解密、CAS 操作。 */
  readonly #keyManager: Open4wdKeyManager;
  /** 序列化同一 workspace 的寫入以避免本頁內 lost update。 */
  #writeTail: Promise<void> = Promise.resolve();
  /** 依 peer、domain 與 container revision 驗證的解碼快取。 */
  readonly #cache = new Map<string, { revision: number; value: unknown }>();

  constructor(keyManager: Open4wdKeyManager) {
    this.#keyManager = keyManager;
  }

  /** 取得目前工作區綁定的節點身分；工作區建立後不允許切換至其他 profile。 */
  currentPeerId(): PeerId {
    return this.#keyManager.getPeerId();
  }

  /** 解密並解碼指定 profile 網域資料；尚未初始化時使用呼叫端提供的預設值。 */
  async read<T>(domain: string, decode: IdentityDomainDecoder<T>, fallback: () => T): Promise<T> {
    const peerId = this.#keyManager.getPeerId();
    const container = await this.#keyManager.getIdentityContainer();
    const revision = container?.revision ?? 0;
    const cacheKey = `${peerId}\0${domain}`;
    const cached = this.#cache.get(cacheKey);
    if (cached?.revision === revision) return decode(cached.value);
    const sealed = container?.domains[domain];
    if (sealed === undefined) return fallback();
    const plaintext = await this.#keyManager.openIdentityDomain(domain, sealed);
    if (plaintext.byteLength > MAX_DOMAIN_BYTES)
      throw new Error('Identity data domain is too large');
    const value = dagCbor.decode(plaintext);
    const decoded = decode(value);
    this.#cache.set(cacheKey, { revision, value: decoded });
    return decoded;
  }

  /** 在同一 profile 修訂版上讀取、修改並重新加密網域資料，衝突時重試避免覆寫並行更新。 */
  mutate<T>(
    domain: string,
    decode: IdentityDomainDecoder<T>,
    fallback: () => T,
    mutate: (current: T) => T | Promise<T>,
  ): Promise<T> {
    const result = this.#writeTail.then(async () => {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const peerId = this.#keyManager.getPeerId();
        const container = await this.#keyManager.getIdentityContainer();
        if (this.#keyManager.getPeerId() !== peerId)
          throw new Error('Identity changed during container mutation');
        const current = await this.#decodeCurrent(domain, container, decode, fallback);
        const value = await mutate(current);
        const encoded = dagCbor.encode(value);
        if (encoded.byteLength > MAX_DOMAIN_BYTES)
          throw new Error('Identity data domain is too large');
        const sealed = await this.#keyManager.sealIdentityDomain(domain, encoded);
        if (this.#keyManager.getPeerId() !== peerId)
          throw new Error('Identity changed during container mutation');
        const revision = (container?.revision ?? 0) + 1;
        const next: StoredIdentityContainer = {
          schemaVersion: 1,
          peerId: peerId as PeerId,
          revision,
          domains: { ...(container?.domains ?? {}), [domain]: sealed },
        };
        if (
          await this.#keyManager.compareAndSwapIdentityContainer(container?.revision ?? null, next)
        ) {
          this.#cache.set(`${peerId}\0${domain}`, { revision, value });
          return value;
        }
      }
      throw new Error('Identity container write conflict');
    });
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 僅在指定身分網域尚未存在時寫入初始值，回傳是否實際完成初始化。 */
  initialize(domain: string, value: unknown): Promise<boolean> {
    const result = this.#writeTail.then(async () => {
      const encoded = dagCbor.encode(value);
      if (encoded.byteLength > MAX_DOMAIN_BYTES)
        throw new Error('Identity data domain is too large');
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const peerId = this.#keyManager.getPeerId();
        const container = await this.#keyManager.getIdentityContainer();
        if (container?.domains[domain] !== undefined) return false;
        const sealed = await this.#keyManager.sealIdentityDomain(domain, encoded);
        const revision = (container?.revision ?? 0) + 1;
        const next: StoredIdentityContainer = {
          schemaVersion: 1,
          peerId,
          revision,
          domains: { ...(container?.domains ?? {}), [domain]: sealed },
        };
        if (
          await this.#keyManager.compareAndSwapIdentityContainer(container?.revision ?? null, next)
        )
          return true;
      }
      throw new Error('Identity container initialization conflict');
    });
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 清除工作區持有的已解密快取，使後續讀取重新驗證目前容器修訂版。 */
  clearCache(): void {
    this.#cache.clear();
  }

  /** 解密並解碼目前容器中的指定網域；格式或網域綁定不符時拒絕。 */
  async #decodeCurrent<T>(
    domain: string,
    container: StoredIdentityContainer | null,
    decode: IdentityDomainDecoder<T>,
    fallback: () => T,
  ): Promise<T> {
    const sealed = container?.domains[domain];
    if (sealed === undefined) return fallback();
    const plaintext = await this.#keyManager.openIdentityDomain(domain, sealed);
    if (plaintext.byteLength > MAX_DOMAIN_BYTES)
      throw new Error('Identity data domain is too large');
    return decode(dagCbor.decode(plaintext));
  }
}
