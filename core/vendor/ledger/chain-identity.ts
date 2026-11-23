import { base58btc } from 'multiformats/bases/base58';
import { CID } from 'multiformats/cid';

declare const CHAIN_ID_BRAND: unique symbol;

/** OrbitDB 帳本位址中的 canonical 完整 CID segment。 */
export type ChainId = string & { readonly [CHAIN_ID_BRAND]: true };

/** 從 canonical `/orbitdb/<CIDv1-base58btc>` 位址推導唯一 chain identity。 */
export function chainIdFromLedgerAddress(ledgerAddress: string): ChainId {
  const match = /^\/orbitdb\/([^/]+)$/.exec(ledgerAddress);
  if (match === null || !match[1]!.startsWith('z'))
    throw new TypeError('invalid canonical ledger address');
  try {
    const cid = CID.parse(match[1]!, base58btc);
    if (cid.version !== 1 || cid.toString(base58btc) !== match[1])
      throw new TypeError('invalid canonical ledger address');
    return match[1] as ChainId;
  } catch (cause) {
    if (cause instanceof TypeError && cause.message === 'invalid canonical ledger address')
      throw cause;
    throw new TypeError('invalid canonical ledger address', { cause });
  }
}

/** 在不縮短 chain identity 的情況下建立確定性可變儲存 namespace。 */
export function chainStorageName(base: string, chainId: ChainId): string {
  if (base.trim().length === 0 || base.includes(':'))
    throw new TypeError('invalid chain storage base');
  return `${base}:${chainId}`;
}
