import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Provider from "oidc-provider";
import { startFakeMachine, startFakeModel } from "./fake-model.js";
import { pickPorts } from "./ports.js";
import { runSuite } from "./run.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface Account {
  sub: string;
  email: string;
  name: string;
}

const accounts: Record<string, Account> = {
  admin: { sub: "admin", email: "ada@example.com", name: "Ada" },
  user: { sub: "user", email: "bob@example.com", name: "Bob" },
};
let current = accounts.admin;

async function main(): Promise<void> {
  const ports = await pickPorts();
  const dataDir = mkdtempSync(join(tmpdir(), "vb-e2e-"));
  const children: ChildProcess[] = [];
  const idpOrigin = `http://127.0.0.1:${ports.idp}`;
  const webOrigin = `http://127.0.0.1:${ports.web}`;
  const provider = new Provider(idpOrigin, {
    clients: [{
      client_id: "bot",
      client_secret: "secret",
      redirect_uris: [`${webOrigin}/auth/callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    }],
    cookies: { keys: ["e2e-cookie-secret"] },
    claims: { openid: ["sub"], email: ["email", "email_verified"], profile: ["name"] },
    issueRefreshToken: async () => true,
    features: { devInteractions: { enabled: false } },
    interactions: { url: () => "/test/complete" },
    async findAccount(_ctx: unknown, id: string) {
      const account = Object.values(accounts).find((item) => item.sub === id);
      if (!account) return undefined;
      return {
        accountId: id,
        async claims() {
          return { sub: account.sub, email: account.email, email_verified: true, name: account.name };
        },
      };
    },
  });
  provider.use(async (ctx, next) => {
    if (ctx.path === "/test/use") {
      const nextAccount = accounts[ctx.query.sub ?? ""];
      if (!nextAccount) {
        ctx.body = { error: "未知身份" };
        return;
      }
      current = nextAccount;
      ctx.body = { ok: true };
      return;
    }
    if (ctx.path !== "/test/complete") {
      await next();
      return;
    }
    const details = await provider.interactionDetails(ctx.req, ctx.res);
    const grant = new provider.Grant({ accountId: current.sub, clientId: details.params.client_id ?? "bot" });
    grant.addOIDCScope(details.params.scope ?? "openid email profile");
    const grantId = await grant.save();
    await provider.interactionFinished(ctx.req, ctx.res, { login: { accountId: current.sub }, consent: { grantId } });
  });
  const idp = provider.listen(ports.idp, "127.0.0.1");
  if (!idp.listening) await once(idp, "listening");
  const model = await startFakeModel(ports.model);
  const machine = await startFakeMachine(ports.machine, "token-e2e");
  const control = spawn("pnpm", ["--filter", "@viate-bot/control", "exec", "tsx", "src/main.ts"], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      VB_DEV: "1",
      VB_INTEGRATION: "none",
      VB_MODEL_API: "openai-completions",
      VB_DATA_DIR: dataDir,
      VB_PUBLIC_URL: webOrigin,
      VB_CONTROL_PORT: String(ports.control),
      VB_OIDC_ISSUER: idpOrigin,
      VB_OIDC_CLIENT_ID: "bot",
      VB_OIDC_CLIENT_SECRET: "secret",
      VB_ALLOW_SIGNUP: "true",
      VB_OIDC_TRUST_EMAIL: "true",
      VB_ADMIN_EMAILS: "ada@example.com",
      VB_MODEL_BASE_URL: `http://127.0.0.1:${ports.model}/v1`,
      VB_MODEL_API_KEY: "test-key",
      VB_MODELS: "fake",
      VB_VISION_MODELS: "fake",
      VB_MODEL_RATE_USER: "1000",
      VB_MODEL_RATE_BOT: "1000",
      VB_MAX_TASK_STEPS: "32",
      VB_DEV_MACHINE: `127.0.0.1,${ports.machine},token-e2e`,
    },
    stdio: "inherit",
  });
  children.push(control);
  const web = spawn("pnpm", ["--filter", "@viate-bot/web", "exec", "vite", "--host", "127.0.0.1", "--port", String(ports.web), "--strictPort"], {
    cwd: root,
    detached: true,
    env: { ...process.env, VITE_CONTROL_ORIGIN: `http://127.0.0.1:${ports.control}` },
    stdio: "inherit",
  });
  children.push(web);
  try {
    await waitFor(`http://127.0.0.1:${ports.control}/health`, 30_000);
    await waitFor(`${webOrigin}/`, 30_000);
    process.env.VB_E2E_BASE_URL = webOrigin;
    process.env.VB_E2E_IDP_ORIGIN = idpOrigin;
    process.env.VB_E2E_LOGIN_MODULE = fileURLToPath(new URL("./login-local.ts", import.meta.url));
    process.env.VB_E2E_LOCAL = "1";
    process.env.VB_E2E_MODEL = "fake";
    process.env.VB_E2E_SHOTS = process.env.VB_E2E_SHOTS || "/tmp/vb-polish1-shots";
    if (!process.env.VB_E2E_BROWSER_CHANNEL && !process.env.VB_E2E_BROWSER_PATH) process.env.VB_E2E_BROWSER_CHANNEL = "chrome";
    await runSuite();
  } finally {
    for (const child of children) stopChild(child);
    await close(idp);
    await close(model);
    await close(machine);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "没有响应";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      last = String(response.status);
    } catch (error) {
      last = error instanceof Error ? error.message : "连接失败";
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`本地页面没有起来: ${last}`);
}

function stopChild(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
