# 构建上下文是仓库根目录：docker build -f images/control/Dockerfile .
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 默认仍是 registry.npmjs.org。构建机器访问不到它时，用 --build-arg 换成别的镜像，不写进 Dockerfile。
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV NPM_CONFIG_REGISTRY=$NPM_CONFIG_REGISTRY
# 与根 package.json 的 packageManager 同一版本。不在 Dockerfile 里指定网络模式。
RUN npm install --global pnpm@12.16.1

WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control/package.json apps/control/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/machined/package.json apps/machined/package.json
COPY apps/e2e/package.json apps/e2e/package.json
COPY packages/browser/package.json packages/browser/package.json
COPY packages/integration-viate/package.json packages/integration-viate/package.json
COPY packages/protocol/package.json packages/protocol/package.json
# better-sqlite3 要编译原生模块，esbuild 要下载对应平台的二进制。两者都在 pnpm-workspace.yaml 的 allowBuilds 里。
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @viate-bot/protocol build \
    && pnpm --filter @viate-bot/integration-viate build \
    && pnpm --filter @viate-bot/browser build \
    && pnpm --filter @viate-bot/web build \
    && pnpm --filter @viate-bot/control build \
    && pnpm --filter @viate-bot/control check:dist \
    && pnpm --filter @viate-bot/control deploy --prod /out/apps/control \
    && node /out/apps/control/scripts/check-dist.mjs \
    && mkdir -p /out/apps/web \
    && cp -a /src/apps/web/dist /out/apps/web/dist

FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

# 发布镜像把缺省机器镜像指到同一版本的 GHCR 标签。源码运行不设置这个变量。
ARG MACHINE_IMAGE_REF=viate-bot/machine:dev
ARG IMAGE_VERSION=0.0.0
ARG IMAGE_REVISION=unknown
ARG IMAGE_SOURCE=https://github.com/ViateAI/viate-bot
ENV VB_MACHINE_IMAGE_DEFAULT=$MACHINE_IMAGE_REF
LABEL org.opencontainers.image.version=$IMAGE_VERSION \
      org.opencontainers.image.source=$IMAGE_SOURCE \
      org.opencontainers.image.revision=$IMAGE_REVISION \
      org.opencontainers.image.licenses=MIT

RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /out /app
COPY LICENSE /app/LICENSE

WORKDIR /app/apps/control
ENV NODE_ENV=production \
    VB_DATA_DIR=/data
USER node
EXPOSE 3000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.VB_CONTROL_PORT||3000)+'/health').then(r=>r.json()).then(b=>process.exit(b&&b.ok===true?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
