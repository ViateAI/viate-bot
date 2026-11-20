import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { approvalClass, skipsApproval } from "../m2/risk.js";
import { openDatabase } from "../db/index.js";
import { apps, appVersions } from "../db/schema.js";
import { userRepository } from "../db/users.js";
import { MachinedClient } from "../machines/client.js";
import { adminScope } from "../scope.js";
import { validatePackage, type PackageFile } from "./archive.js";
import { listUserCatalog, publishCatalogVersion, type CatalogDeps } from "./catalog.js";
import { packageAppFromArchive, packageAppTool } from "./package-app.js";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const SECRET = "broker-secret-value-9f3a";
const KEY_BODY = "MIIEsecretmaterial";
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boot(): CatalogDeps {
  const dir = mkdtempSync(join(tmpdir(), "vb-pkg-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  closers.push(async () => {
    db.$client.close();
  });
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const users = userRepository(db);
  users.insert({ id: "admin", email: "admin@example.com", name: "Admin", status: "active", isAdmin: true });
  users.insert({ id: "alice", email: "alice@example.com", name: "Alice", status: "active", isAdmin: false });
  users.insert({ id: "bob", email: "bob@example.com", name: "Bob", status: "active", isAdmin: false });
  return {
    db,
    key: Buffer.alloc(32, 3),
    dataDir: dir,
    installer: { async install() {}, async uninstall() {} },
  };
}

function archive(files: PackageFile[]): Buffer {
  return validatePackage(files).archive;
}

function skill(name: string, extra: PackageFile[] = []): Buffer {
  return archive([
    { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: PLUGIN, name })) },
    {
      path: `skills/${name}/SKILL.md`,
      data: Buffer.from(`---\nname: ${name}\ndescription: private notes\n---\nhello\n`),
    },
    ...extra,
  ]);
}

function mcp(name: string, token: string): Buffer {
  return archive([
    {
      path: "plugin.json",
      data: Buffer.from(JSON.stringify({
        $schema: PLUGIN,
        name,
        extensions: { "ai.viate.bot": { config: [{ key: "TOKEN", secret: true }] } },
      })),
    },
    {
      path: "mcp.json",
      data: Buffer.from(JSON.stringify({
        $schema: MCP,
        mcpServers: { notes: { type: "stdio", command: "./bin/mcp", env: { TOKEN: token } } },
      })),
    },
  ]);
}

describe("package_app", () => {
  it("rejects short known secrets", async () => {
    const deps = boot();
    await expect(packageAppFromArchive(deps, "alice", {
      version: "1.0.0",
      archive: skill("short-secret", [{ path: "note.txt", data: Buffer.from("password=7q!Z") }]),
      secrets: ["7q!Z"],
    })).rejects.toThrow("note.txt: 已知密钥");
  });

  it("accepts ordinary text sharing a key prefix", async () => {
    const deps = boot();
    await expect(packageAppFromArchive(deps, "alice", {
      version: "1.0.0",
      archive: skill("ordinary", [{ path: "note.txt", data: Buffer.from("locale sk-SK; identifier ghp_example; AKIA demo") }]),
      secrets: [],
    })).resolves.toMatchObject({ name: "ordinary" });
  });

  it("stores a private version and does not require approval", async () => {
    const deps = boot();
    const packed = skill("notes");
    const saved = await packageAppFromArchive(deps, "alice", {
      version: "1.0.0",
      archive: packed,
      secrets: [],
    });
    expect(saved).toMatchObject({
      name: "notes",
      version: "1.0.0",
      kinds: ["技能"],
      files: 2,
      warnings: [],
    });
    expect(saved.bytes).toBeGreaterThan(0);
    const row = deps.db.select().from(apps).where(eq(apps.name, "notes")).get();
    expect(row).toMatchObject({ source: "user", ownerUserId: "alice" });
    expect(deps.db.select().from(appVersions).all()).toHaveLength(1);
    expect(listUserCatalog(deps, "alice").map((entry) => entry.name)).toEqual(["notes"]);
    expect(listUserCatalog(deps, "bob").map((entry) => entry.name)).toEqual([]);
    expect(approvalClass("package_app")).toBeUndefined();
    expect(skipsApproval(approvalClass("package_app"), { alwaysAllow: [], approveShell: false, approveNone: false })).toBe(true);

    const calls: string[] = [];
    const tool = packageAppTool({
      userId: "alice",
      catalog: deps,
      secrets: () => [],
      client: {
        async pack(path) {
          calls.push(path);
          return packed;
        },
      },
    });
    await expect(tool.execute("call", { path: "/etc/passwd", version: "1.2.0" })).rejects.toThrow(/\/home\/bot|\/tmp/);
    expect(calls).toEqual([]);
    const result = await tool.execute("call", { path: "/tmp/notes", version: "1.2.0", note: "first" });
    expect(calls).toEqual(["/tmp/notes"]);
    expect(result.details).toMatchObject({ name: "notes", version: "1.2.0", kinds: ["技能"] });
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("notes");
    expect(text).toContain("1.2.0");
    expect(text).toContain("技能");
  });

  it("rejects a taken name, a repeated version, and packaged secrets without echoing them", async () => {
    const deps = boot();
    publishCatalogVersion(deps, adminScope("admin"), {
      name: "weather",
      version: "1.0.0",
      manifestJson: "{}",
      archivePath: "/tmp/weather.tar.zst",
      sha256: "ab".repeat(32),
    });
    await expect(packageAppFromArchive(deps, "alice", {
      version: "1.0.0",
      archive: skill("weather"),
      secrets: [],
    })).rejects.toMatchObject({ statusCode: 409, message: "名称已被占用" });

    await packageAppFromArchive(deps, "alice", { version: "1.0.0", archive: skill("notes"), secrets: [] });
    await expect(packageAppFromArchive(deps, "alice", {
      version: "1.0.0",
      archive: skill("notes"),
      secrets: [],
    })).rejects.toMatchObject({ statusCode: 409, message: "版本已存在" });

    const leaked = [
      skill("notes", [{ path: "key.pem", data: Buffer.from(`-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}\n-----END RSA PRIVATE KEY-----\n`) }]),
      skill("notes", [{ path: "token.txt", data: Buffer.from(`prefix sk-${SECRET} suffix`) }]),
      skill("notes", [{ path: "note.txt", data: Buffer.from(`see ${SECRET} here`) }]),
      mcp("notes", "literal-token-value-9f3a"),
    ];
    for (const bytes of leaked) {
      await expect(packageAppFromArchive(deps, "alice", {
        version: "9.9.9",
        archive: bytes,
        secrets: [SECRET],
      })).rejects.toThrow(/key\.pem|token\.txt|note\.txt|mcp\.json/);
    }
    const errors: string[] = [];
    for (const bytes of leaked) {
      try {
        await packageAppFromArchive(deps, "alice", { version: "9.9.9", archive: bytes, secrets: [SECRET] });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "");
      }
    }
    expect(errors.join("\n")).not.toContain(SECRET);
    expect(errors.join("\n")).not.toContain(KEY_BODY);
    expect(errors.join("\n")).not.toContain("literal-token-value-9f3a");
    expect(errors.some((message) => message.includes("私钥块"))).toBe(true);
    expect(errors.some((message) => message.includes("明文配置"))).toBe(true);

    const allowed = await packageAppFromArchive(deps, "alice", {
      version: "2.0.0",
      archive: mcp("relay", "${config.TOKEN}"),
      secrets: [SECRET],
    });
    expect(allowed.kinds).toContain("本地 MCP");
    expect(deps.db.select().from(appVersions).all().map((row) => row.version).sort()).toEqual(["1.0.0", "1.0.0", "2.0.0"]);
  });

  it("downloads a raw tar from the machine pack route", async () => {
    const payload = Buffer.from("ustar-body");
    const address = await listen((response) => {
      response.setHeader("content-type", "application/x-tar");
      response.end(payload);
    });
    const client = new MachinedClient({ host: "127.0.0.1", port: address.port, token: "machine-token" });
    await expect(client.pack("/tmp/notes")).resolves.toEqual(payload);
  });

  it("packs a path outside the roots only when the switch is off", async () => {
    const deps = boot();
    const packed = skill("notes");
    const calls: string[] = [];
    const open = packageAppTool({
      userId: "alice",
      catalog: deps,
      secrets: () => [],
      confined: false,
      confineNow: () => false,
      client: {
        async pack(path) {
          calls.push(path);
          return packed;
        },
      },
    });
    expect(JSON.stringify(open.parameters)).not.toContain("只能在 /home/bot 或 /tmp");
    const saved = await open.execute("call", { path: "/etc/notes", version: "1.2.0" });
    expect(calls).toEqual(["/etc/notes"]);
    expect(saved.details).toMatchObject({ name: "notes", version: "1.2.0" });

    const callsWhenOn: string[] = [];
    const locked = packageAppTool({
      userId: "alice",
      catalog: deps,
      secrets: () => [],
      confined: true,
      confineNow: () => true,
      client: {
        async pack(path) {
          callsWhenOn.push(path);
          return packed;
        },
      },
    });
    expect(JSON.stringify(locked.parameters)).toContain("只能在 /home/bot 或 /tmp");
    await expect(locked.execute("call", { path: "/etc/passwd", version: "1.2.0" })).rejects.toThrow(/\/home\/bot|\/tmp/);
    expect(callsWhenOn).toEqual([]);
  });
});

function listen(handler: (response: ServerResponse) => void): Promise<AddressInfo> {
  const server = createServer((request, response) => {
    request.resume();
    handler(response);
  });
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const info = server.address();
      if (!info || typeof info === "string") throw new Error("no port");
      resolve(info);
    });
  });
}
