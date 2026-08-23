import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupAll,
  confirmedCounter,
  confirmedNotice,
  makeService,
  validCounter,
  validNotice,
} from './dmca.test-support';
import {
  DmcaCounterNotEligibleError,
  DmcaInvalidReasonError,
  DmcaInvalidTransitionError,
  createDmcaService,
} from './service';
import type { DMCACounterNoticeV1, DMCANotice } from './types';

afterEach(async () => {
  await cleanupAll();
});

describe('DMCA service', () => {
  const signedSubmission = (payload: DMCACounterNoticeV1, signer: string) => ({
    mode: 'signed-uploader' as const,
    signed: {
      payload,
      timestamp: payload.submittedAt,
      nonceHex: '00'.repeat(16),
      signer,
      signatureHex: '00'.repeat(64),
    },
  });

  it('只有可信原上傳者簽章會立即受理並啟動一次期限', async () => {
    const { svc, clock } = await makeService();
    const noticeId = await confirmedNotice(svc, ['identity-cid'], 'trusted-uploader');
    const payload = validCounter(noticeId, ['identity-cid']);
    const result = await svc.submitCounter(
      signedSubmission(payload, 'trusted-uploader'),
      'trusted-uploader',
    );
    const record = await svc.getNotice(result.counterNoticeId);
    const original = await svc.getNotice(noticeId);
    expect(record).toMatchObject({
      status: 'received',
      counterIdentityStatus: 'verified-uploader-signature',
      acceptedAt: clock.now(),
      counterDeliveryStatus: 'delivered',
    });
    expect(original?.waitingPeriodEndDate).toBeDefined();
  });

  it('簽章不符、缺少可信 uploader metadata 與 manual submission 都等待人工覆核且不啟動期限', async () => {
    const cases = [
      async () => {
        const setup = await makeService();
        const noticeId = await confirmedNotice(setup.svc, ['mismatch-cid'], 'trusted-uploader');
        return {
          ...setup,
          noticeId,
          submission: signedSubmission(validCounter(noticeId, ['mismatch-cid']), 'other-uploader'),
          signer: 'other-uploader',
        };
      },
      async () => {
        const setup = await makeService();
        const notice = validNotice();
        notice.infringingContent[0]!.cid = 'missing-metadata-cid';
        const { noticeId } = await setup.svc.submitNotice(notice);
        await setup.svc.confirmEmail(setup.mail.lastConfirmToken());
        return {
          ...setup,
          noticeId,
          submission: signedSubmission(
            validCounter(noticeId, ['missing-metadata-cid']),
            'claimed-uploader',
          ),
          signer: 'claimed-uploader',
        };
      },
      async () => {
        const setup = await makeService();
        const noticeId = await confirmedNotice(setup.svc, ['manual-cid'], 'trusted-uploader');
        return {
          ...setup,
          noticeId,
          submission: {
            mode: 'manual-review' as const,
            payload: validCounter(noticeId, ['manual-cid']),
          },
          signer: undefined,
        };
      },
    ];

    for (const makeCase of cases) {
      const { svc, noticeId, submission, signer } = await makeCase();
      const result = await svc.submitCounter(submission, signer);
      expect(await svc.getNotice(result.counterNoticeId)).toMatchObject({
        status: 'pending-identity-review',
        counterIdentityStatus: 'pending-identity-review',
        counterDeliveryStatus: 'not-ready',
      });
      expect((await svc.getNotice(result.counterNoticeId))?.acceptedAt).toBeUndefined();
      expect((await svc.getNotice(noticeId))?.waitingPeriodEndDate).toBeUndefined();
    }
  });

  it('人工接受只設定一次 acceptedAt 與期限；人工拒絕永不啟動期限', async () => {
    const accepted = await makeService();
    const acceptedNoticeId = await confirmedNotice(
      accepted.svc,
      ['manual-accept-cid'],
      'trusted-uploader',
    );
    const acceptedCounter = await accepted.svc.submitCounter({
      mode: 'manual-review',
      payload: validCounter(acceptedNoticeId, ['manual-accept-cid']),
    });
    await accepted.svc.adminIdentityDecide(
      acceptedCounter.counterNoticeId,
      'accept',
      'Verified retained ownership evidence',
      'operator@example.org',
    );
    const acceptedAt = (await accepted.svc.getNotice(acceptedCounter.counterNoticeId))?.acceptedAt;
    expect(acceptedAt).toBe(accepted.clock.now());
    await expect(
      accepted.svc.adminIdentityDecide(
        acceptedCounter.counterNoticeId,
        'accept',
        'duplicate',
        'operator@example.org',
      ),
    ).rejects.toThrow();
    expect((await accepted.svc.getNotice(acceptedCounter.counterNoticeId))?.acceptedAt).toBe(
      acceptedAt,
    );

    const rejected = await makeService();
    const rejectedNoticeId = await confirmedNotice(
      rejected.svc,
      ['manual-reject-cid'],
      'trusted-uploader',
    );
    const rejectedCounter = await rejected.svc.submitCounter({
      mode: 'manual-review',
      payload: validCounter(rejectedNoticeId, ['manual-reject-cid']),
    });
    await rejected.svc.adminIdentityDecide(
      rejectedCounter.counterNoticeId,
      'reject',
      'Identity evidence did not match',
      'operator@example.org',
    );
    expect(await rejected.svc.getNotice(rejectedCounter.counterNoticeId)).toMatchObject({
      status: 'rejected_by_admin',
      counterIdentityStatus: 'rejected-manual',
    });
    expect((await rejected.svc.getNotice(rejectedNoticeId))?.waitingPeriodEndDate).toBeUndefined();
  });

  it('受理後把完整法律反通知交付原 claimant，公開狀態不含聯絡或管轄資訊', async () => {
    const { svc, mail } = await makeService();
    const noticeId = await confirmedNotice(svc, ['delivery-cid'], 'delivery-uploader');
    const payload = validCounter(noticeId, ['delivery-cid']);
    const result = await svc.submitCounter(
      signedSubmission(payload, 'delivery-uploader'),
      'delivery-uploader',
    );
    const record = await svc.getNotice(result.counterNoticeId);
    expect(record).toMatchObject({
      counterDeliveryStatus: 'delivered',
      counterDeliveryAttemptCount: 1,
    });
    const claimantMail = [...mail.log]
      .reverse()
      .find((entry) => entry.to === 'claimant@example.org' && entry.subject.includes('counter'));
    expect(claimantMail?.text).toContain(payload.uploaderName);
    expect(claimantMail?.text).toContain(payload.uploaderEmail);
    expect(claimantMail?.text).toContain(payload.uploaderPhone);
    expect(claimantMail?.text).toContain(payload.uploaderAddress);
    expect(claimantMail?.text).toContain(payload.takenDownContent[0]!.url);
    expect(claimantMail?.text).toContain(payload.federalDistrict);
    expect(claimantMail?.text).toContain(payload.signature);
    const inbox = await svc.uploaderInbox('delivery-uploader');
    expect(JSON.stringify(inbox)).not.toMatch(/uploader@example|Federal District|456 Side/);
  });

  it('寄送失敗持久化穩定錯誤與退避；重啟後續送不改 acceptedAt 或期限', async () => {
    const setup = await makeService();
    const noticeId = await confirmedNotice(setup.svc, ['retry-cid'], 'retry-uploader');
    setup.mail.failNextSend();
    const payload = validCounter(noticeId, ['retry-cid']);
    const result = await setup.svc.submitCounter(
      signedSubmission(payload, 'retry-uploader'),
      'retry-uploader',
    );
    const failed = await setup.svc.getNotice(result.counterNoticeId);
    const acceptedAt = failed?.acceptedAt;
    const deadline = (await setup.svc.getNotice(noticeId))?.waitingPeriodEndDate;
    expect(failed).toMatchObject({
      counterDeliveryStatus: 'retrying',
      counterDeliveryAttemptCount: 1,
      counterDeliveryLastErrorCode: 'delivery-failed',
      counterDeliveryNextAttemptAt: setup.clock.now() + 60_000,
    });

    const restarted = createDmcaService({
      store: setup.store,
      mailer: setup.mail,
      executor: setup.executor,
      clock: setup.clock,
      agentEmail: 'agent@example.org',
    });
    setup.clock.advance(60_000);
    await restarted.sweepCounterDeliveries(setup.clock.now());
    expect(await restarted.getNotice(result.counterNoticeId)).toMatchObject({
      counterDeliveryStatus: 'delivered',
      counterDeliveryAttemptCount: 2,
      acceptedAt,
    });
    expect((await restarted.getNotice(noticeId))?.waitingPeriodEndDate).toBe(deadline);
  });

  it('只接受完整且無未知欄位的 canonical v1 反通知', async () => {
    const complete = (originalNoticeId: string) => ({
      schemaVersion: 1 as const,
      uploaderName: 'Uploader Person',
      uploaderEmail: 'uploader@example.org',
      uploaderPhone: '+1-555-0101',
      uploaderAddress: '456 Side St, Shelbyville',
      originalNoticeId,
      takenDownContent: [
        {
          cid: 'counter-cid',
          url: 'https://example.org/original/counter-cid',
          description: 'The removed original location and content.',
        },
      ],
      goodFaithMistakeOrMisidentification: true as const,
      perjuryStatement: true as const,
      federalDistrict: 'United States District Court for the District of Example',
      acceptsServiceFromClaimant: true as const,
      signature: 'Uploader Person',
      signatureDate: '2026-08-03',
      submittedAt: Date.now(),
    });
    const invalidMutations = [
      (value: ReturnType<typeof complete>) =>
        Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'federalDistrict')),
      (value: ReturnType<typeof complete>) =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== 'acceptsServiceFromClaimant'),
        ),
      (value: ReturnType<typeof complete>) =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== 'goodFaithMistakeOrMisidentification'),
        ),
      (value: ReturnType<typeof complete>) => ({
        ...value,
        takenDownContent: [{ ...value.takenDownContent[0], url: ' ' }],
      }),
      (value: ReturnType<typeof complete>) => ({ ...value, unexpected: 'not allowed' }),
    ];

    for (const mutate of invalidMutations) {
      const { svc } = await makeService();
      const noticeId = await confirmedNotice(svc, ['counter-cid']);
      await expect(
        svc.submitCounter({ mode: 'manual-review', payload: mutate(complete(noticeId)) } as never),
      ).rejects.toThrow();
    }

    const { svc } = await makeService();
    const noticeId = await confirmedNotice(svc, ['counter-cid']);
    const payload = complete(noticeId);
    const result = await svc.submitCounter({ mode: 'manual-review', payload });
    expect((await svc.getNotice(result.counterNoticeId))?.payload).toEqual(payload);
  });

  it('admin 清單只回安全摘要、限制筆數並提供 cursor，不洩漏確認 token 或案卷個資', async () => {
    const { svc } = await makeService();
    await svc.submitNotice(validNotice('private-one@example.org'));
    await svc.submitNotice(validNotice('private-two@example.org'));

    const page = await svc.adminList({ limit: 1 });
    expect(page.cases).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    expect(page.cases[0]).toMatchObject({ type: 'notice', status: 'pending-email-confirm' });
    expect(JSON.stringify(page)).not.toContain('confirmToken');
    expect(JSON.stringify(page)).not.toContain('private-one@example.org');
    expect(JSON.stringify(page)).not.toContain('private-two@example.org');
  });

  it('admin 詳情保留案卷內容但不回確認 token 與寄信內部欄位', async () => {
    const { svc } = await makeService();
    const { noticeId } = await svc.submitNotice(validNotice('detail@example.org'));
    const detail = await svc.adminGet(noticeId);

    expect(detail).toMatchObject({ id: noticeId, type: 'notice' });
    expect(JSON.stringify(detail)).toContain('detail@example.org');
    expect(JSON.stringify(detail)).not.toContain('confirmToken');
    expect(JSON.stringify(detail)).not.toContain('confirmMailSentAt');
  });

  it('admin 裁決拒絕非法狀態轉移，且不執行下架或恢復副作用', async () => {
    const { svc, executor } = await makeService();
    const id = await confirmedNotice(svc, ['c-state']);

    await expect(
      svc.adminDecide(id, 'hold', '沒有反通知或訴訟資料', 'operator@example.org'),
    ).rejects.toThrow(DmcaInvalidTransitionError);
    expect(executor.unpinned).toEqual(['c-state']);
    expect(executor.repinned).toEqual([]);
  });

  it('admin 裁決理由必須有內容，稽核軌跡記錄可信任的操作者', async () => {
    const { svc } = await makeService();
    const id = await confirmedNotice(svc, ['c-audit']);

    await expect(svc.adminDecide(id, 'restore', '   ', 'operator@example.org')).rejects.toThrow(
      DmcaInvalidReasonError,
    );
    const decided = await svc.adminDecide(
      id,
      'restore',
      '  erroneous notice reversal  ',
      'operator@example.org',
    );
    expect(decided.decisionLog.at(-1)).toMatchObject({
      action: 'restore',
      reason: 'erroneous notice reversal',
      operatorId: 'operator@example.org',
    });
  });

  it('notice 生命週期：submit→pending-email-confirm→confirm 後自動停止 provider 供應', async () => {
    const { svc, mail, executor } = await makeService();
    const { noticeId } = await svc.submitNotice(validNotice());
    expect((await svc.getNotice(noticeId))?.status).toBe('pending-email-confirm');
    await svc.confirmEmail(mail.lastConfirmToken());
    expect(executor.unpinned).toEqual(['cidPlaceholder']);
    expect((await svc.getNotice(noticeId))?.status).toBe('taken_down');
    expect(mail.sentTo).toContain('agent@example.org');
  });

  it('自動下架前保存 provider pin metadata 的可信 uploader，不採信通知人自報 PeerId', async () => {
    const { svc, executor } = await makeService();
    executor.uploaderPeerIds.set('cid-owned', 'trusted-uploader-peer');

    const id = await confirmedNotice(svc, ['cid-owned'], 'claimant-forged-peer');
    const record = await svc.getNotice(id);

    expect(record?.uploaderByCid).toEqual({ 'cid-owned': 'trusted-uploader-peer' });
    expect(record?.uploaderByCid).not.toEqual({ 'cid-owned': 'claimant-forged-peer' });
  });

  it('自動下架前把恢復所需的最小雙計量 metadata 存入私有案卷', async () => {
    const { svc, executor } = await makeService();
    executor.pinMetadataByCid.set('cid-metadata', {
      category: 'part',
      signer: 'trusted-uploader-peer',
      source: 'api',
      logicalSizeBytes: 123,
      physicalSizeBytes: 100,
    });

    const id = await confirmedNotice(svc, ['cid-metadata'], 'claimant-forged-peer');
    expect((await svc.getNotice(id))?.pinMetadataByCid).toEqual({
      'cid-metadata': {
        category: 'part',
        signer: 'trusted-uploader-peer',
        source: 'api',
        logicalSizeBytes: 123,
        physicalSizeBytes: 100,
      },
    });
  });

  it('透明度的 repeat-infringer 候選人來自 provider metadata，不採信通知人自報 PeerId', async () => {
    const { svc, executor } = await makeService();
    for (const cid of ['cid-trusted-1', 'cid-trusted-2', 'cid-trusted-3']) {
      executor.uploaderPeerIds.set(cid, 'trusted-repeat-uploader');
      await confirmedNotice(svc, [cid], `claimant-forged-${cid}`);
    }

    expect((await svc.transparency()).repeatInfringersTerminated).toBe(1);
  });

  it('解除法律阻擋時 exact CID bytes 已不存在，仍記 restored + missing 且不建立假 re-pin', async () => {
    const { svc, executor } = await makeService();
    const id = await confirmedNotice(svc, ['cid-gone']);
    executor.missingCids.add('cid-gone');

    const restored = await svc.adminDecide(id, 'restore', '明顯誤判，撤銷下架');

    expect(restored.status).toBe('restored_after_counter');
    expect(restored.resourceAvailability).toBe('missing');
    expect(restored.missingCIDs).toEqual(['cid-gone']);
    expect(executor.repinned).toEqual([]);
  });

  it('uploader inbox 只回可信 PeerId 對應的最小案件資料，不含通知或反通知個資', async () => {
    const { svc, executor } = await makeService();
    executor.uploaderPeerIds.set('cid-private', 'peer-recipient');
    const id = await confirmedNotice(svc, ['cid-private'], 'claimant-forged-peer');

    const inbox = await svc.uploaderInbox('peer-recipient');
    expect(inbox).toEqual([
      expect.objectContaining({
        noticeId: id,
        affectedCIDs: ['cid-private'],
        legalStatus: 'taken_down',
        resourceAvailability: 'missing',
      }),
    ]);
    const serialized = JSON.stringify(inbox);
    for (const privateValue of [
      'Claimant Person',
      'claimant@example.org',
      '+1-555-0100',
      '123 Main St',
      'infringing part',
      'claimant-forged-peer',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(await svc.uploaderInbox('some-other-peer')).toEqual([]);
  });

  it('自動 take_down：一次確認＝全部 affectedCIDs unpin＋status 轉移＋透明度計數', async () => {
    const { svc, executor } = await makeService();
    const id = await confirmedNotice(svc, ['cidX', 'cidY']);
    expect(executor.unpinned).toEqual(['cidX', 'cidY']);
    expect((await svc.getNotice(id))?.status).toBe('taken_down');
    expect((await svc.transparency()).removed).toBe(1);
  });

  it('restore 同步 re-pin；repeat-infringer 計數＝notRestored 的 take_down 數', async () => {
    const { svc, executor } = await makeService();
    const a = await confirmedNotice(svc, ['c1'], 'signerA');
    await confirmedNotice(svc, ['c2'], 'signerA');
    expect(await svc.countNotRestoredTakedowns('signerA')).toBe(2);
    await svc.adminDecide(a, 'restore', 'counter accepted');
    expect(executor.repinned).toEqual(['c1']);
    expect(await svc.countNotRestoredTakedowns('signerA')).toBe(1);
  });

  it('未確認 notice 逾 72h 被 purge', async () => {
    const { svc, clock } = await makeService();
    const { noticeId } = await svc.submitNotice(validNotice());
    clock.advance(73 * 3600 * 1000);
    await svc.purgeUnconfirmed(clock.now());
    expect(await svc.getNotice(noticeId)).toBeUndefined();
  });

  it('反通知第 13 工作日可 restore；hold 必須有 federal court/CCB 證據且可明確解除', async () => {
    const { svc, executor, clock } = await makeService();
    const id = await confirmedNotice(svc, ['c1']);
    await confirmedCounter(svc, id);
    clock.advanceBusinessDays(12);
    await svc.sweepCounterRestores(clock.now());
    expect(executor.repinned).toEqual([]);
    clock.advanceBusinessDays(1);
    await svc.sweepCounterRestores(clock.now());
    expect(executor.repinned).toEqual(['c1']);
    const id2 = await confirmedNotice(svc, ['c2']);
    await confirmedCounter(svc, id2);
    await expect(svc.adminDecide(id2, 'hold', 'no evidence')).rejects.toThrow();
    await svc.adminDecide(id2, 'hold', 'lawsuit notice received', 'operator', {
      proceeding: 'us-federal-court',
      reference: 'Case 1:26-cv-00001',
      receivedAt: clock.now(),
    });
    clock.advanceBusinessDays(14);
    await svc.sweepCounterRestores(clock.now());
    expect(executor.repinned).toEqual(['c1']); // c2 未 restore
    await svc.adminDecide(id2, 'release_hold', 'proceeding dismissed');
    await svc.sweepCounterRestores(clock.now());
    expect(executor.repinned).toEqual(['c1', 'c2']);
  });

  it('自動下架暫時失敗：保留 received、反通知拒絕，背景 sweep 可重試完成', async () => {
    const { svc, mail, executor, clock } = await makeService();
    executor.pinMetadataByCid.set('cidPlaceholder', {
      category: 'part',
      signer: 'trusted-uploader',
      source: 'api',
      logicalSizeBytes: 100,
      physicalSizeBytes: 80,
    });
    executor.failNextUnpin();
    const { noticeId } = await svc.submitNotice(validNotice());

    await expect(svc.confirmEmail(mail.lastConfirmToken())).rejects.toThrow(
      'stub unpin unavailable',
    );
    expect((await svc.getNotice(noticeId))?.status).toBe('received');
    expect((await svc.getNotice(noticeId))?.pinMetadataByCid?.['cidPlaceholder']).toMatchObject({
      logicalSizeBytes: 100,
      physicalSizeBytes: 80,
    });
    await expect(confirmedCounter(svc, noticeId)).rejects.toThrow(DmcaCounterNotEligibleError);

    await svc.sweepTakedowns(clock.now());
    expect((await svc.getNotice(noticeId))?.status).toBe('taken_down');
    expect(executor.unpinned).toEqual(['cidPlaceholder']);
  });

  it('同信箱冷卻：同 claimantEmail 有未確認案不重寄確認信', async () => {
    const { svc, mail } = await makeService();
    await svc.submitNotice(validNotice('same@example.org'));
    await svc.submitNotice(validNotice('same@example.org'));
    expect(mail.confirmMailsTo('same@example.org')).toBe(1);
  });

  it('確認信寄送失敗不阻斷 record 回傳；同信箱冷卻放行重試並於下次成功寄出', async () => {
    const { svc, mail } = await makeService();
    mail.failNextSend();
    const { noticeId } = await svc.submitNotice(validNotice('flaky@example.org'));
    // record 已持久化，即使寄信失敗也不受影響、不拋例外。
    expect((await svc.getNotice(noticeId))?.status).toBe('pending-email-confirm');
    expect(mail.confirmMailsTo('flaky@example.org')).toBe(0); // 這次沒送成功

    // 同信箱再次提交：上一筆 pending 案的確認信從未寄成功，冷卻不應擋下這次重試。
    await svc.submitNotice(validNotice('flaky@example.org'));
    expect(mail.confirmMailsTo('flaky@example.org')).toBe(1); // 這次成功寄出
  });

  it('歸檔抹除保 publicView 並抹除 Notice 聯絡個資', async () => {
    const { svc, clock } = await makeService();
    const id = await confirmedNotice(svc, ['c1']);
    clock.advance(400 * 24 * 3600 * 1000);
    await svc.redactClosed(clock.now());
    const rec = await svc.getNotice(id);
    expect(rec?.publicView).toBeDefined();
    expect(JSON.stringify(rec)).not.toContain('@'); // 聯絡個資已抹

    // 逐欄比對 store.ts redactPayload 實際清空的每一欄（notice 分支）：claimantName／
    // claimantEmail／claimantPhone／claimantAddress／signature 恆抹為同一個標記字串；
    // ipAddress／userAgent 清為 undefined。claimantOrganization／agentName 因
    // validNotice() 本就沒填，redactPayload 的 if 守門不會動它們，故不列入本斷言範圍。
    const payload = rec?.payload as DMCANotice;
    const REDACTED_MARKER = '[已抹除]';
    expect(payload.claimantName).toBe(REDACTED_MARKER);
    expect(payload.claimantEmail).toBe(REDACTED_MARKER);
    expect(payload.claimantPhone).toBe(REDACTED_MARKER);
    expect(payload.claimantAddress).toBe(REDACTED_MARKER);
    expect(payload.signature).toBe(REDACTED_MARKER);
    expect(payload.ipAddress).toBeUndefined();
    expect(payload.userAgent).toBeUndefined();
  });

  it('歸檔抹除 counter-notice 全部聯絡與簽章欄位', async () => {
    const { svc, clock } = await makeService();
    const noticeId = await confirmedNotice(svc, ['c-counter-redact']);
    const original = await svc.getNotice(noticeId);
    if (original === undefined) throw new Error('setup 失敗：original notice 不存在');

    const counter: DMCACounterNoticeV1 = {
      uploaderName: 'Uploader Person',
      uploaderEmail: 'uploader-redact@example.org',
      uploaderPhone: '+1-555-0101',
      uploaderAddress: '456 Side St, Shelbyville',
      schemaVersion: 1,
      originalNoticeId: noticeId,
      takenDownContent: original.affectedCIDs.map((cid) => ({
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
    const { counterNoticeId } = await svc.submitCounter(
      {
        mode: 'signed-uploader',
        signed: {
          payload: counter,
          timestamp: Date.now(),
          nonceHex: '00'.repeat(16),
          signer: 'signerDefault',
          signatureHex: '00'.repeat(64),
        },
      },
      'signerDefault',
    );

    clock.advance(400 * 24 * 3600 * 1000);
    await svc.redactClosed(clock.now());

    const rec = await svc.getNotice(counterNoticeId);
    const payload = rec?.payload as DMCACounterNoticeV1;
    const REDACTED_MARKER = '[已抹除]';
    expect(payload.uploaderName).toBe(REDACTED_MARKER);
    expect(payload.uploaderEmail).toBe(REDACTED_MARKER);
    expect(payload.uploaderPhone).toBe(REDACTED_MARKER);
    expect(payload.uploaderAddress).toBe(REDACTED_MARKER);
    expect(payload.signature).toBe(REDACTED_MARKER);
  });
});
