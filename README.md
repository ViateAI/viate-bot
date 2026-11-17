# viate-bot

给每个用户一台容器机器（浏览器、终端、文件系统）和一个控制面。用户在网页上和自己的 bot 对话；bot 可以跑定时任务，也可以使用管理员推送的应用（Skill、MCP、CLI）。用户之间隔离；同一用户的 bot 共享这台机器。

要求 Node.js 24 或更高，pnpm 12.16.1（`packageManager` 字段）。

## 开发

控制面不读取 `.env` 文件。先把变量放进当前进程的环境，再启动。仓库根目录：

```sh
cp .env.example .env
set -a
source .env
set +a
pnpm install --frozen-lockfile
pnpm --filter @viate-bot/control dev
```

PowerShell 没有仓库里的导入脚本。在 Windows 上按下表逐项设置进程环境，或在 WSL 里 `source`。

| 命令 | 作用 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 按锁文件安装 |
| `pnpm dev` | 并行跑各包已有的 `dev`：控制面、machined、网页 |
| `pnpm --filter @viate-bot/control dev` | 只跑控制面（`tsx src/main.ts`） |
| `pnpm --filter @viate-bot/machined dev` | 只跑本机 machined |
| `pnpm --filter @viate-bot/web dev` | Vite，端口 4420，把 `/api`、`/auth`、`/ws` 代理到 `VITE_CONTROL_ORIGIN`（缺省 `http://127.0.0.1:4418`） |
| `pnpm typecheck` | 先构建 protocol，再做各包类型检查 |
| `pnpm test` | 各包测试 |
| `pnpm build` | 构建 protocol，再构建其余有 `build` 的包 |
| `pnpm --filter @viate-bot/web build` | 网页构建到 `apps/web/dist`；控制面同源提供这个目录 |
| `pnpm --filter @viate-bot/control machine <create\|start\|stop\|rebuild\|delete\|inspect> <userId>` | 开发机器命令。必须 `VB_DEV=1` |
| `pnpm --filter @viate-bot/machined image [tag] [platform]` | 构建 machined 并 `docker buildx build --load`。缺省标签 `viate-bot/machine:dev` |
| `pnpm --filter @viate-bot/control exec tsx scripts/load-control.ts` | 控制面压测。只绑 `127.0.0.1` 的 4418、4421、4422，不进测试套件 |

开发时浏览器走 Vite（4420）的话，`VB_PUBLIC_URL` 必须是浏览器打开的源，`VB_CONTROL_PORT` 必须和 `VITE_CONTROL_ORIGIN` 的端口一致。例如控制面 `4418`、公开地址 `http://127.0.0.1:4420`、`VITE_CONTROL_ORIGIN=http://127.0.0.1:4418`。控制面自己提供构建好的网页时，公开地址和控制面端口用同一个源。

## 配置

只读进程环境。缺省值是 `apps/control/src/config.ts` 里变量未设置或空字符串时的值。`.env.example` 把 `VB_DATA_DIR` 设成 `./data`，代码缺省是 `/data`。

| 变量 | 缺省 | 作用 |
| --- | --- | --- |
| `VB_PUBLIC_URL` | `http://127.0.0.1:3000` | 浏览器所见的源。OIDC 回调和 WebSocket 的 Origin 检查用它 |
| `VB_OIDC_ISSUER` | 空 | OIDC issuer。登录时三项都必须有值 |
| `VB_OIDC_CLIENT_ID` | 空 | OIDC client id |
| `VB_OIDC_CLIENT_SECRET` | 空 | OIDC client secret |
| `VB_ALLOW_SIGNUP` | `false` | `true` 时，未知身份可以建一个还没有 bot 的用户。不会自动开通 bot |
| `VB_OIDC_TRUST_EMAIL` | `false` | `true` 时把身份提供方给出的邮箱当作已验证 |
| `VB_MODEL_BASE_URL` | 空 | 模型网关地址。调用模型时必须有值 |
| `VB_MODEL_API_KEY` | 空 | 共享 key。共享模式下调用模型时必须有值 |
| `VB_MODELS` | 空 | 逗号分隔的模型白名单。空表示不额外限制 |
| `VB_MODEL_API` | `openai-completions` | `openai-completions` 或 `openai-responses` |
| `VB_MODEL_MAX_TOKENS` | `4096` | 单次生成上限，正整数 |
| `VB_MODEL_CONTEXT_TOKENS` | `128000` | 上下文窗口，正整数 |
| `VB_SUMMARY_MAX_TOKENS` | `2000` | 上下文摘要单次输出上限，正整数 |
| `VB_TASK_TOKEN_BUDGET` | `100000` | 单任务 token 预算，正整数 |
| `VB_MODEL_RATE_USER` | `30` | 每用户每分钟模型请求上限，正整数 |
| `VB_MODEL_RATE_BOT` | `20` | 每 bot 每分钟模型请求上限，正整数 |
| `VB_MAX_TASK_STEPS` | `16` | 单任务步数上限，正整数 |
| `VB_MAX_TASK_DURATION_SEC` | `600` | 单任务时长上限（秒），正整数 |
| `VB_DEFAULT_MAX_BOTS` | `5` | 管理员开通时写入配额的 bot 上限。已有配额行不会被这个值改写 |
| `VB_DEFAULT_MAX_CONCURRENT_TASKS` | `2` | 开通时写入配额的单用户并发任务上限 |
| `VB_INTEGRATION` | `none` | `none` 或 `viate` |
| `VB_VIATE_URL` | 空 | 只在 `VB_INTEGRATION=viate` 时读。调服务接口时三项都必须有值 |
| `VB_VIATE_CLIENT_ID` | 空 | viate 服务客户端 id |
| `VB_VIATE_CLIENT_SECRET` | 空 | viate 服务客户端密钥 |
| `VB_ADMIN_EMAILS` | 空 | 逗号分隔。可信邮箱命中则登录后是管理员 |
| `VB_DATA_DIR` | `/data` | SQLite、密钥和应用归档目录。库文件是 `$VB_DATA_DIR/viate-bot.sqlite` |
| `VB_MACHINE_IMAGE` | `viate-bot/machine:dev` | 新建机器使用的镜像标签 |
| `VB_MACHINE_DNS` | 空 | 逗号分隔的 DNS IP 字面量；写入新建/重建容器的 `HostConfig.Dns`。空则沿用 Docker 默认 DNS；非法地址会阻止启动 |
| `VB_IDLE_STOP_MINUTES` | `120` | 空闲多久后停机，单位分钟。非负整数。`0` 表示空闲条件一满足就停机 |
| `VB_MAX_RUNNING_TASKS` | `20` | 控制面全局同时处于运行中的任务上限。非负整数。`0` 表示不再开始新任务 |
| `VB_METRICS_TOKEN` | 空 | `GET /metrics` 的 Bearer token。空则拒绝所有抓取 |
| `VB_VISION_MODELS` | 空 | 逗号分隔。这些模型才注册 `browser_screenshot` |
| `VB_SECRET_WAIT_MS` | `1800000` | `request_secret` 等待用户的毫秒数。超时后任务失败。正整数 |
| `VB_CONTROL_PORT` | `3000` | 控制面监听端口。非负整数 |
| `VB_DEV` | 关 | 只有 `1` 打开 `/dev/*` 和 `machine` 命令 |

`VB_RATE_MBIT`、`VB_HASHLIMIT`、`VB_HASHLIMIT_BURST`、`VB_CONNLIMIT` 只给 WSL 里的防火墙脚本用，不是控制面配置。见 `deploy/rancher-desktop/README.md`。

## Windows + Rancher Desktop

目标机器是 Windows 上的 Rancher Desktop（WSL2、Alpine、amd64、dockerd/moby，关掉 Kubernetes）。控制面跑在 WSL 宿主网络命名空间里，主动连机器上的 machined。把控制面放进用户网桥并不能让它连上 machined，这一步还没有实现。

防火墙的安装、策略和验收只写在 `deploy/rancher-desktop/README.md`。它使用同目录的 `deploy/rancher-desktop/vb-firewall.start` 和 `deploy/rancher-desktop/vb-firewall-check.sh`。先按那份文档把防火墙装上并验收，再跑用户机器。

在部署机上构建机器镜像（Windows 上的 Docker 是 amd64）：

```sh
pnpm install --frozen-lockfile
pnpm --filter @viate-bot/machined image viate-bot/machine:dev linux/amd64
```

标签要和 `VB_MACHINE_IMAGE` 一致。然后按上面的方式启动控制面。管理员登录后开通用户；开通会按当时的镜像标签建容器。

### 网络出口与 fake-ip DNS

machined 和桌面客户端默认拒绝 `198.18.0.0/15`，避免 fake-ip 隐藏最终的私网目标。宿主机启用 Clash / Surge / sing-box fake-ip 时，设置 `VB_MACHINE_DNS=223.5.5.5,1.1.1.1`，使机器容器使用真实 DNS；已有机器必须重建容器才生效。用户网桥里 `/etc/resolv.conf` 可能仍显示 Docker 的 `127.0.0.11`，实际外部解析器应在容器 `HostConfig.Dns` 及 resolv.conf 注释里检查。若 TUN 劫持所有 DNS，还需在代理软件中让这些解析器返回真实地址。TUN 按 IP / SNI 分流不依赖 fake-ip。

Rancher Desktop 防火墙脚本不封锁公网 IPv4 的 UDP/TCP 53；公网 DNS 仍受连接速率限额约束。它封锁私网 DNS，且用户网桥的 IPv6 全部丢弃，因此该部署请使用可达的公网 IPv4 DNS。不要为 DNS 放宽现有防火墙策略。

用户电脑也建议使用真实 DNS。确实需要 fake-ip 时，可运行 `viate-egress run --base https://bot.example --allow-fake-ip`：只额外放行 `198.18.0.0/15`，其它私网仍拒绝。**fake-ip 会隐藏真实目标；必须确保代理软件不会把这些连接直连进内网。** 每次启用启动都会打印风险提示。选择持久化在 `~/.viate-bot/egress.json`（`{"allowFakeIp":true}`；可用 `--config <path>` 指定路径）；使用 `--no-allow-fake-ip` 或把值改为 `false` 关闭。默认没有配置文件时关闭。控制面只在用户设备列表显示“允许 fake-ip”，不改变中继规则，管理端不显示该标记。machined direct 不提供此例外。

## 桌面客户端

托盘程序在 `apps/desktop`，隧道、拨号、目标检查和绑定仍用 `packages/egress-client`。内测不做代码签名，也不做自动更新。设置 `VB_DESKTOP_DOWNLOAD_URL` 后，用户端「网络出口」页显示这个下载地址；留空则继续显示命令行说明。

### 构建

macOS arm64 在 Mac 上构建：

```sh
pnpm install --frozen-lockfile
pnpm --filter @viate-bot/desktop dist:mac
```

产物在 `apps/desktop/release/`，有 zip 和 dmg。脚本设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`，避免把钥匙串里的开发证书拿去签名。

Windows x64 的 NSIS 安装包：

```sh
pnpm install --frozen-lockfile
pnpm --filter @viate-bot/desktop dist:win
```

产物在 `apps/desktop/release/`，文件名是 `viate-bot-<version>-win-x64.exe`。electron-builder 26 会自己下载 NSIS，macOS 上这条命令不需要 Wine。Windows 上用同一条命令。

`dist:mac:test` 是验收用的开发构建：允许 `http://127.0.0.1` 和 `http://localhost`，并包含环境变量 `VB_EGRESS_ALLOW_PRIVATE` 这条测试入口。不要分发它。发布构建不引用这段代码；`apps/desktop/scripts/build.mjs` 会在发布产物出现 `VB_EGRESS_ALLOW_PRIVATE` 时失败。

### 安装

macOS Gatekeeper 会拦截未签名应用。在 Finder 里对 `viate-bot.app` 按住 Control 点按，选择「打开」，再确认打开。系统设置 → 隐私与安全性里也可能出现「仍要打开」。只对你核对过的这份安装包，可以去掉下载隔离标记：`xattr -dr com.apple.quarantine /Applications/viate-bot.app`。

Windows SmartScreen 会提示已保护你的电脑。点「更多信息」，再点「仍要运行」。这是因为安装包没有代码签名。

### 绑定

首次打开填写 viate-bot 地址。发布版只接受 `https://`。开发构建另外接受 `http://127.0.0.1` 和 `http://localhost`。客户端在本机随机端口等待回调，并用系统浏览器打开这个站点的 `/client/link`。网页上点「允许」后，浏览器回到 `http://127.0.0.1:<端口>/callback`。设备令牌只用 Electron `safeStorage` 加密后放在用户数据目录。系统加密不可用时拒绝保存，不会退回明文。托盘里的「退出登录」删除这份密文。

托盘显示在线、离线、已暂停或未绑定，以及今日流量。暂停会断开出口并且不再重连，机器侧按离线策略处理。开机自启动默认关闭。

### fake-ip

托盘里的「允许 fake-ip」默认不勾选。勾选前会要求确认：只额外放行 `198.18.0.0/15`，其它私网仍然拒绝。fake-ip 会隐藏真实目标，必须确保代理软件不会把这些连接直连进内网。取消勾选后立即恢复拒绝。客户端重连时把开关报给控制面，用户设备列表显示「允许 fake-ip」。

命令行的 `--allow-fake-ip` 仍然写 `~/.viate-bot/egress.json`，和桌面客户端的用户数据目录互不影响。

## 升级

新的 machined 只存在于新建的容器里。只构建镜像、不重建已有机器的容器，跑着的仍是旧进程。

1. 停掉控制面进程，更新代码后再执行上一节的镜像命令。标签保持不变，让 `docker buildx build --load` 替换本地这个标签。
2. 再启动控制面。数据库在 `VB_DATA_DIR`，升级不要删它。
3. 对每一台已有机器重建容器：管理端「机器」页的「重建」，或 `POST /api/admin/machines/<machineId>/rebuild`。这会删掉旧容器并用该机器记录上的镜像标签新建一个。卷保留。有未完成任务时这个接口拒绝。
4. 开发环境且 `VB_DEV=1` 时，对应的命令是 `pnpm --filter @viate-bot/control machine rebuild <userId>`。
5. 防火墙脚本有变更时，按 `deploy/rancher-desktop/README.md` 重新下发并验收。不要只替换文件而不重跑 provisioning。

## 接 viate

`VB_INTEGRATION=viate`。登录仍走下一节的 OIDC 变量，issuer 是 viate 的 OIDC issuer。服务接口（用户状态、模型 key、用量）另外读：

```sh
VB_INTEGRATION=viate
VB_VIATE_URL=https://viate.example
VB_VIATE_CLIENT_ID=
VB_VIATE_CLIENT_SECRET=
```

缺任何一项不会阻止控制面启动；第一次调服务接口才报错。viate 的 `id_token` 已经带已验证邮箱时，`VB_OIDC_TRUST_EMAIL` 保持 `false`。邮箱只有在身份提供方侧被当作已验证时才设 `true`。

## 任意 OIDC

`VB_INTEGRATION=none`。登录要：

```sh
VB_PUBLIC_URL=https://bot.example
VB_OIDC_ISSUER=https://idp.example/realms/bot
VB_OIDC_CLIENT_ID=
VB_OIDC_CLIENT_SECRET=
VB_OIDC_TRUST_EMAIL=false
VB_ALLOW_SIGNUP=false
VB_ADMIN_EMAILS=admin@example.com
```

提供方要有 `openid` scope、`id_token`、JWKS 和 `/.well-known/openid-configuration`。回调地址是 `{VB_PUBLIC_URL}/auth/callback`。`id_token` 缺邮箱、姓名或 `email_verified` 时，控制面用 access token 调 userinfo 补。管理员只能来自 `VB_ADMIN_EMAILS` 里的可信邮箱。
