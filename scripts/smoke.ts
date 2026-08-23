/**
 * 部署後 smoke：GET <baseUrl>/stats 回 200 且回應含 node_id 即通過。
 * 用法：tsx scripts/smoke.ts http://127.0.0.1:8000
 *
 * 結束碼比照 signaling smoke：0＝通過、1＝失敗（連線／狀態碼／內容不符）、2＝用法錯誤。
 */
import { pinningStatsUrl, validatePinningStats } from './smoke-lib';

async function run(baseUrl: string, strict: boolean): Promise<number> {
  let target: string;
  try {
    target = pinningStatsUrl(baseUrl);
  } catch (error) {
    console.error(`smoke 失敗：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(15_000) });
    if (res.status !== 200) {
      console.error(`smoke 失敗：${target} 回應 HTTP ${res.status}`);
      return 1;
    }
    const body: unknown = await res.json();
    const finding = validatePinningStats(body, strict);
    if (finding !== null) {
      console.error(`smoke 失敗：${finding}`);
      return 1;
    }
    const stats = body as {
      node_id: string;
      ipfs_cluster_peers?: number;
      available_space_bytes?: number;
    };
    console.log(
      strict
        ? `strict smoke 通過（node_id=${stats.node_id}，ipfs_cluster_peers=${stats.ipfs_cluster_peers}，available_space_bytes=${stats.available_space_bytes}）`
        : `liveness smoke 通過（node_id=${stats.node_id}）`,
    );
    return 0;
  } catch (error) {
    console.error(`smoke 失敗：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const positional = args.filter((argument) => argument !== '--strict');
const base = positional[0];
if (
  base === undefined ||
  positional.length !== 1 ||
  args.some((argument) => argument.startsWith('--') && argument !== '--strict')
) {
  console.error('用法：tsx scripts/smoke.ts [--strict] <base url>（例：http://127.0.0.1:8000）');
  process.exit(2);
}

void run(base, strict).then((code) => process.exit(code));
