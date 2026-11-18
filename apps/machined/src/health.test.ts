import { describe, expect, it } from "vitest";
import { MACHINE_PROTOCOL_VERSION } from "@viate-bot/protocol";
import { buildServer } from "./server.js";

describe("machine protocol health", () => {
  it("reports the implemented protocol even when an environment override claims another version", async () => {
    const previous = process.env.VB_MACHINE_PROTOCOL;
    process.env.VB_MACHINE_PROTOCOL = "2";
    const app = buildServer({ token: "test-token", protocol: 2 } as Parameters<typeof buildServer>[0]);
    try {
      const health = await app.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: "Bearer test-token" },
      });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: true, protocol: MACHINE_PROTOCOL_VERSION });
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.VB_MACHINE_PROTOCOL;
      else process.env.VB_MACHINE_PROTOCOL = previous;
    }
  });
});
