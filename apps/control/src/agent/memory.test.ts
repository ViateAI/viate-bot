import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, chatService, type ControlContext } from "../app.js";
import { loadConfig } from "../config.js";
import { loadOrCreateKey } from "../crypto.js";
import { openDatabase } from "../db/index.js";
import { memoryRepository } from "../db/memories.js";
import { ensureDevUser } from "../db/users.js";
import { createSession } from "../session.js";
import { userScope } from "../scope.js";
import { memoryTools } from "./memory-tools.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return server.address() as AddressInfo;
}

describe("memory tools and context", () => {
  it("masks secret values before they are stored", async () => {
    let stored = "";
    const save = memoryTools({
      knownSecrets: () => [{ name: "API", value: "sk-live-secret-value" }],
      save: (content) => {
        stored = content;
        return { id: "mem-1", botId: "bot", content, sourceTaskId: "task", createdAt: "", updatedAt: "" };
      },
      search: () => [],
      remove: () => true,
    }).find((tool) => tool.name === "memory_save");
    if (!save) throw new Error("missing memory_save");
    await save.execute("call-1", { content: "把 sk-live-secret-value 记下来" });
    expect(stored).toBe("把 {{secret:API}} 记下来");
    expect(stored).not.toContain("sk-live-secret-value");
  });

  it("puts recent memories and the FTS hit into the system prompt", async () => {
    const seen: string[] = [];
    const address = await listen((_req, res, body) => {
      seen.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "好" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
      );
    });
    const dir = mkdtempSync(join(tmpdir(), "vb-mem-http-"));
    const config = loadConfig({
      VB_DATA_DIR: dir,
      VB_PUBLIC_URL: "http://127.0.0.1:4418",
      VB_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      VB_MODEL_API_KEY: "shared-secret",
      VB_OIDC_ISSUER: "http://127.0.0.1:9",
      VB_OIDC_CLIENT_ID: "bot",
      VB_OIDC_CLIENT_SECRET: "secret",
    });
    const db = openDatabase(config.databasePath);
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    ensureDevUser(db, "user-a");
    const ctx: ControlContext = { db, driver: {} as ControlContext["driver"], config, key: loadOrCreateKey(config.secretKeyPath) };
    const app = buildApp(ctx, {
      ensureMachine: async () => {},
      prepareEndpoint: async (_userId, onPhase) => {
        onPhase("ready");
        return { host: "127.0.0.1", port: 9, token: "t" };
      },
    });
    await app.ready();
    cleanups.push(async () => {
      await app.close();
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const session = createSession(db, ctx.key, "user-a", "refresh", new Date());
    const created = await app.inject({
      method: "POST",
      url: "/api/bots",
      headers: { cookie: `vb_session=${session.token}`, "x-vb-csrf": session.csrf, "content-type": "application/json" },
      payload: { name: "Ada", model: "fake" },
    });
    expect(created.statusCode).toBe(201);
    const botId = created.json().bot.id as string;
    const memories = memoryRepository(db);
    const scope = userScope("user-a");
    memories.save(scope, botId, { id: "old-hidden", content: "不该出现的旧记忆ZZZ", sourceTaskId: null });
    memories.save(scope, botId, { id: "searched", content: "独特检索词甲乙丙", sourceTaskId: null });
    for (let index = 0; index < 10; index += 1) {
      memories.save(scope, botId, { id: `recent-${index}`, content: `最近记忆${index}`, sourceTaskId: null });
    }
    const sent = await app.inject({
      method: "POST",
      url: `/api/bots/${botId}/messages`,
      headers: { cookie: `vb_session=${session.token}`, "x-vb-csrf": session.csrf, "content-type": "application/json" },
      payload: { text: "独特检索词甲乙丙" },
    });
    expect(sent.statusCode).toBe(202);
    await chatService(app).idle();
    const prompt = seen[0] ?? "";
    expect(prompt).toContain("最近记忆9");
    expect(prompt).toContain("独特检索词甲乙丙");
    expect(prompt).toContain("searched");
    expect(prompt).not.toContain("不该出现的旧记忆ZZZ");
    ensureDevUser(db, "user-b");
    const other = createSession(db, ctx.key, "user-b", "refresh-b", new Date());
    const denied = await app.inject({
      method: "GET",
      url: `/api/bots/${botId}/memories`,
      headers: { cookie: `vb_session=${other.token}` },
    });
    expect(denied.statusCode).toBe(404);
  });
});
