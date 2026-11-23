/**
 * app 節點的 libp2p 工廠——傳輸固定 webSockets＋circuitRelayTransport（無 webrtc：
 * `@libp2p/webrtc` 在 Node 端靜態載入即 require `node-datachannel` 原生模組，供應鏈
 * 立場已拒建，與 vendored peer-discovery/node-config.ts 的 `createNode` 同理不可直用）；
 * relayEnabled 時額外掛 circuit relay server service，讓其餘節點可借道本節點中繼。
 * DHT 協議與 server mode（clientMode:false）已由 vendored buildNodeOptions 固定，此處
 * 沿用不覆寫。
 */
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webSockets } from '@libp2p/websockets';
import { createLibp2p, type Libp2p, type Libp2pOptions } from 'libp2p';
import { buildNodeOptions, type Open4wdServices } from '../core';

/**
 * 私鑰型別借道 `Libp2pOptions['privateKey']` 萃取——`@libp2p/interface` 未列於
 * package.json，pnpm 隔離式 node_modules 下對本檔不可直接 import（同 vendored
 * peer-discovery/identity.ts、node/identity.ts 的既有手法）。
 */
export type AppPrivateKey = NonNullable<Libp2pOptions['privateKey']>;

/** transports 陣列元素型別借道 buildNodeOptions 參數萃取，避免另外 import 未匯出的 vendor 型別。 */
type AppTransportFactory = Parameters<typeof buildNodeOptions>[0]['transports'][number];

/** 設定服務擁有的 libp2p 傳輸、身分與資料儲存。 */
export interface AppLibp2pOptions {
  readonly privateKey: AppPrivateKey;
  /** 例：['/ip4/0.0.0.0/tcp/4001/ws']；測試給 ['/memory/<id>']（@libp2p/memory 免開埠）。 */
  readonly listen: readonly string[];
  readonly bootstrap: readonly string[];
  readonly relayEnabled: boolean;
  readonly datastore: NonNullable<Libp2pOptions['datastore']>;
  /** 測試注入 @libp2p/memory 等額外傳輸；production 留空。 */
  readonly extraTransports?: readonly AppTransportFactory[];
}

/** 建立支援 WebSocket 與 circuit relay 的服務 libp2p 節點。 */
export async function createAppLibp2p(opts: AppLibp2pOptions): Promise<Libp2p<Open4wdServices>> {
  const base = buildNodeOptions({
    privateKey: opts.privateKey,
    bootstrapList: opts.bootstrap,
    transports: [webSockets(), circuitRelayTransport(), ...(opts.extraTransports ?? [])],
  });
  // buildNodeOptions 的宣告型別將 services 標為選填（Libp2pOptions 介面本身如此），但實作
  // 一律回傳填好的 services；`?? {}` 會把 spread 結果的每個 service 都降級成 optional
  // （丟失 Open4wdServices 要求的必要性），故改用執行期斷言＋窄化保留原始必要型別。
  if (base.services === undefined)
    throw new Error('buildNodeOptions did not return a services map (unexpected)');
  const baseServices = base.services;
  return createLibp2p({
    ...base,
    privateKey: opts.privateKey,
    datastore: opts.datastore,
    addresses: { listen: [...opts.listen] },
    services: {
      ...baseServices,
      ...(opts.relayEnabled ? { relay: circuitRelayServer() } : {}),
    },
  });
}
