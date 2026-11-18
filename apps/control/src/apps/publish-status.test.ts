import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/index.js";
import { appPublishRequests } from "../db/schema.js";
import { userRepository } from "../db/users.js";
import { validatePackage, type PackageFile } from "./archive.js";
import { listUserCatalog, publishValidatedPackage, searchApps, withdrawPublishRequest, type CatalogDeps } from "./catalog.js";
import { requestAppPublish } from "./publish-request.js";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boot() {
  const dir = mkdtempSync(join(tmpdir(), "vb-status-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "viate-bot.sqlite"));
  closers.push(() => db.$client.close());
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  const users = userRepository(db);
  users.insert({ id: "alice", email: "alice@example.com", name: "Alice", status: "active", isAdmin: false });
  users.insert({ id: "bob", email: "bob@example.com", name: "Bob", status: "active", isAdmin: false });
  const deps: CatalogDeps = { db, key: Buffer.alloc(32, 4), dataDir: dir, installer: { async install() {}, async uninstall() {} } };
  return { db, deps };
}

async function publish(deps: CatalogDeps, version: string) {
  const files: PackageFile[] = [{
    path: "plugin.json",
    data: Buffer.from(JSON.stringify({ $schema: PLUGIN, name: "notes", description: "private notes" })),
  }];
  await publishValidatedPackage(deps, "alice", validatePackage(files), { version, privateUserId: "alice" });
}

describe("publish status", () => {
  it("shows the owner every version state and other users only the publisher name", async () => {
    const ctx = boot();
    for (const version of ["1.0.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0"]) await publish(ctx.deps, version);
    requestAppPublish(ctx.deps, "alice", { name: "notes", version: "2.0.0", note: "pending note" });
    const rejected = requestAppPublish(ctx.deps, "alice", { name: "notes", version: "3.0.0", note: "reject me" });
    ctx.db.update(appPublishRequests).set({ state: "rejected", reason: "不行", reviewerUserId: "bob" }).where(eq(appPublishRequests.id, rejected.id)).run();
    const withdrawn = requestAppPublish(ctx.deps, "alice", { name: "notes", version: "4.0.0", note: "withdraw me" });
    withdrawPublishRequest(ctx.deps, "alice", withdrawn.id);
    const approved = requestAppPublish(ctx.deps, "alice", { name: "notes", version: "5.0.0", note: "ship it" });
    ctx.db.update(appPublishRequests).set({ state: "approved", reviewerUserId: "bob" }).where(eq(appPublishRequests.id, approved.id)).run();

    const mine = listUserCatalog(ctx.deps, "alice").find((entry) => entry.name === "notes");
    expect(mine?.privateVersions).toEqual([
      { version: "1.0.0", publishState: "私有", reason: null },
      { version: "2.0.0", publishState: "待审批", reason: null },
      { version: "3.0.0", publishState: "已驳回", reason: "不行" },
      { version: "4.0.0", publishState: "已撤回", reason: null },
      { version: "5.0.0", publishState: "已公开", reason: null },
    ]);
    const theirs = listUserCatalog(ctx.deps, "bob").find((entry) => entry.name === "notes");
    expect(theirs).toMatchObject({ version: { version: "5.0.0" }, publisher: "Alice" });
    expect(theirs?.privateVersions ?? []).toEqual([]);

    const ownerHit = searchApps(ctx.deps, "alice", "notes")[0];
    expect(ownerHit?.publishVersions).toEqual(mine?.privateVersions);
    const publicHit = searchApps(ctx.deps, "bob", "notes")[0];
    expect(publicHit).toMatchObject({ version: "5.0.0", publisher: "Alice" });
    expect(JSON.stringify(publicHit)).not.toContain("不行");
    expect(publicHit?.publishVersions).toBeUndefined();
  });
});
