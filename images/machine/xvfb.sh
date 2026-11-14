#!/bin/sh
# 卷挂载会盖住镜像里的 /home/bot，所有者是 root。
# 在拉起 Xvfb 之前把家目录交给 uid 1000，Chromium 才能写 profile。
set -eu
mkdir -p /home/bot /tmp/.X11-unix
chown 1000:1000 /home/bot
chmod 1777 /tmp/.X11-unix
exec /usr/sbin/runuser -u bot -- /usr/bin/Xvfb :1 -screen 0 1280x720x24 -ac -nolisten tcp -noreset
