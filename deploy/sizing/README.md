# 部署容量量測流程

公版 base Compose／Kubernetes 刻意不套 CPU、RAM requests 或 limits；三個容器的需求會隨
pinset、同時 DAG 搬運、gateway 流量、是否兼任 bootstrap/relay 與 Kubo routing 模式改變。
`compose.resources.example.yml` 與 `k8s/overlays/sizing-example/` 只是可複製的起始樣本，不是
容量保證或通用建議。

## 量測再設定

1. 以接近正式環境的 pinset、合法最大 DAG 與預期並行請求跑至少一個尖峰週期。
2. Compose 用 `docker compose stats --no-stream` 反覆取樣三個容器；Kubernetes 使用
   `kubectl top pod <pod> --containers`，並由 private Prometheus 保存 CPU、working set、restart、
   Kubo repo、Bitswap 與 Cluster 指標。
3. 對 app 測 `/pin` p95/p99、timeout、event-loop lag 與 RSS；對 Kubo 同時看 repo/stat、GC、
   `ipfs swarm resources` 與連線數；對 Cluster 看 pin queue 與 RPC latency。
4. requests 依穩態高分位數加 headroom；limits 必須能容納合法最大 DAG 的尖峰。故意壓測超限、
   OOM restart、磁碟接近上限與依賴重啟，確認新 pin fail-closed、既有 unpin 仍可完成。
5. Kubo 若設定容器 memory limit，同時設定較低的 `GOMEMLIMIT`；
   `Swarm.ResourceMgr.MaxMemory` 只限制 libp2p networking stack，不代表整個 Kubo／Bitswap。

磁碟容量必須維持 `app global quota < KUBO_STORAGE_MAX < volume/filesystem capacity`。三者要一起
調整，且中間差額需容納 Kubo repo metadata、未 pin cache 與 GC 工作空間；`StorageMax` 是 Kubo
GC／容量訊號，不是 filesystem hard quota。部署後 strict smoke 會拒絕
`available_space_bytes <= 0`，但不能取代宿主磁碟監控。

## Routing 對 sizing 的影響

`KUBO_ROUTING_TYPE=none` 是公版預設：清除 public bootstrap、不加入 public DHT，關閉 mDNS、NAT traversal 與 relay，
只保留 operator 明示的 Peering。改成 `auto`／`autoclient`／`dht*` 會恢復 public bootstrap，增加
連線、CPU、RAM 與頻寬需求；必須重新量測，並評估 generic block advertisement/serving 對
root-scoped UGC policy、DMCA 下架、IP/access log 與內容興趣隱私的旁路風險。
