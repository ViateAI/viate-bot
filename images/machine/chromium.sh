#!/bin/sh
# 以 bot 身份把有界面 Chromium 跑在 Xvfb :1 上。调试端口只绑 127.0.0.1。
set -eu

export HOME=/home/bot
export USER=bot
export LOGNAME=bot
export DISPLAY=:1
export XDG_RUNTIME_DIR=/tmp/runtime-bot
export LANG=C.UTF-8

i=0
while [ ! -w /home/bot ]; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then
    echo "/home/bot 不可写" >&2
    exit 1
  fi
  sleep 0.1
done

mkdir -p /home/bot/.chrome /home/bot/Downloads "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

i=0
while [ ! -S /tmp/.X11-unix/X1 ]; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then
    echo "Xvfb :1 未就绪" >&2
    exit 1
  fi
  sleep 0.1
done

CHROME=$(cat /opt/viate/chromium-bin)
if [ ! -x "$CHROME" ]; then
  echo "找不到 Chromium：$CHROME" >&2
  exit 1
fi

cd /home/bot
# profile 在用户卷上。容器重建后主机名变了，旧的 SingletonLock 会让新进程立刻退出。
lock=/home/bot/.chrome/SingletonLock
if [ -L "$lock" ] || [ -e "$lock" ]; then
  target=$(readlink "$lock" || true)
  host=${target%-*}
  pid=${target##*-}
  self=$(cat /etc/hostname)
  if [ "$host" != "$self" ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "清掉过期的 profile 锁 ${target:-空}"
    rm -f /home/bot/.chrome/SingletonLock /home/bot/.chrome/SingletonCookie /home/bot/.chrome/SingletonSocket
  fi
fi
echo "启动 Chromium $CHROME"
# cap_drop ALL 且 no-new-privileges 时，SUID sandbox 不能提权，用户命名空间也被禁用。
# 容器是隔离边界，所以这里关闭 Chromium 自己的沙箱。
exec "$CHROME" \
  --no-sandbox \
  --user-data-dir=/home/bot/.chrome \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  --disable-breakpad \
  --disable-crash-reporter \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --proxy-server=http://127.0.0.1:3128 \
  --disable-quic \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  about:blank
