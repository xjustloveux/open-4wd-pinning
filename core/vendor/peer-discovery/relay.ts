/**
 * Circuit Relay v2 slot 保留 — 不可直達（嚴格 NAT）的 client 只對 relayAddrs 中
 * 明示受信的位址逐一建立 reservation；首個成功即止。libp2p 面注入。
 */
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';

/** 明示建立 Circuit Relay v2 reservation 並回報目前連線的最小節點面。 */
export interface RelayRecoveryNode {
  /** 建立 explicit `<relay>/p2p-circuit` listener；完成代表 v2 reservation 已成立。 */
  reserveRelay(address: Multiaddr): Promise<void>;
  /** 目前所有直連／relay 連線快照。 */
  getConnections(): readonly unknown[];
}

/** 可重用的 libp2p transport listener 最小面。 */
export interface ExplicitRelayListener {
  /** 對指定 relay 建立／更新 Circuit Relay v2 reservation。 */
  listen(address: Multiaddr): Promise<void>;
}

/** 最小 transport-manager surface，用來建立明示 relay reservation。 */
export interface ExplicitRelayTransportNode {
  /** 目前所有直連／relay 連線快照。 */
  getConnections(): readonly unknown[];
  /** libp2p transport manager；listen 完成才代表 reservation 已成立。 */
  readonly components: {
    readonly transportManager: {
      listen(addresses: readonly Multiaddr[]): Promise<void>;
      getListeners(): readonly ExplicitRelayListener[];
    };
  };
}

/**
 * 將 libp2p node 收斂成只允許明示 relay 位址的 reservation adapter。
 *
 * @param node - 具 transport manager 的 libp2p node。
 * @returns 不會啟動全域 relay discovery 的 recovery node。
 */
export function makeExplicitRelayReservationNode(
  node: ExplicitRelayTransportNode,
): RelayRecoveryNode {
  const manager = node.components.transportManager;
  let ownedListener: ExplicitRelayListener | null = null;
  let reservationTail = Promise.resolve();

  const reserve = async (address: Multiaddr): Promise<void> => {
    const circuitAddress = address.encapsulate('/p2p-circuit');
    if (ownedListener !== null) {
      await ownedListener.listen(circuitAddress);
      return;
    }

    const before = new Set(manager.getListeners());
    let failed = false;
    let failure: unknown;
    try {
      await manager.listen([circuitAddress]);
    } catch (cause) {
      failed = true;
      failure = cause;
    } finally {
      ownedListener = manager.getListeners().find((listener) => !before.has(listener)) ?? null;
    }

    if (failed) throw failure;
    if (ownedListener === null)
      throw new Error('Explicit relay transport listener was not registered');
  };

  return {
    getConnections: () => node.getConnections(),
    reserveRelay: (address) => {
      const pending = reservationTail.then(
        () => reserve(address),
        () => reserve(address),
      );
      reservationTail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
}

/** 直接連線全失後的 relay recovery 依賴。 */
export interface RelayRecoveryOptions {
  /** 提供可驗證 reservation 與連線快照的目前節點。 */
  readonly node: RelayRecoveryNode;
  /** 僅接受已由本機部署／玩家設定明示授權的 relay，不能傳入社群 bootstrap 清單。 */
  readonly relayAddrs: readonly string[];
  /** 確認回呼仍屬目前 online generation。 */
  readonly isCurrent: () => boolean;
  /** 所有明示 relay reservation 失敗時使 runtime fail-closed。 */
  readonly onUnavailable: () => void;
}

/**
 * 逐一對受信 relay 建立 explicit circuit listener，並等待 v2 reservation 完成。
 *
 * @param node - 目前 libp2p node。
 * @param relayAddrs - 明示的 relay multiaddr，依序嘗試。
 * @returns 是否至少連上一個 relay。
 */
export async function reserveRelaySlot(
  node: Pick<RelayRecoveryNode, 'reserveRelay'>,
  relayAddrs: readonly string[],
): Promise<boolean> {
  for (const addr of relayAddrs) {
    try {
      await node.reserveRelay(multiaddr(addr));
      return true;
    } catch {
      continue; // 此 relay 不可達＝試下一個
    }
  }
  return false;
}

/**
 * 建立「直接連線全失」後才啟動的單航班 relay recovery。
 *
 * @param options - 受信 relay、generation guard 與最終失敗回呼。
 * @returns connection-close handler；仍有連線時不動作，並行事件共用同一回復作業。
 */
export function makeRelayRecoveryOnDirectLoss(options: RelayRecoveryOptions): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return async () => {
    await Promise.resolve();
    if (!options.isCurrent() || options.node.getConnections().length > 0) return;
    if (pending !== null) return pending;
    const recovery = reserveRelaySlot(options.node, options.relayAddrs)
      .then((reserved) => {
        if (options.isCurrent() && !reserved && options.node.getConnections().length === 0)
          options.onUnavailable();
      })
      .finally(() => {
        if (pending === recovery) pending = null;
      });
    pending = recovery;
    return recovery;
  };
}
