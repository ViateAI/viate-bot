import { describe, expect, it } from "vitest";
import { MachinedClient } from "./client.js";

describe("MachinedClient.download", () => {
  it("returns the file bytes and throws the machine error", async () => {
    const seen: Array<{ path: string; maxBytes: number; confine: boolean; confinePolicy?: { allow: string[]; deny: string[] } }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        path: string;
        maxBytes: number;
        confine: boolean;
        confinePolicy?: { allow: string[]; deny: string[] };
      };
      seen.push(body);
      if (body.path === "/missing") {
        return new Response(JSON.stringify({ error: "文件不存在" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (body.path === "/empty") return new Response(null, { status: 200 });
      return new Response(Buffer.from("png-bytes"), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    };
    const client = new MachinedClient({ host: "127.0.0.1", port: 9, token: "token" }, fetchImpl);
    const policy = { allow: ["/tmp"], deny: [] };
    const stream = await client.download("/tmp/a.png", 25 * 1024 * 1024, undefined, true, policy);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("png-bytes");
    expect(seen[0]).toEqual({
      path: "/tmp/a.png",
      maxBytes: 25 * 1024 * 1024,
      confine: true,
      confinePolicy: policy,
    });

    const empty = await client.download("/empty", 1);
    const emptyChunks: Buffer[] = [];
    for await (const chunk of empty) emptyChunks.push(Buffer.from(chunk));
    expect(Buffer.concat(emptyChunks).length).toBe(0);

    await expect(client.download("/missing", 10)).rejects.toThrow("文件不存在");
  });
});
