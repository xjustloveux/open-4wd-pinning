/**
 * DMCA 案卷加密匯出 CLI——唯一格式為版本化 authenticated header＋AES-256-GCM payload。
 *
 * 用法：DMCA_PROVIDER_ID=<PeerId> DMCA_EXPORT_PASSPHRASE=<pass> tsx scripts/dmca-export.ts [輸出檔路徑]
 *   - 案卷 store 路徑＝env DMCA_NOTICE_STORE，或 <DATA_DIR|./data>/dmca-notices（與 app 一致）。
 *   - passphrase 只從 env 讀，刻意不收命令列參數——避免金鑰留在 shell 歷史或 process 列表。
 *   - 輸出＝argv[2]，或 env DMCA_EXPORT_OUT，或預設 dmca-export-<timestamp>.bin。
 *   - 產物＝版本化、authenticated header 加 AES-256-GCM ciphertext。
 *   - 目的檔已存在時拒絕覆寫。
 *
 * ⚠️ NoticeStore 後端是 classic-level（獨佔鎖）：本指令需要對 store 目錄的獨佔存取——請在服務
 *    停機時執行，或對複製出來的 store 目錄執行（DMCA_NOTICE_STORE 指向副本）。
 *
 * 結束碼：0＝成功、1＝失敗、2＝用法錯誤。
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNoticeStore, encryptDmcaExport, writeDmcaExportExclusive } from '../dmca';

export async function runDmcaExport(): Promise<number> {
  const passphrase = process.env['DMCA_EXPORT_PASSPHRASE'];
  if (passphrase === undefined || passphrase.trim() === '') {
    console.error('用法錯誤：請以 env DMCA_EXPORT_PASSPHRASE 提供加密金鑰（勿放命令列）');
    return 2;
  }

  const dataDir = process.env['DATA_DIR'] ?? './data';
  const storePath = process.env['DMCA_NOTICE_STORE'] ?? join(dataDir, 'dmca-notices');
  const providerId = process.env['DMCA_PROVIDER_ID'];
  if (providerId === undefined || providerId.trim() === '') {
    console.error('用法錯誤：請以 env DMCA_PROVIDER_ID 提供此節點的固定 provider PeerId');
    return 2;
  }
  const outPath =
    process.argv[2] ?? process.env['DMCA_EXPORT_OUT'] ?? `dmca-export-${Date.now()}.bin`;

  const store = createNoticeStore(storePath);
  try {
    const bytes = encryptDmcaExport(passphrase, {
      providerId: providerId.trim(),
      exportedAt: Date.now(),
      records: await store.list(),
    });
    delete process.env['DMCA_EXPORT_PASSPHRASE'];
    writeDmcaExportExclusive(outPath, bytes);
    console.log(`DMCA 案卷已加密匯出：${outPath}（${bytes.byteLength} bytes）`);
    return 0;
  } catch (error) {
    console.error(`DMCA 匯出失敗：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    delete process.env['DMCA_EXPORT_PASSPHRASE'];
    await store.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runDmcaExport().then((code) => process.exit(code));
}
