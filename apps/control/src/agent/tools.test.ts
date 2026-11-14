import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MachinedClient } from "../machines/client.js";
import { machineTools } from "./tools.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function machined(onRequest: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const hits: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    hits.push(`${req.url ?? ""} ${body}`);
    onRequest(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  servers.push({
    close: () => new Promise((resolve) => server.close(() => resolve())),
  });
  return { hits, port: address.port };
}

function execSse(stdout: string): void {
  // placeholder so the helper below stays local
  void stdout;
}

describe("machine tools", () => {
  it("sends the command only to the bound machine", async () => {
    const a = await machined((req, res) => {
      expect(req.headers.authorization).toBe("Bearer token-a");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "stdout", data: "from-a\n" })}\n\ndata: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
    });
    const b = await machined((_req, res) => {
      res.writeHead(200);
      res.end("no");
    });
    const [shell] = machineTools(new MachinedClient({ host: "127.0.0.1", port: a.port, token: "token-a" }));
    if (!shell) throw new Error("missing shell");
    const result = await shell.execute("call-1", { cmd: `curl http://127.0.0.1:${b.port}/secret` });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(result.content)).toContain("from-a");
    expect(a.hits).toHaveLength(1);
    expect(a.hits[0]).toContain(`127.0.0.1:${b.port}`);
    expect(b.hits).toHaveLength(0);
    void execSse;
  });

  it("keeps only the head and tail of a huge command output and caps reads", async () => {
    const huge = "x".repeat(100_000);
    const machine = await machined((_req, res, body) => {
      const parsed = JSON.parse(body) as { path?: string; maxBytes?: number };
      if (parsed.path) {
        expect(parsed.maxBytes).toBe(65_536);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: parsed.path, content: huge, truncated: true }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ type: "stdout", data: huge })}\n\ndata: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`,
      );
    });
    const tools = machineTools(new MachinedClient({ host: "127.0.0.1", port: machine.port, token: "token-a" }));
    const shell = tools.find((tool) => tool.name === "shell_exec");
    const read = tools.find((tool) => tool.name === "fs_read");
    if (!shell || !read) throw new Error("missing tools");
    const ran = await shell.execute("call-1", { cmd: "yes" });
    const text = ran.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    expect(text.length).toBeLessThan(20_000);
    expect(text).toContain("截断");
    const file = await read.execute("call-2", { path: "/home/bot/a.txt", maxBytes: 10_000_000 });
    const fileText = file.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    expect(fileText.length).toBeLessThan(70_000);
    expect(fileText).toContain("截断");
  });
});
