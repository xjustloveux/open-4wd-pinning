import type { BaseEvent, LedgerEvent } from '@open4wd/interfaces';
import { lowercaseHex } from '../encoding/bytes';
import type { DerivedState } from './derived-state';
import { ledgerSignedIntentDigest } from './ledger-signing';

/** 需要以完整已簽意圖識別、避免重包 entry 重複扣款的經濟事件。 */
export type PaymentIntentEvent = BaseEvent & {
  type: 'ugc-sponsor-burn' | 'ugc-maintenance';
};

/** 只有會累積扣款且無天然序號守門的兩種 UGC 事件使用此持久冪等鍵。 */
export function isPaymentIntentEvent(event: Pick<LedgerEvent, 'type'>): boolean {
  return event.type === 'ugc-sponsor-burn' || event.type === 'ugc-maintenance';
}

/** 64 位小寫 hex，來源只含 chain-bound 已簽事件，不含 Orbit entry 包裝。 */
export function paymentIntentDigest(event: PaymentIntentEvent): string {
  return lowercaseHex(ledgerSignedIntentDigest(event));
}

/** writer、live validator 與 fold reducer 共用的已消費意圖判定。 */
export function hasProcessedPaymentIntent(state: DerivedState, event: PaymentIntentEvent): boolean {
  return state.economy.processedPaymentIntents.has(paymentIntentDigest(event));
}
