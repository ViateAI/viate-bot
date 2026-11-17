import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AdminScope, UserScope } from "../scope.js";
import { ulid } from "../id.js";
import type { AppDatabase } from "./index.js";

export const LINK_TTL_MS = 60_000;

export interface EgressSettings {
  machineId: string;
  mode: "direct" | "user_network";
  offlinePolicy: "fallback_direct" | "pause";
  deviceId: string | null;
}

export interface DevicePublic {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  allowFakeIp: boolean;
}

export interface DeviceAuth {
  id: string;
  userId: string;
  name: string;
}

/** 管理端只看出口元数据。这个查询不读 last_ip。 */
export interface EgressAdminMeta {
  machineId: string;
  userId: string;
  mode: string;
  offlinePolicy: string;
  deviceId: string | null;
}

export function egressRepository(db: AppDatabase) {
  const sql = db.$client;
  return {
    settings(scope: UserScope): EgressSettings | undefined {
      clearRevokedSelection(sql, scope.userId);
      const row = sql
        .prepare(
          `select id as machineId, egress_mode as mode, egress_offline_policy as offlinePolicy, egress_device_id as deviceId
           from machines where user_id = ?`,
        )
        .get(scope.userId) as EgressSettings | undefined;
      if (!row) return undefined;
      return {
        machineId: row.machineId,
        mode: row.mode === "user_network" ? "user_network" : "direct",
        offlinePolicy: row.offlinePolicy === "fallback_direct" ? "fallback_direct" : "pause",
        deviceId: row.deviceId,
      };
    },
    /** 还没选设备时，用最近一次未吊销的绑定。只改本用户的机器。 */
    assignDefaultDevice(scope: UserScope): void {
      sql
        .prepare(
          `update machines set egress_device_id = (
             select id from client_devices
             where user_id = ? and revoked_at is null
             order by created_at desc limit 1
           ), updated_at = ?
           where user_id = ? and egress_device_id is null
             and exists (select 1 from client_devices where user_id = ? and revoked_at is null)`,
        )
        .run(scope.userId, new Date().toISOString(), scope.userId, scope.userId);
    },
    updateSettings(
      scope: UserScope,
      patch: { mode?: "direct" | "user_network"; offlinePolicy?: "fallback_direct" | "pause"; deviceId?: string | null },
    ): boolean {
      const current = this.settings(scope);
      if (!current) return false;
      let deviceId = patch.deviceId === undefined ? current.deviceId : patch.deviceId;
      if (deviceId) {
        const owned = sql
          .prepare("select id from client_devices where id = ? and user_id = ? and revoked_at is null")
          .get(deviceId, scope.userId);
        if (!owned) return false;
      }
      const result = sql
        .prepare(
          `update machines set egress_mode = ?, egress_offline_policy = ?, egress_device_id = ?, updated_at = ?
           where user_id = ?`,
        )
        .run(
          patch.mode ?? current.mode,
          patch.offlinePolicy ?? current.offlinePolicy,
          deviceId,
          new Date().toISOString(),
          scope.userId,
        );
      return result.changes > 0;
    },
    listDevices(scope: UserScope): DevicePublic[] {
      const rows = sql
        .prepare(
          `select id, name, created_at as createdAt, last_seen_at as lastSeenAt, revoked_at as revokedAt, allow_fake_ip as allowFakeIp
           from client_devices where user_id = ? order by created_at desc`,
        )
        .all(scope.userId) as DevicePublic[];
      return rows.map((row) => ({ ...row, allowFakeIp: Boolean(row.allowFakeIp) }));
    },
    renameDevice(scope: UserScope, id: string, name: string): boolean {
      const result = sql
        .prepare("update client_devices set name = ? where id = ? and user_id = ? and revoked_at is null")
        .run(name, id, scope.userId);
      return result.changes > 0;
    },
    revokeDevice(scope: UserScope, id: string, now = new Date()): boolean {
      const result = sql
        .prepare("update client_devices set revoked_at = ? where id = ? and user_id = ? and revoked_at is null")
        .run(now.toISOString(), id, scope.userId);
      if (result.changes === 0) return false;
      sql
        .prepare("update machines set egress_device_id = null, updated_at = ? where user_id = ? and egress_device_id = ?")
        .run(now.toISOString(), scope.userId, id);
      return true;
    },
    findActiveByTokenHash(tokenHash: string): DeviceAuth | undefined {
      return sql
        .prepare(
          `select id, user_id as userId, name from client_devices
           where token_hash = ? and revoked_at is null`,
        )
        .get(tokenHash) as DeviceAuth | undefined;
    },
    touchDevice(id: string, seenAt: string, ip: string | null): void {
      sql.prepare("update client_devices set last_seen_at = ?, last_ip = ? where id = ? and revoked_at is null").run(seenAt, ip, id);
    },
    setFakeIp(id: string, enabled: boolean): void {
      sql.prepare("update client_devices set allow_fake_ip = ? where id = ? and revoked_at is null").run(enabled ? 1 : 0, id);
    },
    userStatus(userId: string): string | undefined {
      const row = sql.prepare("select status from users where id = ?").get(userId) as { status: string } | undefined;
      return row?.status;
    },
    createLink(
      scope: UserScope,
      input: { deviceName: string; codeChallenge: string; state: string; redirectPort: number },
      now = new Date(),
    ): { code: string } {
      const code = randomBytes(32).toString("base64url");
      sql
        .prepare(
          `insert into client_link_codes
           (id, user_id, device_name, code_hash, code_challenge, state, redirect_port, expires_at)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ulid(now.getTime()),
          scope.userId,
          input.deviceName,
          sha256(code),
          input.codeChallenge,
          input.state,
          input.redirectPort,
          new Date(now.getTime() + LINK_TTL_MS).toISOString(),
        );
      return { code };
    },
    /**
     * 兑换授权码。成功时创建设备并只返回一次明文令牌。
     * 码不对、过期、用过、PKCE 或 state 不匹配都返回 undefined。
     */
    consumeLink(
      input: { code: string; verifier: string; state: string; challenge: string },
      now = new Date(),
    ): { token: string; deviceId: string; userId: string; name: string } | undefined {
      const hash = sha256(input.code);
      const consumed = sql.transaction(() => {
        const row = sql
          .prepare(
            `select id, user_id as userId, device_name as deviceName, code_challenge as codeChallenge, state, expires_at as expiresAt, used_at as usedAt
             from client_link_codes where code_hash = ?`,
          )
          .get(hash) as
          | { id: string; userId: string; deviceName: string; codeChallenge: string; state: string; expiresAt: string; usedAt: string | null }
          | undefined;
        if (!row || row.usedAt) return undefined;
        if (Date.parse(row.expiresAt) <= now.getTime()) return undefined;
        if (!safeEqual(row.state, input.state) || !safeEqual(row.codeChallenge, input.challenge)) return undefined;
        const marked = sql.prepare("update client_link_codes set used_at = ? where id = ? and used_at is null").run(now.toISOString(), row.id);
        if (marked.changes !== 1) return undefined;
        const token = randomBytes(32).toString("base64url");
        const deviceId = ulid(now.getTime());
        sql
          .prepare("insert into client_devices (id, user_id, name, token_hash, created_at) values (?, ?, ?, ?, ?)")
          .run(deviceId, row.userId, row.deviceName, sha256(token), now.toISOString());
        sql
          .prepare(
            `update machines set egress_device_id = ?, updated_at = ?
             where user_id = ? and egress_device_id is null`,
          )
          .run(deviceId, now.toISOString(), row.userId);
        return { token, deviceId, userId: row.userId, name: row.deviceName };
      })();
      return consumed;
    },
    addBytes(machineId: string, deviceId: string, hour: string, toClient: number, toMachine: number): void {
      if (toClient === 0 && toMachine === 0) return;
      sql
        .prepare(
          `insert into egress_bytes_hourly (machine_id, device_id, hour, bytes_to_client, bytes_to_machine)
           values (?, ?, ?, ?, ?)
           on conflict(machine_id, device_id, hour) do update set
             bytes_to_client = bytes_to_client + excluded.bytes_to_client,
             bytes_to_machine = bytes_to_machine + excluded.bytes_to_machine`,
        )
        .run(machineId, deviceId, hour, toClient, toMachine);
    },
    adminMeta(_scope: AdminScope): EgressAdminMeta[] {
      return sql
        .prepare(
          `select id as machineId, user_id as userId, egress_mode as mode, egress_offline_policy as offlinePolicy, egress_device_id as deviceId
           from machines`,
        )
        .all() as EgressAdminMeta[];
    },
  };
}

function clearRevokedSelection(sql: AppDatabase["$client"], userId: string): void {
  sql
    .prepare(
      `update machines set egress_device_id = null
       where user_id = ? and egress_device_id in (
         select id from client_devices where user_id = ? and revoked_at is not null
       )`,
    )
    .run(userId, userId);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifierOk(verifier: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
