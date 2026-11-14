import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createViateIntegration, type ViateIntegration } from "./index.js";

interface KeyRecord {
  id: string;
  userId: string;
  channelId: string;
  externalRef: string;
  secret: string;
}

describe("viate service client", () => {
  const keys = new Map<string, KeyRecord>();
  let tokenCalls = 0;
  let app: ReturnType<typeof Fastify>;
  let viate: ViateIntegration;
  let now = 1_000_000;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
      done(null, JSON.parse(body as string));
    });
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    app.post("/oauth/token", async (request) => {
      tokenCalls += 1;
      const body = request.body as Record<string, string>;
      expect(body.grant_type).toBe("client_credentials");
      expect(body.scope).toBe("users:read channels:read keys:write usage:read");
      expect(body.client_id).toBe("service");
      expect(body.client_secret).toBe("secret");
      return { access_token: `token-${tokenCalls}`, expires_in: 3600, token_type: "Bearer" };
    });

    app.get("/api/service/users", async (request) => {
      expect(request.headers.authorization).toBe(`Bearer token-${tokenCalls}`);
      const cursor = (request.query as { cursor?: string }).cursor;
      if (cursor === "page-2") return { users: [], nextCursor: null };
      return {
        users: [{ id: "user-1", email: "ada@example.com", name: "Ada", status: "active", createdAt: "2026-01-01T00:00:00.000Z" }],
        nextCursor: "page-2",
      };
    });

    app.get("/api/service/users/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (id === "missing") return reply.code(404).send({ error: { message: "user not found", type: "viate_error" } });
      if (id === "off") return { id, email: "off@example.com", name: "Off", status: "disabled" };
      return { id, email: "ada@example.com", name: "Ada", status: "active" };
    });

    app.get("/api/service/users/:id/channels", async () => ({ channels: [{ id: "channel-1", name: "Default" }] }));

    app.post("/api/service/users/:id/keys", async (request, reply) => {
      const body = request.body as { name: string; channelId: string; kind: string; externalRef: string };
      if (body.kind !== "bot" || body.name !== "bot:Helper" || body.externalRef !== "bot-1" || body.channelId !== "channel-1") {
        return reply.code(400).send({ error: { message: "bad key request", type: "viate_error" } });
      }
      const id = "key-1";
      keys.set(id, { id, userId: (request.params as { id: string }).id, channelId: body.channelId, externalRef: body.externalRef, secret: "sk-secret" });
      return { id, prefix: "sk", key: "sk-secret", name: body.name, channelId: body.channelId, kind: "bot", externalRef: body.externalRef, createdAt: "2026-01-01T00:00:00.000Z" };
    });

    app.get("/api/service/keys", async (request) => {
      const kind = (request.query as { kind?: string }).kind;
      const apiKeys = [...keys.values()]
        .filter((key) => kind === undefined || kind === "bot")
        .map((key) => ({ id: key.id, name: "bot:Helper", prefix: "sk", createdAt: "2026-01-01T00:00:00.000Z", userId: key.userId, channelId: key.channelId, kind: "bot", externalRef: key.externalRef }));
      return { apiKeys };
    });

    app.delete("/api/service/keys/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!keys.delete(id)) return reply.code(404).send({ error: { message: "not found", type: "viate_error" } });
      return { ok: true };
    });

    app.get("/api/service/usage", async (request) => {
      const query = request.query as { keyIds?: string; granularity?: string };
      expect(query.granularity).toBe("hour");
      expect(query.keyIds).toBe("key-1");
      return {
        buckets: [
          {
            keyId: "key-1",
            bucket: "2026-11-13T10:00:00.000Z",
            requests: 2,
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheWriteTokens: 1,
            costUsd: "0.010000",
          },
        ],
      };
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    viate = createViateIntegration({
      url: `http://127.0.0.1:${address.port}`,
      clientId: "service",
      clientSecret: "secret",
      now: () => now,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("caches the service token until five minutes before expiry", async () => {
    const first = await viate.directory.listUsers();
    expect(first.users).toEqual([{ subject: "user-1", email: "ada@example.com", name: "Ada", status: "active" }]);
    expect(first.nextCursor).toBe("page-2");
    const calls = tokenCalls;
    await viate.directory.listUsers("page-2");
    expect(tokenCalls).toBe(calls);
    now += 3600 * 1000 - 4 * 60 * 1000;
    await viate.directory.userStatus({ subject: "user-1" });
    expect(tokenCalls).toBe(calls + 1);
    expect(await viate.directory.userStatus({ subject: "off" })).toBe("disabled");
    expect(await viate.directory.userStatus({ subject: "missing" })).toBe("unknown");
  });

  it("issues, bills, revokes, and reconciles bot keys", async () => {
    const issued = await viate.credentials.issue({ id: "bot-1", name: "Helper", userId: "local-1", subject: "user-1" });
    expect(issued).toMatchObject({ provider: "viate", externalId: "key-1", secret: "sk-secret", policyRef: "channel-1", shared: false });
    const usage = await viate.pullUsage(
      [{ externalId: "key-1", botId: "bot-1", userId: "local-1" }],
      "2026-11-13T00:00:00.000Z",
      "2026-11-14T00:00:00.000Z",
    );
    expect(usage).toEqual([
      {
        botId: "bot-1",
        userId: "local-1",
        model: "",
        hour: "2026-11-13T10:00:00.000Z",
        requests: 2,
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 1,
        costUsd: "0.010000",
        costSource: "viate",
      },
    ]);
    keys.set("orphan", { id: "orphan", userId: "user-1", channelId: "channel-1", externalRef: "gone", secret: "x" });
    const revoked = await viate.reconcile((botId) => botId === "bot-1");
    expect(revoked).toEqual(["orphan"]);
    expect(keys.has("key-1")).toBe(true);
    await viate.credentials.revoke({ provider: "viate", externalId: "key-1", shared: false });
    expect(keys.has("key-1")).toBe(false);
    await expect(viate.credentials.issue({ id: "bot-2", name: "Helper", userId: "local-1", subject: null })).rejects.toThrow(/viate 身份/);
  });
});
