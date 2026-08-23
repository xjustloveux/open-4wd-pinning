/**
 * libp2p 節點組態 — 傳輸（WebRTC／WebRTC-Direct／WS／Circuit Relay）＋yamux＋noise
 * ＋identify＋自訂協議 Kademlia DHT＋GossipSub（含 rooms topic score 參數與
 * appSpecificScore 信譽掛點）。組態建構為純函式（工廠皆延遲建構、可測）；
 * `createNode` 於 runtime 呼叫。
 */
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { gossipsub, type GossipsubOpts } from '@libp2p/gossipsub';
import { createPeerScoreParams, createTopicScoreParams } from '@libp2p/gossipsub/score';
import { identify } from '@libp2p/identify';
import { kadDHT, type KadDHTInit } from '@libp2p/kad-dht';
import { ping } from '@libp2p/ping';
import { webSockets } from '@libp2p/websockets';
import { createLibp2p, type Libp2pOptions } from 'libp2p';
import { Network } from '@open4wd/system-constants';
import type { Libp2pPrivateKey } from './identity';
import type { TopicNamespace } from './topics';

/** 本網路專用 DHT 協議名（非本協議節點對發現無用） */
export const KAD_PROTOCOL = '/open4wd/kad/1.0.0';

/** 將專案 DHT authority 明示映射到 libp2p adapter，避免依賴套件預設值漂移。 */
export function open4wdDhtOptions(): KadDHTInit {
  return {
    protocol: KAD_PROTOCOL,
    clientMode: false,
    querySelfInterval: Network.peerDiscovery.DHT_QUERY_SELF_INTERVAL_MS,
  };
}

/** 將專案 GossipSub mesh 與原生三層 score thresholds 映射到 adapter。 */
export function open4wdGossipsubOptions(): Pick<
  GossipsubOpts,
  'D' | 'heartbeatInterval' | 'scoreThresholds'
> {
  return {
    D: Network.peerDiscovery.GOSSIPSUB_MESH_DEGREE,
    heartbeatInterval: Network.peerDiscovery.GOSSIPSUB_HEARTBEAT_INTERVAL_MS,
    scoreThresholds: {
      gossipThreshold: Network.peerDiscovery.GOSSIPSUB_SCORE_GOSSIP_THRESHOLD,
      publishThreshold: Network.peerDiscovery.GOSSIPSUB_SCORE_PUBLISH_THRESHOLD,
      graylistThreshold: Network.peerDiscovery.GOSSIPSUB_SCORE_GRAYLIST_THRESHOLD,
    },
  };
}

/** 建立 Open4WD libp2p node 所需的身分、bootstrap 與 chain topic 設定。 */
export interface NodeConfigInput {
  privateKey: Libp2pPrivateKey;
  bootstrapList: readonly string[];
  /** 已配置 ledger 時提供；動態 genesis 在 open 前尚無 chain topic score。 */
  topics?: TopicNamespace;
  /** 信譽／黑名單加權（AppPeerScore.appSpecificScore 綁定；缺＝恆 0） */
  appSpecificScore?: (peerId: string) => number;
}

/** 可延遲注入 buildNodeOptions 的單一 libp2p transport factory。 */
export type TransportFactory = NonNullable<Libp2pOptions['transports']>[number];

/** 本節點服務面（型別以工廠回推——kad-dht 對兄弟服務 ping 的需求由此證明） */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- ServiceMap 約束需要型別字面量的隱式 index signature、interface 不具備
export type Open4wdServices = {
  identify: ReturnType<ReturnType<typeof identify>>;
  ping: ReturnType<ReturnType<typeof ping>>;
  dht: ReturnType<ReturnType<typeof kadDHT>>;
  pubsub: ReturnType<ReturnType<typeof gossipsub>>;
};

/** 純函式組裝正式的 transport、加密、DHT、pubsub 與 scoring 選項。 */
export function buildNodeOptions(
  input: NodeConfigInput & { transports: TransportFactory[] },
): Libp2pOptions<Open4wdServices> {
  return {
    privateKey: input.privateKey,
    // Generic /p2p-circuit listener會自動搜尋並向任何 HOP peer reservation；
    // relay 必須等直接連線需求出現後，才由 app-shell 對明示 multiaddr 建立 explicit listener。
    addresses: { listen: ['/webrtc'] },
    transports: input.transports,
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
    services: {
      identify: identify(),
      ping: ping(), // kad-dht 硬性依賴的兄弟服務（peer 存活探測）
      dht: kadDHT(open4wdDhtOptions()),
      pubsub: gossipsub({
        ...open4wdGossipsubOptions(),
        emitSelf: false,
        allowPublishToZeroTopicPeers: false,
        scoreParams: createPeerScoreParams({
          topics:
            input.topics === undefined
              ? {}
              : {
                  [input.topics.rooms]: createTopicScoreParams({
                    topicWeight: 0.5,
                    timeInMeshWeight: 1,
                    timeInMeshQuantum: 1000,
                    timeInMeshCap: 3600,
                    firstMessageDeliveriesWeight: 1,
                    firstMessageDeliveriesDecay: 0.5,
                    firstMessageDeliveriesCap: 100,
                  }),
                },
          appSpecificWeight: 1,
          appSpecificScore: input.appSpecificScore ?? (() => 0),
          // 同 IP 大量 peer 是 Sybil 訊號；gossipsub 也硬性要求此權重 <= 0。
          IPColocationFactorWeight: -5,
          behaviourPenaltyWeight: -10,
          behaviourPenaltyDecay: 0.5,
        }),
      }),
    },
    // 玩家選定的 bootstrap 集合為空＝不掛發現器（bootstrap() 拒空清單）
    ...(input.bootstrapList.length > 0
      ? { peerDiscovery: [bootstrap({ list: [...input.bootstrapList] })] }
      : {}),
  };
}

/**
 * 建立並啟動 libp2p 節點（runtime 專用；測試面止於 buildNodeOptions）。
 * `@libp2p/webrtc` 動態載入——其 Node 端入口於模組載入即 require `node-datachannel`
 * 原生模組（供應鏈立場已拒建）；瀏覽器動態載入走 browser 條件、測試 bundle 不執行此路徑。
 */
export async function createNode(
  input: NodeConfigInput,
): ReturnType<typeof createLibp2p<Open4wdServices>> {
  const { webRTC, webRTCDirect } = await import('@libp2p/webrtc');
  return createLibp2p(
    buildNodeOptions({
      ...input,
      transports: [webRTC(), webRTCDirect(), webSockets(), circuitRelayTransport()],
    }),
  );
}
