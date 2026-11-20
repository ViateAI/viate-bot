import { describe, expect, it } from "vitest";
import { loadConfig, requireOidc, requireServiceCredentials, requireSharedModelKey } from "./config.js";

describe("loadConfig", () => {
  it("uses documented defaults when optional variables are absent", () => {
    const config = loadConfig({});
    expect(config.dataDir).toBe("/data");
    expect(config.machineImage).toBe("viate-bot/machine:dev");
    expect(loadConfig({ VB_MACHINE_IMAGE_DEFAULT: "ghcr.io/viateai/viate-bot-machine:v0.1.0" }).machineImage).toBe(
      "ghcr.io/viateai/viate-bot-machine:v0.1.0",
    );
    expect(loadConfig({
      VB_MACHINE_IMAGE_DEFAULT: "ghcr.io/viateai/viate-bot-machine:v0.1.0",
      VB_MACHINE_IMAGE: "viate-bot/machine:dev",
    }).machineImage).toBe("viate-bot/machine:dev");
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

  it("defaults upload storage to local and ignores partial S3 settings", () => {
    const config = loadConfig({});
    expect(config.uploadStorage).toBe("local");
    expect(config.acceptUploadStorageSwitch).toBe(false);
    expect(loadConfig({ VB_UPLOAD_STORAGE: "local", VB_S3_SECRET_ACCESS_KEY: "s3-secret-do-not-print" }).uploadStorage).toBe("local");
    expect(loadConfig({ VB_UPLOAD_STORAGE_ACCEPT_SWITCH: "true" }).acceptUploadStorageSwitch).toBe(false);
    expect(loadConfig({ VB_UPLOAD_STORAGE_ACCEPT_SWITCH: "1" }).acceptUploadStorageSwitch).toBe(true);
  });

  it("rejects an unknown upload backend, a missing bucket, and a single S3 credential without echoing the secret", () => {
    expect(() => loadConfig({ VB_UPLOAD_STORAGE: "disk" })).toThrow(/VB_UPLOAD_STORAGE/);
    const missingBucket = () =>
      loadConfig({
        VB_UPLOAD_STORAGE: "s3",
        VB_S3_REGION: "us-east-1",
        VB_S3_SECRET_ACCESS_KEY: "s3-secret-do-not-print",
      });
    expect(missingBucket).toThrow(/VB_S3_BUCKET/);
    expect(() =>
      loadConfig({
        VB_UPLOAD_STORAGE: "s3",
        VB_S3_BUCKET: "attachments",
      }),
    ).toThrow(/VB_S3_REGION/);
    const onlySecret = () =>
      loadConfig({
        VB_UPLOAD_STORAGE: "s3",
        VB_S3_BUCKET: "attachments",
        VB_S3_REGION: "us-east-1",
        VB_S3_SECRET_ACCESS_KEY: "s3-secret-do-not-print",
      });
    expect(onlySecret).toThrow(/VB_S3_ACCESS_KEY_ID/);
    const onlyKey = () =>
      loadConfig({
        VB_UPLOAD_STORAGE: "s3",
        VB_S3_BUCKET: "attachments",
        VB_S3_REGION: "us-east-1",
        VB_S3_ACCESS_KEY_ID: "test-access-key",
      });
    expect(onlyKey).toThrow(/VB_S3_SECRET_ACCESS_KEY/);
    for (const run of [missingBucket, onlySecret, onlyKey, () => loadConfig({ VB_UPLOAD_STORAGE: "disk" })]) {
      try {
        run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain("s3-secret-do-not-print");
        expect(message).not.toContain("test-access-key");
      }
    }
    const ready = loadConfig({
      VB_UPLOAD_STORAGE: "s3",
      VB_S3_BUCKET: "attachments",
      VB_S3_REGION: "us-east-1",
      VB_S3_ENDPOINT: "http://127.0.0.1:9",
      VB_S3_FORCE_PATH_STYLE: "1",
      VB_S3_PREFIX: "team",
      VB_S3_ACCESS_KEY_ID: "test-access-key",
      VB_S3_SECRET_ACCESS_KEY: "s3-secret-do-not-print",
    });
    expect(ready.uploadStorage).toBe("s3");
    expect(ready.s3).toMatchObject({
      bucket: "attachments",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9",
      forcePathStyle: true,
      prefix: "team",
      accessKeyId: "test-access-key",
    });
    expect(JSON.stringify({ ...ready.s3, secretAccessKey: undefined })).not.toContain("s3-secret-do-not-print");
  });

  it("defaults the model gateway and rejects bad values", () => {
    const config = loadConfig({});
    expect(config.modelApi).toBe("openai-completions");
    expect(config.models).toEqual([]);
    expect(config.modelMaxTokens).toBe(4096);
    expect(config.modelContextTokens).toBe(256_000);
    expect(config.summaryMaxTokens).toBe(2_000);
    expect(config.taskTokenBudget).toBe(2_000_000);
    expect(config.modelRateUserPerMin).toBe(120);
    expect(config.modelRateBotPerMin).toBe(60);
    expect(config.maxTaskSteps).toBe(200);
    expect(config.maxTaskDurationSec).toBe(3600);
    expect(config.defaultMaxBots).toBe(5);
    expect(config.defaultMaxConcurrentTasks).toBe(2);
    expect(config.defaultMaxRoutines).toBe(10);
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
    expect(loadConfig({ VB_TASK_TOKEN_BUDGET: "0" }).taskTokenBudget).toBe(0);
    expect(loadConfig({ VB_MAX_TASK_STEPS: "0" }).maxTaskSteps).toBe(0);
    expect(loadConfig({ VB_MAX_TASK_DURATION_SEC: "0" }).maxTaskDurationSec).toBe(0);
    expect(loadConfig({ VB_MODEL_RATE_USER: "0", VB_MODEL_RATE_BOT: "0" }).modelRateUserPerMin).toBe(0);
    expect(loadConfig({ VB_MODEL_RATE_BOT: "0" }).modelRateBotPerMin).toBe(0);
    expect(() => loadConfig({ VB_MODEL_API: "anthropic" })).toThrow(/VB_MODEL_API/);
    expect(() => loadConfig({ VB_MODEL_MAX_TOKENS: "0" })).toThrow(/VB_MODEL_MAX_TOKENS/);
    expect(() => loadConfig({ VB_MAX_TASK_STEPS: "-1" })).toThrow(/VB_MAX_TASK_STEPS/);
    expect(() => loadConfig({ VB_MAX_TASK_DURATION_SEC: "-1" })).toThrow(/VB_MAX_TASK_DURATION_SEC/);
  });
});
