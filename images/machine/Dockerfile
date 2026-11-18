# 官方 Node 镜像同时发布 linux/amd64 和 linux/arm64。
# 不从 ubuntu:24.04 再装 Node：NodeSource 的安装脚本在跨架构构建时不可靠，
# 而 node:24-bookworm-slim 本机已经有 arm64，部署机拉取对应 amd64 即可。
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/viate/ms-playwright

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl tini supervisor \
        xvfb openbox x11vnc xdotool imagemagick \
        fonts-noto-cjk fonts-noto-color-emoji \
        python3 python3-pip python3-venv git jq unzip ripgrep \
    && rm -rf /var/lib/apt/lists/*

# uv 的安装脚本按目标架构下载二进制。
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Playwright 打包的 Chromium 同时有 linux/amd64 和 linux/arm64。
# Debian 的 chromium 包在容器里依赖不完整；Google Chrome stable 没有 arm64。
ARG PLAYWRIGHT_VERSION=1.56.1
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
RUN npm install --registry="$NPM_CONFIG_REGISTRY" --global playwright-core@${PLAYWRIGHT_VERSION} \
    && playwright-core install --with-deps chromium \
    && rm -rf /root/.npm

# 运行时不再依赖 node 解析 playwright-core，把浏览器路径写进镜像。
# openbox、x11vnc 只安装，这个镜像的默认进程不启动它们。
RUN mkdir -p /opt/viate \
    && node -e "process.stdout.write(require('/usr/local/lib/node_modules/playwright-core').chromium.executablePath())" > /opt/viate/chromium-bin \
    && test -x "$(cat /opt/viate/chromium-bin)" \
    && command -v runuser \
    && command -v Xvfb \
    && command -v x11vnc \
    && command -v openbox

# 官方镜像把 node 放在 /usr/local/bin。supervisord 和 machined 都按 /usr/bin/node 调用。
RUN ln -sf /usr/local/bin/node /usr/bin/node

# 官方镜像自带 uid 1000 的 node 用户。改名为 bot，避免和“用户命令以 bot 执行”的约定不一致。
RUN usermod --login bot --home /home/bot --move-home node \
    && groupmod --new-name bot node \
    && mkdir -p /opt/viate /var/log/supervisor \
    && chown root:root /opt/viate

COPY machined.mjs /opt/viate/machined.mjs
COPY fs-worker.mjs /opt/viate/fs-worker.mjs
COPY LICENSE /opt/viate/LICENSE
COPY run-as-bot.mjs /opt/viate/run-as-bot.mjs
COPY chromium.sh /opt/viate/chromium.sh
COPY xvfb.sh /opt/viate/xvfb.sh
COPY supervisord.conf /etc/supervisor/conf.d/viate.conf
RUN chmod 755 /opt/viate/machined.mjs /opt/viate/fs-worker.mjs /opt/viate/run-as-bot.mjs /opt/viate/chromium.sh /opt/viate/xvfb.sh \
    && chown root:root /opt/viate/machined.mjs /opt/viate/fs-worker.mjs /opt/viate/run-as-bot.mjs /opt/viate/chromium.sh /opt/viate/xvfb.sh \
    && sed -i 's/\r$//' /opt/viate/chromium.sh /opt/viate/xvfb.sh

EXPOSE 7070

COPY source_manifest.py /usr/local/lib/viate-bot/source_manifest.py
RUN python3 /usr/local/lib/viate-bot/source_manifest.py

# MACHINE_PROTOCOL 必须和 packages/protocol 的 MACHINE_PROTOCOL_VERSION 一致。
ARG MACHINE_PROTOCOL=1
ARG IMAGE_VERSION=0.0.0
ARG IMAGE_REVISION=unknown
ARG IMAGE_SOURCE=https://github.com/ViateAI/viate-bot
LABEL ai.viate.bot.machine-protocol=$MACHINE_PROTOCOL \
      org.opencontainers.image.version=$IMAGE_VERSION \
      org.opencontainers.image.source=$IMAGE_SOURCE \
      org.opencontainers.image.revision=$IMAGE_REVISION \
      org.opencontainers.image.licenses=MIT

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
