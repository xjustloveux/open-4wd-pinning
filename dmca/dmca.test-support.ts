/**
 * DMCA 測試共用替身：真 level（tmpdir）＋捕獲式 mailer＋stub executor＋假時鐘。
 * makeService() 是唯一入口，回傳的 svc 與捕獲替身之間用 WeakMap 綁定，讓 confirmedNotice／
 * confirmedCounter 只需要拿到 svc 就能找回對應的 mail 捕獲器讀出確認 token——不必額外把
 * mail 當參數傳來傳去，呼叫端寫法可以貼近真實案例操作流程（提交→（人工）點信箱連結→受理）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addBusinessDays } from './business-days';
import type { Mailer } from './mailer';
import { createDmcaService, type Clock, type DmcaExecutor, type DmcaService } from './service';
import { createNoticeStore, type NoticeStore } from './store';
import type {
  DMCACounterNoticeV1,
  DMCANotice,
  DmcaPinMetadata,
  InfringingContentItem,
} from './types';

export interface CapturedMail {
  to: string;
  subject: string;
  text: string;
}

export interface CapturingMailer extends Mailer {
  readonly log: readonly CapturedMail[];
  readonly sentTo: readonly string[];
  /** 掃描目前捕獲到的信件，取出最後一封「確認信」內夾帶的一次性 token。 */
  lastConfirmToken(): string;
  /** 統計寄給某個信箱的「確認信」封數（只算帶 token 的那種，不含 Agent／權利人通知信）。 */
  confirmMailsTo(email: string): number;
  /** 讓下一次 send() 呼叫拋出例外（模擬 SMTP 暫時掛掉），只消耗一次、之後恢復正常寄送——
   * 供「寄信失敗不鎖死申訴人／同信箱冷卻允許重試」測試使用（service.ts safeSend 的
   * 例外收斂行為）。 */
  failNextSend(): void;
}

// 與 service.ts 的 confirmMailText() 約定的可辨識標記；服務端只要在確認信文字裡帶這個
// 標記加 token，測試端就能反解出來，兩邊不需要共用任何額外的型別或常數模組。
const CONFIRM_TOKEN_MARKER = 'Confirm token: ';

export function createCapturingMailer(): CapturingMailer {
  const log: CapturedMail[] = [];
  const sentTo: string[] = [];
  let failNext = false;

  return {
    log,
    sentTo,
    async send(to, subject, text) {
      if (failNext) {
        failNext = false; // 只消耗一次，之後恢復正常寄送
        throw new Error('模擬 SMTP 寄送失敗（測試用）');
      }
      log.push({ to, subject, text });
      sentTo.push(to);
    },
    lastConfirmToken() {
      // token 本身是純 hex 字串，用字元類別把它從標記後面截出來——不能整段 slice 到字串
      // 尾端，確認信文字裡 token 後面還接著其他說明句子，會把後續文字一起吞進來。
      for (let i = log.length - 1; i >= 0; i--) {
        const match = /Confirm token: ([0-9a-f]+)/.exec(log[i].text);
        if (match !== null) return match[1];
      }
      throw new Error('沒有捕獲到任何確認信，無法取得 confirm token');
    },
    confirmMailsTo(email) {
      return log.filter((m) => m.to === email && m.text.includes(CONFIRM_TOKEN_MARKER)).length;
    },
    failNextSend() {
      failNext = true;
    },
  };
}

export interface StubExecutor extends DmcaExecutor {
  readonly unpinned: string[];
  readonly repinned: string[];
  readonly uploaderPeerIds: Map<string, string>;
  readonly pinMetadataByCid: Map<string, DmcaPinMetadata>;
  readonly missingCids: Set<string>;
  uploaderPeerIdFor(cid: string): Promise<string | undefined>;
  pinMetadataFor(cid: string): Promise<DmcaPinMetadata | undefined>;
  hasExactBytes(cid: string): Promise<boolean>;
  failNextUnpin(): void;
}

export function createStubExecutor(): StubExecutor {
  const unpinned: string[] = [];
  const repinned: string[] = [];
  const uploaderPeerIds = new Map<string, string>();
  const pinMetadataByCid = new Map<string, DmcaPinMetadata>();
  const missingCids = new Set<string>();
  let rejectNextUnpin = false;
  return {
    unpinned,
    repinned,
    uploaderPeerIds,
    pinMetadataByCid,
    missingCids,
    async uploaderPeerIdFor(cid) {
      return uploaderPeerIds.get(cid) ?? pinMetadataByCid.get(cid)?.signer;
    },
    async pinMetadataFor(cid) {
      return pinMetadataByCid.get(cid);
    },
    async hasExactBytes(cid) {
      return !missingCids.has(cid);
    },
    async unpin(cids) {
      if (rejectNextUnpin) {
        rejectNextUnpin = false;
        throw new Error('stub unpin unavailable');
      }
      unpinned.push(...cids);
    },
    async restore(cids) {
      repinned.push(...cids);
    },
    failNextUnpin() {
      rejectNextUnpin = true;
    },
  };
}

export interface TestClock extends Clock {
  advance(ms: number): void;
  advanceBusinessDays(days: number): void;
}

const DEFAULT_START_MS = 1_700_000_000_000;

export function createTestClock(startMs: number = DEFAULT_START_MS): TestClock {
  let current = startMs;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    advanceBusinessDays(days) {
      current = addBusinessDays(current, days);
    },
  };
}

// svc 實例 → 建立它時所配的捕獲式 mailer；confirmedNotice/confirmedCounter 靠這個找回對應
// 的 mail 捕獲器。每次 makeService() 都是全新物件，不同測試之間不會互相污染。
const mailByService = new WeakMap<DmcaService, CapturingMailer>();
const executorByService = new WeakMap<DmcaService, StubExecutor>();

interface CreatedStore {
  store: NoticeStore;
  dir: string;
}
const createdStores: CreatedStore[] = [];

export interface MadeService {
  svc: DmcaService;
  mail: CapturingMailer;
  executor: StubExecutor;
  clock: TestClock;
  store: NoticeStore;
}

export async function makeService(): Promise<MadeService> {
  const dir = await mkdtemp(join(tmpdir(), 'dmca-test-'));
  const store = createNoticeStore(join(dir, 'dmca-notices'));
  const mail = createCapturingMailer();
  const executor = createStubExecutor();
  const clock = createTestClock();
  const svc = createDmcaService({
    store,
    mailer: mail,
    executor,
    clock,
    agentEmail: 'agent@example.org',
  });
  mailByService.set(svc, mail);
  executorByService.set(svc, executor);
  createdStores.push({ store, dir });
  return { svc, mail, executor, clock, store };
}

/** 每個 it() 結束後呼叫：關閉本次測試建立的所有 level handle 並清掉 tmpdir，避免留下一堆
 * 殘留的暫存目錄／檔案鎖。 */
export async function cleanupAll(): Promise<void> {
  while (createdStores.length > 0) {
    const entry = createdStores.pop();
    if (entry === undefined) continue;
    await entry.store.close();
    await rm(entry.dir, { recursive: true, force: true });
  }
}

function mailOf(svc: DmcaService): CapturingMailer {
  const mail = mailByService.get(svc);
  if (mail === undefined) {
    throw new Error('svc 不是經 makeService() 建立的實例，找不到對應的 mailer 捕獲替身');
  }
  return mail;
}

export function validNotice(email = 'claimant@example.org'): DMCANotice {
  return {
    claimantName: 'Claimant Person',
    claimantEmail: email,
    claimantPhone: '+1-555-0100',
    claimantAddress: '123 Main St, Springfield',
    isAuthorizedAgent: false,
    copyrightedWork: {
      title: 'Original Vehicle Design',
      type: 'design',
      descriptionOfWork: '具原創性的車體外觀設計',
    },
    infringingContent: [
      {
        type: 'part',
        cid: 'cidPlaceholder',
        url: 'https://example.org/part/cidPlaceholder',
        description: 'infringing part',
      },
    ],
    goodFaithStatement: true,
    perjuryStatement: true,
    signature: 'Claimant Person',
    signatureDate: '2026-07-20',
    submittedAt: Date.now(),
  };
}

/** 送出一筆以 cids/signer 客製 infringingContent 的 notice，並立刻用捕獲到的 token 完成
 * 信箱確認，回傳 noticeId。 */
export async function confirmedNotice(
  svc: DmcaService,
  cids: string[],
  signer = 'signerDefault',
): Promise<string> {
  const executor = executorByService.get(svc);
  if (executor === undefined) throw new Error('svc 不是經 makeService() 建立的實例');
  for (const cid of cids) {
    if (!executor.uploaderPeerIds.has(cid)) executor.uploaderPeerIds.set(cid, signer);
  }
  const notice = validNotice();
  notice.infringingContent = cids.map((cid): InfringingContentItem => ({
    type: 'part',
    cid,
    url: `https://example.org/part/${cid}`,
    description: 'infringing part',
    creatorPeerId: signer,
  }));
  const { noticeId } = await svc.submitNotice(notice);
  await svc.confirmEmail(mailOf(svc).lastConfirmToken());
  return noticeId;
}

/** 針對 originalNoticeId 送出一筆反通知（沿用原案的 affectedCIDs 作為 takenDownContent），
 * 並立刻完成信箱確認，回傳 counterNoticeId。 */
export function validCounter(
  originalNoticeId: string,
  cids: readonly string[],
): DMCACounterNoticeV1 {
  return {
    schemaVersion: 1,
    uploaderName: 'Uploader Person',
    uploaderEmail: 'uploader@example.org',
    uploaderPhone: '+1-555-0101',
    uploaderAddress: '456 Side St, Shelbyville',
    originalNoticeId,
    takenDownContent: cids.map((cid) => ({
      cid,
      url: `https://example.org/part/${cid}`,
      description: 'my content',
    })),
    goodFaithMistakeOrMisidentification: true,
    federalDistrict: 'United States District Court for the District of Example',
    acceptsServiceFromClaimant: true,
    perjuryStatement: true,
    signature: 'Uploader Person',
    signatureDate: '2026-07-20',
    submittedAt: Date.now(),
  };
}

export async function confirmedCounter(
  svc: DmcaService,
  originalNoticeId: string,
): Promise<string> {
  const original = await svc.getNotice(originalNoticeId);
  if (original === undefined) {
    throw new Error(`confirmedCounter：原始 notice 不存在：${originalNoticeId}`);
  }

  const counter = validCounter(originalNoticeId, original.affectedCIDs);
  const signer = Object.values(original.uploaderByCid ?? {})[0] ?? 'uploaderPeer1';
  const { counterNoticeId } = await svc.submitCounter(
    {
      mode: 'signed-uploader',
      signed: {
        payload: counter,
        timestamp: Date.now(),
        nonceHex: '00'.repeat(16),
        signer,
        signatureHex: '00'.repeat(64),
      },
    },
    signer,
  );
  return counterNoticeId;
}
