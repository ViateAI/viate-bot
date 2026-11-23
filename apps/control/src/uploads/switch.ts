import type { ControlConfig, UploadStorageName } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import { settingsRepository } from "../db/settings.js";

export const UPLOAD_STORAGE_KEY = "uploads.storage";
/** 后端仍是 local 时，升级前已经在本地的附件没有切换点。用纪元而不是启动时间，避免第一次启动把它们全部标成旧后端。 */
export const UPLOAD_STORAGE_EPOCH = "1970-01-01T00:00:00.000Z";

export interface UploadStorageRecord {
  backend: UploadStorageName;
  since: string;
}

export function uploadPredatesStorage(createdAt: string, since: string): boolean {
  return createdAt < since;
}

export function ensureUploadStorage(db: AppDatabase, config: ControlConfig, now: Date): UploadStorageRecord {
  const settings = settingsRepository(db);
  let stored: unknown;
  try {
    stored = settings.getJson(UPLOAD_STORAGE_KEY);
  } catch {
    throw invalidStorageRecord();
  }
  let current = parseUploadStorage(stored);
  const backend = config.uploadStorage;
  if (!current) {
    const existing = uploadCount(db);
    if (existing === 0 || backend === "local") {
      const since = existing > 0 ? UPLOAD_STORAGE_EPOCH : now.toISOString();
      const value = { backend, since };
      settings.setJson(UPLOAD_STORAGE_KEY, value);
      return value;
    }
    // 上线前的附件只在本地。没有记录却直接配成其他后端，按从 local 切过来处理，不能写成纪元。
    current = { backend: "local", since: UPLOAD_STORAGE_EPOCH };
  }
  if (current.backend === backend) return current;
  if (uploadCount(db) === 0) {
    const value = { backend, since: now.toISOString() };
    settings.setJson(UPLOAD_STORAGE_KEY, value);
    return value;
  }
  if (!config.acceptUploadStorageSwitch) {
    throw new Error(
      `附件存储后端将从 ${current.backend} 改为 ${backend}。切换后原有附件无法在聊天中预览、下载或再次发送，旧数据不会删除或迁移；确认后设置 VB_UPLOAD_STORAGE_ACCEPT_SWITCH=1 重启`,
    );
  }
  const value = { backend, since: now.toISOString() };
  settings.setJson(UPLOAD_STORAGE_KEY, value);
  return value;
}

function uploadCount(db: AppDatabase): number {
  const row = db.$client.prepare("select count(*) as n from uploads").get() as { n: number };
  return Number(row.n);
}

function parseUploadStorage(value: unknown): UploadStorageRecord | undefined {
  if (value === undefined) return undefined;
  if (value && typeof value === "object" && "backend" in value && "since" in value) {
    const { backend, since } = value;
    if ((backend === "local" || backend === "s3") && typeof since === "string") {
      const parsed = Date.parse(since);
      if (Number.isFinite(parsed) && new Date(parsed).toISOString() === since) return { backend, since };
    }
  }
  throw invalidStorageRecord();
}

function invalidStorageRecord(): Error {
  return new Error("附件存储记录无效（uploads.storage），请从备份恢复记录后重启");
}
