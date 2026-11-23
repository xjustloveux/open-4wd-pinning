/** Open4WD ledger 專用 OrbitDB access controller（manifest type 固定、決定性 admission）。 */
import * as Block from 'multiformats/block';
import * as dagCbor from '@ipld/dag-cbor';
import { base58btc } from 'multiformats/bases/base58';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import {
  ComposedStorage,
  IPFSBlockStorage,
  LRUStorage,
  useAccessController,
  type OrbitAccessControllerFactory,
  type OrbitStorage,
} from '@orbitdb/core';
import { ledgerOperationAdmissionFailure } from './ledger-admission';
import {
  LEDGER_ADMISSION_V1,
  ledgerEntryAdmissionFailure,
  type LedgerAdmissionScheme,
} from './ledger-entry-admission';

/** OrbitDB 註冊 Open4WD ledger access controller 使用的型別名稱。 */
export const OPEN4WD_LEDGER_ACCESS_TYPE = 'open4wd-ledger';
/** Access manifest 宣告 canonical admission scheme 的型別名稱。 */
export const OPEN4WD_LEDGER_ADMISSION_TYPE = 'open4wd-ledger-admission-v1';
const WRITE_POLICY = Object.freeze(['*'] as const);

interface AccessFactoryOptions {
  storage?: OrbitStorage;
  admissionScheme?: LedgerAdmissionScheme;
  ledgerAddress?: () => string | null;
}

interface AccessFactoryContext {
  orbitdb: { ipfs: unknown };
  identities: {
    getIdentity(hash: string): Promise<unknown>;
    verifyIdentity(identity: unknown): Promise<boolean>;
  };
  address?: string;
}

function isExactManifest(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    record['type'] === OPEN4WD_LEDGER_ACCESS_TYPE &&
    record['version'] === 1 &&
    record['admission'] === OPEN4WD_LEDGER_ADMISSION_TYPE &&
    Array.isArray(record['write']) &&
    record['write'].length === 1 &&
    record['write'][0] === '*'
  );
}

/** existing access-controller address 必須內容尋址且 manifest bytes 與固定 contract 相符。 */
export async function validateOpen4wdAccessManifest(
  address: string,
  storage: OrbitStorage,
): Promise<void> {
  const match = new RegExp(`^/${OPEN4WD_LEDGER_ACCESS_TYPE}/([^/]+)$`).exec(address);
  if (match === null) throw new Error('unexpected Open4WD ledger access-controller address');
  let cid: CID;
  try {
    cid = CID.parse(match[1]!, base58btc);
  } catch {
    throw new Error('invalid Open4WD ledger access-controller CID');
  }
  if (cid.version !== 1 || cid.toString(base58btc) !== match[1])
    throw new Error('non-canonical Open4WD ledger access-controller CID');
  const bytes = await storage.get(match[1]!);
  if (bytes === undefined) throw new Error('Open4WD ledger access-controller manifest unavailable');
  const decoded = await Block.decode({ bytes, codec: dagCbor, hasher: sha256 });
  if (decoded.cid.toString(base58btc) !== match[1] || !isExactManifest(decoded.value))
    throw new Error('Open4WD ledger access-controller manifest mismatch');
}

/**
 * 建立 custom access-controller factory；write policy 固定公開寫入，但每筆仍須通過
 * Orbit identity 驗證與 Open4WD ledger deterministic admission。
 */
export function Open4wdLedgerAccessController(
  options: AccessFactoryOptions = {},
): OrbitAccessControllerFactory {
  const admissionScheme = options.admissionScheme ?? LEDGER_ADMISSION_V1;
  const factory = async ({ orbitdb, identities, address }: AccessFactoryContext) => {
    const storage =
      options.storage ??
      (await ComposedStorage(
        await LRUStorage({ size: 128 }),
        await IPFSBlockStorage({ ipfs: orbitdb.ipfs, pin: true }),
      ));
    let resolvedAddress = address;
    if (resolvedAddress === undefined) {
      const encoded = await Block.encode({
        value: {
          type: OPEN4WD_LEDGER_ACCESS_TYPE,
          version: 1,
          write: WRITE_POLICY,
          admission: OPEN4WD_LEDGER_ADMISSION_TYPE,
        },
        codec: dagCbor,
        hasher: sha256,
      });
      const hash = encoded.cid.toString(base58btc);
      await storage.put(hash, encoded.bytes);
      resolvedAddress = `/${OPEN4WD_LEDGER_ACCESS_TYPE}/${hash}`;
    } else await validateOpen4wdAccessManifest(resolvedAddress, storage);
    return {
      type: OPEN4WD_LEDGER_ACCESS_TYPE,
      address: resolvedAddress,
      write: [...WRITE_POLICY],
      async canAppend(entry: unknown): Promise<boolean> {
        if ((await ledgerEntryAdmissionFailure(entry, admissionScheme)) !== null) return false;
        const admitted = entry as { identity: string; payload: unknown };
        if (
          ledgerOperationAdmissionFailure(
            admitted.payload,
            options.ledgerAddress?.() ?? undefined,
          ) !== null
        )
          return false;
        const identity = await identities.getIdentity(admitted.identity);
        return identity !== undefined && identity !== null && identities.verifyIdentity(identity);
      },
      close: () => storage.close?.(),
    };
  };
  Object.assign(factory, { type: OPEN4WD_LEDGER_ACCESS_TYPE });
  return factory as unknown as OrbitAccessControllerFactory;
}
Object.assign(Open4wdLedgerAccessController, { type: OPEN4WD_LEDGER_ACCESS_TYPE });

const admissionConfigByIpfs = new WeakMap<
  object,
  { scheme: LedgerAdmissionScheme; ledgerAddress?: () => string | null }
>();
const registeredFactory = Object.assign(
  () => async (context: AccessFactoryContext) => {
    const ipfs = context.orbitdb.ipfs;
    const config =
      typeof ipfs === 'object' && ipfs !== null ? admissionConfigByIpfs.get(ipfs) : undefined;
    const configured = Open4wdLedgerAccessController({
      admissionScheme: config?.scheme ?? LEDGER_ADMISSION_V1,
      ...(config?.ledgerAddress === undefined ? {} : { ledgerAddress: config.ledgerAddress }),
    }) as unknown as (value: AccessFactoryContext) => Promise<unknown>;
    return configured(context);
  },
  { type: OPEN4WD_LEDGER_ACCESS_TYPE },
);
let registered = false;

/** 每個 process 只註冊一次；existing address 依所屬 IPFS runtime 取回同一 admission contract。 */
export function ensureOpen4wdLedgerAccessControllerRegistered(
  ipfs?: unknown,
  admissionScheme: LedgerAdmissionScheme = LEDGER_ADMISSION_V1,
  ledgerAddress?: () => string | null,
): void {
  if (typeof ipfs === 'object' && ipfs !== null)
    admissionConfigByIpfs.set(ipfs, {
      scheme: admissionScheme,
      ...(ledgerAddress === undefined ? {} : { ledgerAddress }),
    });
  if (!registered) {
    useAccessController(registeredFactory as unknown as OrbitAccessControllerFactory);
    registered = true;
  }
}
