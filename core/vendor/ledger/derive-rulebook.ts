/**
 * 鏈錨定 derive 規則簿。
 *
 * 規則 epoch 只能由已編譯進 client 的 entry CID 邊界推進：錨點本身仍套舊規則，
 * 成功 fold 後才切換 epoch，所以下一筆 accepted entry 才開始使用新規則。
 */
import type { LedgerEvent } from '@open4wd/interfaces';
import { applyEvent, type ApplierRegistry, type DerivedState } from './derived-state';

/** 一段由 entry CID 錨點啟用的 derive logic 與 reducer registry。 */
export interface DeriveEra {
  readonly id: string;
  readonly deriveLogicVersion: number;
  readonly activation: { readonly afterEntryCid: string } | null;
  readonly registry: ApplierRegistry;
  readonly statefulGuard?: (state: DerivedState, event: LedgerEvent) => boolean;
}

/** 由 genesis 起依序排列、編譯進 client 的 derive eras。 */
export interface DeriveRulebook {
  readonly genesisEraId: string;
  readonly eras: readonly DeriveEra[];
}

/** Stateful guard 是否接受 entry，以及相應的下一個 derived state。 */
export interface LedgerEntryFoldResult {
  readonly accepted: boolean;
  readonly state: DerivedState;
}

function validateRulebook(rulebook: DeriveRulebook): void {
  if (rulebook.eras.length === 0) throw new Error('derive rulebook must contain an era');
  const ids = new Set<string>();
  const anchors = new Set<string>();
  let genesisCount = 0;
  for (const era of rulebook.eras) {
    if (era.id.length === 0 || ids.has(era.id)) throw new Error('derive era id must be unique');
    ids.add(era.id);
    if (!Number.isSafeInteger(era.deriveLogicVersion) || era.deriveLogicVersion < 1)
      throw new Error('derive logic version must be a positive integer');
    if (era.activation === null) {
      genesisCount++;
      if (era.id !== rulebook.genesisEraId)
        throw new Error('only the genesis derive era may omit activation');
      continue;
    }
    if (era.activation.afterEntryCid.length === 0)
      throw new Error('derive era activation anchor must be non-empty');
    if (anchors.has(era.activation.afterEntryCid))
      throw new Error('derive era activation anchors must be unique');
    anchors.add(era.activation.afterEntryCid);
  }
  if (genesisCount !== 1 || rulebook.eras[0]?.id !== rulebook.genesisEraId)
    throw new Error('derive rulebook must start with exactly one genesis era');
}

/** 為尚無升級錨點的部署建立單一 genesis era rulebook。 */
export function singleEraRulebook(
  id: string,
  deriveLogicVersion: number,
  registry: ApplierRegistry,
): DeriveRulebook {
  const rulebook: DeriveRulebook = {
    genesisEraId: id,
    eras: [{ id, deriveLogicVersion, activation: null, registry }],
  };
  validateRulebook(rulebook);
  return rulebook;
}

/** 以目前 era guard/reducers fold entry，並在錨點後切換下一 era。 */
export function applyLedgerEntry(
  state: DerivedState,
  event: LedgerEvent,
  entryCid: string,
  rulebook: DeriveRulebook,
): LedgerEntryFoldResult {
  validateRulebook(rulebook);
  const eraIndex = rulebook.eras.findIndex((era) => era.id === state.deriveRuleEpoch);
  if (eraIndex < 0) throw new Error(`unknown derive rule epoch: ${state.deriveRuleEpoch}`);
  const era = rulebook.eras[eraIndex]!;
  if (era.statefulGuard !== undefined && !era.statefulGuard(state, event))
    return { accepted: false, state };

  let nextState = applyEvent(state, event, era.registry);
  const nextEra = rulebook.eras[eraIndex + 1];
  if (nextEra?.activation?.afterEntryCid === entryCid)
    nextState = { ...nextState, deriveRuleEpoch: nextEra.id };
  return { accepted: true, state: nextState };
}
