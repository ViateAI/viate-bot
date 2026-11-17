import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTar } from "./archive.js";
// The linker runs on the machine as plain JavaScript, so it has no TypeScript types.
// @ts-expect-error machine script
import { inferLaunchBin, linkInstalled, npmBinMap } from "./link-mcp.mjs";
import { buildRegistryPackage, buildRemotePackage, PackageCommandError } from "./package-command.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("package launch command", () => {
  it("executes the packaged setup linker and installed MCP without a shell or registry", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-link-exec-"));
    dirs.push(root);
    const data = join(root, "data");
    const pkg = buildRegistryPackage({ appName: "demo", ecosystem: "npm", packageName: "demo", version: "1.2.3" });
    for (const file of readTar(pkg.archive)) {
      const path = join(root, file.path);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, file.data, { mode: file.executable ? 0o755 : 0o644 });
    }
    mkdirSync(join(data, "node_modules", "demo"), { recursive: true });
    mkdirSync(join(data, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(data, "node_modules", "demo", "package.json"), JSON.stringify({ version: "1.2.3", bin: { demo: "index.js" } }));
    writeFileSync(join(data, "node_modules", ".bin", "demo"), `#!${process.execPath}\nconsole.log(process.argv.slice(2).join('|'));`, { mode: 0o755 });
    const env = { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data };
    execFileSync(join(root, "bin", "link.mjs"), [], { env });
    expect(execFileSync(join(root, "bin", "mcp"), ["--flag", "two words"], { env, encoding: "utf8" }).trim()).toBe("--flag|two words");
  });

  it("launches the per-app pip copy rather than another app's shared executable", () => {
    const home = mkdtempSync(join(tmpdir(), "vb-pip-isolation-"));
    dirs.push(home);
    const data = join(home, "app-data");
    for (const [base, version] of [[join(home, ".local"), "9.0.0"], [join(data, "python"), "1.2.3"]] as const) {
      const dist = join(base, "lib", "python3.12", "site-packages", `demo-${version}.dist-info`);
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "METADATA"), `Name: demo\nVersion: ${version}\n`);
      writeFileSync(join(dist, "entry_points.txt"), "[console_scripts]\ndemo = demo:main\n");
      mkdirSync(join(base, "bin"), { recursive: true });
      writeFileSync(join(base, "bin", "demo"), `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});`, { mode: 0o755 });
    }
    const root = join(home, "plugin");
    expect(linkInstalled({ ecosystem: "pip", packageName: "demo" }, { PLUGIN_DATA: data, HOME: home }, root)).toEqual({ bin: "demo", version: "1.2.3" });
    expect(execFileSync(join(root, "bin", "mcp"), [], { env: { ...process.env, HOME: home, PLUGIN_DATA: data }, encoding: "utf8" }).trim()).toBe("1.2.3");
  });

  it.each(["--registry", "-e", "../pkg", "pkg/../../evil", "https://evil.example/pkg"])("rejects option or non-registry package %s", (packageName) => {
    expect(() => buildRegistryPackage({ appName: "safe", ecosystem: "npm", packageName, version: "1.2.3" })).toThrow(PackageCommandError);
  });

  it("infers a single bin, a name match, and refuses npx or an ambiguous package", () => {
    expect(inferLaunchBin({ packageName: "@modelcontextprotocol/server-everything", bins: { "mcp-server-everything": "dist/index.js" } })).toEqual({ bin: "mcp-server-everything" });
    expect(inferLaunchBin({ packageName: "left-pad", bins: { "left-pad": "bin.js", pad: "pad.js" } })).toEqual({ bin: "left-pad" });
    expect(inferLaunchBin({ packageName: "left-pad", command: "pad", bins: { "left-pad": "bin.js", pad: "pad.js" } })).toEqual({ bin: "pad" });
    expect(inferLaunchBin({ packageName: "left-pad", command: "npx", bins: { npx: "x" } }).error).toMatch(/npx/);
    expect(inferLaunchBin({ packageName: "tools", bins: { one: "a", two: "b" } }).error).toMatch(/候选：one, two/);
    expect(inferLaunchBin({ packageName: "tools", bins: {} }).error).toMatch(/显式给出 command/);
    expect(npmBinMap({ bin: "./dist/index.js" }, "@scope/server-everything")).toEqual({ "server-everything": "./dist/index.js" });
  });

  it("links the installed npm or pip executable and records the resolved version", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-link-"));
    dirs.push(root);
    const data = join(root, "data");
    mkdirSync(join(data, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(data, "node_modules", "left-pad", "package.json"), JSON.stringify({ name: "left-pad", version: "1.2.3", bin: { "left-pad": "index.js" } }));
    const npm = linkInstalled({ ecosystem: "npm", packageName: "left-pad" }, { PLUGIN_DATA: data, HOME: root }, root);
    expect(npm).toEqual({ bin: "left-pad", version: "1.2.3" });
    expect(readFileSync(join(data, "resolved-version"), "utf8")).toBe("1.2.3\n");
    expect(readFileSync(join(root, "bin", "mcp"), "utf8")).toContain("left-pad");
    expect(readFileSync(join(root, "bin", "mcp"), "utf8")).not.toContain("npx");

    const home = join(root, "pyhome");
    const dist = join(data, "python", "lib", "python3.12", "site-packages", "demo-1.4.0.dist-info");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "METADATA"), "Name: Demo_Tool\nVersion: 1.4.0\n");
    writeFileSync(join(dist, "entry_points.txt"), "[console_scripts]\ndemo-tool = demo:main\n");
    const pip = linkInstalled({ ecosystem: "pip", packageName: "demo-tool" }, { PLUGIN_DATA: data, HOME: home }, root);
    expect(pip).toEqual({ bin: "demo-tool", version: "1.4.0" });
  });

  it("builds a registry package whose launch command is the installed shim", () => {
    const pkg = buildRegistryPackage({
      appName: "pad",
      ecosystem: "npm",
      packageName: "left-pad",
      version: "1.2.3",
      config: [{ key: "API_TOKEN", secret: true }],
    });
    const files = readTar(pkg.archive);
    const mcp = JSON.parse(files.find((file) => file.path === "mcp.json")?.data.toString("utf8") ?? "{}") as { mcpServers: { pad: { command: string } } };
    expect(mcp.mcpServers.pad.command).toBe("./bin/mcp");
    const extension = JSON.parse(files.find((file) => file.path === "ai.viate.bot/app.json")?.data.toString("utf8") ?? "{}") as { setup: Array<{ type: string; packages?: string[] }> };
    expect(extension.setup[0]).toEqual({ type: "npm", packages: ["left-pad@1.2.3"] });
    expect(extension.setup[1]).toEqual({ type: "exec", argv: ["./bin/link.mjs"] });
    expect(() => buildRegistryPackage({ appName: "pad", ecosystem: "npm", packageName: "left-pad", version: "1.2.3", command: "npx" })).toThrow(PackageCommandError);
    const remote = buildRemotePackage({ appName: "far", url: "https://example.com/mcp", headers: [] });
    const remoteMcp = JSON.parse(readTar(remote.archive).find((file) => file.path === "mcp.json")?.data.toString("utf8") ?? "{}") as { mcpServers: { far: { url: string } } };
    expect(remoteMcp.mcpServers.far.url).toBe("https://example.com/mcp");
    expect(() => buildRemotePackage({ appName: "far", url: "http://192.168.1.8/mcp", headers: [] })).toThrow(/https/);
  });
});
