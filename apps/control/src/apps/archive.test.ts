import { describe, expect, it } from "vitest";
import { crc32 } from "node:zlib";
import { readTar, validatePackage, wrapMcpUrl, wrapMcpb, wrapSkill } from "./archive.js";

describe("app archives", () => {
  it("normalizes and hashes a skill package", () => {
    const app = wrapSkill("demo", [{ path: "SKILL.md", data: Buffer.from("---\nname: demo\ndescription: Example\n---\nInstructions") }]);
    expect(app.skills).toEqual(["demo"]);
    expect(app.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readTar(app.archive).map(f => f.path)).toEqual(["plugin.json", "skills/demo/SKILL.md"]);
  });

  it("rejects paths escaping the package", () => {
    expect(() => validatePackage([{ path: "../plugin.json", data: Buffer.from("{}") }])).toThrow(/escape/);
  });

  it("rejects symlinks in tar archives", () => {
    const header = Buffer.alloc(512);
    header.write("link", 0);
    header.write("0000000\0", 124);
    header.fill(32, 148, 156);
    header[156] = 50;
    const checksum = header.reduce((sum, b) => sum + b, 0);
    header.write(checksum.toString(8).padStart(7, "0") + "\0", 148);
    expect(() => readTar(Buffer.concat([header, Buffer.alloc(1024)]))).toThrow(/Unsupported tar entry/);
  });

  it("rejects non-loopback insecure MCP URLs", () => {
    expect(() => wrapMcpUrl("demo", "http://example.org/mcp")).toThrow();
    expect(wrapMcpUrl("demo", "https://example.org/mcp").servers.demo).toEqual({ type: "streamable-http", url: "https://example.org/mcp" });
  });

  it("rejects a known extension field with the wrong type and still ignores a non-object extensions value", () => {
    const manifest = (extensions: unknown) => ({
      path: "plugin.json",
      data: Buffer.from(JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "demo",
        extensions,
      })),
    });
    expect(() => validatePackage([manifest({ "ai.viate.bot": { bin: 1 } })])).toThrow(/Invalid app bin/);
    expect(() => validatePackage([manifest({ "ai.viate.bot": { riskyTools: "shell_exec" } })])).toThrow(/Invalid risky tools/);
    expect(() => validatePackage([manifest({ "ai.viate.bot": { routines: {} } })])).toThrow(/Invalid routines/);
    const ignored = validatePackage([manifest([])]);
    expect(ignored.warnings).toContain("Invalid extensions ignored");
    expect(ignored.extension).toEqual({});
  });

  it("keeps valid components while skipping invalid servers and unknown manifest fields", () => {
    const file = (path: string, value: unknown) => ({ path, data: Buffer.from(JSON.stringify(value)) });
    const app = validatePackage([
      file("plugin.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "demo", version: "rolling release", extra: true }),
      { path: "skills/demo/SKILL.md", data: Buffer.from("---\nname: demo\ndescription: Example\n---\nInstructions") },
      file("mcp.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {
        good: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.js"] },
        command: { type: "stdio", command: "${PLUGIN_ROOT}/server" },
        url: { type: "streamable-http", url: "https://example.org/${config.KEY}" },
        args: { type: "stdio", command: "node", args: ["${OTHER}"] },
      } }),
    ]);
    expect(app.manifest.version).toBe("rolling release");
    expect(app.manifest).not.toHaveProperty("extra");
    expect(app.warnings.join(" ")).toContain("extra");
    expect(app.skills).toEqual(["demo"]);
    expect(Object.keys(app.servers)).toEqual(["good"]);
    expect(app.warnings.join(" ")).toContain("ValidationError");
  });

  it("parses multiline skill frontmatter and skips only the invalid skill", () => {
    const markdown = [
      "---",
      "name: demo",
      "description: |",
      "  Say hello",
      "  across lines",
      "metadata:",
      "  owner: ada",
      "allowed-tools: shell_exec",
      "license: MIT",
      "extra-field: kept",
      "---",
      "body",
    ].join("\n");
    const app = validatePackage([
      { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "demo" })) },
      { path: "skills/demo/SKILL.md", data: Buffer.from(markdown) },
      { path: "skills/broken/SKILL.md", data: Buffer.from("---\nname: broken\ndescription: [\n---\n") },
      { path: "skills/wrong/SKILL.md", data: Buffer.from("---\nname: other\ndescription: nope\n---\n") },
      { path: "skills/long/SKILL.md", data: Buffer.from(`---\nname: long\ndescription: ${"d".repeat(1025)}\n---\n`) },
      { path: "skills/huge/SKILL.md", data: Buffer.from(`---\nname: huge\ndescription: Huge\n---\n${"x".repeat(70_000)}`) },
    ]);
    expect(app.skills).toEqual(["demo"]);
    expect(app.warnings.join(" ")).toContain("Invalid skill: broken");
    expect(app.warnings.join(" ")).toContain("Invalid skill: wrong");
    expect(app.warnings.join(" ")).toContain("Invalid skill: long");
    expect(app.warnings.join(" ")).toContain("Invalid skill: huge");
    const stored = readTar(app.archive).find((file) => file.path === "skills/demo/SKILL.md")?.data.toString("utf8") ?? "";
    expect(stored).toContain("across lines");
    expect(stored).toContain("extra-field: kept");
  });

  it("wraps an MCPB stdio server and a secret user config", () => {
    const manifest = {
      name: "demo",
      manifest_version: "0.2",
      version: "1.0.0",
      description: "Example",
      author: { name: "Ada" },
      user_config: { token: { sensitive: true } },
      server: { mcp_config: { command: "node", args: ["${__dirname}/server.js"], env: { TOKEN: "${user_config.token}" } } },
    };
    const packed = wrapMcpb(zipStored([{ path: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }]));
    expect(packed.servers.demo).toEqual({ type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.js"] });
    expect(packed.extension.config).toEqual([{ key: "TOKEN", secret: true, env: "TOKEN" }]);
  });
});

function zipStored(files: Array<{ path: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path);
    const checksum = crc32(file.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, file.data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + file.data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
