# open-4wd-pinning

[![CI](https://github.com/xjustloveux/open-4wd-pinning/actions/workflows/cicd.yml/badge.svg?branch=master)](https://github.com/xjustloveux/open-4wd-pinning/actions/workflows/cicd.yml)

Open4WD 的 pinning 節點公版 Template。節點可依營運者政策保存帳本、檢查點、cold match
partitions 與 UGC，並可選擇提供 bootstrap、受控 UGC pin/unpin、DMCA 與透明度能力。

> 本專案仍在開發中；Open4WD 主遊戲尚未正式公開。本 repo 先提供可審查、可自行部署的
> 服務模板，不代表官方營運中的節點。

公版 repo 本體不部署、不持有 secrets，也不指定或預選任何 pinning endpoint。營運者 fork
必須自行決定容量、公開能力、法遵責任與可用性政策。

## 快速開始

前置需求：Node.js 24、pnpm 11、Docker Compose 與 OpenSSL。

```sh
git clone <本 repo 或你的 fork>
cd open-4wd-pinning
pnpm install --frozen-lockfile
cp config/config.example.yaml config/config.yaml
openssl rand -hex 32
```

編輯 `config/config.yaml`，至少填入 receipt 的 `ledger_db_address` 與
`genesis_timestamp`；將 OpenSSL 輸出安全地設為 `CLUSTER_SECRET`，再啟動：

```sh
docker compose -f deploy/docker/docker-compose.yml up -d
pnpm exec tsx scripts/smoke.ts http://127.0.0.1:8000
```

本機 smoke 驗 `GET /stats` 與非空 `node_id`。正式部署另跑嚴格閘：

```sh
pnpm exec tsx scripts/smoke.ts --strict https://pin.example.org
```

嚴格模式另要求 `ipfs_cluster_peers >= 1` 與 `available_space_bytes > 0`。

## 操作與部署權威

根 README 只保留最短成功路徑；完整設定值、genesis／rebirth、DMCA、備份、Kubernetes
workflow 與營運責任，以
[open-4wd-specs 部署資訊](https://github.com/xjustloveux/open-4wd-specs/blob/master/%E9%83%A8%E7%BD%B2%E8%B3%87%E8%A8%8A/open-4wd-pinning.md)
為規格權威。repo 內就地手冊與範本：

- [容量量測與 sizing](deploy/sizing/README.md)
- [私有監控 overlay](deploy/monitoring/README.md)
- [Docker Compose](deploy/docker/docker-compose.yml)
- [Kubernetes manifests](deploy/k8s/)
- [設定樣本](config/config.example.yaml)
- [DMCA OpenAPI 產生器](dmca/openapi.ts)；runtime 契約由 `GET /api/dmca/openapi.json` 提供

公版 Kubo 預設只使用明示 Peering，不加入 public DHT。若營運者改開 public routing，
generic block 供應會旁路 root-scoped UGC policy；必須重新量測容量並揭露隱私、法遵與
內容供應邊界。所有環境變數與預設值以 Specs 上述權威為準，不在根 README 複製第二份表。

Ledger genesis 是一次性 ceremony，不由一般 service 自動建立；執行前先依 Specs §3.4
準備專用資料目錄、穩定 identity、治理 signer set、release commit 與外部 receipt 路徑。

## 架構

- `core/`：provider policy、配置、ledger/checkpoint、UGC、DMCA 與 vendored protocol。
- `node/`：HTTP、OrbitDB/IPFS/Cluster adapters 與持久化。
- `deploy/`：Docker、Kubernetes、sizing 與 monitoring 範本。
- `scripts/`：smoke、genesis、rebirth proof、DMCA export、vendor 與品質 gates。

`core/vendor/` 由主專案同步並以 `MANIFEST.json` 鎖定 closure 與 SHA-256；不要手改。
本機同步後先執行 `pnpm check:vendor:local`，需要完整 release gate 時再執行
`pnpm check:vendor`。

## 驗證

```sh
pnpm test
pnpm test:scripts
pnpm test:integration
pnpm e2e
pnpm check:vendor:local
pnpm check:comments:self-test
pnpm check:comments
```

integration 在本機沒有 Docker 時可 skip；官方 CI 會對真 Kubo／Cluster 執行。公版
deploy workflow 只接受營運者 fork 手動 opt-in，不是 CI、build 或 image publish 的依賴。

## Open4WD 生態

- [主遊戲](https://github.com/xjustloveux/open-4wd)
- [規格與部署權威](https://github.com/xjustloveux/open-4wd-specs)
- [Signaling Template](https://github.com/xjustloveux/open-4wd-signaling)
- [TURN Template](https://github.com/xjustloveux/open-4wd-turn)

## 貢獻、安全與授權

一般貢獻請使用 GitHub Issue／Pull Request；安全弱點請依
[Open4WD Security Reporting](https://github.com/xjustloveux/open-4wd-specs/blob/master/%E8%B3%87%E5%AE%89%E8%A6%8F%E7%AF%84.md#101-reporting)
私下回報，不要公開揭露細節。

[MIT](LICENSE)

改寫自第三方 MIT 授權專案的程式碼，其原始版權與許可聲明見
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
