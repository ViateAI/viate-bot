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
RUN npm install --global playwright-core@${PLAYWRIGHT_VERSION} \
    && playwright-core install --with-deps chromium \
    && rm -rf /root/.npm

# 官方镜像把 node 放在 /usr/local/bin。supervisord 和 machined 都按 /usr/bin/node 调用。
RUN ln -sf /usr/local/bin/node /usr/bin/node

# 官方镜像自带 uid 1000 的 node 用户。改名为 bot，避免和“用户命令以 bot 执行”的约定不一致。
RUN usermod --login bot --home /home/bot --move-home node \
    && groupmod --new-name bot node \
    && mkdir -p /opt/viate /var/log/supervisor \
    && chown root:root /opt/viate

COPY machined.mjs /opt/viate/machined.mjs
COPY fs-worker.mjs /opt/viate/fs-worker.mjs
COPY run-as-bot.mjs /opt/viate/run-as-bot.mjs
COPY supervisord.conf /etc/supervisor/conf.d/viate.conf
RUN chmod 755 /opt/viate/machined.mjs /opt/viate/fs-worker.mjs /opt/viate/run-as-bot.mjs \
    && chown root:root /opt/viate/machined.mjs /opt/viate/fs-worker.mjs /opt/viate/run-as-bot.mjs

EXPOSE 7070

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
