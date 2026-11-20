# viate-bot

中文：[README.zh-CN.md](README.zh-CN.md)

Each user gets one container machine (browser, terminal, filesystem) and a control plane. People talk to their own bots in the web UI. A bot can run routines and use apps an administrator pushed (Skill, MCP, CLI). Users are isolated from each other. Bots that belong to the same user share that user's machine.

Requires Node.js 24 or newer and pnpm 12.16.1 (the `packageManager` field).

## Architecture

`apps/web` is the UI. `apps/control` handles login, bots, chat tasks, approvals, routines, and the admin UI. State is SQLite. Each user has one machine container. `machined` inside that image runs commands, reads and writes files, drives the browser, and loads pushed apps. The control plane connects out to machined. It does not join the user's bridge.

## Run the published images

After the first release, images are on GHCR. The published control image defaults its machine image to the machine image with the same tag. `VB_MACHINE_IMAGE` still overrides that.

```sh
docker pull ghcr.io/viateai/viate-bot-control:v0.1.0
docker pull ghcr.io/viateai/viate-bot-machine:v0.1.0
```

Run the control plane on the Linux host where the Docker daemon runs (for Rancher Desktop, that is its WSL distro). Check the socket GID there. Do not reuse the GID of a Mac or Windows proxy socket.

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

`/data` holds SQLite and the encryption key. Pass login and model settings as environment variables. Do not bake them into the image. `--network host` is required so the control plane can open connections to machined. Putting the control plane on the user bridge does not work: the firewall drops new connections that originate on that bridge, including the control plane. See [firewall boundaries](deploy/rancher-desktop/README.md#实际策略与边界). On the host network, ports listen on the host. Put a reverse proxy and a host firewall in front of them.

Access to the Docker socket is root on that daemon. Do not `chmod 666` the socket or open unauthenticated Docker TCP. A bind-mounted `/data` must be writable by UID 1000.

Register `{VB_PUBLIC_URL}/auth/callback` at your IdP. Replace `admin@example.com` with your verified IdP email and `your-model-id` with a model served by your gateway. Sign in as that admin, then provision users in the admin UI. Install and verify the Rancher Desktop firewall before creating any user machine; a Docker bridge alone does not provide the documented egress isolation.

## Development

The control plane does not read a `.env` file. Export variables into the process, then start. From the repository root:

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

PowerShell has no equivalent of the sourced file. On Windows, set each variable in the process, or use WSL.

| Command | What it does |
| --- | --- |
| `pnpm install --frozen-lockfile` | Install from the lockfile |
| `pnpm dev` | Run every package `dev` script that exists: control, machined, web |
| `pnpm --filter @viate-bot/control dev` | Control plane only (`tsx src/main.ts`) |
| `pnpm --filter @viate-bot/machined dev` | Local machined |
| `pnpm --filter @viate-bot/web dev` | Vite on port 4420. Proxies `/api`, `/auth`, and `/ws` to `VITE_CONTROL_ORIGIN` (default `http://127.0.0.1:4418`) |
| `pnpm typecheck` | Build protocol, then typecheck packages that have the script |
| `pnpm test` | Package tests |
| `pnpm build` | Build protocol, then every other package that has `build` |
| `pnpm --filter @viate-bot/web build` | Web build in `apps/web/dist`. The control plane serves that directory when it is present |
| `pnpm --filter @viate-bot/control machine <create\|start\|stop\|rebuild\|delete\|inspect> <userId>` | Dev machine command. Requires `VB_DEV=1` |
| `pnpm --filter @viate-bot/machined image [tag] [platform]` | Build machined and `docker buildx build --load`. Default tag `viate-bot/machine:dev` |
| `pnpm --filter @viate-bot/control exec tsx scripts/load-control.ts` | Control-plane load test. Binds `127.0.0.1` on 4418, 4421, and 4422. Not part of the test suite |

When the browser uses Vite on 4420, `VB_PUBLIC_URL` must be the origin the browser opens, and `VB_CONTROL_PORT` must be the port in `VITE_CONTROL_ORIGIN`. Example: control `4418`, public URL `http://127.0.0.1:4420`, `VITE_CONTROL_ORIGIN=http://127.0.0.1:4418`. When the control plane serves the built web app itself, the public URL and the control port are the same origin.

The control build copies JavaScript from `src`, including `apps/link-mcp.mjs`, into `dist`. Before deploy, run `pnpm --filter @viate-bot/control build && pnpm --filter @viate-bot/control check:dist`. That loads the compiled install module and the server import graph without `src`. Run the same check again after `deploy --prod` so development dependencies cannot hide a missing runtime package. A deploy still needs `apps/control/drizzle`, the workspace dependencies, and the built web app.

The control image is built from the repository root. The Node 24 base image is pinned by digest, pnpm matches the root `packageManager`, and the lockfile is frozen. Manifests are copied before the source, so source edits do not reinstall dependencies. The image contains the web build, migrations, compiled output, and production dependencies. It does not contain workspace source, tests, or env files. The process user is `node`.

The control plane connects only to `/var/run/docker.sock`. It does not read `DOCKER_HOST`. Mount the real daemon socket, and give the non-root user in the container access to that socket's group. See the GHCR example above.

Building the image compiles `better-sqlite3` and lets `esbuild` download its platform binary. Both are allowed in `pnpm-workspace.yaml`. Other dependency install scripts do not run.

Task budget, usage, and length-continuation counts are stored while waiting for the user. Resuming the same task after a restart does not grant a new budget. When the budget is spent, that turn's tools do not run, and the task fails with the reason. A model response without a normal finish marker, or a task that hits the step or duration limit, is not reported as a normal `stop`. An automatic shell rule matches only literal tokens that can be parsed statically. Expansion, an environment override, or a non-default working directory goes to a person. `fs_write` does not follow symlinks in the path. After a bot disables an app, new tasks do not load that app's MCP tools.

## Configuration

Read from the process environment only. Defaults are the values in `apps/control/src/config.ts` when a variable is unset or empty. `.env.example` sets `VB_DATA_DIR` to `./data`. The code default is `/data`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VB_PUBLIC_URL` | `http://127.0.0.1:3000` | Origin the browser uses. OIDC redirect and WebSocket Origin checks use it |
| `VB_OIDC_ISSUER` | empty | OIDC issuer. Login needs all three OIDC variables |
| `VB_OIDC_CLIENT_ID` | empty | OIDC client id |
| `VB_OIDC_CLIENT_SECRET` | empty | OIDC client secret |
| `VB_ALLOW_SIGNUP` | `false` | `true` lets an unknown identity create a user with no bot. It does not provision a bot |
| `VB_OIDC_TRUST_EMAIL` | `false` | **Global email-trust switch, not only the first admin login.** Off: only `email_verified=true` can match an admin by email, bind the single unbound user, or pass the first admin login. On: those three paths trust an unverified email from the IdP (`false` or missing), but the email claim must be non-empty. Anyone who can obtain an admin email at the IdP becomes an admin. Anyone who can obtain a pre-provisioned email can bind that still-unbound user and reach their bots, machine, and data, even when signup is closed and the email is not an admin. Already-bound users still match only `(provider, sub)`, not email. Turn this on only when the IdP has no open signup, or accounts are created by an admin and untrusted users cannot change the email. Confirm that before using another IdP. viate always reports `email_verified=false`, so viate needs this on |
| `VB_MODEL_BASE_URL` | empty | Model gateway. Required when calling a model |
| `VB_MODEL_API_KEY` | empty | Shared key. Required in shared-key mode |
| `VB_MODELS` | empty | Comma-separated model allowlist. Empty means no extra restriction |
| `VB_MODEL_API` | `openai-completions` | `openai-completions` or `openai-responses` |
| `VB_MODEL_MAX_TOKENS` | `4096` | Per-call generation cap, positive integer |
| `VB_MODEL_CONTEXT_TOKENS` | `256000` | Context window, positive integer. An admin can override per model. Applies to tasks that start afterwards |
| `VB_SUMMARY_MAX_TOKENS` | `2000` | Context-summary output cap, positive integer |
| `VB_TASK_TOKEN_BUDGET` | `2000000` | Per-task token budget. `0` means unlimited. Admins can change the global value and override it per user. Counts input and output, not cache reads or writes |
| `VB_MODEL_RATE_USER` | `120` | Per-user model requests per minute. Non-negative integer. `0` means unlimited. An admin override applies on the next call. Over the limit, the task waits. It does not fail |
| `VB_MODEL_RATE_BOT` | `60` | Per-bot model requests per minute. Counted only when both the user window and the bot window have room |
| `VB_MAX_TASK_STEPS` | `200` | Per-task step cap. Non-negative integer. `0` means unlimited. Admins can change the global value and override it per user. Changes apply to running tasks immediately |
| `VB_MAX_TASK_DURATION_SEC` | `3600` | Per-task active run time cap in seconds. Non-negative integer. `0` means unlimited. Waiting for approval, takeover, user input, or rate limits does not count. Used time is stored and keeps counting after a restart; downtime does not count. Admins can change the global value and override it per user. Each model request still has its own 120 s network timeout |
| `VB_DEFAULT_MAX_BOTS` | `5` | Bot cap written into a quota when an admin provisions a user. Existing quota rows are not rewritten |
| `VB_DEFAULT_MAX_CONCURRENT_TASKS` | `2` | Per-user concurrent task cap written at provision time |
| `VB_DEFAULT_MAX_ROUTINES` | `10` | Routine cap written at provision time. A user whose quota is already 0 is not rewritten |
| `VB_INTEGRATION` | `none` | `none` or `viate` |
| `VB_VIATE_URL` | empty | Read only when `VB_INTEGRATION=viate`. All three service variables are required on the first service call |
| `VB_VIATE_CLIENT_ID` | empty | viate service client id |
| `VB_VIATE_CLIENT_SECRET` | empty | viate service client secret |
| `VB_ADMIN_EMAILS` | empty | Comma-separated. A trusted email match makes the user an admin after login |
| `VB_DATA_DIR` | `/data` | SQLite, key, and app archives. The database file is `$VB_DATA_DIR/viate-bot.sqlite` |
| `VB_UPLOAD_STORAGE` | `local` | `local` or `s3`. Chat attachments stay on the control plane either way. Downloads are still proxied; there are no presigned URLs |
| `VB_S3_BUCKET` | empty | Required when storage is `s3` |
| `VB_S3_REGION` | empty | Required when storage is `s3` |
| `VB_S3_ENDPOINT` | empty | Optional S3-compatible endpoint, such as `https://s3.example` |
| `VB_S3_FORCE_PATH_STYLE` | off | Only `1` turns on path-style addressing |
| `VB_S3_PREFIX` | empty | Optional key prefix. `team` stores objects at `team/uploads/<userId>/<uploadId>`. The original filename is not part of the key |
| `VB_S3_ACCESS_KEY_ID` | empty | Optional. Set it together with `VB_S3_SECRET_ACCESS_KEY`, or leave both empty to use the SDK default credential chain. Setting only one refuses to start |
| `VB_S3_SECRET_ACCESS_KEY` | empty | Optional secret for the access key. It is not written to logs or error responses |
| `VB_UPLOAD_STORAGE_ACCEPT_SWITCH` | off | Only `1` allows a change of `VB_UPLOAD_STORAGE` after attachments already exist. Existing objects are not migrated or deleted. Chat can no longer preview, download, or send them. Copies already on a bot machine stay there |
| `VB_MACHINE_IMAGE` | `viate-bot/machine:dev` | Image tag for a new machine. If unset, `VB_MACHINE_IMAGE_DEFAULT` is used, then this default. Published images set `VB_MACHINE_IMAGE_DEFAULT` to `ghcr.io/viateai/viate-bot-machine:vX.Y.Z` for the same release. Leave that variable unset when running from source |
| `VB_IDLE_STOP_MINUTES` | `120` | Minutes before an idle machine stops. Non-negative integer. `0` stops as soon as the idle conditions hold |
| `VB_MAX_RUNNING_TASKS` | `20` | Global cap on tasks in the running state. Non-negative integer. `0` starts no new task |
| `VB_METRICS_TOKEN` | empty | Bearer token for `GET /metrics`. Empty rejects every scrape |
| `VB_VISION_MODELS` | empty | Comma-separated. Only these models get the `browser_screenshot` tool |
| `VB_SECRET_WAIT_MS` | `1800000` | How long `request_secret` waits for the user, in milliseconds. The task fails after that. Positive integer |
| `VB_CONTROL_PORT` | `3000` | Control-plane listen port. Non-negative integer |
| `VB_DEV` | off | Only `1` enables `/dev/*` and the `machine` command |

`VB_RATE_MBIT`, `VB_HASHLIMIT`, `VB_HASHLIMIT_BURST`, and `VB_CONNLIMIT` belong to the firewall script in WSL, not to the control plane. See `deploy/rancher-desktop/README.md`.

Changing `VB_UPLOAD_STORAGE` does not copy attachments. The first start on `local` records that backend, and uploads that already exist stay readable. Starting on `s3` when uploads already exist and no backend has been recorded is a switch from local: the process refuses to start until `VB_UPLOAD_STORAGE_ACCEPT_SWITCH=1`. A later change with an empty `uploads` table is recorded immediately. If uploads exist, a backend change also refuses to start until that variable is `1`. After an accepted switch, only attachments stored on the new backend can be previewed, downloaded, or sent. Cleanup does not remove the previous backend's files. Changing the bucket, endpoint, or prefix while `VB_UPLOAD_STORAGE` stays the same is a known limitation: startup does not ask for confirmation, and existing attachments are not marked unavailable (HTTP 410).

## Windows + Rancher Desktop

The target is Rancher Desktop on Windows (WSL2, Alpine, amd64, dockerd/moby, Kubernetes off). The control plane runs in the WSL host network namespace and connects to machined. Putting the control plane on the user bridge does not make that connection work.

Install and check the firewall using `deploy/rancher-desktop/README.md` and the scripts next to it before running user machines.

Build the machine image on the deploy host (Docker on that Windows setup is amd64):

```sh
pnpm install --frozen-lockfile
pnpm --filter @viate-bot/protocol build
pnpm --filter @viate-bot/browser build
pnpm --filter @viate-bot/machined image viate-bot/machine:dev linux/amd64
```

The tag must match `VB_MACHINE_IMAGE`. Then start the control plane. An admin signs in and provisions users. Provisioning creates the container from the image tag configured at that moment.

## Security model

- Mounting `docker.sock` is root on that Docker daemon. The control plane uses it to create user machines. Do not make the socket mode `0666`, and do not expose Docker over unauthenticated TCP.
- `VB_OIDC_TRUST_EMAIL` is global. It is not limited to the first admin login. When it is on, an unverified email from the IdP is trusted: anyone who can obtain an admin email can become an admin, and anyone who can obtain a pre-provisioned email that is not bound yet can bind that user and use their bots and machine. Users that are already bound still match only `(provider, sub)`. Turn it on only when the IdP does not allow open signup, or an admin creates the accounts and untrusted users cannot change the email. viate always sends `email_verified=false`, so a viate IdP needs the switch on.
- Each user gets their own Docker network. The machine container drops all capabilities and adds back only what it needs to drop privileges, sets `no-new-privileges`, and does not mount host directories. Isolation between machines also depends on the firewall in `deploy/rancher-desktop`: new connections to private-network destinations are dropped, new connections per source and TCP concurrency are limited, and bandwidth is shaped. Those rules are checked on the Rancher Desktop WSL host network.
- Dangerous tools wait for a person by default. Admins can add automatic approval rules. **Skip all approvals** (「全部免审批」) bypasses the approval gate, including those rules. Prompt injection in a web page can then make the bot install an MCP server or rewrite its own prompt with nobody confirming. The settings page says so.
- The control plane is not supported on the user bridge. Private-network rules drop new connections that come from that bridge, so the control plane cannot reach machined. The supported placement is the Docker daemon's host network, with the control plane connecting out to the machine.

## Upgrading

A new machined exists only in containers created after the image is built. Building an image without rebuilding an existing machine leaves the old process running. If the machine image digest did not change, do not rebuild user machines. A protocol change does require a rebuild. See [UPGRADING.md](UPGRADING.md). The steps below are the usual path. That file is the full procedure.

1. Stop the control plane, update the code, and run the image command from the previous section. Keep the tag so `docker buildx build --load` replaces it locally.
2. Start the control plane. The database stays in `VB_DATA_DIR`. Do not delete it during an upgrade.
3. Rebuild only machines whose image changed: **重建** on the admin Machines page, or `POST /api/admin/machines/<machineId>/rebuild`. That deletes the old container and uses the control plane's current `VB_MACHINE_IMAGE` (including its published default), not the old machine's stored tag. The volume is kept. The call is rejected while a task is unfinished. Start a stopped rebuilt machine to check compatibility and clear any previous protocol error.
4. With `VB_DEV=1`, the command is `pnpm --filter @viate-bot/control machine rebuild <userId>`.
5. When the firewall scripts change, install and check them again from `deploy/rancher-desktop/README.md`. Do not only replace the files.

## viate

Set `VB_INTEGRATION=viate`. Login still uses the OIDC variables below. The issuer is viate's OIDC issuer. Service calls (user status, model key, usage) also need:

```sh
VB_INTEGRATION=viate
VB_VIATE_URL=https://viate.example
VB_VIATE_CLIENT_ID=
VB_VIATE_CLIENT_SECRET=
```

Missing values do not stop the process from starting. The first service call fails. viate always reports `email_verified=false`, so set `VB_OIDC_TRUST_EMAIL=true`. While that is on, anyone who can obtain an admin email at the IdP can become an admin. Use it only when the IdP has no open signup or an admin creates the accounts. Confirm that for any other IdP too.

## Any OIDC provider

`VB_INTEGRATION=none`. Login needs:

```sh
VB_PUBLIC_URL=https://bot.example
VB_OIDC_ISSUER=https://idp.example/realms/bot
VB_OIDC_CLIENT_ID=
VB_OIDC_CLIENT_SECRET=
VB_OIDC_TRUST_EMAIL=false
VB_ALLOW_SIGNUP=false
VB_ADMIN_EMAILS=admin@example.com
```

The provider must offer the `openid` scope, `id_token`, JWKS, and `/.well-known/openid-configuration`. The redirect URL is `{VB_PUBLIC_URL}/auth/callback`. If the `id_token` lacks email, name, or `email_verified`, the control plane fills them from userinfo with the access token. Admins come only from trusted emails in `VB_ADMIN_EMAILS`.

## End-to-end tests

The browser suite in `apps/e2e` is not part of `pnpm test` (the scripts are `e2e` and `e2e:local`). `pnpm test` only runs the unit test for host-resolution arguments. The browser suite uses Chrome or Edge already installed on the machine (`channel`, or `VB_E2E_BROWSER_PATH`). It does not download Playwright's own browser.

Local smoke (fake model, fake machine, built-in OIDC, no Docker):

```sh
pnpm --filter @viate-bot/e2e e2e:local
```

Default ports are 4418 and 4420–4423. If they are taken, use 4430–4434. Screenshots default to `/tmp/vb-polish1-shots`, or `VB_E2E_SHOTS`.

Against a deployed environment, point the suite at a login module and the control plane:

```sh
VB_E2E_BASE_URL=https://bot.example \
VB_E2E_LOGIN_MODULE=./login.js \
VB_E2E_ALLOW_ACCOUNT_MUTATION=1 \
VB_E2E_MODEL=deepseek-flash \
VB_E2E_AVATAR_PATH=/home/bot/e2e-avatar.png \
VB_E2E_BROWSER_CHANNEL=chrome \
pnpm --filter @viate-bot/e2e e2e
```

The login module exports `login({ browser, baseURL, role })` and returns an in-memory Playwright `storageState`. Do not write a login-state file. The local implementation is `apps/e2e/src/login-local.ts`. `VB_E2E_LOGIN_MODULE` is an absolute path, or a path relative to the directory you started the command from. Screenshots do not include the login form.

A viate OIDC deployment (viate at `https://viate.example.com`, login page `/portal/oauth-login`) uses the viate login module, `apps/e2e/src/login-viate.ts`. Email and password come from the environment only:

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

Local smoke uses `fake`. A real deployment defaults to `deepseek-flash`. `VB_E2E_MODEL` selects another allowlisted model. A real deployment must use a dedicated ordinary test account that is already provisioned (the machine already exists) and must set `VB_E2E_ALLOW_ACCOUNT_MUTATION=1`. The avatar case needs a PNG already on that machine, named by `VB_E2E_AVATAR_PATH`. The suite deletes only bots, rules, and routines it created, and uninstalls the one install it created under the test name. Temporary quota and process-detail switches are restored in `finally`. The model-settings test uses its own random model name and does not change the model in use. Audit rows and soft-delete history stay. A Windows or real-model check is a separate run. A local fake-model result does not replace it.

If a local proxy answers DNS with an address the suite cannot use, either pass `VB_E2E_HOST_RESOLVER_RULES` through to Chromium's `--host-resolver-rules`, or pass curl-style `VB_E2E_RESOLVE=host:port:address` (comma-separated). The suite turns that into `MAP host ip`. The port only lines up with curl. The address given to Chromium must be IPv4. With that rule, API calls are `fetch` inside the page, because Playwright's own HTTP client ignores it. `VB_E2E_BROWSER_PATH` disables `channel`.

A Windows host on Node 22 without pnpm can run `apps/e2e/docker-run.sh`. That script uses `mcr.microsoft.com/playwright:v1.49.1-noble`, installs Node 24, and runs the deployed check. The image includes the Chromium build that matches `playwright-core` 1.49.

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

`127.0.0.1` inside that container is not the Windows host. `host.docker.internal` is not passed through `docker run --add-host` as that hostname (Docker rejects it). The script writes `--add-host <domain>:host-gateway`, resolves it to IPv4 inside the container, and gives that address to Chromium. Other addresses must already be IPv4. Screenshots go to `VB_E2E_STORAGE_DIR` (a temp directory by default). The login session stays in memory and is not written there. `VB_E2E_IMAGE` changes the image. Node defaults to `24.22.3` (`VB_E2E_NODE_VERSION`).

`VB_E2E_IGNORE_HTTPS_ERRORS=1` makes the login context and both browser contexts ignore HTTPS errors. Unset, certificates are checked. `VB_E2E_PACE_MS` is the pause between messages in real mode, default 15000, `0` disables it. `VB_E2E_LOCAL=1` does not wait. `docker-run.sh` forwards both.

On Windows Git Bash, use the same variables as the container example and the deployment's own hostnames. Git Bash rewrites paths that start with `/` into Windows paths. If `cygpath` exists, the script converts the repo and screenshot directories before mounting them and sets `MSYS_NO_PATHCONV=1` so `/work` inside the container is left alone. macOS and Linux have no `cygpath` and do not rewrite mounts.

## License

MIT. See [LICENSE](LICENSE). Packages stay private and are not published to npm. Vulnerability reports: [SECURITY.md](SECURITY.md).

Third-party dependencies retain their own licenses. The built web app serves `/third-party.html` and the exact, unmodified `@novnc/novnc` source and notices under `/third-party/novnc/` (MPL-2.0; version in `package.json`). See [Mozilla's distribution FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

### Machine-image GPL/LGPL programs and sources

The machine image includes independently licensed Debian programs such as Git, Openbox and x11vnc, and LGPL libraries such as glibc. They are separate programs/libraries in the image, not linked into machined; viate-bot's own code remains MIT. Their original licenses and copyright notices remain in `/usr/share/doc/<package>/copyright`. Playwright Chromium and other third-party components retain their own licenses too.

Every machine image generates `/usr/share/doc/viate-bot/SOURCES.txt` from its installed dpkg metadata and copyright files during the build. It conservatively lists every Debian package with a GPL/LGPL reference (including alternative licenses and embedded components): binary package/version, source package/version, license references and a `snapshot.debian.org` URL pinned to that exact source version. Source versions are distinct from binary rebuild versions (`+bN`). Download the source files, Debian patches and build rules from those snapshot pages.

Each Release attaches `machine-sources-linux-amd64.txt` and `machine-sources-linux-arm64.txt`, extracted from the corresponding published images. To inspect a local image without starting it:

```sh
id=$(docker create ghcr.io/viateai/viate-bot-machine:v0.1.0)
docker cp "$id:/usr/share/doc/viate-bot/SOURCES.txt" ./machine-sources.txt
docker rm "$id"
```

This release distributes a version-pinned source-location inventory, not source archives or a written source offer. Upstream third-party licenses continue to apply; this inventory does not relicense their code under MIT.
