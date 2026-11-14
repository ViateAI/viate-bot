import { describe, expect, it } from "vitest";
import { loadConfig, requireOidc, requireServiceCredentials, requireSharedModelKey } from "./config.js";

describe("loadConfig", () => {
  it("uses documented defaults when optional variables are absent", () => {
    const config = loadConfig({});
    expect(config.dataDir).toBe("/data");
    expect(config.machineImage).toBe("viate-bot/machine:dev");
    expect(config.idleStopMinutes).toBe(120);
    expect(config.maxRunningTasks).toBe(20);
    expect(config.secretKeyPath).toBe("/data/secret.key");
    expect(config.adminEmails).toEqual([]);
    expect(config.dev).toBe(false);
    expect(config.integration).toBe("none");
    expect(config.allowSignup).toBe(false);
    expect(config.oidcIssuer).toBe("");
    expect(config.modelBaseUrl).toBe("");
    expect(config.serviceCredentials).toBeUndefined();
  });

  it("rejects a non-integer idle timeout", () => {
    expect(() => loadConfig({ VB_IDLE_STOP_MINUTES: "soon" })).toThrow(/VB_IDLE_STOP_MINUTES/);
  });

  it("parses the admin email list", () => {
    const config = loadConfig({ VB_ADMIN_EMAILS: " A@Example.com, b@example.com " });
    expect(config.adminEmails).toEqual(["a@example.com", "b@example.com"]);
  });

  it("ignores service credentials unless integration is viate", () => {
    const config = loadConfig({
      VB_VIATE_URL: "https://example.test",
      VB_VIATE_CLIENT_ID: "id",
      VB_VIATE_CLIENT_SECRET: "secret",
    });
    expect(config.integration).toBe("none");
    expect(config.serviceCredentials).toBeUndefined();
    expect(() => requireServiceCredentials(config)).toThrow(/VB_INTEGRATION=viate/);
  });

  it("reads service credentials for viate integration without failing when they are empty", () => {
    const config = loadConfig({ VB_INTEGRATION: "viate" });
    expect(config.serviceCredentials).toEqual({ url: "", clientId: "", clientSecret: "" });
    expect(() => requireServiceCredentials(config)).toThrow(/VB_VIATE_URL/);
  });

  it("checks OIDC and the shared model key only when those features are used", () => {
    const empty = loadConfig({});
    expect(() => requireOidc(empty)).toThrow(/VB_OIDC_ISSUER/);
    expect(() => requireSharedModelKey(empty)).toThrow(/VB_MODEL_API_KEY/);
    const ready = loadConfig({
      VB_OIDC_ISSUER: "https://idp.example",
      VB_OIDC_CLIENT_ID: "bot",
      VB_OIDC_CLIENT_SECRET: "secret",
      VB_MODEL_API_KEY: "key",
      VB_ALLOW_SIGNUP: "true",
    });
    expect(requireOidc(ready)).toEqual({
      issuer: "https://idp.example",
      clientId: "bot",
      clientSecret: "secret",
    });
    expect(requireSharedModelKey(ready)).toBe("key");
    expect(ready.allowSignup).toBe(true);
  });

  it("rejects an unknown integration name", () => {
    expect(() => loadConfig({ VB_INTEGRATION: "other" })).toThrow(/VB_INTEGRATION/);
  });
});
