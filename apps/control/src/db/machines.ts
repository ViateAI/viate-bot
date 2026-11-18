import { and, eq } from "drizzle-orm";
import type { MachineSpec } from "../machines/policy.js";
import type { AdminScope, UserScope } from "../scope.js";
import type { AppDatabase } from "./index.js";
import { machines } from "./schema.js";

export interface MachineRecord {
  id: string;
  userId: string;
  state: string;
  containerId: string | null;
  networkId: string | null;
  volumeName: string;
  imageVersion: string;
  spec: MachineSpec;
  tokenEnc: string;
  /** 最近一次协议拒绝的原因。没有拒绝时为空。 */
  statusDetail?: string | null;
}

/** 管理端可以改的字段。不含 machined token。 */
export type MachineAdminPatch = Omit<MachinePatch, "tokenEnc">;

export interface MachinePatch {
  state?: string;
  containerId?: string | null;
  networkId?: string | null;
  volumeName?: string;
  imageVersion?: string;
  spec?: MachineSpec;
  tokenEnc?: string;
  lastHeartbeatAt?: string | null;
  statusDetail?: string | null;
}

/** 管理端能看到的机器元数据。不含 machined token。 */
export interface MachineMeta {
  id: string;
  userId: string;
  state: string;
}

/** 机器页面用的元数据。仍然没有 token。 */
export interface MachineAdminRecord {
  id: string;
  userId: string;
  state: string;
  spec: MachineSpec;
  imageVersion: string;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string | null;
  statusDetail: string | null;
}

export interface MachineStore {
  find(scope: UserScope): MachineRecord | undefined;
  findById(scope: UserScope, id: string): MachineRecord | undefined;
  insert(scope: UserScope, record: MachineRecord): void;
  update(scope: UserScope, patch: MachinePatch): boolean;
  updateById(scope: UserScope, id: string, patch: MachinePatch): boolean;
  list(scope: AdminScope): MachineMeta[];
  listAdmin(scope: AdminScope): MachineAdminRecord[];
  findAdmin(scope: AdminScope, id: string): MachineAdminRecord | undefined;
  /** 管理端按 id 和 user_id 核对机器是否存在。不返回 token。 */
  findOwned(scope: AdminScope, userId: string, id: string): MachineMeta | undefined;
  updateOwned(scope: AdminScope, userId: string, id: string, patch: MachineAdminPatch): boolean;
}

export function machineRepository(db: AppDatabase): MachineStore {
  return {
    find(scope) {
      const row = db.select().from(machines).where(eq(machines.userId, scope.userId)).get();
      return row ? toRecord(row) : undefined;
    },
    findById(scope, id) {
      const row = db
        .select()
        .from(machines)
        .where(and(eq(machines.id, id), eq(machines.userId, scope.userId)))
        .get();
      return row ? toRecord(row) : undefined;
    },
    insert(scope, record) {
      if (record.userId !== scope.userId) throw new Error("不能把机器写到别的用户名下");
      const now = new Date().toISOString();
      db.insert(machines)
        .values({
          id: record.id,
          userId: scope.userId,
          state: record.state,
          specJson: JSON.stringify(record.spec),
          imageVersion: record.imageVersion,
          containerId: record.containerId,
          networkId: record.networkId,
          volumeName: record.volumeName,
          machinedTokenEnc: record.tokenEnc,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    },
    update(scope, patch) {
      const result = db
        .update(machines)
        .set({ ...columns(patch), updatedAt: new Date().toISOString() })
        .where(eq(machines.userId, scope.userId))
        .run();
      return result.changes > 0;
    },
    updateById(scope, id, patch) {
      const result = db
        .update(machines)
        .set({ ...columns(patch), updatedAt: new Date().toISOString() })
        .where(and(eq(machines.id, id), eq(machines.userId, scope.userId)))
        .run();
      return result.changes > 0;
    },
    list(_scope) {
      return db
        .select({ id: machines.id, userId: machines.userId, state: machines.state })
        .from(machines)
        .all();
    },
    listAdmin(_scope) {
      return db
        .select({
          id: machines.id,
          userId: machines.userId,
          state: machines.state,
          specJson: machines.specJson,
          imageVersion: machines.imageVersion,
          createdAt: machines.createdAt,
          updatedAt: machines.updatedAt,
          lastHeartbeatAt: machines.lastHeartbeatAt,
          statusDetail: machines.statusDetail,
        })
        .from(machines)
        .all()
        .map(toAdmin);
    },
    findAdmin(_scope, id) {
      const row = db
        .select({
          id: machines.id,
          userId: machines.userId,
          state: machines.state,
          specJson: machines.specJson,
          imageVersion: machines.imageVersion,
          createdAt: machines.createdAt,
          updatedAt: machines.updatedAt,
          lastHeartbeatAt: machines.lastHeartbeatAt,
          statusDetail: machines.statusDetail,
        })
        .from(machines)
        .where(eq(machines.id, id))
        .get();
      return row ? toAdmin(row) : undefined;
    },
    findOwned(_scope, userId, id) {
      const row = db
        .select({ id: machines.id, userId: machines.userId, state: machines.state })
        .from(machines)
        .where(and(eq(machines.id, id), eq(machines.userId, userId)))
        .get();
      return row ?? undefined;
    },
    updateOwned(_scope, userId, id, patch) {
      const result = db
        .update(machines)
        .set({ ...columns(patch), updatedAt: new Date().toISOString() })
        .where(and(eq(machines.id, id), eq(machines.userId, userId)))
        .run();
      return result.changes > 0;
    },
  };
}

function toAdmin(row: {
  id: string;
  userId: string;
  state: string;
  specJson: string;
  imageVersion: string;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string | null;
  statusDetail: string | null;
}): MachineAdminRecord {
  return {
    id: row.id,
    userId: row.userId,
    state: row.state,
    spec: readSpec(row.specJson),
    imageVersion: row.imageVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    statusDetail: row.statusDetail,
  };
}

function toRecord(row: typeof machines.$inferSelect): MachineRecord {
  return {
    id: row.id,
    userId: row.userId,
    state: row.state,
    containerId: row.containerId,
    networkId: row.networkId,
    volumeName: row.volumeName,
    imageVersion: row.imageVersion,
    spec: readSpec(row.specJson),
    tokenEnc: row.machinedTokenEnc,
    statusDetail: row.statusDetail,
  };
}

function columns(patch: MachinePatch): Partial<typeof machines.$inferInsert> {
  return {
    ...(patch.state !== undefined ? { state: patch.state } : {}),
    ...(patch.containerId !== undefined ? { containerId: patch.containerId } : {}),
    ...(patch.networkId !== undefined ? { networkId: patch.networkId } : {}),
    ...(patch.volumeName !== undefined ? { volumeName: patch.volumeName } : {}),
    ...(patch.imageVersion !== undefined ? { imageVersion: patch.imageVersion } : {}),
    ...(patch.spec !== undefined ? { specJson: JSON.stringify(patch.spec) } : {}),
    ...(patch.tokenEnc !== undefined ? { machinedTokenEnc: patch.tokenEnc } : {}),
    ...(patch.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: patch.lastHeartbeatAt } : {}),
    ...(patch.statusDetail !== undefined ? { statusDetail: patch.statusDetail } : {}),
  };
}

function readSpec(specJson: string): MachineSpec {
  const parsed: unknown = JSON.parse(specJson);
  if (!parsed || typeof parsed !== "object") throw new Error("spec_json 不是对象");
  if (!("cpu" in parsed) || !("memMb" in parsed) || !("diskGb" in parsed)) {
    throw new Error("spec_json 缺少 cpu、memMb 或 diskGb");
  }
  const { cpu, memMb, diskGb } = parsed;
  if (typeof cpu !== "number" || typeof memMb !== "number" || typeof diskGb !== "number") {
    throw new Error("spec_json 的 cpu、memMb、diskGb 必须是数字");
  }
  return { cpu, memMb, diskGb };
}
