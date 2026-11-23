/**
 * NoticeStore：dmca-notices 的儲存層，後端＝節點本地 classic-level（app-pvc）。
 * 選 level 而非帳本/blockstore 的理由：申訴人個資絕不能進 content-addressed 對外供應面，
 * 且需要真刪除（72h 未確認清除）與歸檔抹除（保留 publicView、抹聯絡個資）——append-only
 * 儲存無法滿足這兩件事。notice 與 counter-notice 共用同一個 keyspace（key＝_id），用
 * record.type 分辨；資料量天生低（法律案件、非高頻使用者資料），所有查詢都用整表掃描＋
 * 記憶體過濾實作，換取遠低於維護次索引的複雜度與出錯風險。
 */
import { ClassicLevel } from 'classic-level';
import {
  isNoticePayload,
  type DMCACounterNoticeV1,
  type DMCANotice,
  type DmcaNoticeStatus,
  type NoticeRecord,
} from './types';

// 已結案（狀態不會再變動）的集合；歸檔抹除只對這些狀態的舊案生效——仍在流程中的案件
// （pending-email-confirm／received）不能被抹，否則會截斷還在進行中的法律程序。
const CLOSED_STATUSES: ReadonlySet<DmcaNoticeStatus> = new Set([
  'taken_down',
  'rejected_by_admin',
  'restored_after_counter',
]);

const REDACTED = '[已抹除]';

/** 持久保存私人 DMCA 案件紀錄並執行有界保留操作。 */
export interface NoticeStore {
  /** 新增一筆全新案卷（notice 或 counter-notice）。 */
  create(record: NoticeRecord): Promise<void>;
  /** 覆寫既有案卷（狀態轉移、欄位更新皆走這個）。 */
  put(record: NoticeRecord): Promise<void>;
  get(id: string): Promise<NoticeRecord | undefined>;
  delete(id: string): Promise<void>;
  list(filter?: { status?: DmcaNoticeStatus }): Promise<NoticeRecord[]>;
  findByConfirmToken(token: string): Promise<NoticeRecord | undefined>;
  /** 供「同信箱冷卻」使用：該 email 是否已有一筆待確認（pending-email-confirm）案卷。 */
  findPendingByEmail(email: string): Promise<NoticeRecord | undefined>;
  /** repeat-infringer 計數：該 signer 名下、status 仍為 taken_down（尚未恢復）的 notice 數。 */
  countNotRestoredTakedowns(signer: string): Promise<number>;
  /** 歸檔抹除：processedAt 早於 before 的已結案案卷，保留 publicView、抹除聯絡個資。 */
  redactClosed(before: number): Promise<void>;
  close(): Promise<void>;
}

function emailOf(payload: DMCANotice | DMCACounterNoticeV1): string {
  return isNoticePayload(payload) ? payload.claimantEmail : payload.uploaderEmail;
}

function redactPayload(
  payload: DMCANotice | DMCACounterNoticeV1,
): DMCANotice | DMCACounterNoticeV1 {
  if (isNoticePayload(payload)) {
    payload.claimantName = REDACTED;
    payload.claimantEmail = REDACTED;
    payload.claimantPhone = REDACTED;
    payload.claimantAddress = REDACTED;
    if (payload.claimantOrganization !== undefined) payload.claimantOrganization = REDACTED;
    if (payload.agentName !== undefined) payload.agentName = REDACTED;
    payload.signature = REDACTED;
    payload.ipAddress = undefined;
    payload.userAgent = undefined;
    return payload;
  } else {
    return {
      ...payload,
      uploaderName: REDACTED,
      uploaderEmail: REDACTED,
      uploaderPhone: REDACTED,
      uploaderAddress: REDACTED,
      signature: REDACTED,
    };
  }
}

/** 在營運者選定的本機路徑開啟 Level 私人案件儲存。 */
export function createNoticeStore(location: string): NoticeStore {
  const db = new ClassicLevel<string, NoticeRecord>(location, { valueEncoding: 'json' });

  const all = async (): Promise<NoticeRecord[]> => {
    const records: NoticeRecord[] = [];
    for await (const [, value] of db.iterator()) records.push(value);
    return records;
  };

  return {
    async create(record) {
      await db.put(record._id, record);
    },

    async put(record) {
      await db.put(record._id, record);
    },

    async get(id) {
      return db.get(id);
    },

    async delete(id) {
      await db.del(id);
    },

    async list(filter) {
      const records = await all();
      const filtered =
        filter?.status === undefined ? records : records.filter((r) => r.status === filter.status);
      return filtered.sort((a, b) => b.createdAt - a.createdAt);
    },

    async findByConfirmToken(token) {
      const records = await all();
      return records.find((r) => r.confirmToken === token);
    },

    async findPendingByEmail(email) {
      const records = await all();
      return records.find(
        (r) => r.status === 'pending-email-confirm' && emailOf(r.payload) === email,
      );
    },

    async countNotRestoredTakedowns(signer) {
      const records = await all();
      return records.filter((r) => {
        if (r.type !== 'notice' || r.status !== 'taken_down') return false;
        return Object.values(r.uploaderByCid ?? {}).includes(signer);
      }).length;
    },

    async redactClosed(before) {
      const records = await all();
      const byId = new Map(records.map((r) => [r._id, r]));
      for (const r of records) {
        if (r.type === 'notice') {
          if (
            CLOSED_STATUSES.has(r.status) &&
            r.processedAt !== undefined &&
            r.processedAt < before
          ) {
            r.payload = redactPayload(r.payload);
            await db.put(r._id, r);
          }
        } else {
          // counter-notice 自身沒有 taken_down/restored 狀態（那組狀態只活在對應的原始
          // notice 上），要不要抹要看它所反通知的那筆原始案卷是否已結案。
          const counter = r.payload as DMCACounterNoticeV1;
          const original = byId.get(counter.originalNoticeId);
          if (
            original !== undefined &&
            CLOSED_STATUSES.has(original.status) &&
            original.processedAt !== undefined &&
            original.processedAt < before
          ) {
            r.payload = redactPayload(r.payload);
            await db.put(r._id, r);
          }
        }
      }
    },

    async close() {
      await db.close();
    },
  };
}
