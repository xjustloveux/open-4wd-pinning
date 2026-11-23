import type { CID } from '@open4wd/interfaces';
import type { AssetVersionDerivedState } from '../ledger/derived-state';

/** 版本 concrete CID → 不變的首 CID 血緣節點；舊 checkpoint/未知 CID 以自身為節點。 */
export function resolveLineageNode(cid: CID, state: AssetVersionDerivedState): CID {
  return state.lineageNodeByCid.get(cid) ?? cid;
}
