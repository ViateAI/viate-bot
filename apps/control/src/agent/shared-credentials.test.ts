import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import {
  catalogSecretName,
  installForUser,
  listUserInstalls,
  publishCatalogVersion,
  resolveMcpLaunch,
  setVisibility,
  type CatalogDeps,
  type CatalogMachineInstall,
} from "../apps/catalog.js";
import { decrypt } from "../crypto.js";
import { openDatabase } from "../db/index.js";
import { botRepository } from "../db/bots.js";
import { machineRepository } from "../db/machines.js";
import { auditLog, secrets } from "../db/schema.js";
import { userRepository } from "../db/users.js";
import { approvalClass, CONTROL_PLANE_TOOLS } from "../m2/risk.js";
import { adminScope, userScope } from "../scope.js";
import { createSecretBroker } from "./secrets.js";
import { maskSecrets } from "./text.js";
import { linkAppCredentialTool, saveSecretFromMachineTool } from "./shared-credentials.js";
import { createTaskMcp } from "./mcp-tools.js";
import type { MachinedMcpClient } from "./mcp-client.js";

const TOKEN = "machine-file-token-9f3c";
const NEXT = "machine-file-token-9f3d";
const PRIVATE = "private-copy-token-9f3e";
const dirs: string[] = [];
const closers: Array<() => void> = [];
let shaByte = 1;

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("shared credential tools", () => {
  it("saves a machine file into the user secret without echoing it and masks later output", async () => {
    const ctx = boot();
    const published = publish(ctx, "tara", "1.0.0", JSON.stringify({
      config: [{ key: "MCP_TOKEN", secret: true, header: "Authorization", prefix: "Bearer " }],
    }));
    setVisibility(ctx.deps, adminScope("admin"), published.appId, { scope: "all" });
    const { secretRepository } = await import("../db/secrets.js");
    secretRepository(ctx.db).upsert(userScope("alice"), {
      id: "sec-old",
      name: "corp_token",
      valueEnc: (await import("../crypto.js")).encrypt(ctx.key, "old-token-value-9f30"),
      scope: "browser",
    });
    await installForUser(ctx.deps, "alice", "tara", {
      config: { MCP_TOKEN: { secret: true, secretRef: "corp_token", prefix: "Bearer " } },
    });
    const files = fakeFiles(`  Bearer ${TOKEN}\n`);
    const stopped: string[] = [];
    const broker = brokerFor(ctx);
    const tool = saveSecretFromMachineTool({
      userId: "alice",
      taskId: "task-1",
      catalog: ctx.deps,
      files,
      confineNow: () => true,
      remember: (name, value) => broker.remember("task-1", name, value),
      stopApp: (name) => stopped.push(name),
    });
    const result = await tool.execute("save", {
      name: "corp_token",
      path: "/tmp/vb-token",
      stripPrefix: "Bearer ",
    });
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain("已保存密钥 corp_token");
    expect(text).toContain(`长度 ${TOKEN.length}`);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("已删除临时文件");
    expect(files.reads).toEqual([{ path: "/tmp/vb-token", maxBytes: 4096, confine: true }]);
    expect(files.removed).toEqual(["/tmp/vb-token"]);
    const row = ctx.db.select().from(secrets).where(eq(secrets.name, "corp_token")).get();
    expect(row?.scope).toBe("browser");
    expect(row?.userId).toBe("alice");
    expect(decrypt(ctx.key, row?.valueEnc ?? "")).toBe(TOKEN);
    expect(JSON.stringify(ctx.db.select().from(auditLog).all())).not.toContain(TOKEN);
    expect(ctx.db.select().from(auditLog).all().map((item) => item.action)).toContain("secret.saved_from_machine");
    expect(stopped).toEqual(["tara"]);
    expect(resolveMcpLaunch(ctx.deps, "alice", "tara").headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(maskSecrets(`seen ${TOKEN} end`, broker.known("alice", "task-1"))).toBe("seen {{secret:corp_token}} end");
    expect(maskSecrets(`seen ${TOKEN} end`, broker.known("alice", "task-1"))).not.toContain(TOKEN);
  });

  it("rejects an oversized file and keeps the secret when deleting the temp file fails", async () => {
    const ctx = boot();
    const files = fakeFiles(`${TOKEN}\n`);
    files.truncated = true;
    const tool = saveSecretFromMachineTool({
      userId: "alice",
      taskId: "task-1",
      catalog: ctx.deps,
      files,
      confineNow: () => false,
      remember: () => undefined,
      stopApp: () => undefined,
    });
    const rejected = await tool.execute("save", { name: "corp_token", path: "/tmp/vb-big" });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).not.toContain(TOKEN);
    expect(ctx.db.select().from(secrets).all()).toEqual([]);
    expect(files.removed).toEqual([]);

    files.truncated = false;
    files.content = ` ${NEXT} `;
    files.failRemove = true;
    const saved = await tool.execute("save", { name: "corp_token", path: "/tmp/vb-big", trim: false });
    expect(saved.isError).not.toBe(true);
    expect(textOf(saved)).toContain("未能删除");
    expect(textOf(saved)).not.toContain(NEXT);
    expect(decrypt(ctx.key, ctx.db.select().from(secrets).where(eq(secrets.name, "corp_token")).get()?.valueEnc ?? "")).toBe(` ${NEXT} `);
  });

  it("links one secret across credential matches and explicit targets without touching other keys", async () => {
    const ctx = boot();
    const { encrypt } = await import("../crypto.js");
    const { secretRepository } = await import("../db/secrets.js");
    secretRepository(ctx.db).upsert(userScope("alice"), {
      id: "sec-corp",
      name: "corp_token",
      valueEnc: encrypt(ctx.key, TOKEN),
      scope: "browser",
    });
    const sso = (prefix?: string) => JSON.stringify({
      config: [
        { key: "MCP_TOKEN", secret: true, env: "MCP_TOKEN", credential: "corp_sso", ...(prefix ? { prefix } : {}) },
        { key: "REGION", secret: false },
      ],
    });
    for (const [name, manifest] of [
      ["tara", sso("Bearer ")],
      ["onebuild", sso()],
      ["skipped", sso("Bearer ")],
    ] as const) {
      const published = publish(ctx, name, "1.0.0", manifest);
      setVisibility(ctx.deps, adminScope("admin"), published.appId, { scope: "all" });
      const installed = await installForUser(ctx.deps, "alice", name, { config: { REGION: "eu" } });
      if (name === "skipped") {
        ctx.db.$client.prepare("update bot_apps set enabled=0 where app_install_id=?").run(installed.id);
      }
    }
    const biops = publish(ctx, "biops", "1.0.0", JSON.stringify({
      config: [
        { key: "MCP_TOKEN", secret: true, env: "MCP_TOKEN" },
        { key: "REGION", secret: false },
      ],
    }));
    setVisibility(ctx.deps, adminScope("admin"), biops.appId, { scope: "all" });
    const installedBiops = await installForUser(ctx.deps, "alice", "biops", {
      config: { MCP_TOKEN: PRIVATE, REGION: "keep" },
    });
    const stopped: string[] = [];
    const tool = linkAppCredentialTool({
      userId: "alice",
      botId: "bot-alice",
      catalog: ctx.deps,
      stopApp: (name) => stopped.push(name),
    });
    const result = await tool.execute("link", {
      secretName: "corp_token",
      credential: "corp_sso",
      defaultPrefix: "Token ",
      targets: [{ app: "biops", key: "MCP_TOKEN", prefix: "Bearer " }],
    });
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain("tara");
    expect(text).toContain("onebuild");
    expect(text).toContain("biops");
    expect(text).not.toContain("skipped");
    expect(text).toContain("mcp_inspect");
    expect(text).toContain("mcp_call");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PRIVATE);
    expect(configOf(ctx, "tara")).toEqual({
      MCP_TOKEN: { secret: true, secretRef: "corp_token", prefix: "Bearer " },
      REGION: "eu",
    });
    expect(configOf(ctx, "onebuild")).toEqual({
      MCP_TOKEN: { secret: true, secretRef: "corp_token", prefix: "Token " },
      REGION: "eu",
    });
    expect(configOf(ctx, "skipped")).toEqual({ REGION: "eu" });
    expect(configOf(ctx, "biops")).toEqual({
      MCP_TOKEN: { secret: true, secretRef: "corp_token", prefix: "Bearer " },
      REGION: "keep",
    });
    expect(ctx.db.select().from(secrets).where(eq(secrets.name, catalogSecretName(installedBiops.id, "MCP_TOKEN"))).get()).toBeUndefined();
    expect(resolveMcpLaunch(ctx.deps, "alice", "tara").env.MCP_TOKEN).toBe(`Bearer ${TOKEN}`);
    expect(resolveMcpLaunch(ctx.deps, "alice", "onebuild").env.MCP_TOKEN).toBe(`Token ${TOKEN}`);
    expect(resolveMcpLaunch(ctx.deps, "alice", "biops").env.MCP_TOKEN).toBe(`Bearer ${TOKEN}`);
    expect(stopped.sort()).toEqual(["biops", "onebuild", "tara"]);
    const audit = ctx.db.select().from(auditLog).all().map((item) => `${item.action} ${item.attrsJson}`).join("\n");
    expect(audit).toContain("secret.link_app");
    expect(audit).not.toContain(TOKEN);
    expect(audit).not.toContain(PRIVATE);
  });

  it("rejects another user's secret and a link that matches nothing", async () => {
    const ctx = boot();
    machineRepository(ctx.db).insert(userScope("bob"), {
      id: "machine-bob",
      userId: "bob",
      state: "running",
      containerId: "c",
      networkId: "n",
      volumeName: "vol-bob",
      imageVersion: "dev",
      spec: { cpu: 1, memMb: 512, diskGb: 10 },
      tokenEnc: "enc",
    });
    const { encrypt } = await import("../crypto.js");
    const { secretRepository } = await import("../db/secrets.js");
    secretRepository(ctx.db).upsert(userScope("bob"), {
      id: "sec-bob",
      name: "corp_token",
      valueEnc: encrypt(ctx.key, TOKEN),
      scope: "browser",
    });
    const tool = linkAppCredentialTool({
      userId: "alice",
      botId: "bot-alice",
      catalog: ctx.deps,
      stopApp: () => undefined,
    });
    const foreign = await tool.execute("link", { secretName: "corp_token", targets: [{ app: "tara", key: "MCP_TOKEN" }] });
    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toContain("不存在");
    expect(textOf(foreign)).not.toContain(TOKEN);
    secretRepository(ctx.db).upsert(userScope("alice"), {
      id: "sec-alice",
      name: "corp_token",
      valueEnc: encrypt(ctx.key, "alice-token-value-9f31"),
      scope: "browser",
    });
    const none = await tool.execute("link", { secretName: "corp_token", credential: "missing" });
    expect(none.isError).toBe(true);
    expect(textOf(none)).not.toContain("alice-token-value-9f31");
    expect(listUserInstalls(ctx.deps, "alice")).toEqual([]);
  });

  it("does not require approval", () => {
    expect(CONTROL_PLANE_TOOLS.save_secret_from_machine).toBe(true);
    expect(CONTROL_PLANE_TOOLS.link_app_credential).toBe(true);
    expect(approvalClass("save_secret_from_machine")).toBeUndefined();
    expect(approvalClass("link_app_credential")).toBeUndefined();
  });

  it("does not cache an MCP session that was stopped while it was launching", async () => {
    const ctx = boot();
    const published = publish(ctx, "tara", "1.0.0", JSON.stringify({ extensions: { "ai.viate.bot": { riskyTools: [] } } }));
    setVisibility(ctx.deps, adminScope("admin"), published.appId, { scope: "all" });
    await installForUser(ctx.deps, "alice", "tara", {});
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let launches = 0;
    const client = {
      async launchApp() {
        launches += 1;
        if (launches === 1) {
          started.resolve();
          await gate.promise;
        }
        return { server: `sess-${launches}`, running: true };
      },
      async listTools() {
        return { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] };
      },
      stopApp() {},
      async callTool() {
        return { content: [{ type: "text", text: "ok" }] };
      },
      close() {},
    } as unknown as MachinedMcpClient;
    const task = createTaskMcp({
      client,
      files: { async inspectApp() { return { mcpServers: ["main"] }; } },
      catalog: ctx.deps,
      userId: "alice",
      botId: "bot-alice",
      taskId: "task-1",
    });
    const first = task.inspectTool.execute("inspect-1", { app: "tara" });
    await started.promise;
    task.stopApp("tara");
    gate.resolve();
    await first;
    await task.inspectTool.execute("inspect-2", { app: "tara" });
    expect(launches).toBe(2);
  });
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("\n");
}

function configOf(ctx: ReturnType<typeof boot>, name: string): unknown {
  return listUserInstalls(ctx.deps, "alice").find((item) => item.name === name)?.config;
}

function brokerFor(ctx: ReturnType<typeof boot>) {
  return createSecretBroker({
    db: ctx.db,
    key: ctx.key,
    waitMs: 1_000,
    now: () => new Date("2026-11-22T00:00:00.000Z"),
    onWaiting() {},
    onRunning() {},
    onResume() {},
    onFail() {},
  });
}

function fakeFiles(content: string) {
  return {
    content,
    truncated: false,
    failRemove: false,
    reads: [] as Array<{ path: string; maxBytes: number; confine: boolean }>,
    removed: [] as string[],
    async read(path: string, maxBytes: number, _signal?: AbortSignal, _encoding?: "utf8" | "base64", confine = true) {
      this.reads.push({ path, maxBytes, confine });
      return { path, content: this.content, truncated: this.truncated };
    },
    async removeFile(path: string) {
      if (this.failRemove) throw new Error("busy");
      this.removed.push(path);
      return { path };
    },
  };
}

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "vb-shared-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  closers.push(() => db.$client.close());
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const key = randomBytes(32);
  userRepository(db).insert({ id: "alice", email: "alice@example.com", name: "Alice", status: "active", isAdmin: false });
  userRepository(db).insert({ id: "bob", email: "bob@example.com", name: "Bob", status: "active", isAdmin: false });
  userRepository(db).insert({ id: "admin", email: "admin@example.com", name: "Admin", status: "active", isAdmin: true });
  machineRepository(db).insert(userScope("alice"), {
    id: "machine-alice",
    userId: "alice",
    state: "running",
    containerId: "c",
    networkId: "n",
    volumeName: "vol-alice",
    imageVersion: "dev",
    spec: { cpu: 1, memMb: 512, diskGb: 10 },
    tokenEnc: "enc",
  });
  botRepository(db).insert(userScope("alice"), { id: "bot-alice", name: "Helper", model: "fake" });
  const installed: CatalogMachineInstall[] = [];
  const deps: CatalogDeps = {
    db,
    key,
    dataDir: dir,
    installer: {
      async install(command) {
        installed.push(command);
      },
      async uninstall() {},
    },
  };
  return { dir, db, key, deps, installed };
}

function publish(ctx: ReturnType<typeof boot>, name: string, version: string, manifestJson: string) {
  shaByte += 1;
  return publishCatalogVersion(ctx.deps, adminScope("admin"), {
    name,
    version,
    manifestJson,
    archivePath: `/var/lib/viate/apps/${name}/${version}.tar.zst`,
    sha256: shaByte.toString(16).padStart(2, "0").repeat(32),
  });
}

