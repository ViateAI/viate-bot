# viate-bot

English: [README.md](README.md)

给每个用户一台容器机器（浏览器、终端、文件系统）和一个控制面。用户在网页上和自己的 bot 对话；bot 可以跑定时任务，也可以使用管理员推送的应用（Skill、MCP、CLI）。用户之间隔离；同一用户的 bot 共享这台机器。

## 架构

网页是 `apps/web`。控制面 `apps/control` 负责登录、bot、对话任务、审批、定时任务和管理端，数据在 SQLite。每个用户一台机器容器：镜像里的 `machined` 执行命令、读写文件、打开浏览器，并加载管理员推送的应用。控制面主动连接这台机器上的 machined。同一用户的 bot 共享这台机器；用户之间用各自的 Docker 网络和防火墙隔开。

## 用已发布的镜像开始

第一个版本发布后，镜像在 GHCR。控制面镜像的缺省机器镜像就是同一标签的机器镜像，仍可用 `VB_MACHINE_IMAGE` 覆盖。

```sh
docker pull ghcr.io/viateai/viate-bot-control:v0.1.0
docker pull ghcr.io/viateai/viate-bot-machine:v0.1.0
```

在 **Docker daemon 所在的 Linux 环境**启动控制面（Rancher Desktop 为其 WSL 环境）。先确认 Docker socket 的 GID，不要套用 Mac 或 Windows 代理 socket 的 GID。

```sh
docker run --rm --network host \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e VB_PUBLIC_URL=http://127.0.0.1:3000 \
  -e VB_OIDC_ISSUER=https://id.example/ \
  -e VB_OIDC_CLIENT_ID=bot \
  -e VB_OIDC_CLIENT_SECRET=replace-me \
  -e VB_ADMIN_EMAILS=admin@example.com \
  -e VB_MODEL_BASE_URL=https://model.example/v1 \
  -e VB_MODEL_API_KEY=replace-me \
  -e VB_MODELS=your-model-id \
  -v viate-bot-data:/data \
  ghcr.io/viateai/viate-bot-control:v0.1.0
```

`/data` 保存 SQLite 和密钥。登录、模型地址和密钥用环境变量传入，不要写进镜像。`--network host` 使控制面从 daemon 宿主网络主动连接用户机器。只把控制面放进用户网桥会被私网规则拦住，不能这样部署。详见 [防火墙部署边界](deploy/rancher-desktop/README.md#实际策略与边界)。Host 网络下端口直接在宿主监听，用反向代理和宿主防火墙限制入口。

Docker socket 访问等于该 daemon 的 root 权限。不要用 `chmod 666` 或未认证的 Docker TCP 端口解决权限。绑定宿主目录到 `/data` 时还须允许 UID 1000 写入。

在 IdP 注册 `{VB_PUBLIC_URL}/auth/callback`。把 `admin@example.com` 换成 IdP 中已验证的管理员邮箱，把 `your-model-id` 换成模型网关提供的模型。管理员登录后在管理端开通用户。创建任何用户机器之前，先安装并验收 Rancher Desktop 防火墙；仅有 Docker 网桥不能提供文档所述的出口隔离。

要求 Node.js 24 或更高，pnpm 12.16.1（`packageManager` 字段）。

## 开发

控制面不读取 `.env` 文件。先把变量放进当前进程的环境，再启动。仓库根目录：

```sh
cp .env.example .env
set -a
source .env
set +a
pnpm install --frozen-lockfile
pnpm --filter @viate-bot/protocol build
pnpm --filter @viate-bot/integration-viate build
pnpm --filter @viate-bot/browser build
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

控制面构建会把 `src` 中的 JavaScript（包括 `apps/link-mcp.mjs`）一并输出到 `dist`。部署前执行 `pnpm --filter @viate-bot/control build && pnpm --filter @viate-bot/control check:dist`，检查编译后的安装模块和服务端导入图可直接加载，不依赖 `src`。镜像在 `deploy --prod` 后再跑同一检查，防止开发依赖掩盖运行依赖缺失。部署仍需 `apps/control/drizzle` 迁移文件、工作区依赖和构建好的网页。

## 控制面镜像

在仓库根目录构建。Node 24 基础镜像按 digest 固定，pnpm 版本与根 `packageManager` 一致，锁文件冻结；先复制工作区清单安装依赖，源码改动不会重新安装依赖。镜像只打包网页、迁移、编译产物和生产依赖，不含工作区源码、测试或环境文件，运行用户是 `node`。

控制面创建机器时只连接 `/var/run/docker.sock`，目前不读取 `DOCKER_HOST`。必须挂入实际 Docker daemon 的 socket，且容器里的非 root 用户要有该 socket 的组权限。以下运行示例在 **Docker daemon 所在的 Linux 环境**执行（Rancher Desktop 为其 WSL 环境）；先确认 socket 所属 GID，不能直接套用 Mac/Windows 代理 socket 的 GID。

```sh
docker build -f images/control/Dockerfile -t viate-bot/control:dev .
docker run --rm --network host \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e VB_PUBLIC_URL=http://127.0.0.1:3000 \
  -e VB_OIDC_ISSUER=https://id.example/ \
  -e VB_OIDC_CLIENT_ID=bot \
  -e VB_OIDC_CLIENT_SECRET=replace-me \
  -e VB_ADMIN_EMAILS=admin@example.com \
  -e VB_MODEL_BASE_URL=https://model.example/v1 \
  -e VB_MODEL_API_KEY=replace-me \
  -e VB_MODELS=your-model-id \
  -v viate-bot-data:/data \
  viate-bot/control:dev
```

`/data` 挂载保存 SQLite 和密钥。登录、模型地址和密钥按上一节的环境变量传入，不要写进镜像。构建阶段会编译 `better-sqlite3`，并让 `esbuild` 下载对应平台的二进制；这两项在 `pnpm-workspace.yaml` 的 `allowBuilds` 里，其余依赖安装脚本不运行。

Docker socket 访问相当于该 daemon 的 root 权限；不要用 `chmod 666` 或开放未认证的 Docker TCP 端口解决权限问题。绑定宿主目录到 `/data` 时还须允许 UID 1000 写入。`--network host` 使控制面从 daemon 宿主网络主动连接用户机器，和现有 Rancher Desktop 防火墙相容；仅把控制面加入用户网桥会被私网规则拦截，不能视为受支持的部署方式。详见 [防火墙部署边界](deploy/rancher-desktop/README.md#实际策略与边界)。Host 网络下端口直接在宿主监听，请由反向代理和宿主防火墙限制入口。

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
| `VB_OIDC_TRUST_EMAIL` | `false` | **全局邮箱信任开关，不仅用于管理员首登。** 关闭时只有 `email_verified=true` 才能按邮箱认管理员、自动绑定唯一未绑定用户或放行管理员首登。打开后这三条路径都信任 IdP 的未验证邮箱（含 `false` 或缺失），但仍须有非空邮箱声明。能在 IdP 拿到管理员邮箱的人可成为管理员；能拿到任意预开通邮箱的人也可绑定该唯一未绑定用户并访问其 bot、机器及数据，即使关闭注册且邮箱不在管理员列表。已绑定用户仍只按 `(provider, sub)` 匹配，不按邮箱合并。只有 IdP 不开放自助注册、或账号由管理员创建且邮箱不可由不可信用户任意修改时才应打开；对接其他 IdP 先确认。viate 的 `email_verified` 恒为 `false`，接 viate 时需要打开 |
| `VB_MODEL_BASE_URL` | 空 | 模型网关地址。调用模型时必须有值 |
| `VB_MODEL_API_KEY` | 空 | 共享 key。共享模式下调用模型时必须有值 |
| `VB_MODELS` | 空 | 逗号分隔的模型白名单。空表示不额外限制 |
| `VB_MODEL_API` | `openai-completions` | `openai-completions` 或 `openai-responses` |
| `VB_MODEL_MAX_TOKENS` | `4096` | 单次生成上限，正整数 |
| `VB_MODEL_CONTEXT_TOKENS` | `256000` | 上下文窗口，正整数。管理员可按模型覆盖；只影响之后开始的任务 |
| `VB_SUMMARY_MAX_TOKENS` | `2000` | 上下文摘要单次输出上限，正整数 |
| `VB_TASK_TOKEN_BUDGET` | `2000000` | 单任务 token 预算。`0` 表示不限制。管理员可在模型设置改全局值，在配额里按用户覆盖。计入输入和输出，不计缓存读写 |
| `VB_MODEL_RATE_USER` | `120` | 每用户每分钟模型请求上限。非负整数，`0` 表示不限制。管理员可在模型设置覆盖，下一次调用即生效。超限会等待，不让任务失败 |
| `VB_MODEL_RATE_BOT` | `60` | 每 bot 每分钟模型请求上限。非负整数，`0` 表示不限制。和用户窗口一起判断，两个都有空位才记一次 |
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
| `VB_MACHINE_IMAGE` | `viate-bot/machine:dev` | 新建机器使用的镜像标签。未设置时再读 `VB_MACHINE_IMAGE_DEFAULT`，仍为空才用左边的缺省。发布镜像会把 `VB_MACHINE_IMAGE_DEFAULT` 设成同一版本的 `ghcr.io/viateai/viate-bot-machine:vX.Y.Z`。从源码运行不要设置它 |
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
pnpm --filter @viate-bot/protocol build
pnpm --filter @viate-bot/browser build
pnpm --filter @viate-bot/machined image viate-bot/machine:dev linux/amd64
```

标签要和 `VB_MACHINE_IMAGE` 一致。然后按上面的方式启动控制面。管理员登录后开通用户；开通会按当时的镜像标签建容器。

## 安全模型

- 挂载 `docker.sock` 等于该 Docker daemon 的 root。控制面用它创建用户机器。不要把 socket 改成 `0666`，也不要开放没有认证的 Docker TCP。
- `VB_OIDC_TRUST_EMAIL` 是全局开关，不只用于管理员第一次登录。打开后，身份提供方给出的未验证邮箱也会被信任：能拿到管理员邮箱的人可以成为管理员；能拿到某个已预开通、尚未绑定的邮箱的人可以绑定那个用户，并使用其 bot 和机器。已绑定用户仍只按 `(provider, sub)` 匹配。只有身份提供方不开放自助注册，或账号由管理员创建且邮箱不能被不可信用户改掉时才应打开。viate 的 `email_verified` 恒为 `false`，接 viate 时需要打开。
- 每个用户一个 Docker 网络。机器容器丢掉全部能力后再加回降权所需的几项，`no-new-privileges` 打开，不挂载宿主目录。机器之间的隔离还依赖 `deploy/rancher-desktop` 里的防火墙：丢弃发往私网地址的新连接，限制每个源的新连接速率和 TCP 并发，并限制带宽。这套规则只在 Rancher Desktop 的 WSL 宿主网络上验收过。
- 危险工具默认要人批准。管理端可以加自动批准规则。「全部免审批」会跳过这些规则，网页里的提示注入就可能让 bot 在无人确认时安装 MCP 或改写自己的提示词。网页上写了这个风险。
- 控制面不能放进用户网桥。用户网桥的私网规则会把从网桥里主动连出来的流量一起丢掉，控制面因此连不上 machined。当前支持的部署是控制面使用 Docker daemon 的宿主网络，主动连接机器。

## 升级

新的 machined 只存在于新建的容器里。只构建镜像、不重建已有机器的容器，跑着的仍是旧进程。机器镜像的 digest 没变就不必重建用户机器。协议版本变化时要重建，见 [UPGRADING.md](UPGRADING.md)。下面是日常步骤，完整说明以那份文档为准。

1. 停掉控制面进程，更新代码后再执行上一节的镜像命令。标签保持不变，让 `docker buildx build --load` 替换本地这个标签。
2. 再启动控制面。数据库在 `VB_DATA_DIR`，升级不要删它。
3. 只对镜像变化的机器重建容器：管理端「机器」页的「重建」，或 `POST /api/admin/machines/<machineId>/rebuild`。这会删掉旧容器，并使用控制面当前的 `VB_MACHINE_IMAGE`（含发布镜像的缺省值），不再锁定机器记录中的旧标签。卷保留。有未完成任务时这个接口拒绝。重建后若机器停着，启动它以检查兼容性并清除之前的协议错误。
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

缺任何一项不会阻止控制面启动；第一次调服务接口才报错。viate 作为 IdP 时 `email_verified` 恒为 `false`，所以接 viate 时要把 `VB_OIDC_TRUST_EMAIL` 设为 `true`。打开后，任何能在 IdP 里拿到某个管理员邮箱的人都能成为管理员；只有 IdP 不开放自助注册、或账号由管理员创建时才应打开。对接其他 IdP 时要先确认这一点。

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

## 许可证

MIT，见 [LICENSE](LICENSE)。各包保持 private，不发布到 npm。漏洞报告见 [SECURITY.md](SECURITY.md)。

第三方依赖保留自己的许可证。构建后的网页提供 `/third-party.html`，以及 `/third-party/novnc/` 下完全对应所分发版本、未修改的 `@novnc/novnc` 源码和声明（MPL-2.0，版本见该目录的 `package.json`）。分发要求见 [Mozilla FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)。

### 机器镜像里的 GPL/LGPL 程序与源码

机器镜像包含独立许可的 Debian 程序，如 Git、Openbox、x11vnc，以及 glibc 等 LGPL 库。它们是镜像里的独立程序/库，没有链接进 machined；viate-bot 自身代码保持 MIT。原始许可证及版权声明保留在 `/usr/share/doc/<包名>/copyright`。Playwright Chromium 和其他第三方组件也保留自己的许可证。

每次构建机器镜像时，都会根据实际安装的 dpkg 元数据及 copyright 文件，自动生成 `/usr/share/doc/viate-bot/SOURCES.txt`。清单保守地包含所有提及 GPL/LGPL 的 Debian 包（含可选许可证及内嵌组件），列出二进制包名/版本、源码包名/版本、许可证引用，以及固定到该源码版本的 `snapshot.debian.org` 地址。源码版本与二进制重构建版本（`+bN`）分开记录；从 snapshot 页面可获取源码、Debian 补丁及构建规则。

每次 Release 附带 `machine-sources-linux-amd64.txt` 和 `machine-sources-linux-arm64.txt`，分别从对应架构的已发布镜像中提取。不启动容器也能读取本地镜像里的清单：

```sh
id=$(docker create ghcr.io/viateai/viate-bot-machine:v0.1.0)
docker cp "$id:/usr/share/doc/viate-bot/SOURCES.txt" ./machine-sources.txt
docker rm "$id"
```

本次发布提供固定版本的源码地址清单，不附源码归档，也不作书面源码提供承诺。第三方原有许可证继续适用；清单不会把这些代码改成 MIT。
