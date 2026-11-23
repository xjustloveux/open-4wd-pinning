#!/bin/sh
# kubo 上游 image 的 container-init.d 掛鉤：ipfs init 完成之後、daemon 啟動之前執行；不需要
# 執行位元（找不到 +x 時上游腳本會改用 source 執行這個檔案）。
set -e

# 容器間一律以 0.0.0.0 監聽 API（重申——不依賴「repo 是不是全新初始化」這個隱性條件）。
ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001

# 公開 stats 的 available_space_bytes 由這個上限扣 RepoSize 得出。必須顯式設定，否則 Kubo
# image 的隱含預設會和 app quota／實際 volume 漂移。部署可覆寫，但應維持：
# app global quota < KUBO_STORAGE_MAX < volume/filesystem capacity。
KUBO_STORAGE_MAX="${KUBO_STORAGE_MAX:-80GB}"
ipfs config Datastore.StorageMax "$KUBO_STORAGE_MAX"

# 公版預設只和 operator 明示的 peers 互連，不加入 public DHT／delegated routing。這同時避免
# gateway 為任意 CID 主動抓取。要加入 public routing 必須由 operator 明示 production mode；
# 其供應、隱私與 root-scoped policy 旁路責任見 README。
KUBO_ROUTING_TYPE="${KUBO_ROUTING_TYPE:-none}"
case "$KUBO_ROUTING_TYPE" in
  none|auto|autoclient|dht|dhtclient|dhtserver) ;;
  *)
    echo "不支援的 KUBO_ROUTING_TYPE: $KUBO_ROUTING_TYPE" >&2
    exit 1
    ;;
esac
ipfs config Routing.Type "$KUBO_ROUTING_TYPE"
ipfs config --bool Gateway.NoFetch true
ipfs config --json Swarm.ConnMgr.LowWater 16
ipfs config --json Swarm.ConnMgr.HighWater 32

if [ "$KUBO_ROUTING_TYPE" = "none" ]; then
  ipfs bootstrap rm --all
  ipfs config --bool Discovery.MDNS.Enabled false
  ipfs config --bool Swarm.DisableNatPortMap true
  ipfs config --bool Swarm.EnableHolePunching false
  ipfs config --bool Swarm.RelayClient.Enabled false
  ipfs config --bool Swarm.RelayService.Enabled false
else
  ipfs bootstrap add --default
  echo "已明示啟用 public IPFS routing ($KUBO_ROUTING_TYPE)；請確認 README 所列供應與政策邊界"
fi

# 讓 kubo 主動保持與 app 節點的常駐連線：app 自 mesh 抓到的塊可經由這條連線被 kubo bitswap
# 直取，是既有發現機制外的補充通路。app 若沒有固定身分（BOOTSTRAP_PEER_ID 未設）就略過——
# 身分每次重啟都變，peering 指向舊 id 沒有意義；KUBO_PEERING_APP_MULTIADDR 由外層 compose／
# k8s manifest 依各自的網路拓撲提供（同 pod 共用 localhost，或 compose 各服務各自命名空間）。
if [ -n "$BOOTSTRAP_PEER_ID" ] && [ -n "$KUBO_PEERING_APP_MULTIADDR" ]; then
  ipfs config --json Peering.Peers "[{\"ID\":\"${BOOTSTRAP_PEER_ID}\",\"Addrs\":[\"${KUBO_PEERING_APP_MULTIADDR}\"]}]"
else
  echo "BOOTSTRAP_PEER_ID／KUBO_PEERING_APP_MULTIADDR 未設定，略過 Peering.Peers（app 身分非固定時這是正常狀況）"
fi
