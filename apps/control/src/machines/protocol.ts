import { MACHINE_PROTOCOL_VERSION } from "@viate-bot/protocol";
import { auditRepository } from "../db/audit.js";
import type { AppDatabase } from "../db/index.js";
import { machineRepository } from "../db/machines.js";
import { schedulerScope, userScope } from "../scope.js";

/** Inclusive range this control plane will talk to. */
export const SUPPORTED_MACHINE_PROTOCOL = {
  min: 1,
  max: MACHINE_PROTOCOL_VERSION,
} as const;

/**
 * Health bodies from machines built before this field existed omit `protocol`.
 * Those machines speak version 1. A present but non-integer value is not a version.
 */
export function reportedProtocol(body: unknown): number {
  if (!body || typeof body !== "object" || !("protocol" in body)) return 1;
  const value = (body as { protocol: unknown }).protocol;
  if (typeof value !== "number" || !Number.isInteger(value)) return Number.NaN;
  return value;
}

export function protocolNeed(): string {
  const { min, max } = SUPPORTED_MACHINE_PROTOCOL;
  return min === max ? String(min) : `${min}–${max}`;
}

export class ProtocolMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolMismatchError";
  }
}

export function protocolMismatchMessage(reported: number): string {
  const shown = Number.isInteger(reported) ? String(reported) : "无效";
  return `机器镜像协议版本 ${shown}，控制面需要 ${protocolNeed()}，请重建机器`;
}

export function protocolCompatible(reported: number): boolean {
  return Number.isInteger(reported)
    && reported >= SUPPORTED_MACHINE_PROTOCOL.min
    && reported <= SUPPORTED_MACHINE_PROTOCOL.max;
}

export function noteMachineProtocolMismatch(
  db: AppDatabase,
  record: { id: string; userId: string },
  reported: number,
): string {
  const message = protocolMismatchMessage(reported);
  const store = machineRepository(db);
  const current = store.findAdmin(schedulerScope, record.id);
  store.update(userScope(record.userId), { state: "error", statusDetail: message });
  if (current?.statusDetail !== message) {
    auditRepository(db).write(schedulerScope, "machine.protocol", record.id, {
      userId: record.userId,
      reported: Number.isInteger(reported) ? reported : null,
      need: protocolNeed(),
    });
  }
  return message;
}

export function protocolMismatch(reported: number): ProtocolMismatchError {
  return new ProtocolMismatchError(protocolMismatchMessage(reported));
}

/** A compatible health check clears a previous protocol refusal and marks the machine running. */
export function acceptMachineProtocol(db: AppDatabase, userId: string): void {
  const store = machineRepository(db);
  const current = store.find(userScope(userId));
  if (!current?.statusDetail || (current.state !== "running" && current.state !== "error")) return;
  store.update(userScope(userId), { statusDetail: null, state: "running" });
}
