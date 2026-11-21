import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { skillMachine } from "../agent/skill-tools.js";
import { machineTools } from "../agent/tools.js";
import { MachinedClient } from "./client.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function listen(onRequest: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const hits: Array<{ url: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    hits.push({ url: req.url ?? "", body });
    onRequest(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  servers.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  return { hits, port: address.port };
}

describe("internal machine calls stay confined", () => {
  it("sends confine true unless the caller passes false", async () => {
    const machine = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: "/home/bot/a", content: "ok", truncated: false, entries: [], bytes: 1 }));
    });
    const seen: Array<{ url: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      if (url.endsWith("/exec")) {
        return new Response(`data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/fs/pack")) return new Response(Buffer.from("tar"), { status: 200 });
      return new Response(JSON.stringify({ path: "/tmp/a", entries: [], content: "", truncated: false, bytes: 0, hits: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new MachinedClient({ host: "127.0.0.1", port: machine.port, token: "token" }, fetchImpl);
    await client.read("/home/bot/a.txt", 32);
    await client.exec({ cmd: "true" });
    await client.upload("/home/bot/uploads/m/a.txt", Readable.from([Buffer.from("hi")]), "deliv1");
    expect(JSON.parse(seen[0]?.body ?? "{}").confine).toBe(true);
    expect(JSON.parse(seen[1]?.body ?? "{}").confine).toBe(true);
    expect(seen[2]?.url).toContain("confine=true");

    seen.splice(0);
    await client.read("/etc/hosts", 32, undefined, undefined, false);
    await client.write("/etc/hosts", "x", undefined, false);
    await client.list("/etc", undefined, false);
    await client.search("/etc", "root", 10, undefined, false);
    await client.removeFile("/etc/hosts", undefined, false);
    await client.pack("/etc", undefined, false);
    await client.exec({ cmd: "true", cwd: "/etc", confine: false });
    for (const hit of seen) {
      if (hit.url.includes("/fs/pack") || hit.url.includes("/fs/")) {
        expect(JSON.parse(hit.body).confine, hit.url).toBe(false);
      }
    }
    expect(JSON.parse(seen.at(-1)?.body ?? "{}").confine).toBe(false);

    const skill = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: "/home/bot/.viate/skills", entries: [] }));
    });
    const skillClient = new MachinedClient({ host: "127.0.0.1", port: skill.port, token: "token" });
    await skillMachine(skillClient).listSkills();
    expect(skill.hits.length).toBeGreaterThan(0);
    for (const hit of skill.hits) expect(JSON.parse(hit.body).confine).toBe(true);
  });

  it("forwards confinePolicy for user file tools and leaves it off internal calls", async () => {
    const policy = { allow: ["/work"], deny: ["/work/secret"] };
    const seen: Array<{ url: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      if (url.endsWith("/exec")) {
        return new Response(`data: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.includes("/fs/pack")) return new Response(Buffer.from("tar"), { status: 200 });
      return new Response(JSON.stringify({ path: "/tmp/a", entries: [], content: "", truncated: false, bytes: 0, hits: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new MachinedClient({ host: "127.0.0.1", port: 9, token: "token" }, fetchImpl);
    const tools = machineTools(client, {
      confined: true,
      confineNow: () => true,
      confinePolicyNow: () => policy,
    });
    const shell = tools.find((tool) => tool.name === "shell_exec");
    const read = tools.find((tool) => tool.name === "fs_read");
    const write = tools.find((tool) => tool.name === "fs_write");
    const list = tools.find((tool) => tool.name === "fs_list");
    const search = tools.find((tool) => tool.name === "fs_search");
    if (!shell || !read || !write || !list || !search) throw new Error("missing tools");
    await shell.execute("call-shell", { cmd: "true", cwd: "/work" });
    await read.execute("call-read", { path: "/work/a.txt" });
    await write.execute("call-write", { path: "/work/a.txt", content: "x" });
    await list.execute("call-list", { path: "/work" });
    await search.execute("call-search", { path: "/work", pattern: "a" });
    expect(seen).toHaveLength(5);
    for (const hit of seen) {
      expect(JSON.parse(hit.body).confine).toBe(true);
      expect(JSON.parse(hit.body).confinePolicy).toEqual(policy);
    }

    seen.splice(0);
    await client.read("/home/bot/a.txt", 32);
    await client.write("/home/bot/a.txt", "x");
    await client.list("/home/bot");
    await client.search("/home/bot", "a", 10);
    await client.pack("/home/bot");
    await client.exec({ cmd: "true" });
    await client.upload("/home/bot/uploads/m/a.txt", Readable.from([Buffer.from("hi")]), "deliv1");
    for (const hit of seen) {
      expect(hit.url.includes("confinePolicy") || hit.body.includes("confinePolicy"), hit.url).toBe(false);
      if (!hit.url.includes("/fs/upload")) expect(JSON.parse(hit.body).confine).toBe(true);
    }
    expect(seen.at(-1)?.url).toContain("confine=true");
  });
});
