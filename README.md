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

控制面构建会把 `src` 中的 JavaScript（包括 `apps/link-mcp.mjs`）一并输出到 `dist`。部署前执行 `pnpm --filter @viate-bot/control build && pnpm --filter @viate-bot/control check:dist`，检查编译后的安装模块可直接加载，不依赖 `src`。部署仍需 `apps/control/drizzle` 迁移文件、工作区依赖和构建好的网页。

任务预算、用量和 length 续写次数在等待用户时也会持久化；重启恢复同一个任务不会重新获得预算。预算耗尽后不执行该轮返回的工具，任务失败且显示原因。缺少正常结束标记的模型响应，以及步数/时长耗尽，都不能伪造正常 `stop`。shell 自动规则只匹配可静态解析的字面词，含展开、环境变量覆盖或非默认工作目录时转人工审批；`fs_write` 不跟随路径中的符号链接。bot 禁用应用后，新任务不再加载该应用的 MCP 工具。

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
| `VB_MODEL_CONTEXT_TOKENS` | `256000` | 上下文窗口，正整数。管理员可按模型覆盖；只影响之后开始的任务 |
| `VB_SUMMARY_MAX_TOKENS` | `2000` | 上下文摘要单次输出上限，正整数 |
| `VB_TASK_TOKEN_BUDGET` | `2000000` | 单任务 token 预算。`0` 表示不限制。管理员可在模型设置改全局值，在配额里按用户覆盖。计入输入和输出，不计缓存读写 |
| `VB_MODEL_RATE_USER` | `30` | 每用户每分钟模型请求上限，正整数 |
| `VB_MODEL_RATE_BOT` | `20` | 每 bot 每分钟模型请求上限，正整数 |
| `VB_MAX_TASK_STEPS` | `16` | 单任务步数上限，正整数 |
| `VB_MAX_TASK_DURATION_SEC` | `600` | 单任务时长上限（秒），正整数 |
| `VB_DEFAULT_MAX_BOTS` | `5` | 管理员开通时写入配额的 bot 上限。已有配额行不会被这个值改写 |
| `VB_DEFAULT_MAX_CONCURRENT_TASKS` | `2` | 开通时写入配额的单用户并发任务上限 |
| `VB_DEFAULT_MAX_ROUTINES` | `10` | 开通时写入配额的定时任务上限。已有配额为 0 的用户不会被改写 |
| `VB_INTEGRATION` | `none` | `none` 或 `viate` |
| `VB_VIATE_URL` | 空 | 只在 `VB_INTEGRATION=viate` 时读。调服务接口时三项都必须有值 |
| `VB_VIATE_CLIENT_ID` | 空 | viate 服务客户端 id |
| `VB_VIATE_CLIENT_SECRET` | 空 | viate 服务客户端密钥 |
| `VB_ADMIN_EMAILS` | 空 | 逗号分隔。可信邮箱命中则登录后是管理员 |
| `VB_DATA_DIR` | `/data` | SQLite、密钥和应用归档目录。库文件是 `$VB_DATA_DIR/viate-bot.sqlite` |
| `VB_MACHINE_IMAGE` | `viate-bot/machine:dev` | 新建机器使用的镜像标签 |
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

## 端到端测试

`apps/e2e` 的浏览器套件不进 `pnpm test`（脚本是 `e2e` 和 `e2e:local`）。`pnpm test` 只跑域名解析参数的单元测试。浏览器套件用本机已安装的 Chrome 或 Edge（`channel`，或 `VB_E2E_BROWSER_PATH` 指向可执行文件），不下载 Playwright 自带浏览器。

本地冒烟（假模型、假机器、内置 OIDC，不碰 Docker）：

```sh
pnpm --filter @viate-bot/e2e e2e:local
```

默认端口 4418、4420–4423。被占用时改用 4430–4434。截图目录默认 `/tmp/vb-polish1-shots`，可用 `VB_E2E_SHOTS` 改。

对着已部署环境时，单独准备登录模块和控制面地址：

```sh
VB_E2E_BASE_URL=https://bot.example \
VB_E2E_LOGIN_MODULE=./login.js \
VB_E2E_ALLOW_ACCOUNT_MUTATION=1 \
VB_E2E_MODEL=deepseek-flash \
VB_E2E_AVATAR_PATH=/home/bot/e2e-avatar.png \
VB_E2E_BROWSER_CHANNEL=chrome \
pnpm --filter @viate-bot/e2e e2e
```

登录模块导出 `login({ browser, baseURL, role })`，返回内存里的 Playwright `storageState`，不要写登录态文件。本地实现是 `apps/e2e/src/login-local.ts`。`VB_E2E_LOGIN_MODULE` 用绝对文件路径，或相对于命令发起目录的路径。截图不包含登录表单。

接 viate OIDC 的部署（下例中 viate 在 `https://viate.example.com`，登录页是 `/portal/oauth-login`）用 viate 登录模块。实现是 `apps/e2e/src/login-viate.ts`，邮箱和密码只从环境变量读，不写进仓库：

```sh
VB_E2E_BASE_URL=https://bot.example.com \
VB_E2E_LOGIN_MODULE=apps/e2e/src/login-viate.ts \
VB_E2E_ADMIN_EMAIL=admin@example.com \
VB_E2E_ADMIN_PASSWORD=... \
VB_E2E_USER_EMAIL=user@example.com \
VB_E2E_USER_PASSWORD=... \
VB_E2E_ALLOW_ACCOUNT_MUTATION=1 \
VB_E2E_MODEL=deepseek-flash \
VB_E2E_AVATAR_PATH=/home/bot/e2e-avatar.png \
VB_E2E_HOST_RESOLVER_RULES="MAP bot.example.com 127.0.0.1,MAP viate.example.com 127.0.0.1" \
pnpm --filter @viate-bot/e2e e2e
```

本地冒烟用 `fake`；真实部署默认 `deepseek-flash`，可用 `VB_E2E_MODEL` 指定白名单内模型。真实部署必须使用已开通的专用普通测试账号（机器已存在），并显式设置 `VB_E2E_ALLOW_ACCOUNT_MUTATION=1`。头像场景需要该账号机器上预先准备好的 PNG 文件，路径由 `VB_E2E_AVATAR_PATH` 提供。套件只删除自己新建的 bot、规则和定时任务，并卸载唯一测试名的新安装；临时用户配额/详细过程开关在 finally 恢复。模型设置测试使用独立随机模型名，不改正在使用的模型。审计和软删除历史保留。Windows/真实模型验收需要另外运行，不能以本地假模型结果替代。

Clash 的 fake-ip 会把部署域名指到错误地址。二选一：`VB_E2E_HOST_RESOLVER_RULES` 传给 Chromium 的 `--host-resolver-rules`；或 curl 形式的 `VB_E2E_RESOLVE=host:port:address`（逗号分隔），套件转成 `MAP host ip`。端口只为对齐 curl。交给 Chromium 的地址必须是 IPv4。设了这条规则后，接口请求改在页面里 `fetch`，因为 Playwright 自己的 HTTP 客户端不走这条规则。给了 `VB_E2E_BROWSER_PATH` 时不再使用 `channel`。

Windows 宿主机是 Node 22，且没有 pnpm。`apps/e2e/docker-run.sh` 在 `mcr.microsoft.com/playwright:v1.49.1-noble` 里装 Node 24，再跑部署验收（镜像自带与 `playwright-core` 1.49 匹配的 Chromium）：

```sh
VB_E2E_BASE_URL=https://bot.example.com \
VB_E2E_ADMIN_EMAIL=admin@example.com \
VB_E2E_ADMIN_PASSWORD=... \
VB_E2E_USER_EMAIL=user@example.com \
VB_E2E_USER_PASSWORD=... \
VB_E2E_ALLOW_ACCOUNT_MUTATION=1 \
VB_E2E_MODEL=deepseek-flash \
VB_E2E_AVATAR_PATH=/home/bot/e2e-avatar.png \
VB_E2E_RESOLVE="bot.example.com:443:host.docker.internal,viate.example.com:443:host.docker.internal" \
apps/e2e/docker-run.sh
```

容器里的 `127.0.0.1` 不是 Windows 宿主机。`host.docker.internal` 不会原样传给 `docker run --add-host`（Docker 会拒绝这个主机名）。脚本把它写成 `--add-host <域名>:host-gateway`，进容器后再解析成 IPv4，交给 Chromium。其它地址必须已经是 IPv4。截图在 `VB_E2E_STORAGE_DIR`（缺省是临时目录），登录会话只在内存中，不写入这个目录。镜像可用 `VB_E2E_IMAGE` 改，Node 版本缺省 `24.22.3`，可用 `VB_E2E_NODE_VERSION` 改。

`VB_E2E_IGNORE_HTTPS_ERRORS=1` 时，登录上下文以及管理员和普通用户两个浏览器上下文忽略 HTTPS 证书错误。不设置则校验证书。`VB_E2E_PACE_MS` 是真实模式下两次发消息的间隔，缺省 15000 毫秒，设为 `0` 关闭；`VB_E2E_LOCAL=1` 的本地冒烟不等待。这两个变量由 `docker-run.sh` 透传进容器。

在 Windows Git Bash 里运行 `apps/e2e/docker-run.sh` 时，变量与上面的容器示例相同，主机名用部署环境自己的地址。Git Bash 会把以 `/` 开头的路径改写成 Windows 路径。脚本发现 `cygpath` 后，把仓库目录和截图目录转成盘符路径再挂载，并设置 `MSYS_NO_PATHCONV=1`，避免容器内的 `/work` 被改写。macOS 和 Linux 没有 `cygpath`，不改挂载路径。
