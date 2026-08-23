/**
 * SRI 工具 — 為資源計算 Subresource Integrity hash（sha384）
 * 自有 bundle 的 SRI 由 build（angular.json subresourceIntegrity）產生；本工具供腳本／診斷用
 */
export async function computeSRI(url: string, algo: 'sha384' = 'sha384'): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`); // 錯誤頁雜湊沒有意義
  const buffer = await response.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-384', buffer);
  return `${algo}-${btoa(String.fromCharCode(...new Uint8Array(hash)))}`;
}
