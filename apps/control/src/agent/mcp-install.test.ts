import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapMcpUrl } from "../apps/archive.js";
import { publishValidatedPackage, resolveMcpLaunch, recordResolvedVersion } from "../apps/catalog.js";
import { buildRegistryPackage } from "../apps/package-command.js";
import { describeInstall, installMcpBlock, installMcpTool, scrubInstallPlaintext } from "./app-tools.js";
import { buildApp, chatService, type ControlContext } from "../app.js";
import { createBot } from "../bot-service.js";
import { loadConfig, type ControlConfig } from "../config.js";
import { SESSION_COOKIE } from "../cookies.js";
import { loadOrCreateKey } from "../crypto.js";
import { chatRepository } from "../db/chat.js";
import { openDatabase } from "../db/index.js";
import { machineRepository } from "../db/machines.js";
import { ensureDevUser } from "../db/users.js";
import { createRuntime } from "../compose.js";
import { createSession } from "../session.js";
import { userScope } from "../scope.js";

const SENTINEL = "vb-mcpinst-plaintext-9f3a7c";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("bot installs an MCP in the same task", () => {
  it("cancels an in-flight install and does not schedule a reconciliation retry", async () => {
    const received = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const port = await listen((request, response) => {
      if (!request.url?.startsWith("/apps/install?")) {
        json(response, 404, { error: "no" });
        return;
      }
      response.on("close", disconnected.resolve);
      received.resolve();
    });
    const started = await start(port, () => namedToolSse("install_mcp", JSON.stringify({ remote: { name: "cancel-running", url: "https://example.com/mcp" }, reason: "cancel test" })));
    const bot = await createBot(depsOf(started), userScope("user-a"), { name: "Ada", model: "gpt-test" });
    const sent = await started.service.send({ userId: "user-a", botId: bot.id, text: "install", mode: "queue" });
    await waitFor(() => Boolean(started.ctx.db.$client.prepare("select id from approvals where task_id=? and state='pending'").get(sent.taskId)));
    const approval = started.ctx.db.$client.prepare("select id from approvals where task_id=?").get(sent.taskId) as { id: string };
    started.service.approvalGate.decide("user-a", approval.id, "allow");
    await received.promise;
    expect(started.service.stop(userScope("user-a"), sent.taskId)).toBe(true);
    await started.service.idle();
    await disconnected.promise;
    expect(chatRepository(started.ctx.db).findTask(userScope("user-a"), sent.taskId)?.state).toBe("cancelled");
    expect(started.ctx.db.$client.prepare("select state, desired from app_installs").get()).toEqual({ state: "failed", desired: "absent" });
  });

  it("requires a separate approval for a newly loaded MCP tool", async () => {
    const machine = await fakeMachine();
    const started = await start(machine.port, (body) => {
      const count = toolResults(body);
      if (count === 0) return namedToolSse("install_mcp", JSON.stringify({ remote: { name: "fresh", url: "https://example.com/mcp" }, reason: "tools" }));
      if (count === 1) return namedToolSse("echo_installed", JSON.stringify({ text: "must-not-run" }));
      return textSse("done");
    });
    const bot = await createBot(depsOf(started), userScope("user-a"), { name: "Ada", model: "gpt-test" });
    const sent = await started.service.send({ userId: "user-a", botId: bot.id, text: "install", mode: "queue" });
    await waitFor(() => Boolean(started.ctx.db.$client.prepare("select id from approvals where task_id=? and state='pending'").get(sent.taskId)));
    const first = started.ctx.db.$client.prepare("select id from approvals where task_id=? and state='pending'").get(sent.taskId) as { id: string };
    started.service.approvalGate.decide("user-a", first.id, "allow");
    await waitFor(() => Boolean(started.ctx.db.$client.prepare("select id from approvals where task_id=? and state='pending' and tool='echo_installed'").get(sent.taskId)));
    const next = started.ctx.db.$client.prepare("select id from approvals where task_id=? and state='pending'").get(sent.taskId) as { id: string };
    started.service.approvalGate.decide("user-a", next.id, "deny");
    await started.service.idle();
    expect(storedText(started.ctx)).not.toContain("echo:must-not-run");
    expect(chatRepository(started.ctx.db).findTask(userScope("user-a"), sent.taskId)?.state).toBe("succeeded");
  });

  it("cannot replace another user's private app by publishing the same name", async () => {
    const machine = await fakeMachine();
    const started = await start(machine.port, () => textSse("done"));
    const saved = await publishValidatedPackage(catalogOf(started), "user-b", wrapMcpUrl("other-private", "https://private.example/mcp"), { version: "1.0.0", privateUserId: "user-b" });
    const result = await directInstaller(started).execute("conflict", { remote: { name: "other-private", url: "https://replacement.example/mcp" }, reason: "conflict" });
    expect(result.isError).toBe(true);
    expect(started.ctx.db.$client.prepare("select owner_user_id from apps where id=?").get(saved.appId)).toEqual({ owner_user_id: "user-b" });
    expect(started.ctx.db.$client.prepare("select count(*) as n from app_versions where app_id=?").get(saved.appId)).toEqual({ n: 1 });
    expect(machine.installs).toEqual([]);
  });

  it("does not publish or install when the tool signal is already aborted", async () => {
    const machine = await fakeMachine();
    const started = await start(machine.port, () => textSse("done"));
    const controller = new AbortController();
    controller.abort();
    const result = await directInstaller(started).execute("cancel", { remote: { name: "cancelled", url: "https://example.com/mcp" }, reason: "cancelled" }, controller.signal);
    expect(result.isError).toBe(true);
    expect(started.ctx.db.$client.prepare("select count(*) as n from apps").get()).toEqual({ n: 0 });
  });

  it("records the resolved version without changing the approved archive identity", async () => {
    const machine = await fakeMachine();
    const started = await start(machine.port, () => textSse("done"));
    const saved = await publishValidatedPackage(catalogOf(started), "user-a", buildRegistryPackage({ appName: "latest-pkg", ecosystem: "npm", packageName: "left-pad", version: "latest" }), { privateUserId: "user-a" });
    await directInstaller(started).execute("latest", { catalog: { name: "latest-pkg", version: "latest" }, reason: "install" });
    expect(recordResolvedVersion(catalogOf(started), saved.versionId, "1.2.3")).toBe("1.2.3");
    expect(started.ctx.db.$client.prepare("select version from app_versions where id=?").get(saved.versionId)).toEqual({ version: "latest" });
  });

  it("cannot change an installed app through install_mcp", async () => {
    const machine = await fakeMachine();
    const started = await start(machine.port, () => textSse("done"));
    await publishValidatedPackage(catalogOf(started), "user-a", wrapMcpUrl("existing", "https://example.com/mcp"), { version: "1.0.0", privateUserId: "user-a" });
    const tool = directInstaller(started);
    const args = { catalog: { name: "existing", version: "1.0.0" }, reason: "install" };
    expect((await tool.execute("first", args)).isError).not.toBe(true);
    expect((await tool.execute("second", { ...args, config: { TOKEN: "replacement" } })).isError).toBe(true);
    expect(resolveMcpLaunch(catalogOf(started), "user-a", "existing").env).toEqual({});
  });

  it("does not reuse a different archive with the approved name and version", async () => {
    const machine = await fakeMachine();
    const started = await start(machine.port, () => textSse("done"));
    await publishValidatedPackage(catalogOf(started), "user-a", wrapMcpUrl("occupied", "https://old.example/mcp"), { version: "1.0.0", privateUserId: "user-a" });
    const tool = directInstaller(started);
    const result = await tool.execute("conflict", { remote: { name: "occupied", url: "https://approved.example/mcp" }, reason: "approved source" });
    expect(result.isError).toBe(true);
    expect(machine.installs).toEqual([]);
    expect(started.ctx.db.$client.prepare("select count(*) as n from app_installs").get()).toEqual({ n: 0 });
  });

  it("encrypts a placeholder even without secretKeys", async () => {
    const machine = await fakeMachine();
    const started = await start(machine.port, () => textSse("done"));
    const result = await directInstaller(started).execute("secret", {
      package: { name: "secret-pkg", ecosystem: "npm", package: "left-pad", version: "1.2.3" },
      config: { API_TOKEN: "{{secret:token}}" }, reason: "secret",
    });
    expect(result.isError).not.toBe(true);
    expect(storedText(started.ctx)).not.toContain(SENTINEL);
    expect(resolveMcpLaunch(catalogOf(started), "user-a", "secret-pkg").env.API_TOKEN).toBe(SENTINEL);
  });

  it("rejects and redacts catalog-declared secret plaintext without trusting secretKeys", async () => {
    const machine = await fakeMachine();
    const started = await start(machine.port, () => textSse("done"));
    await publishValidatedPackage(catalogOf(started), "user-a", buildRegistryPackage({ appName: "secret-cat", ecosystem: "npm", packageName: "left-pad", version: "1.0.0", config: [{ key: "TOKEN", secret: true }] }), { privateUserId: "user-a" });
    const args = { catalog: { name: "secret-cat", version: "1.0.0" }, config: { TOKEN: SENTINEL }, reason: "secret" };
    expect(installMcpBlock(catalogOf(started), "user-a", args)).toContain("request_secret");
    // Same redaction path used before persisting assistant tool calls.
    scrubInstallPlaintext(args, catalogOf(started), "user-a");
    expect(JSON.stringify(args)).not.toContain(SENTINEL);
  });

  it("describes the selected catalog version and full launch arguments", async () => {
    const machine = await fakeMachine();
    const started = await start(machine.port, () => textSse("done"));
    for (const version of ["1.0.0", "2.0.0"]) {
      await publishValidatedPackage(catalogOf(started), "user-a", buildRegistryPackage({ appName: "versions", ecosystem: "npm", packageName: "left-pad", version, args: [`--version=${version}`] }), { privateUserId: "user-a" });
    }
    const card = describeInstall(catalogOf(started), "user-a", { catalog: { name: "versions", version: "1.0.0" }, reason: "old version" });
    expect(card?.command).toContain("--version=1.0.0");
    expect(card?.command).not.toContain("--version=2.0.0");
    expect(describeInstall(catalogOf(started), "user-a", { package: { name: "args", ecosystem: "npm", package: "left-pad", version: "1.2.3", args: ["--delete", "two words"] }, reason: "args" })?.command).toContain('"two words"');
  });

  it.each([
    ["catalog", { catalog: { name: "demo-cat", version: "1.0.0" }, reason: "需要目录里的工具" }],
    ["remote", { remote: { name: "demo-remote", url: "https://example.com/mcp" }, reason: "需要远程工具" }],
    ["package", { package: { name: "demo-pkg", ecosystem: "npm", package: "left-pad", version: "1.2.3" }, reason: "需要包里的工具" }],
  ] as const)("approves a %s install and calls the new tool", async (source, args) => {
    const machine = await fakeMachine();
    const calls: string[] = [];
    const started = await start(machine.port, (body) => {
      calls.push(body);
      const count = toolResults(body);
      if (count === 0) return namedToolSse("install_mcp", JSON.stringify(args));
      if (count === 1) return namedToolSse("echo_installed", JSON.stringify({ text: source }));
      return textSse("完成");
    });
    if (source === "catalog") {
      await publishValidatedPackage(catalogOf(started), "user-a", wrapMcpUrl("demo-cat", "https://example.com/catalog"), {
        version: "1.0.0",
        privateUserId: "user-a",
      });
    }
    const bot = await createBot(depsOf(started), userScope("user-a"), { name: "Ada", model: "gpt-test" });
    started.ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["mcp"] }), bot.id);
    const sent = await started.service.send({ userId: "user-a", botId: bot.id, text: `安装 ${source}`, mode: "queue" });
    await waitFor(() => Boolean(started.ctx.db.$client.prepare("select id from approvals where task_id=? and state='pending'").get(sent.taskId)));
    const approval = started.ctx.db.$client.prepare("select id, summary, args_json from approvals where task_id=?").get(sent.taskId) as { id: string; summary: string; args_json: string };
    const card = JSON.parse(approval.summary) as { source?: string; runsInstallScript?: boolean };
    expect(card.source).toBe(source);
    if (source === "package") expect(card.runsInstallScript).toBe(true);
    expect(approval.args_json).toContain(source === "catalog" ? "demo-cat" : source === "remote" ? "https://example.com/mcp" : "left-pad");
    expect(started.service.approvalGate.decide("user-a", approval.id, "allow")).toBe("ok");
    await started.service.idle();
    expect(machine.installs.some((url) => url.includes(source === "catalog" ? "demo-cat" : source === "remote" ? "demo-remote" : "demo-pkg"))).toBe(true);
    const messages = chatRepository(started.ctx.db).listMessages(userScope("user-a"), sent.conversationId) ?? [];
    expect(messages.some((message) => message.contentJson.includes(`echo:${source}`))).toBe(true);
    expect(calls.some((body) => body.includes("echo_installed"))).toBe(true);
    const marked = started.ctx.db.$client.prepare("select installed_by_bot_name as name from app_installs").all() as Array<{ name: string | null }>;
    expect(marked.some((row) => row.name === "Ada")).toBe(true);
  }, 15000);

  it("does not install after a denial, and app_install in alwaysAllow still prompts", async () => {
    const machine = await fakeMachine();
    const started = await start(machine.port, () => namedToolSse("install_mcp", JSON.stringify({
      remote: { name: "demo-remote", url: "https://example.com/mcp" },
      reason: "需要远程工具",
    })));
    const bot = await createBot(depsOf(started), userScope("user-a"), { name: "Ada", model: "gpt-test" });
    started.ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["app_install", "mcp"] }), bot.id);
    const sent = await started.service.send({ userId: "user-a", botId: bot.id, text: "安装", mode: "queue" });
    await waitFor(() => Boolean(started.ctx.db.$client.prepare("select id from approvals where task_id=? and state='pending'").get(sent.taskId)));
    const approval = started.ctx.db.$client.prepare("select id from approvals where task_id=?").get(sent.taskId) as { id: string };
    expect(started.service.approvalGate.decide("user-a", approval.id, "deny")).toBe("ok");
    await started.service.idle();
    expect(machine.installs).toEqual([]);
    const messages = chatRepository(started.ctx.db).listMessages(userScope("user-a"), sent.conversationId) ?? [];
    expect(messages.some((message) => message.contentJson.includes("用户拒绝安装"))).toBe(true);
  }, 15000);

  it("rejects plaintext secrets and keeps a resolved placeholder out of context, steps, approvals, and audit", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    const machine = await fakeMachine();
    const bodies: string[] = [];
    const started = await start(machine.port, (body) => {
      bodies.push(body);
      const count = toolResults(body);
      if (count === 0) return namedToolSse("install_mcp", JSON.stringify({
        package: { name: "demo-pkg", ecosystem: "npm", package: "left-pad", version: "1.2.3" },
        config: { API_TOKEN: SENTINEL },
        secretKeys: ["API_TOKEN"],
        reason: "需要密钥",
      }));
      return textSse("结束");
    });
    const bot = await createBot(depsOf(started), userScope("user-a"), { name: "Ada", model: "gpt-test" });
    const leaked = await started.service.send({ userId: "user-a", botId: bot.id, text: "安装明文", mode: "queue" });
    await started.service.idle();
    expect(started.ctx.db.$client.prepare("select count(*) as n from approvals where task_id=?").get(leaked.taskId)).toEqual({ n: 0 });
    expect(machine.installs).toEqual([]);
    expect(storedText(started.ctx)).not.toContain(SENTINEL);
    expect(bodies.join("\n")).not.toContain(SENTINEL);
    expect(logs.join("\n")).not.toContain(SENTINEL);

    const secretBodies: string[] = [];
    const secretMachine = await fakeMachine();
    const secretRun = await start(secretMachine.port, (body) => {
      secretBodies.push(body);
      const count = toolResults(body);
      if (count === 0) return namedToolSse("request_secret", JSON.stringify({ name: "api_token", label: "令牌", kind: "password", reason: "安装需要" }));
      if (count === 1) return namedToolSse("install_mcp", JSON.stringify({
        package: { name: "demo-pkg", ecosystem: "npm", package: "left-pad", version: "1.2.3" },
        config: { API_TOKEN: "{{secret:api_token}}" },
        secretKeys: ["API_TOKEN"],
        reason: "需要密钥",
      }));
      if (count === 2) return namedToolSse("echo_installed", JSON.stringify({ text: "secret-ok" }));
      return textSse("完成");
    });
    const secretBot = await createBot(depsOf(secretRun), userScope("user-a"), { name: "Ada", model: "gpt-test" });
    secretRun.ctx.db.$client.prepare("update bots set settings_json=? where id=?").run(JSON.stringify({ alwaysAllow: ["mcp"] }), secretBot.id);
    const session = createSession(secretRun.ctx.db, secretRun.ctx.key, "user-a", "refresh-token", new Date());
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, "x-vb-csrf": session.csrf, origin: secretRun.config.publicUrl };
    const sent = await secretRun.service.send({ userId: "user-a", botId: secretBot.id, text: "安装密钥", mode: "queue" });
    await waitFor(() => {
      const row = secretRun.ctx.db.$client.prepare("select state from tasks where id=?").get(sent.taskId) as { state: string } | undefined;
      return row?.state === "waiting_input";
    });
    const provided = await secretRun.app.inject({
      method: "POST",
      url: `/api/tasks/${sent.taskId}/secrets`,
      headers,
      payload: { decision: "provide", name: "api_token", value: SENTINEL, save: false },
    });
    expect(provided.statusCode).toBe(200);
    await waitFor(() => Boolean(secretRun.ctx.db.$client.prepare("select id from approvals where task_id=? and state='pending'").get(sent.taskId)));
    const approval = secretRun.ctx.db.$client.prepare("select id, summary, args_json from approvals where task_id=?").get(sent.taskId) as { id: string; summary: string; args_json: string };
    expect(approval.summary).toContain("已填写的密钥");
    expect(approval.summary).not.toContain(SENTINEL);
    expect(approval.args_json).toContain("{{secret:api_token}}");
    expect(secretRun.service.approvalGate.decide("user-a", approval.id, "allow")).toBe("ok");
    await secretRun.service.idle();
    const config = secretRun.ctx.db.$client.prepare("select config_json as json from app_installs").all() as Array<{ json: string }>;
    expect(config.some((row) => row.json.includes('"secret":true'))).toBe(true);
    expect(storedText(secretRun.ctx)).not.toContain(SENTINEL);
    expect(secretBodies.join("\n")).not.toContain(SENTINEL);
    const messages = chatRepository(secretRun.ctx.db).listMessages(userScope("user-a"), sent.conversationId) ?? [];
    expect(messages.some((message) => message.contentJson.includes("echo:secret-ok"))).toBe(true);
  }, 15000);

  it("hides another user's private app from search and install", async () => {
    const machine = await fakeMachine();
    const started = await start(machine.port, (body) => {
      const count = toolResults(body);
      if (count === 0) return namedToolSse("search_apps", JSON.stringify({ query: "bob-private" }));
      if (count === 1) return namedToolSse("install_mcp", JSON.stringify({ catalog: { name: "bob-private", version: "1.0.0" }, reason: "想装别人的" }));
      return textSse("结束");
    });
    await publishValidatedPackage(catalogOf(started), "user-b", wrapMcpUrl("bob-private", "https://example.com/bob"), {
      version: "1.0.0",
      privateUserId: "user-b",
    });
    const bot = await createBot(depsOf(started), userScope("user-a"), { name: "Ada", model: "gpt-test" });
    const sent = await started.service.send({ userId: "user-a", botId: bot.id, text: "找别人的应用", mode: "queue" });
    await started.service.idle();
    expect(machine.installs).toEqual([]);
    const messages = chatRepository(started.ctx.db).listMessages(userScope("user-a"), sent.conversationId) ?? [];
    const text = messages.map((message) => message.contentJson).join("\n");
    expect(text).toContain("没有匹配的应用");
    expect(text).toContain("找不到");
    expect(text).not.toContain("https://example.com/bob");
  });

  it("continues a task when an installed MCP fails to start and tells the model", async () => {
    const machine = await fakeMachine({ fail: new Set(["broken"]) });
    const bodies: string[] = [];
    const started = await start(machine.port, (body) => {
      bodies.push(body);
      return textSse("继续");
    });
    seedBrokenInstall(started.ctx);
    const bot = await createBot(depsOf(started), userScope("user-a"), { name: "Ada", model: "gpt-test" });
    const sent = await started.service.send({ userId: "user-a", botId: bot.id, text: "你好", mode: "queue" });
    await started.service.idle();
    expect(chatRepository(started.ctx.db).findTask(userScope("user-a"), sent.taskId)?.state).toBe("succeeded");
    const steps = chatRepository(started.ctx.db).listSteps(userScope("user-a"), sent.taskId) ?? [];
    const failure = steps.find((step) => step.kind === "mcp");
    expect(failure?.requestJson).toContain("broken");
    expect(failure?.requestJson).toContain("启动失败");
    expect(bodies.some((body) => body.includes("应用 broken 的工具当前不可用"))).toBe(true);
  });
});

function catalogOf(started: Started) {
  return {
    db: started.ctx.db,
    key: started.ctx.key,
    dataDir: started.config.dataDir,
    installer: { async install() {}, async uninstall() {} },
  };
}

function directInstaller(started: Started) {
  return installMcpTool({ userId: "user-a", botId: "bot-review", botName: "Review", taskId: "task-review", catalog: {
    ...catalogOf(started),
    installer: { async install() {}, async uninstall() {} },
  }, lookup: (name) => name === "token" ? SENTINEL : undefined, readFile: async () => "1.2.3", launch: async () => ["echo"] });
}

function depsOf(started: Started) {
  return { db: started.ctx.db, key: started.ctx.key, credentials: started.runtime.credentials, providerId: started.runtime.identity.id };
}

function seedBrokenInstall(ctx: ControlContext): void {
  const now = new Date().toISOString();
  ctx.db.$client.prepare("insert into apps (id,name,source,owner_user_id,created_at) values ('app-broken','broken','user','user-a',?)").run(now);
  ctx.db.$client.prepare("insert into app_versions (id,app_id,version,manifest_json,archive_path,sha256,status,recommended,created_at) values ('ver-broken','app-broken','1.0.0','{}','/tmp/vb-missing','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','active',0,?)").run(now);
  ctx.db.$client.prepare("insert into app_installs (id,machine_id,app_version_id,forced,desired,state,config_json,updated_at) values ('inst-broken','machine-a','ver-broken',0,'present','installed','{}',?)").run(now);
}

function storedText(ctx: ControlContext): string {
  const chunks: string[] = [];
  for (const table of ["messages", "task_steps", "approvals", "audit_log", "events", "app_installs", "secrets"]) {
    const rows = ctx.db.$client.prepare(`select * from ${table}`).all() as Array<Record<string, unknown>>;
    chunks.push(JSON.stringify(rows));
  }
  return chunks.join("\n");
}

interface Started {
  app: ReturnType<typeof buildApp>;
  service: ReturnType<typeof chatService>;
  runtime: ReturnType<typeof createRuntime>;
  ctx: ControlContext;
  config: ControlConfig;
}

async function start(port: number, respond: (body: string) => string): Promise<Started> {
  const modelPort = await listen(async (_req, res, body) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(respond(body));
  });
  const dir = mkdtempSync(join(tmpdir(), "vb-mcpinst-"));
  const config = loadConfig({
    VB_DATA_DIR: dir,
    VB_PUBLIC_URL: "http://127.0.0.1:4418",
    VB_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
    VB_MODEL_API_KEY: "super-secret-key",
    VB_OIDC_ISSUER: "http://127.0.0.1:9",
    VB_OIDC_CLIENT_ID: "bot",
    VB_OIDC_CLIENT_SECRET: "secret",
  });
  const ctx = contextFor(config);
  ensureDevUser(ctx.db, "user-a");
  ensureDevUser(ctx.db, "user-b");
  machineRepository(ctx.db).insert(userScope("user-a"), {
    id: "machine-a",
    userId: "user-a",
    state: "running",
    containerId: "c",
    networkId: "n",
    volumeName: "vol-a",
    imageVersion: "mcpinst",
    spec: { cpu: 1, memMb: 512, diskGb: 10 },
    tokenEnc: "enc",
  });
  const app = buildApp(ctx, {
    retryDelays: [0, 0],
    ensureMachine: async () => {},
    prepareEndpoint: async (_userId, onPhase) => {
      onPhase("ready");
      return { host: "127.0.0.1", port, token: "machine" };
    },
  });
  await app.ready();
  const runtime = createRuntime(config, ctx.db);
  cleanups.push(async () => {
    await app.close();
    ctx.db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, service: chatService(app), runtime, ctx, config };
}

async function fakeMachine(options: { fail?: Set<string> } = {}): Promise<{ port: number; installs: string[] }> {
  const installs: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (req.method === "POST" && path === "/apps/install") {
        installs.push(req.url ?? "");
        json(res, 200, { routines: [] });
        return;
      }
      const inspect = /^\/apps\/([^/]+)$/.exec(path);
      if (req.method === "GET" && inspect) {
        const name = decodeURIComponent(inspect[1] ?? "");
        if (options.fail?.has(name)) {
          json(res, 500, { error: "boom" });
          return;
        }
        json(res, 200, { mcpServers: [name] });
        return;
      }
      const launch = /^\/apps\/([^/]+)\/mcp\/([^/]+)$/.exec(path);
      if (req.method === "POST" && launch) {
        json(res, 200, { server: decodeURIComponent(launch[2] ?? ""), running: true });
        return;
      }
      if (req.method === "POST" && path === "/fs/read") {
        json(res, 200, { path: "/resolved", content: "1.2.3\n", truncated: false });
        return;
      }
      json(res, 404, { error: "no" });
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: number; method?: string; params?: { arguments?: { text?: string } } };
      const result = message.method === "tools/list"
        ? { tools: [{ name: "echo_installed", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
        : { content: [{ type: "text", text: `echo:${message.params?.arguments?.text ?? ""}` }], isError: false };
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port, installs };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>): Promise<number> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      void Promise.resolve(handler(req, res, Buffer.concat(chunks).toString("utf8"))).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return port;
}

function toolResults(body: string): number {
  const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
  return (parsed.messages ?? []).filter((message) => message.role === "tool").length;
}

function namedToolSse(name: string, args: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function textSse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
}

function contextFor(config: ControlConfig): ControlContext {
  const db = openDatabase(config.databasePath);
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return { db, config, key: loadOrCreateKey(config.secretKeyPath), driver: {} as ControlContext["driver"] };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
