# 私有監控 overlay 參考

這些檔案是營運者 fork 私有監控 overlay 的起點，不會被公版 Compose／Kubernetes 自動啟用，也不會建立任何 public ingress。

1. app 設 `METRICS_ENABLE=true`。Compose 的 Prometheus 若與 app 同 network，另設 `METRICS_HOST=0.0.0.0`；Kubernetes 讓 Prometheus 抓 pod IP 時同樣綁 `0.0.0.0`，並以 NetworkPolicy 只允許監控 namespace。
2. 將 `prometheus.yml` 與 `alerts.yml` 掛入 private Prometheus；app 已提供 Kubo repo／StorageMax
   與 global quota 四個容量 gauge，以及兩條持續 80% 告警。依實際版本另加 Kubo
   `/debug/metrics/prometheus`、IPFS Cluster、node-exporter 與 Grafana scrape/data source，才能觀測
   filesystem、GC 與其他程序；raw metrics 不經 public ingress。
3. 公版 `alertmanager.yml` 只宣告中立的 `operator-selected` receiver，不預設任何私人通道、Email 或外部 uptime 供應商。營運者必須自行選擇 receiver integration，把憑證放在部署 secret，不得寫進 yaml 或 repo；完成設定前此 receiver 不會送出通知。
4. Grafana 只讀 private Prometheus。營運者可以 Cloudflare Tunnel 將自己的 monitoring hostname 指向 Grafana private origin，再用獨立 Access self-hosted application／維運群組／MFA 保護；不要沿用 DMCA Admin 群組。
5. 上線前用與實際 image 同版的 `promtool check config`、`promtool check rules` 與 `amtool check-config` 驗證，並以測試 alert 確認營運者選定的 receiver 確實收到 firing／resolved 通知；只通過語法檢查但沒有送達證據，不算完成。

警報同時使用最低樣本數與 `for` 持續時間，避免玩家稀少時單一請求造成雜訊。部署端仍需依
磁碟容量、實際基線與 Kubo／Relay 原生指標補 filesystem、Bitswap、Gateway、DHT/Gossip 與
Relay 告警。
