import { describe, expect, it } from "vitest";
import { loadConfig, requireOidc, requireServiceCredentials, requireSharedModelKey } from "./config.js";

describe("loadConfig", () => {
  it("accepts only literal IP addresses for machine DNS", () => {
    expect(loadConfig({}).machineDns).toEqual([]);
    expect(loadConfig({ VB_MACHINE_DNS: "223.5.5.5, 2606:4700:4700::1111" }).machineDns).toEqual(["223.5.5.5", "2606:4700:4700::1111"]);
    for (const value of ["dns.example", "1.1.1.1,,8.8.8.8", "1.2.3.999", "[::1]", "fe80::1%eth0", "1.1.1.1/32"]) {
      expect(() => loadConfig({ VB_MACHINE_DNS: value }), value).toThrow(/VB_MACHINE_DNS/);
    }
  });

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
    expect(config.oidcTrustEmail).toBe(false);
    expect(config.oidcIssuer).toBe("");
    expect(config.modelBaseUrl).toBe("");
    expect(config.serviceCredentials).toBeUndefined();
    expect(config.desktopDownloadUrl).toBe("");
  });

  it("accepts an http(s) desktop download url and rejects anything else", () => {
    expect(loadConfig({ VB_DESKTOP_DOWNLOAD_URL: " https://example.test/viate-bot.zip " }).desktopDownloadUrl).toBe("https://example.test/viate-bot.zip");
    expect(() => loadConfig({ VB_DESKTOP_DOWNLOAD_URL: "ftp://example.test/a" })).toThrow(/VB_DESKTOP_DOWNLOAD_URL/);
    expect(() => loadConfig({ VB_DESKTOP_DOWNLOAD_URL: "not a url" })).toThrow(/VB_DESKTOP_DOWNLOAD_URL/);
    expect(() => loadConfig({ VB_DESKTOP_DOWNLOAD_URL: "https://user:pass@example.test/a" })).toThrow(/VB_DESKTOP_DOWNLOAD_URL/);
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
      VB_OIDC_TRUST_EMAIL: "true",
    });
    expect(requireOidc(ready)).toEqual({
      issuer: "https://idp.example",
      clientId: "bot",
      clientSecret: "secret",
    });
    expect(requireSharedModelKey(ready)).toBe("key");
    expect(ready.allowSignup).toBe(true);
    expect(ready.oidcTrustEmail).toBe(true);
  });

  it("rejects an invalid email trust flag", () => {
    expect(() => loadConfig({ VB_OIDC_TRUST_EMAIL: "yes" })).toThrow(/VB_OIDC_TRUST_EMAIL/);
  });

  it("rejects an unknown integration name", () => {
    expect(() => loadConfig({ VB_INTEGRATION: "other" })).toThrow(/VB_INTEGRATION/);
  });

  it("defaults the model gateway and rejects bad values", () => {
    const config = loadConfig({});
    expect(config.modelApi).toBe("openai-completions");
    expect(config.models).toEqual([]);
    expect(config.modelMaxTokens).toBe(4096);
    expect(config.summaryMaxTokens).toBe(2_000);
    expect(config.taskTokenBudget).toBe(100_000);
    expect(config.defaultMaxBots).toBe(5);
    expect(config.defaultMaxConcurrentTasks).toBe(2);
    const custom = loadConfig({
      VB_MODEL_API: "openai-responses",
      VB_MODELS: " a, b ",
      VB_MODEL_MAX_TOKENS: "128",
      VB_TASK_TOKEN_BUDGET: "10",
      VB_DEFAULT_MAX_BOTS: "1",
      VB_DEFAULT_MAX_CONCURRENT_TASKS: "1",
    });
    expect(custom.modelApi).toBe("openai-responses");
    expect(custom.models).toEqual(["a", "b"]);
    expect(custom.modelMaxTokens).toBe(128);
    expect(custom.taskTokenBudget).toBe(10);
    expect(() => loadConfig({ VB_MODEL_API: "anthropic" })).toThrow(/VB_MODEL_API/);
    expect(() => loadConfig({ VB_MODEL_MAX_TOKENS: "0" })).toThrow(/VB_MODEL_MAX_TOKENS/);
  });
});
