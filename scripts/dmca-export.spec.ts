import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptDmcaExport,
  encryptDmcaExport,
  writeDmcaExportExclusive,
  type NoticeRecord,
} from '../dmca';

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

const record = {
  _id: 'case-1',
  type: 'notice',
  status: 'taken_down',
  payload: {
    claimantName: 'Private Claimant',
    claimantEmail: 'private-claimant@example.org',
  },
  affectedCIDs: ['private-cid'],
  createdAt: 1,
  decisionLog: [],
  publicView: {
    noticeIdShort: 'case-1',
    claimantOrgRedacted: '個人',
    cidsAffected: ['private-cid'],
    status: 'taken_down',
    timestamps: { createdAt: 1 },
  },
} as unknown as NoticeRecord;

describe('DMCA encrypted shutdown export', () => {
  it('round-trips provider metadata and exact private records without plaintext leakage', () => {
    const passphrase = 'correct horse battery staple';
    const bytes = encryptDmcaExport(passphrase, {
      providerId: 'provider-peer-id',
      exportedAt: 1234,
      records: [record],
    });
    const raw = Buffer.from(bytes);
    expect(raw.includes(Buffer.from('private-claimant@example.org'))).toBe(false);
    expect(raw.includes(Buffer.from(passphrase))).toBe(false);
    expect(decryptDmcaExport(passphrase, bytes)).toEqual({
      providerId: 'provider-peer-id',
      exportedAt: 1234,
      records: [record],
    });
  });

  it('rejects wrong passphrase, ciphertext tampering, header tampering, and truncation', () => {
    const bytes = encryptDmcaExport('correct-passphrase', {
      providerId: 'provider-peer-id',
      exportedAt: 1234,
      records: [record],
    });
    expect(() => decryptDmcaExport('wrong-passphrase', bytes)).toThrow();
    const ciphertextTampered = Uint8Array.from(bytes);
    ciphertextTampered[ciphertextTampered.length - 1] ^= 1;
    expect(() => decryptDmcaExport('correct-passphrase', ciphertextTampered)).toThrow();
    const headerTampered = Uint8Array.from(bytes);
    headerTampered[16] ^= 1;
    expect(() => decryptDmcaExport('correct-passphrase', headerTampered)).toThrow();
    expect(() => decryptDmcaExport('correct-passphrase', bytes.slice(0, -8))).toThrow();
  });

  it('writes with exclusive create and refuses to overwrite an existing destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dmca-export-test-'));
    directories.push(directory);
    const destination = join(directory, 'archive.bin');
    const bytes = encryptDmcaExport('correct-passphrase', {
      providerId: 'provider-peer-id',
      exportedAt: 1234,
      records: [record],
    });
    writeDmcaExportExclusive(destination, bytes);
    await expect(readFile(destination)).resolves.toEqual(Buffer.from(bytes));
    expect(() => writeDmcaExportExclusive(destination, bytes)).toThrow();
  });
});
