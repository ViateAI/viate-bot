import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { loadConfig } from "./config.js";
import { loadOrCreateKey } from "./crypto.js";
import { openDatabase, type AppDatabase } from "./db/index.js";
import { machineRepository } from "./db/machines.js";
import { DockerDriver } from "./machines/docker.js";
import { idleActivityProbe, type ActivityProbe } from "./machines/reconcile.js";
import type { ReconcileDeps } from "./machines/loop.js";
import type { MachineSpec } from "./machines/policy.js";
import { schedulerScope } from "./scope.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export function openControlDatabase(path: string): AppDatabase {
  const db = openDatabase(path);
  migrate(db, { migrationsFolder });
  return db;
}

export function createDriver(): DockerDriver {
  const config = loadConfig();
  return new DockerDriver({
    image: config.machineImage,
    key: loadOrCreateKey(config.secretKeyPath),
  });
}

export function reconcileDeps(
  db: AppDatabase,
  driver: DockerDriver,
  probe: ActivityProbe = idleActivityProbe,
  reconcileApps?: ReconcileDeps["reconcileApps"],
): ReconcileDeps {
  const config = loadConfig();
  return {
    driver,
    store: machineRepository(db),
    admin: schedulerScope,
    probe,
    idleStopMinutes: config.idleStopMinutes,
    key: loadOrCreateKey(config.secretKeyPath),
    db,
    ...(reconcileApps ? { reconcileApps } : {}),
  };
}

export const devSpec: MachineSpec = { cpu: 1, memMb: 1024, diskGb: 10 };

export const controlMigrationsFolder = migrationsFolder;
