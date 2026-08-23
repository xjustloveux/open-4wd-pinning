import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PINNING_QUOTA_REASONS, Protocol } from '../core';

const source = (path: string): Promise<string> =>
  readFile(resolve(import.meta.dirname, '..', path), 'utf8');

describe('cross-repository canonical contract consumers', () => {
  it('receives the complete HTTP 507 vocabulary through the vendored interface', () => {
    expect(PINNING_QUOTA_REASONS).toEqual([
      'signer-pins',
      'signer-size',
      'global-size',
      'in-flight',
      'reservation-exceeded',
      'accounting-unavailable',
    ]);
  });

  it('receives the canonical UGC content profile through vendored protocol constants', () => {
    expect(Protocol.ugc).toMatchObject({
      UGC_CHUNK_BYTES: 1_048_576,
      UGC_LOGICAL_MAX_BYTES: 83_886_080,
      UGC_MAX_BLOCKS: 81,
      UGC_MAX_UNIXFS_LINKS: 80,
    });
  });

  it.each(['subscriber/dag-transfer.ts', 'api/provider-descriptor.ts'])(
    '%s consumes the canonical UGC profile instead of numeric copies',
    async (path) => {
      const text = await source(path);
      expect(text).toContain('Protocol.ugc');
      expect(text).not.toMatch(/const UGC_(?:CHUNK_BYTES|LOGICAL_MAX_BYTES|MAX_LINKS)\s*=/);
      expect(text).not.toMatch(/(?:chunk_bytes|max_logical_bytes|max_blocks):\s*[\d_]/);
    },
  );

  it('quota typing consumes the canonical HTTP 507 reason vocabulary', async () => {
    const text = await source('pinning/quota.ts');
    expect(text).toContain('PinningQuotaReason');
    expect(text).not.toMatch(/reason\?:\s*\n\s*\|\s*'signer-pins'/);
  });
});
