/**
 * Mailer：DMCA 模組寄信的唯一出口（SMTP 經 nodemailer）。「同信箱冷卻」需要知道 store 裡
 * 是否已有未確認案，屬於 service 層才有的domain 知識，不下放到這裡；本檔只負責通用的
 * 全域寄信速率上限（佇列封頂）——保護 SMTP 帳號信譽，避免任何呼叫端的迴圈/bug 把信箱
 * 服務商判定為濫發來源。測試替身（capturing double）定義在 dmca.test-support.ts。
 */
import { createTransport } from 'nodemailer';
import type { DMCACounterNoticeV1 } from './types';

/** 傳送營運者控制的郵件，且不向領域層暴露具體傳輸實作。 */
export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** 表示有界郵件佇列無法再接受一筆投遞。 */
export class MailerQueueFullError extends Error {
  constructor() {
    super('mailer-queue-full');
    this.name = 'MailerQueueFullError';
  }
}

/** 透過設定的郵件管道將反通知投遞給原申訴人。 */
export interface CounterNoticeDeliveryPort {
  deliverToClaimant(input: {
    readonly claimantEmail: string;
    readonly counterNotice: DMCACounterNoticeV1;
  }): Promise<void>;
}

/** 將通用郵件器轉接為反通知投遞連接埠。 */
export function createMailerCounterNoticeDelivery(mailer: Mailer): CounterNoticeDeliveryPort {
  return {
    async deliverToClaimant({ claimantEmail, counterNotice }) {
      const content = counterNotice.takenDownContent
        .map(
          (item, index) =>
            `${index + 1}. CID: ${item.cid}\nOriginal URL: ${item.url}\nDescription: ${item.description}`,
        )
        .join('\n\n');
      await mailer.send(
        claimantEmail,
        'DMCA counter-notice received',
        [
          `Schema version: ${counterNotice.schemaVersion}`,
          `Uploader name: ${counterNotice.uploaderName}`,
          `Uploader email: ${counterNotice.uploaderEmail}`,
          `Uploader phone: ${counterNotice.uploaderPhone}`,
          `Uploader address: ${counterNotice.uploaderAddress}`,
          `Original notice ID: ${counterNotice.originalNoticeId}`,
          `Removed content and original locations:\n${content}`,
          'Good-faith statement: removal resulted from mistake or misidentification.',
          'Perjury statement: the counter-notice is submitted under penalty of perjury.',
          `Federal District Court: ${counterNotice.federalDistrict}`,
          'Service acceptance: accepts service from the claimant or claimant agent.',
          `Signature: ${counterNotice.signature}`,
          `Signature date: ${counterNotice.signatureDate}`,
          `Submitted at: ${new Date(counterNotice.submittedAt).toISOString()}`,
        ].join('\n\n'),
      );
    },
  };
}

/** 設定 SMTP 訊息身分與待處理投遞佇列上限。 */
export interface MailerOptions {
  /**
   * 同時在途（尚未 sendMail 完成）的寄信數上限。超過時新請求直接捨棄並記警告，不進佇列
   * 排隊等待——DMCA 通知信不是關鍵路徑（案卷本身已經寫入 store），寧可少一封信、也不要
   * 讓佇列無限堆積拖垮 SMTP 憑證信譽或拖住呼叫端。
   */
  maxInFlight?: number;
}

const DEFAULT_MAX_IN_FLIGHT = 20;

/** 建立由 Nodemailer 支援的有界 SMTP 郵件器。 */
export function createNodemailerMailer(smtpUrl: string, options: MailerOptions = {}): Mailer {
  const transporter = createTransport(smtpUrl);
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  let inFlight = 0;

  return {
    async send(to, subject, text) {
      if (inFlight >= maxInFlight) {
        throw new MailerQueueFullError();
      }
      inFlight++;
      try {
        await transporter.sendMail({ to, subject, text });
      } finally {
        inFlight--;
      }
    },
  };
}
