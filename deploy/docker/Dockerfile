FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
WORKDIR /app
RUN addgroup -S -g 10001 open4wd \
  && adduser -S -D -H -u 10001 -G open4wd open4wd \
  && corepack enable
# pnpm-workspace.yaml 帶 allowBuilds（classic-level 的原生 prebuild 放行）——install 前就要在，
# 否則行為會跟本機開發不一致。packageManager 版本鎖在 package.json（corepack 依它自動起用）。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --chown=10001:10001 tsconfig.json ./
COPY --chown=10001:10001 api ./api
COPY --chown=10001:10001 app ./app
COPY --chown=10001:10001 auth ./auth
COPY --chown=10001:10001 config ./config
COPY --chown=10001:10001 core ./core
COPY --chown=10001:10001 dmca ./dmca
COPY --chown=10001:10001 metrics ./metrics
COPY --chown=10001:10001 node ./node
COPY --chown=10001:10001 pinning ./pinning
COPY --chown=10001:10001 subscriber ./subscriber
# 維運命令 ledger:genesis 與 dmca:export 也是映像的公開介面，只帶入其必要入口。
COPY --chown=10001:10001 scripts/ledger-genesis.ts scripts/ledger-genesis-config.ts scripts/ledger-genesis-receipt.ts scripts/dmca-export.ts ./scripts/
RUN mkdir -p /app/data && chown 10001:10001 /app/data
USER 10001:10001
# 8000＝管理 API；4001＝libp2p（ws，TLS 由外層 ingress／反代終止）；9464＝private metrics。
EXPOSE 8000 4001 9464
# 執行期由 node 直接執行 tsx 的 cli、指向與 package.json start script 同一入口，不經 pnpm／corepack：
# corepack 的 pnpm 快取是 per-user，uid 10001 沒有 home 目錄，`pnpm start` 會在建快取目錄時
# EACCES 直接崩。CMD 與 start script 的同步由 deploy/deployment-policy.spec.ts 守門。
CMD ["node", "node_modules/tsx/dist/cli.mjs", "app/main.ts"]
