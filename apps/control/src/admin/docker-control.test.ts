import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it } from "vitest";
import { deleteCreatedMachine } from "./docker-control.js";
import { openDatabase } from "../db/index.js";
import { machineRepository } from "../db/machines.js";
import { DockerDriver } from "../machines/docker.js";
import { userScope } from "../scope.js";

it("cleans partial creation without a database row while preserving the volume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-m16r-docker-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  try {
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    const networks = new Set<string>();
    const volumes = new Set<string>();
    const missing = () => Object.assign(new Error("not found"), { statusCode: 404 });
    const docker = Object.assign(new Docker(), {
      getContainer() {
        return { remove: async () => { throw missing(); } };
      },
      getNetwork(name: string) {
        return {
          id: name,
          inspect: async () => { if (!networks.has(name)) throw missing(); return { Id: name }; },
          remove: async () => { if (!networks.delete(name)) throw missing(); },
        };
      },
      async createNetwork(options: { Name: string }) {
        networks.add(options.Name);
        return { id: options.Name };
      },
      getVolume(name: string) {
        return {
          inspect: async () => { if (!volumes.has(name)) throw missing(); return { Driver: "local", Options: null }; },
          remove: async () => { volumes.delete(name); },
        };
      },
      async createVolume(options: { Name: string }) { volumes.add(options.Name); },
      async createContainer() { throw new Error("image unavailable"); },
    });
    const driver = new DockerDriver({ docker, image: "viate-bot/machine:dev", key: randomBytes(32) });
    await expect(driver.create(machineRepository(db), userScope("m16r-partial"), { cpu: 1, memMb: 1024, diskGb: 10 })).rejects.toThrow("image unavailable");
    expect(networks.has("vb-net-m16r-partial")).toBe(true);
    expect(machineRepository(db).find(userScope("m16r-partial"))).toBeUndefined();
    await deleteCreatedMachine(db, driver, "m16r-partial");
    expect(networks.has("vb-net-m16r-partial")).toBe(false);
    expect(volumes.has("vb-home-m16r-partial")).toBe(true);
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
