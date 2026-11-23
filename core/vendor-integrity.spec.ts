import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Protocol } from '@open4wd/system-constants';
import { auditVendorImportClosure } from '../scripts/vendor-closure';

describe('vendored 閉包完整性', () => {
  it('MANIFEST 檔數＝清單檔數且逐檔存在', () => {
    const manifest = JSON.parse(readFileSync('core/vendor/MANIFEST.json', 'utf8')) as {
      files: { path: string }[];
    };
    const list = JSON.parse(readFileSync('scripts/vendor-list.json', 'utf8')) as {
      files: string[];
    };
    expect(manifest.files.length).toBe(list.files.length);
  });

  it('清單涵蓋每個 vendored TypeScript 檔的相對 import/export 閉包', () => {
    const list = JSON.parse(readFileSync('scripts/vendor-list.json', 'utf8')) as {
      files: string[];
    };
    expect(
      auditVendorImportClosure(
        list.files.map((path) => ({
          path,
          text: readFileSync(`core/vendor/${path}`, 'utf8'),
        })),
      ),
    ).toEqual([]);
  });

  it('協定常數可自 alias 匯入', () => {
    expect(Protocol.security.P2P_MESSAGE_TIMESTAMP_TOLERANCE_SEC).toBe(30);
  });
});
