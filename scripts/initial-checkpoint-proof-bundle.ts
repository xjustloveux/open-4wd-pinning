import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cidMatchesBytes,
  parseInitialCheckpointProof,
  verifyInitialCheckpointProof,
  type BlockAccess,
  type CID,
  type InitialCheckpointProof,
} from '../core';

const BUNDLE_KEYS = ['version', 'proof', 'blocks'] as const;
const BLOCK_KEYS = ['cid', 'bytesBase64'] as const;
const MAX_BUNDLE_BLOCKS = 4_096;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

export interface InitialCheckpointProofBundleBlock {
  readonly cid: CID;
  readonly bytesBase64: string;
}

/** 自包含 rebirth ceremony 產物；blocks 只能含 proof 完整驗證實際讀到的塊。 */
export interface InitialCheckpointProofBundle {
  readonly version: 1;
  readonly proof: InitialCheckpointProof;
  readonly blocks: readonly InitialCheckpointProofBundleBlock[];
}

/** 已完成 descriptor、CID 與完整來源 checkpoint chain 驗證的本機資料。 */
export interface VerifiedInitialCheckpointProofBundle {
  readonly proof: InitialCheckpointProof;
  readonly blocks: ReadonlyMap<CID, Uint8Array>;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function decodeCanonicalBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError('initial checkpoint proof bundle block base64 is invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value)
    throw new TypeError('initial checkpoint proof bundle block base64 is not canonical');
  return bytes;
}

/**
 * 解析並完整離線驗證 self-contained bundle。缺塊、改塊、多塞未引用塊皆 fail closed。
 */
export async function parseInitialCheckpointProofBundle(
  value: unknown,
): Promise<VerifiedInitialCheckpointProofBundle> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value, BUNDLE_KEYS)
  )
    throw new TypeError('invalid initial checkpoint proof bundle shape');
  const wire = value as Record<string, unknown>;
  if (wire['version'] !== 1 || !Array.isArray(wire['blocks']))
    throw new TypeError('invalid initial checkpoint proof bundle version or blocks');
  if (wire['blocks'].length === 0 || wire['blocks'].length > MAX_BUNDLE_BLOCKS)
    throw new RangeError('initial checkpoint proof bundle block count exceeds bounds');

  const proof = parseInitialCheckpointProof(wire['proof']);
  const blocks = new Map<CID, Uint8Array>();
  let totalBytes = 0;
  for (const entry of wire['blocks']) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      !exactKeys(entry, BLOCK_KEYS)
    )
      throw new TypeError('invalid initial checkpoint proof bundle block shape');
    const block = entry as Record<string, unknown>;
    const cid = block['cid'];
    if (typeof cid !== 'string')
      throw new TypeError('initial checkpoint proof bundle block CID is invalid');
    if (blocks.has(cid as CID))
      throw new Error('initial checkpoint proof bundle contains a duplicate CID');
    const bytes = decodeCanonicalBase64(block['bytesBase64']);
    if (!cidMatchesBytes(cid as CID, bytes))
      throw new Error('initial checkpoint proof bundle block CID mismatch');
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BUNDLE_BYTES)
      throw new RangeError('initial checkpoint proof bundle byte size exceeds bounds');
    blocks.set(cid as CID, bytes);
  }

  const used = new Set<CID>();
  await verifyInitialCheckpointProof(proof, {
    get: (cid) => {
      used.add(cid);
      return Promise.resolve(blocks.get(cid) ?? null);
    },
  });
  if (used.size !== blocks.size)
    throw new Error('initial checkpoint proof bundle contains an unreferenced block');
  return { proof, blocks };
}

/** 由來源 block reader 擷取驗證實際使用的最小 block 集合，並在封裝前完成全證明驗證。 */
export async function createInitialCheckpointProofBundle(
  proofValue: unknown,
  source: Pick<BlockAccess, 'get'>,
): Promise<InitialCheckpointProofBundle> {
  const proof = parseInitialCheckpointProof(proofValue);
  const captured = new Map<CID, Uint8Array>();
  await verifyInitialCheckpointProof(proof, {
    get: async (cid, timeoutMs, maxBytes) => {
      const bytes = await source.get(cid, timeoutMs, maxBytes);
      if (bytes !== null) captured.set(cid, bytes);
      return bytes;
    },
  });
  const blocks = [...captured]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cid, bytes]) => ({ cid, bytesBase64: Buffer.from(bytes).toString('base64') }));
  const bundle: InitialCheckpointProofBundle = { version: 1, proof, blocks };
  await parseInitialCheckpointProofBundle(bundle);
  return bundle;
}

export function serializeInitialCheckpointProofBundle(
  bundle: InitialCheckpointProofBundle,
): string {
  return `${JSON.stringify(
    {
      version: 1,
      proof: bundle.proof,
      blocks: [...bundle.blocks].sort((left, right) => left.cid.localeCompare(right.cid)),
    },
    null,
    2,
  )}\n`;
}

async function runCli(argv: readonly string[]): Promise<void> {
  if (argv.length === 2 && argv[0] === '--verify') {
    const path = resolve(argv[1]!);
    const verified = await parseInitialCheckpointProofBundle(
      JSON.parse(await readFile(path, 'utf8')),
    );
    console.log(
      `Initial checkpoint proof bundle verified: ${verified.proof.commitment} (${verified.blocks.size} blocks)`,
    );
    return;
  }
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const argument = argv[index + 1];
    if (
      name === undefined ||
      !['--proof', '--blocks-dir', '--output'].includes(name) ||
      argument === undefined ||
      args.has(name)
    )
      throw new Error(
        'usage: --verify <bundle> OR --proof <json> --blocks-dir <dir> --output <bundle>',
      );
    args.set(name, argument);
  }
  const proofPath = args.get('--proof');
  const blocksDir = args.get('--blocks-dir');
  const outputPath = args.get('--output');
  if (proofPath === undefined || blocksDir === undefined || outputPath === undefined)
    throw new Error(
      'usage: --verify <bundle> OR --proof <json> --blocks-dir <dir> --output <bundle>',
    );
  const proof = JSON.parse(await readFile(resolve(proofPath), 'utf8'));
  const bundle = await createInitialCheckpointProofBundle(proof, {
    get: async (cid) => {
      try {
        return await readFile(join(resolve(blocksDir), `${cid}.block`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  });
  await writeFile(resolve(outputPath), serializeInitialCheckpointProofBundle(bundle), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644,
  });
  console.log(
    `Initial checkpoint proof bundle created and verified: ${bundle.proof.commitment} (${bundle.blocks.length} blocks)`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(
      `initial-checkpoint-proof-bundle: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
