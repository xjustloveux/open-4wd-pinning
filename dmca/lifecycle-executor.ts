import type {
  KuboClient,
  PinMeta,
  PinRecord,
  QuotaAdmission,
  QuotaBlockMeasurement,
  QuotaReservation,
} from '../pinning';
import { measureCompleteDag } from '../subscriber';
import type { DmcaExecutor } from './service';
import type { DmcaPinMetadata } from './types';

/** 提供排程 DMCA 生命週期工作所需的持久化、投遞與時鐘連接埠。 */
export interface DmcaLifecycleExecutorDeps {
  readonly cluster: {
    get(cid: string): Promise<PinRecord | undefined>;
    pin(cid: string, meta: PinMeta): Promise<void>;
    unpin(cid: string): Promise<void>;
  };
  readonly kubo: KuboClient;
  readonly quota: {
    reserve(input: QuotaAdmission): QuotaReservation;
    release(reservationId: string): void;
    commit(
      reservationId: string,
      record: PinRecord,
      blocks?: readonly QuotaBlockMeasurement[],
    ): void;
    recordUnpin(cid: string): void;
  };
}

function normalizedMetadata(meta: Partial<PinMeta> | undefined): DmcaPinMetadata | undefined {
  const logicalSizeBytes = meta?.logicalSizeBytes;
  const physicalSizeBytes = meta?.physicalSizeBytes;
  if (
    meta === undefined ||
    typeof meta.category !== 'string' ||
    (meta.source !== 'api' && meta.source !== 'auto') ||
    !Number.isSafeInteger(logicalSizeBytes) ||
    (logicalSizeBytes ?? -1) < 0 ||
    !Number.isSafeInteger(physicalSizeBytes) ||
    (physicalSizeBytes ?? -1) < 0 ||
    (meta.signer !== undefined && typeof meta.signer !== 'string') ||
    (meta.source === 'api' && meta.signer === undefined)
  ) {
    return undefined;
  }
  return {
    category: meta.category,
    source: meta.source,
    ...(meta.signer === undefined ? {} : { signer: meta.signer }),
    logicalSizeBytes: logicalSizeBytes as number,
    physicalSizeBytes: physicalSizeBytes as number,
  };
}

function completeMetadata(record: PinRecord | undefined): DmcaPinMetadata | undefined {
  return normalizedMetadata(record?.meta);
}

/** 建立依序處理到期反通知與恢復轉移的執行器。 */
export function createDmcaLifecycleExecutor(deps: DmcaLifecycleExecutorDeps): DmcaExecutor {
  return {
    async uploaderPeerIdFor(cid) {
      return (await deps.cluster.get(cid))?.meta.signer;
    },
    async pinMetadataFor(cid) {
      return completeMetadata(await deps.cluster.get(cid));
    },
    async unpin(cids) {
      for (const cid of cids) {
        await deps.cluster.unpin(cid);
        deps.quota.recordUnpin(cid);
      }
    },
    async hasExactBytes(cid) {
      return (await measureCompleteDag({ root: cid, kubo: deps.kubo })) !== null;
    },
    async restore(cids, pinMetadataByCid) {
      for (const cid of cids) {
        const saved = normalizedMetadata(pinMetadataByCid[cid]);
        if (saved === undefined) throw new Error(`DMCA restore metadata missing: ${cid}`);
        const measured = await measureCompleteDag({ root: cid, kubo: deps.kubo });
        if (measured === null) throw new Error(`DMCA restore resource missing: ${cid}`);

        const meta: PinMeta = {
          ...saved,
          logicalSizeBytes: measured.logicalDagBytes,
        };
        const reservation = deps.quota.reserve({
          cid,
          ...(saved.source === 'api' ? { signer: saved.signer } : {}),
          logicalSizeBytes: measured.logicalDagBytes,
          physicalSizeBytes: saved.physicalSizeBytes,
          blocks: measured.blocks,
        });
        if (!reservation.allowed) {
          throw new Error(`DMCA restore quota rejected: ${reservation.reason}`);
        }

        let committed = false;
        try {
          await deps.cluster.pin(cid, meta);
          deps.quota.commit(reservation.reservationId, { cid, meta }, measured.blocks);
          committed = true;
        } finally {
          if (!committed) deps.quota.release(reservation.reservationId);
        }
      }
    },
  };
}
