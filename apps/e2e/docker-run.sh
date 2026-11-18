#!/bin/sh
# 在 Playwright 容器里跑已部署环境的端到端测试。
# Windows 宿主机是 Node 22，且没有 pnpm。镜像自带与 playwright-core 1.49 匹配的 Chromium；
# 容器里再装 Node 24。本脚本不启动控制面。
# 真实部署默认使用 deepseek-flash；本地冒烟另用 fake。
set -eu

IMAGE=${VB_E2E_IMAGE:-mcr.microsoft.com/playwright:v1.49.1-noble}
NODE_VERSION=${VB_E2E_NODE_VERSION:-24.22.3}

is_ipv4() {
  printf '%s' "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
}

add_host_target() {
  if [ "$1" = "host.docker.internal" ]; then
    printf '%s\n' host-gateway
    return 0
  fi
  if is_ipv4 "$1"; then
    printf '%s\n' "$1"
    return 0
  fi
  echo "VB_E2E_RESOLVE 的地址必须是 IPv4 或 host.docker.internal，收到 $1" >&2
  return 1
}

lookup_ipv4() {
  name=$1
  ip=""
  if command -v getent >/dev/null 2>&1; then
    ip=$(getent ahostsv4 "$name" 2>/dev/null | awk 'NR==1 { print $1; exit }')
  fi
  if [ -z "$ip" ] && command -v python3 >/dev/null 2>&1; then
    ip=$(python3 -c 'import socket,sys; print(socket.getaddrinfo(sys.argv[1], None, socket.AF_INET)[0][4][0])' "$name" 2>/dev/null || true)
  fi
  if ! is_ipv4 "${ip:-}"; then
    return 1
  fi
  printf '%s\n' "$ip"
}

for_resolve() {
  mode=$1
  rest=$2
  rewritten=""
  while [ -n "$rest" ]; do
    item=${rest%%,*}
    if [ "$item" = "$rest" ]; then rest=""; else rest=${rest#*,}; fi
    item=$(printf '%s' "$item" | tr -d '[:space:]')
    if [ -z "$item" ]; then
      continue
    fi
    host=${item%%:*}
    tail=${item#*:}
    port=${tail%%:*}
    address=${tail#*:}
    if [ -z "$host" ] || [ -z "$port" ] || [ "$address" = "$tail" ] || [ -z "$address" ]; then
      echo "VB_E2E_RESOLVE 应为 host:port:address，收到 ${item}" >&2
      return 1
    fi
    case $mode in
      add-host)
        target=$(add_host_target "$address") || return 1
        case $address in
          127.0.0.1|localhost|::1)
            echo "注意: 容器里的 $address 不是 Windows 宿主机。请写 host.docker.internal，脚本会转成 --add-host ${host}:host-gateway。" >&2
            ;;
        esac
        printf '%s\n' "--add-host"
        printf '%s\n' "${host}:${target}"
        ;;
      rewrite)
        if is_ipv4 "$address"; then
          ip=$address
        elif ip=$(lookup_ipv4 "$address"); then
          :
        elif ip=$(lookup_ipv4 "$host"); then
          :
        else
          echo "无法把 $address 解析成 IPv4。Chromium 的 host-resolver-rules 不能使用主机名。" >&2
          return 1
        fi
        if [ -n "$rewritten" ]; then rewritten="$rewritten,"; fi
        rewritten="${rewritten}${host}:${port}:${ip}"
        ;;
    esac
  done
  if [ "$mode" = "rewrite" ]; then
    printf '%s\n' "$rewritten"
  fi
}

rewrite_resolver_rules() {
  rest=$1
  rewritten=""
  while [ -n "$rest" ]; do
    item=${rest%%,*}
    if [ "$item" = "$rest" ]; then rest=""; else rest=${rest#*,}; fi
    item=$(printf '%s' "$item" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [ -z "$item" ]; then
      continue
    fi
    address=${item##* }
    prefix=${item% *}
    if [ "$address" = "$item" ] || [ -z "$prefix" ]; then
      echo "VB_E2E_HOST_RESOLVER_RULES 应为 MAP host address，收到 ${item}" >&2
      return 1
    fi
    mapped=${prefix##* }
    wanted=$address
    if is_ipv4 "$wanted"; then
      address=$wanted
    elif address=$(lookup_ipv4 "$wanted"); then
      :
    elif address=$(lookup_ipv4 "$mapped"); then
      :
    else
      echo "无法把 $wanted 解析成 IPv4。Chromium 的 host-resolver-rules 不能使用主机名。" >&2
      return 1
    fi
    if [ -n "$rewritten" ]; then rewritten="$rewritten,"; fi
    rewritten="${rewritten}${prefix} ${address}"
  done
  printf '%s\n' "$rewritten"
}

case ${1:-} in
  --add-host-args)
    for_resolve add-host "${VB_E2E_RESOLVE:-}"
    exit 0
    ;;
  --rewrite-resolve)
    for_resolve rewrite "${VB_E2E_RESOLVE:-}"
    exit 0
    ;;
  --rewrite-rules)
    rewrite_resolver_rules "${VB_E2E_HOST_RESOLVER_RULES:-}"
    exit 0
    ;;
esac

if [ "${VB_E2E_INSIDE_DOCKER:-}" != "1" ]; then
  root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
  : "${VB_E2E_BASE_URL:?缺少 VB_E2E_BASE_URL}"
  : "${VB_E2E_ADMIN_EMAIL:?缺少 VB_E2E_ADMIN_EMAIL}"
  : "${VB_E2E_ADMIN_PASSWORD:?缺少 VB_E2E_ADMIN_PASSWORD}"
  : "${VB_E2E_USER_EMAIL:?缺少 VB_E2E_USER_EMAIL}"
  : "${VB_E2E_USER_PASSWORD:?缺少 VB_E2E_USER_PASSWORD}"
  storage=${VB_E2E_STORAGE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/vb-e2e-storage.XXXXXX")}
  mkdir -p "$storage"
  echo "截图: $storage（登录会话只在内存中）"
  host_args=""
  if [ -n "${VB_E2E_RESOLVE:-}" ]; then
    host_args=$(for_resolve add-host "$VB_E2E_RESOLVE")
  fi
  # Git Bash 会把 /d/... 和容器内的 /work 都改写成 Windows 路径。挂载源改成盘符，再关掉转换。
  if command -v cygpath >/dev/null 2>&1; then
    root=$(cygpath -w "$root")
    storage=$(cygpath -w "$storage")
  fi
  export MSYS_NO_PATHCONV=1
  # shellcheck disable=SC2086
  exec docker run --rm \
    -v "$root:/work:ro" \
    -v "$storage:/e2e-storage" \
    -e VB_E2E_INSIDE_DOCKER=1 \
    -e VB_E2E_NODE_VERSION="$NODE_VERSION" \
    -e VB_E2E_BASE_URL \
    -e VB_E2E_ADMIN_EMAIL \
    -e VB_E2E_ADMIN_PASSWORD \
    -e VB_E2E_USER_EMAIL \
    -e VB_E2E_USER_PASSWORD \
    -e VB_E2E_HOST_RESOLVER_RULES \
    -e VB_E2E_RESOLVE \
    -e VB_E2E_BROWSER_CHANNEL \
    -e VB_E2E_BROWSER_PATH \
    -e VB_E2E_MODEL \
    -e VB_E2E_AVATAR_PATH \
    -e VB_E2E_ALLOW_ACCOUNT_MUTATION \
    -e VB_E2E_IGNORE_HTTPS_ERRORS \
    -e VB_E2E_PACE_MS \
    $host_args \
    "$IMAGE" \
    sh /work/apps/e2e/docker-run.sh
fi

if ! node -p "process.versions.node.split('.')[0]" 2>/dev/null | grep -qx 24; then
  arch=$(uname -m)
  case $arch in
    x86_64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) echo "不支持的架构 $arch" >&2; exit 1 ;;
  esac
  url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.gz"
  echo "安装 Node ${NODE_VERSION}"
  curl -fsSL "$url" | tar -xz -C /usr/local --strip-components=1
  hash -r
fi
node -v | grep -q '^v24\.' || { echo "容器里的 Node 不是 24: $(node -v)" >&2; exit 1; }

rm -rf /tmp/e2e
mkdir -p /tmp/e2e
cp -a /work/apps/e2e/package.json /work/apps/e2e/tsconfig.json /work/apps/e2e/src /tmp/e2e/
cd /tmp/e2e
npm install
if [ -z "${VB_E2E_BROWSER_PATH:-}" ]; then
  VB_E2E_BROWSER_PATH=$(find /ms-playwright -type f -name chrome -path '*chrome-linux*' | head -n 1)
  if [ -z "$VB_E2E_BROWSER_PATH" ]; then
    echo "镜像里没有 Chromium，请设置 VB_E2E_BROWSER_PATH" >&2
    exit 1
  fi
  export VB_E2E_BROWSER_PATH
  unset VB_E2E_BROWSER_CHANNEL || true
fi
if [ -n "${VB_E2E_RESOLVE:-}" ]; then
  VB_E2E_RESOLVE=$(for_resolve rewrite "$VB_E2E_RESOLVE")
  export VB_E2E_RESOLVE
fi
if [ -n "${VB_E2E_HOST_RESOLVER_RULES:-}" ]; then
  VB_E2E_HOST_RESOLVER_RULES=$(rewrite_resolver_rules "$VB_E2E_HOST_RESOLVER_RULES")
  export VB_E2E_HOST_RESOLVER_RULES
fi
export VB_E2E_LOGIN_MODULE=/tmp/e2e/src/login-viate.ts
export VB_E2E_SHOTS=${VB_E2E_SHOTS:-/e2e-storage/shots}
exec npx tsx src/run.ts
