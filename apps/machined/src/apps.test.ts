import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readFile, readdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAppRuntime,
  MCP_SCHEMA,
  mcpConfigDigest,
  mcpSessionKey,
  packAppArchive,
  PLUGIN_SCHEMA,
  setupCommand,
  setupSpawnIdentity,
  SKILL_BYTE_LIMIT,
  SKILL_DESCRIPTION_BUDGET,
  viateLayout,
  type AppRuntime,
} from "./apps.js";
import { createMcpHost } from "./mcp-host.js";

const dirs: string[] = [];
const junk: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const file of junk.splice(0)) rmSync(file, { force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "vb-apps-"));
  dirs.push(dir);
  return dir;
}

function digest(archive: Buffer): string {
  return createHash("sha256").update(archive).digest("hex");
}

function runFile(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(String(code)));
    });
  });
}

async function contains(dir: string, needle: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await contains(path, needle)) return true;
    } else if (entry.isFile()) {
      const data = await readFile(path);
      if (data.includes(Buffer.from(needle))) return true;
    }
  }
  return false;
}

function fixture(version: string, body: string, setup: unknown[]): ReturnType<typeof packAppArchive> {
  const extension = {
    bin: { "fixture-cli": "./cli.mjs" },
    riskyTools: ["fixture.danger"],
    ...(setup.length > 0 ? { setup } : {}),
  };
  const appJson = JSON.stringify({
    bin: extension.bin,
    riskyTools: extension.riskyTools,
    ...(setup.length > 0 ? { setup } : {}),
  });
  const embedded = JSON.stringify({
    riskyTools: extension.riskyTools,
    ...(setup.length > 0 ? { setup } : {}),
    bin: extension.bin,
  });
  return packAppArchive([
    {
      path: "plugin.json",
      data: Buffer.from(JSON.stringify({
        $schema: PLUGIN_SCHEMA,
        name: "fixture",
        version,
        extra: true,
        extensions: { "ai.viate.bot": JSON.parse(embedded) as unknown },
      })),
    },
    { path: "ai.viate.bot/app.json", data: Buffer.from(appJson) },
    {
      path: "skills/greet/SKILL.md",
      data: Buffer.from(`---\nname: greet\ndescription: Say hello\nallowed-tools: shell_exec\n---\n${body}\n`),
    },
    { path: "skills/BadName/SKILL.md", data: Buffer.from("nope") },
    {
      path: "skills/huge/SKILL.md",
      data: Buffer.from(`---\nname: huge\ndescription: Huge\n---\n${"x".repeat(70_000)}`),
    },
    { path: "skills/greet/nested/SKILL.md", data: Buffer.from("---\nname: nested\ndescription: Hidden\n---\nno\n") },
    { path: "extensions/tool.ts", data: Buffer.from("export const ignored = true;\n") },
    {
      path: "mcp.json",
      data: Buffer.from(JSON.stringify({
        $schema: MCP_SCHEMA,
        mcpServers: {
          fixture: { type: "stdio", command: "./server.mjs" },
          bad: { type: "stdio", command: "bash -c true" },
          configured: { type: "stdio", command: "./server.mjs", args: ["${user_config.TOKEN}"] },
          skipped: { type: "stdio", command: "./skipped.mjs", args: ["${config.KEY}"] },
          dot: { type: "stdio", command: "." },
        },
      })),
    },
    {
      path: "server.mjs",
      executable: true,
      data: Buffer.from(`#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let index = buf.indexOf("\\n");
  while (index >= 0) {
    const line = buf.slice(0, index);
    buf = buf.slice(index + 1);
    index = buf.indexOf("\\n");
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const text = msg.params && msg.params.arguments ? msg.params.arguments.text : "";
    const result = msg.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } }
      : msg.method === "tools/list"
        ? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: text === "__root__" ? process.env.PLUGIN_ROOT : String(text) }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`),
    },
    {
      path: "skipped.mjs",
      executable: true,
      data: Buffer.from("#!/usr/bin/env node\nprocess.stdout.write('skipped\\n');\n"),
    },
    {
      path: "cli.mjs",
      executable: true,
      data: Buffer.from("#!/usr/bin/env node\nconst arg = process.argv[2] ?? \"\";\nif (arg === \"--fail\") process.exit(1);\nprocess.stdout.write(`pong ${arg}\\n`);\n"),
    },
  ]);
}

function tarBytes(entries: { name: string; data: Buffer; type?: number; link?: string }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const field = (value: number, start: number, length: number): void => {
      header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length, "ascii");
    };
    const type = entry.type ?? 48;
    header.write(entry.name, 0, 100);
    field(type === 48 ? 0o644 : 0o777, 100, 8);
    field(0, 108, 8);
    field(0, 116, 8);
    field(type === 48 ? entry.data.length : 0, 124, 12);
    field(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = type;
    if (entry.link) header.write(entry.link, 157, 100);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    field(header.reduce((sum, byte) => sum + byte, 0), 148, 8);
    chunks.push(header);
    if (type === 48) chunks.push(entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

describe("machine apps", () => {
  it("uses a sealed absolute apt command and keeps non-apt identities", () => {
    const context = { root: "/evil/root", dataDir: "/evil/data", homeDir: "/evil", timeoutMs: 123, env: { PATH: "/evil/bin", HOME: "/evil", PLUGIN_ROOT: "/evil/root", PLUGIN_DATA: "/evil/data" } };
    expect(setupCommand({ type: "apt", packages: ["curl", "git"] }, context, { uid: 1000, gid: 1000 })).toEqual({
      command: "/usr/bin/apt-get",
      args: ["install", "-y", "--no-install-recommends", "curl", "git"],
      options: { cwd: "/", timeoutMs: 123, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", DEBIAN_FRONTEND: "noninteractive", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } },
    });
    for (const type of ["npm", "pip", "exec"]) expect(setupSpawnIdentity({ type }, { uid: 1000, gid: 1000 })).toEqual({ uid: 1000, gid: 1000 });
  });

  it("isolates reserved version names and preserves data on failed upgrade", async () => {
    const home = temp();
    const runtime = createAppRuntime({ homeDir: home, runSetup: async () => { throw new Error("failed"); } });
    const layout = viateLayout(home);
    const dir = join(layout.apps, "fixture");
    const first = fixture("data", "First", []);
    const installed = await runtime.install({ name: "fixture", version: "data", sha256: first.sha256, archive: first.archive });
    writeFileSync(join(installed.dataDir, "keep"), "safe");
    const second = fixture("current", "Second", []);
    await runtime.install({ name: "fixture", version: "current", sha256: second.sha256, archive: second.archive });
    const key = digest(Buffer.from("current"));
    expect(await readlink(join(dir, "current"))).toBe(`versions/${key}`);
    expect(JSON.parse(await readFile(join(dir, "install.json"), "utf8"))).toMatchObject({ version: "current", storageKey: key, sha256: second.sha256, bins: ["fixture-cli"] });
    expect(await runtime.listApps()).toEqual([{ name: "fixture", version: "current", state: "installed" }]);
    expect((await runtime.inspect("fixture")).version).toBe("current");
    const failing = fixture("1..0", "Third", [{ type: "exec", argv: ["./cli.mjs"] }]);
    await expect(runtime.install({ name: "fixture", version: "1..0", sha256: failing.sha256, archive: failing.archive })).rejects.toThrow();
    expect(await readlink(join(dir, "current"))).toBe(`versions/${key}`);
    expect(await runFile(join(layout.bin, "fixture-cli"), ["alpha"])).toBe("pong alpha\n");
    expect(await readFile(join(installed.dataDir, "keep"), "utf8")).toBe("safe");
    const dots = fixture("1..0", "Dots", []);
    await runtime.install({ name: "fixture", version: "1..0", sha256: dots.sha256, archive: dots.archive });
    expect((await runtime.inspect("fixture")).version).toBe("1..0");
  });

  it("supports legacy bare-version links when an upgrade fails", async () => {
    const home = temp();
    const runtime = createAppRuntime({ homeDir: home, runSetup: async () => { throw new Error("failed"); } });
    const layout = viateLayout(home);
    const first = fixture("1.0.0", "Legacy", []);
    const installed = await runtime.install({ name: "fixture", version: "1.0.0", sha256: first.sha256, archive: first.archive });
    const dir = join(layout.apps, "fixture");
    await rename(installed.root, join(dir, "1.0.0"));
    await unlink(join(dir, "current"));
    await symlink("1.0.0", join(dir, "current"));
    expect((await runtime.inspect("fixture")).version).toBe("1.0.0");
    expect((await runtime.readSkill("greet")).content).toContain("Legacy");
    const next = fixture("2.0.0", "Next", [{ type: "exec", argv: ["./cli.mjs"] }]);
    await expect(runtime.install({ name: "fixture", version: "2.0.0", sha256: next.sha256, archive: next.archive })).rejects.toThrow();
    expect(await readlink(join(dir, "current"))).toBe("1.0.0");
    expect(await runFile(join(layout.bin, "fixture-cli"), ["legacy"])).toBe("pong legacy\n");
  });

  it("rejects incorrectly typed known extension fields but ignores invalid top-level extensions", async () => {
    const runtime = createAppRuntime({ homeDir: temp() });
    for (const field of ["setup", "bin", "riskyTools", "routines", "config"]) {
      const archive = packAppArchive([
        { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "fixture", extensions: { "ai.viate.bot": { [field]: 42 } } })) },
      ]);
      await expect(runtime.install({ name: "fixture", version: "1", sha256: archive.sha256, archive: archive.archive })).rejects.toMatchObject({ name: "AppError", code: "invalid" });
    }
    const archive = packAppArchive([{ path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "fixture", extensions: 42 })) }]);
    expect((await runtime.install({ name: "fixture", version: "1", sha256: archive.sha256, archive: archive.archive })).warnings).toContain("已忽略无效 extensions");
  });

  it("scopes MCP session keys by install, server, version, and config", () => {
    const base = { appName: "alpha", serverName: "server", version: "1", configDigest: mcpConfigDigest({ TOKEN: "a" }) };
    const expected = mcpSessionKey(base);
    expect(expected).toMatch(/^[a-f0-9]{32}$/);
    expect(mcpSessionKey({ ...base, appName: "beta" })).not.toBe(expected);
    expect(mcpSessionKey({ ...base, serverName: "other" })).not.toBe(expected);
    expect(mcpSessionKey({ ...base, version: "2" })).not.toBe(expected);
    expect(mcpSessionKey({ ...base, configDigest: mcpConfigDigest({ TOKEN: "b" }) })).not.toBe(expected);
  });

  it("installs a skill, stdio MCP, and CLI, and keeps the previous version when upgrade setup fails", async () => {
    const home = temp();
    const runtime = createAppRuntime({ homeDir: home, setupTimeoutMs: 5_000 });
    const host = createMcpHost({ homeDir: home, timeoutMs: 5_000 });
    const layout = viateLayout(home);
    const secret = "super-secret-token";
    try {
      const first = fixture("1.0.0", "Hello", []);
      const installed = await runtime.install({ name: "fixture", version: "1.0.0", sha256: first.sha256, archive: first.archive });
      expect(installed.state).toBe("installed");
      expect(installed.warnings.some((warning) => warning.includes("未知清单字段：extra"))).toBe(true);
      expect(installed.warnings.some((warning) => warning.includes("技能不合规：BadName"))).toBe(true);
      expect(installed.warnings.some((warning) => warning.includes("Pi TypeScript"))).toBe(true);
      expect(installed.warnings.some((warning) => warning.includes("已跳过无效 MCP：bad"))).toBe(true);
      expect(installed.warnings.some((warning) => warning.includes("已跳过无效 MCP：skipped"))).toBe(true);
      expect(installed.warnings.some((warning) => warning.includes("技能不合规：huge"))).toBe(true);
      expect((await lstat(join(installed.root, "skipped.mjs"))).mode & 0o111).toBe(0);
      expect((await lstat(join(installed.root, "cli.mjs"))).mode & 0o111).not.toBe(0);
      expect((await lstat(join(installed.root, "server.mjs"))).mode & 0o111).not.toBe(0);
      await expect(runtime.readSkill("BadName")).rejects.toThrow(/不存在/);
      await expect(runtime.readSkill("huge")).rejects.toThrow(/不存在/);
      expect(installed.warnings.some((warning) => warning.includes("已跳过无效 MCP：configured"))).toBe(true);
      expect(installed.warnings.some((warning) => warning.includes("已跳过无效 MCP：dot"))).toBe(true);
      expect((await runtime.inspect("fixture")).mcpServers).toEqual(["fixture"]);
      expect(installed.riskyTools).toEqual(["fixture.danger"]);
      const skills = await runtime.listSkills();
      expect(skills.skills).toEqual([{ name: "greet", description: "Say hello" }]);
      const greet = skills.skills[0];
      expect(greet && Object.keys(greet).sort()).toEqual(["description", "name"]);
      const read = await runtime.readSkill("greet");
      expect(read.truncated).toBe(false);
      expect(read.content).toContain("Hello");
      const session = mcpSessionKey({ appName: "fixture", serverName: "fixture", version: "1.0.0", configDigest: mcpConfigDigest({ TOKEN: secret }) });
      expect((await runtime.launchMcp(host, "fixture", "fixture", { TOKEN: secret })).server).toBe(session);
      const tools = await host.call(session, "tools/list", {});
      expect(tools).toMatchObject({ tools: [{ name: "echo" }] });
      expect(await host.call(session, "tools/call", { name: "echo", arguments: { text: "hi" } })).toEqual({
        content: [{ type: "text", text: "hi" }],
      });
      expect(await host.call(session, "tools/call", { name: "echo", arguments: { text: "__root__" } })).toEqual({
        content: [{ type: "text", text: installed.root }],
      });
      await expect(runtime.launchMcp(host, "fixture", "bad")).rejects.toThrow(/不存在/);
      await expect(runtime.launchMcp(host, "fixture", "configured")).rejects.toThrow(/不存在/);
      await expect(runtime.launchMcp(host, "fixture", "dot")).rejects.toThrow(/不存在/);
      await expect(runtime.launchMcp(host, "fixture", "skipped")).rejects.toThrow(/不存在/);
      await expect(host.call("bad", "tools/list", {})).rejects.toThrow();
      await expect(host.call("configured", "tools/list", {})).rejects.toThrow();
      await expect(host.call("dot", "tools/list", {})).rejects.toThrow();
      expect(await runFile(join(layout.bin, "fixture-cli"), ["alpha"])).toBe("pong alpha\n");
      await writeFileSync(join(installed.dataDir, "keep.txt"), "keep");
      const saved = await runtime.saveSkill({
        name: "private-note",
        content: `---\nname: private-note\ndescription: Private\n---\ntoken=${secret}\n`,
        secrets: [secret],
      });
      expect(await readFile(saved.path, "utf8")).not.toContain(secret);
      const second = fixture("2.0.0", "Goodbye", [{ type: "exec", argv: ["./cli.mjs", "--fail"] }]);
      await expect(runtime.install({ name: "fixture", version: "2.0.0", sha256: second.sha256, archive: second.archive })).rejects.toThrow(/安装步骤失败/);
      expect(await readlink(join(layout.apps, "fixture", "current"))).toBe(`versions/${digest(Buffer.from("1.0.0"))}`);
      expect(await host.call(session, "tools/call", { name: "echo", arguments: { text: "__root__" } })).toEqual({
        content: [{ type: "text", text: installed.root }],
      });
      expect((await runtime.readSkill("greet")).content).toContain("Hello");
      expect(await readFile(join(installed.dataDir, "keep.txt"), "utf8")).toBe("keep");
      expect(existsSync(join(layout.apps, "fixture", "versions", digest(Buffer.from("2.0.0"))))).toBe(false);
      expect(existsSync(join(layout.apps, "fixture", "versions", `.incoming-${digest(Buffer.from("2.0.0"))}`))).toBe(false);
      expect(await runFile(join(layout.bin, "fixture-cli"), ["alpha"])).toBe("pong alpha\n");
      expect(await contains(join(home, ".viate"), secret)).toBe(false);
      const bigDir = join(layout.skills, "big-note");
      mkdirSync(bigDir);
      writeFileSync(join(bigDir, "SKILL.md"), `---\nname: big-note\ndescription: Big\n---\n${"x".repeat(70_000)}`);
      const big = await runtime.readSkill("big-note");
      expect(big.truncated).toBe(true);
      expect(Buffer.byteLength(big.content)).toBeLessThanOrEqual(SKILL_BYTE_LIMIT);
      const description = "d".repeat(1024);
      for (let index = 0; index < 9; index += 1) {
        await runtime.saveSkill({
          name: `n${index}`,
          content: `---\nname: n${index}\ndescription: ${description}\n---\nbody\n`,
        });
      }
      const listed = await runtime.listSkills();
      const total = listed.skills.reduce((sum, skill) => sum + Buffer.byteLength(skill.description), 0);
      expect(total).toBeLessThanOrEqual(SKILL_DESCRIPTION_BUDGET);
      expect(listed.skills.some((skill) => skill.name === "nested" || skill.name.endsWith("/nested"))).toBe(false);
    } finally {
      await host.close();
    }
  }, 20_000);

  it("keeps the old app usable when apt ran and a later setup step fails", async () => {
    const home = temp();
    const apt: string[] = [];
    const runtime = createAppRuntime({
      homeDir: home,
      runSetup: async (step) => {
        if (step.type === "apt") apt.push(...step.packages);
        if (step.type === "exec") throw new Error("user setup failed");
      },
    });
    const layout = viateLayout(home);
    const first = fixture("1.0.0", "Hello", []);
    const installed = await runtime.install({ name: "fixture", version: "1.0.0", sha256: first.sha256, archive: first.archive });
    await writeFileSync(join(installed.dataDir, "keep.txt"), "keep");
    const second = fixture("2.0.0", "Goodbye", [
      { type: "apt", packages: ["ca-certificates"] },
      { type: "exec", argv: ["./cli.mjs", "--fail"] },
    ]);
    await expect(runtime.install({ name: "fixture", version: "2.0.0", sha256: second.sha256, archive: second.archive })).rejects.toThrow(/user setup failed|安装失败/);
    expect(apt).toEqual(["ca-certificates"]);
    expect(await readlink(join(layout.apps, "fixture", "current"))).toBe(`versions/${digest(Buffer.from("1.0.0"))}`);
    expect(await readFile(join(installed.dataDir, "keep.txt"), "utf8")).toBe("keep");
    expect(await runFile(join(layout.bin, "fixture-cli"), ["alpha"])).toBe("pong alpha\n");
    expect(existsSync(join(layout.apps, "fixture", "versions", digest(Buffer.from("2.0.0"))))).toBe(false);
    expect(setupSpawnIdentity({ type: "apt" }, { uid: 1000, gid: 1000 })).toEqual({});
    expect(setupSpawnIdentity({ type: "exec" }, { uid: 1000, gid: 1000 })).toEqual({ uid: 1000, gid: 1000 });
    expect(setupSpawnIdentity({ type: "npm" }, {})).toEqual({});
  });

  it("installs a multiline skill and skips only the invalid sibling", async () => {
    const home = temp();
    const runtime = createAppRuntime({ homeDir: home });
    const markdown = [
      "---",
      "name: multi",
      "description: |",
      "  Say hello",
      "  across lines",
      "metadata:",
      "  owner: ada",
      "allowed-tools: shell_exec",
      "extra-field: kept",
      "---",
      "body",
    ].join("\n");
    const packed = packAppArchive([
      { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "skills", version: "1" })) },
      { path: "skills/multi/SKILL.md", data: Buffer.from(markdown) },
      { path: "skills/broken/SKILL.md", data: Buffer.from("---\nname: broken\ndescription: [\n---\n") },
      { path: "skills/wrong/SKILL.md", data: Buffer.from("---\nname: other\ndescription: nope\n---\n") },
      { path: "skills/long/SKILL.md", data: Buffer.from(`---\nname: long\ndescription: ${"d".repeat(1025)}\n---\n`) },
      {
        path: "ai.viate.bot/app.json",
        data: Buffer.from(JSON.stringify({
          routines: [
            { cron: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "整理收件箱" },
            { cron: "", timezone: "UTC", prompt: "no" },
          ],
        })),
      },
    ]);
    const installed = await runtime.install({ name: "skills", version: "1", sha256: packed.sha256, archive: packed.archive });
    expect(installed.routines).toEqual([{ cron: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "整理收件箱" }]);
    expect(installed.warnings).toContain("已跳过无效定时任务");
    expect(installed.warnings.filter((warning) => warning.includes("技能不合规")).sort()).toEqual([
      "技能不合规：broken",
      "技能不合规：long",
      "技能不合规：wrong",
    ]);
    const skills = await runtime.listSkills();
    expect(skills.skills).toEqual([{ name: "multi", description: "Say hello\nacross lines" }]);
  });

  it("installs two apps concurrently", async () => {
    const home = temp();
    const runtime = createAppRuntime({ homeDir: home });
    await Promise.all([installBare(runtime, "alpha"), installBare(runtime, "beta")]);
    const listed = await runtime.listApps();
    expect(listed.map((item) => item.name)).toEqual(["alpha", "beta"]);
    expect(listed.every((item) => item.state === "installed" && item.version === "1.0.0")).toBe(true);
  });

  it("accepts a content-hash version and preserves the active install on a bin conflict", async () => {
    const home = temp();
    const runtime = createAppRuntime({ homeDir: home });
    const first = fixture("1.0.0", "Hello", []);
    await runtime.install({ name: "fixture", version: first.sha256, sha256: first.sha256, archive: first.archive });
    const layout = viateLayout(home);
    writeFileSync(join(layout.bin, "occupied"), "keep");
    const second = packAppArchive([
      { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "fixture", version: "2.0.0" })) },
      { path: "ai.viate.bot/app.json", data: Buffer.from(JSON.stringify({ bin: { occupied: "./cli" } })) },
      { path: "cli", data: Buffer.from("cli") },
    ]);
    await expect(runtime.install({ name: "fixture", version: "2.0.0", sha256: second.sha256, archive: second.archive })).rejects.toThrow();
    expect(await readlink(join(layout.apps, "fixture", "current"))).toBe(`versions/${digest(Buffer.from(first.sha256))}`);
    expect(await readFile(join(layout.bin, "occupied"), "utf8")).toBe("keep");
    expect(existsSync(join(layout.apps, "fixture", "2.0.0"))).toBe(false);
  });

  it("rejects escaped archives and shell setup without treating arguments as shell text", async () => {
    const home = temp();
    const layout = viateLayout(home);
    let called = false;
    const guarded = createAppRuntime({
      homeDir: home,
      runSetup: async () => {
        called = true;
      },
    });
    const marker = join(home, "marker");
    const bash = packAppArchive([
      {
        path: "plugin.json",
        data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "evil", version: "1.0.0" })),
      },
      {
        path: "ai.viate.bot/app.json",
        data: Buffer.from(JSON.stringify({ setup: [{ type: "exec", argv: ["/bin/bash", "-c", `printf x > '${marker}'`] }] })),
      },
    ]);
    await expect(guarded.install({ name: "evil", version: "1.0.0", sha256: bash.sha256, archive: bash.archive })).rejects.toThrow(/shell/);
    expect(called).toBe(false);
    expect(existsSync(marker)).toBe(false);
    const seen: string[][] = [];
    const runtime = createAppRuntime({
      homeDir: home,
      runSetup: async (step) => {
        if (step.type === "apt") seen.push(step.packages);
        if (step.type === "exec") seen.push(step.argv);
      },
    });
    const apt = packAppArchive([
      {
        path: "plugin.json",
        data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "aptpkg", version: "1.0.0" })),
      },
      {
        path: "ai.viate.bot/app.json",
        data: Buffer.from(JSON.stringify({ setup: [{ type: "apt", packages: ["rm"] }] })),
      },
    ]);
    const arg = packAppArchive([
      {
        path: "plugin.json",
        data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "argok", version: "1.0.0" })),
      },
      {
        path: "ai.viate.bot/app.json",
        data: Buffer.from(JSON.stringify({ setup: [{ type: "exec", argv: ["./cli.mjs", "bash"] }] })),
      },
    ]);
    await runtime.install({ name: "aptpkg", version: "1.0.0", sha256: apt.sha256, archive: apt.archive });
    await runtime.install({ name: "argok", version: "1.0.0", sha256: arg.sha256, archive: arg.archive });
    expect(seen).toContainEqual(["rm"]);
    expect(seen).toContainEqual(["./cli.mjs", "bash"]);
    const escaped = tarBytes([{ name: "../escaped.txt", data: Buffer.from("pwned") }]);
    await expect(runtime.install({ name: "evil", version: "1.0.0", sha256: digest(escaped), archive: escaped })).rejects.toThrow(/越界/);
    expect(existsSync(join(home, "escaped.txt"))).toBe(false);
    const absolute = join("/tmp", `vb-abs-${process.pid}.txt`);
    junk.push(absolute);
    const absTar = tarBytes([{ name: absolute, data: Buffer.from("pwned") }]);
    await expect(runtime.install({ name: "evil", version: "1.0.0", sha256: digest(absTar), archive: absTar })).rejects.toThrow(/越界/);
    expect(existsSync(absolute)).toBe(false);
    const link = tarBytes([{ name: "link", data: Buffer.alloc(0), type: 50, link: "outside" }]);
    await expect(runtime.install({ name: "evil", version: "1.0.0", sha256: digest(link), archive: link })).rejects.toThrow(/非常规文件/);
    expect(existsSync(join(layout.apps, "evil"))).toBe(false);
    const clash = packAppArchive([
      {
        path: "plugin.json",
        data: Buffer.from(JSON.stringify({
          $schema: PLUGIN_SCHEMA,
          name: "clash",
          version: "1.0.0",
          extensions: { "ai.viate.bot": { bin: { "clash-cli": "./cli.mjs" } } },
        })),
      },
      { path: "ai.viate.bot/app.json", data: Buffer.from(JSON.stringify({ bin: { "clash-cli": "./other.mjs" } })) },
    ]);
    await expect(runtime.install({ name: "clash", version: "1.0.0", sha256: clash.sha256, archive: clash.archive })).rejects.toThrow(/扩展冲突/);
  });

  it("injects declared secrets into stdio env or the first HTTP origin only", async () => {
    const secret = "stdio-secret-value";
    const headerSecret = "header-secret-value";
    const home = temp();
    const runtime = createAppRuntime({ homeDir: home, setupTimeoutMs: 5_000 });
    const host = createMcpHost({ homeDir: home, timeoutMs: 3_000 });
    const servers: Server[] = [];
    try {
      const packed = packAppArchive([
        {
          path: "plugin.json",
          data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "secretapp", version: "not-semver", extra: true })),
        },
        {
          path: "ai.viate.bot/app.json",
          data: Buffer.from(JSON.stringify({ config: [{ key: "API_TOKEN", secret: true, env: "API_TOKEN" }] })),
        },
        {
          path: "skills/greet/SKILL.md",
          data: Buffer.from("---\nname: greet\ndescription: Say hello\n---\nHello\n"),
        },
        {
          path: "mcp.json",
          data: Buffer.from(JSON.stringify({
            $schema: MCP_SCHEMA,
            mcpServers: {
              good: { type: "stdio", command: "./server.mjs" },
              badargs: { type: "stdio", command: "./server.mjs", args: ["${config.KEY}"] },
              badenv: { type: "stdio", command: "./server.mjs", env: { TOKEN: "${OTHER}" } },
              badcwd: { type: "stdio", command: "./server.mjs", cwd: "${OTHER}" },
              expanded: { type: "stdio", command: "${PLUGIN_ROOT}" },
              templated: { type: "streamable-http", url: "http://127.0.0.1/${config.KEY}/mcp" },
              nested: { type: "stdio", command: "./server.mjs", cwd: "${PLUGIN_ROOT}/sub" },
            },
          })),
        },
        {
          path: "server.mjs",
          executable: true,
          data: Buffer.from(`#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let index = buf.indexOf("\\n");
  while (index >= 0) {
    const line = buf.slice(0, index);
    buf = buf.slice(index + 1);
    index = buf.indexOf("\\n");
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const text = msg.params && msg.params.arguments ? String(msg.params.arguments.text ?? "") : "";
    const result = msg.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "secretapp", version: "0" } }
      : msg.method === "tools/list"
        ? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: text === "__secret__" ? process.env.API_TOKEN : text }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`),
        },
      ]);
      const installed = await runtime.install({ name: "secretapp", version: "not-semver", sha256: packed.sha256, archive: packed.archive });
      expect(installed.warnings.some((warning) => warning.includes("未知清单字段：extra"))).toBe(true);
      expect(installed.warnings.some((warning) => warning.includes("已跳过无效 MCP：expanded"))).toBe(true);
      expect(installed.warnings.some((warning) => warning.includes("已跳过无效 MCP：templated"))).toBe(true);
      expect(installed.warnings.some((warning) => warning.includes("已跳过无效 MCP：nested"))).toBe(true);
      expect((await runtime.listSkills()).skills).toEqual([{ name: "greet", description: "Say hello" }]);
      const inspection = await runtime.inspect("secretapp");
      expect(inspection.mcpServers).toEqual(["good"]);
      expect(JSON.stringify(inspection)).not.toContain(secret);
      const stored = await readFile(join(installed.root, "mcp.json"), "utf8");
      expect(stored).toContain("${PLUGIN_ROOT}");
      expect(stored).toContain("${config.KEY}");
      expect(stored).not.toContain(secret);
      const session = mcpSessionKey({ appName: "secretapp", serverName: "good", version: "not-semver", configDigest: mcpConfigDigest({ API_TOKEN: secret }) });
      expect((await runtime.launchMcp(host, "secretapp", "good", { API_TOKEN: secret })).server).toBe(session);
      expect(await host.call(session, "tools/call", { name: "echo", arguments: { text: "__secret__" } })).toEqual({
        content: [{ type: "text", text: secret }],
      });
      expect(await contains(join(home, ".viate"), secret)).toBe(false);
      await expect(runtime.launchMcp(host, "secretapp", "expanded")).rejects.toThrow(/不存在/);
      await expect(runtime.launchMcp(host, "secretapp", "templated")).rejects.toThrow(/不存在/);
      await expect(runtime.launchMcp(host, "secretapp", "badargs")).rejects.toThrow(/不存在/);
      await expect(runtime.launchMcp(host, "secretapp", "badenv")).rejects.toThrow(/不存在/);
      await expect(runtime.launchMcp(host, "secretapp", "badcwd")).rejects.toThrow(/不存在/);

      const landed: { token: string; authorization: string; trace: string; url: string } = { token: "", authorization: "", trace: "", url: "" };
      const next = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { id?: unknown; method?: string };
          landed.token = String(request.headers["x-api-token"] ?? "");
          landed.authorization = String(request.headers.authorization ?? "");
          landed.trace = String(request.headers["x-trace"] ?? "");
          landed.url = request.url ?? "";
          if (message.id === undefined) {
            response.writeHead(202);
            response.end();
            return;
          }
          const result = message.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "landed", version: "0" } }
            : { ok: true };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        });
      });
      servers.push(next);
      const nextPort = await new Promise<number>((resolve) => {
        next.listen(0, "127.0.0.1", () => {
          const address = next.address();
          if (!address || typeof address === "string") throw new Error("no port");
          resolve(address.port);
        });
      });
      let firstToken = "";
      const first = createServer((request, response) => {
        request.resume();
        firstToken = String(request.headers["x-api-token"] ?? "");
        response.writeHead(302, { location: `http://127.0.0.1:${nextPort}/mcp` });
        response.end();
      });
      servers.push(first);
      const port = await new Promise<number>((resolve) => {
        first.listen(0, "127.0.0.1", () => {
          const address = first.address();
          if (!address || typeof address === "string") throw new Error("no port");
          resolve(address.port);
        });
      });
      const remote = packAppArchive([
        {
          path: "plugin.json",
          data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "headerapp", version: "1.0.0" })),
        },
        {
          path: "ai.viate.bot/app.json",
          data: Buffer.from(JSON.stringify({ config: [{ key: "API_TOKEN", secret: true, header: "X-Api-Token" }] })),
        },
        {
          path: "mcp.json",
          data: Buffer.from(JSON.stringify({
            $schema: MCP_SCHEMA,
            mcpServers: {
              remote: {
                type: "streamable-http",
                url: `http://127.0.0.1:${port}/mcp`,
                headers: { "X-Trace": "kept", Authorization: "Bearer literal-token" },
              },
            },
          })),
        },
      ]);
      const headerInstall = await runtime.install({ name: "headerapp", version: "1.0.0", sha256: remote.sha256, archive: remote.archive });
      expect((await runtime.launchMcp(host, "headerapp", "remote", undefined, { "X-Api-Token": headerSecret })).server).toBe(mcpSessionKey({ appName: "headerapp", serverName: "remote", version: "1.0.0", configDigest: mcpConfigDigest(undefined, { "X-Api-Token": headerSecret }) }));
      expect(firstToken).toBe(headerSecret);
      expect(landed.token).toBe("");
      expect(landed.authorization).toBe("");
      expect(landed.trace).toBe("kept");
      expect(landed.url).not.toContain(headerSecret);
      expect(await readFile(join(headerInstall.root, "mcp.json"), "utf8")).not.toContain(headerSecret);
      expect(await contains(join(home, ".viate"), headerSecret)).toBe(false);
      expect(JSON.stringify(await runtime.inspect("headerapp"))).not.toContain(headerSecret);
    } finally {
      await host.close();
      await Promise.all(servers.map(async (server) => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }));
    }
  }, 20_000);
});

async function installBare(runtime: AppRuntime, name: string): Promise<void> {
  const packed = packAppArchive([
    {
      path: "plugin.json",
      data: Buffer.from(JSON.stringify({ $schema: PLUGIN_SCHEMA, name, version: "1.0.0" })),
    },
  ]);
  await runtime.install({ name, version: "1.0.0", sha256: packed.sha256, archive: packed.archive });
}

