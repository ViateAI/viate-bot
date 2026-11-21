import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { arr, bool, obj, opt, str } from "@earendil-works/pi-schema";
import {
  bindSecretRefs,
  CatalogRejected,
  installsForModelContext,
  listUserInstalls,
  manifestConfigItems,
  type CatalogDeps,
  type SecretRefTarget,
} from "../apps/catalog.js";
import { encrypt } from "../crypto.js";
import { auditRepository } from "../db/audit.js";
import { secretRepository } from "../db/secrets.js";
import { ulid } from "../id.js";
import { AUDIT_ACTIONS } from "../m2/events.js";
import { adminScope, userScope } from "../scope.js";

const SECRET_NAME = /^[a-z0-9_]{1,64}$/;
const CREDENTIAL_NAME = /^[a-z0-9_.-]{1,64}$/;
const CONFIG_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const SECRET_LIMIT = 4096;

interface SecretFiles {
  read(
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
    encoding?: "utf8" | "base64",
    confine?: boolean,
  ): Promise<{ path: string; content: string; truncated: boolean }>;
  removeFile(path: string, signal?: AbortSignal, confine?: boolean): Promise<{ path: string }>;
}

export interface SaveSecretBinding {
  userId: string;
  taskId: string;
  catalog: CatalogDeps;
  files: SecretFiles;
  confineNow: () => boolean;
  remember: (name: string, value: string) => void;
  stopApp: (appName: string) => void;
}

export interface LinkCredentialBinding {
  userId: string;
  botId: string;
  catalog: CatalogDeps;
  stopApp: (appName: string) => void;
}

const saveSchema = obj({
  name: str({ description: "用户级密钥名，小写字母、数字和下划线" }),
  path: str({ description: "机器上的临时文件路径" }),
  trim: opt(bool({ description: "去掉首尾空白，默认 true" })),
  stripPrefix: opt(str({ description: "若内容以该前缀开头则去掉后再保存" })),
  removeFile: opt(bool({ description: "保存成功后删除临时文件，默认 true" })),
});

const linkSchema = obj({
  secretName: str({ description: "已经保存的用户级密钥名" }),
  credential: opt(str({ description: "按应用 manifest 的 credential 标识批量匹配" })),
  defaultPrefix: opt(str({ description: "目标自己和 manifest 都没有前缀时使用" })),
  targets: opt(arr(obj({
    app: str({ description: "已安装的应用名" }),
    key: str({ description: "配置键" }),
    prefix: opt(str({ description: "注入时加在密钥前面的文本" })),
  }))),
});

export function saveSecretFromMachineTool(binding: SaveSecretBinding): AgentTool<typeof saveSchema> {
  return {
    name: "save_secret_from_machine",
    label: "从机器文件保存密钥",
    description: "把机器上临时文件里的凭证加密存成当前用户的密钥，不把内容放进对话。可选用同一份密钥给多个应用引用。",
    parameters: saveSchema,
    execute: async (_id, params, signal) => {
      const name = params.name.trim();
      if (!SECRET_NAME.test(name) || name.startsWith("app:")) return fail("密钥名不合法");
      const path = params.path.trim();
      if (path.length === 0 || path.length > 1024) return fail("文件路径不合法");
      if (params.stripPrefix !== undefined && !validAffix(params.stripPrefix)) return fail("前缀不合法");
      let file: { content: string; truncated: boolean };
      try {
        file = await binding.files.read(path, SECRET_LIMIT, signal, undefined, binding.confineNow());
      } catch {
        return fail("读取临时文件失败");
      }
      if (file.truncated || Buffer.byteLength(file.content) > SECRET_LIMIT) return fail("文件超过 4096 字节，不能存成密钥");
      let value = params.trim === false ? file.content : file.content.trim();
      if (params.stripPrefix && value.startsWith(params.stripPrefix)) value = value.slice(params.stripPrefix.length);
      if (value.length === 0) return fail("密钥内容为空");
      if (value.length > SECRET_LIMIT) return fail("密钥过长");
      secretRepository(binding.catalog.db).upsert(userScope(binding.userId), {
        id: ulid(),
        name,
        valueEnc: encrypt(binding.catalog.key, value),
        scope: "browser",
      });
      binding.remember(name, value);
      const stopped = referencingApps(binding.catalog, binding.userId, name);
      for (const appName of stopped) binding.stopApp(appName);
      let removedNote = "";
      if (params.removeFile !== false) {
        try {
          await binding.files.removeFile(path, signal, binding.confineNow());
          removedNote = "，已删除临时文件";
        } catch {
          removedNote = "，未能删除临时文件";
        }
      }
      const reloadedNote = stopped.length > 0 ? `，已停止 ${stopped.length} 个应用的旧会话` : "";
      auditRepository(binding.catalog.db).write(adminScope(binding.userId), AUDIT_ACTIONS.secretSavedFromMachine, name, {
        length: value.length,
      });
      return ok(`已保存密钥 ${name}（长度 ${value.length} 字符）${removedNote}${reloadedNote}`);
    },
  };
}

export function linkAppCredentialTool(binding: LinkCredentialBinding): AgentTool<typeof linkSchema> {
  return {
    name: "link_app_credential",
    label: "绑定应用到共享密钥",
    description: "把一个已保存的用户级密钥引用到已安装应用的密钥配置上。当前任务随后用 mcp_inspect 和 mcp_call 即可使用。",
    parameters: linkSchema,
    execute: async (_id, params) => {
      const secretName = params.secretName.trim();
      if (!SECRET_NAME.test(secretName) || secretName.startsWith("app:")) return fail("密钥名不合法");
      if (params.credential === undefined && (params.targets === undefined || params.targets.length === 0)) {
        return fail("需要 credential 或 targets");
      }
      if (params.defaultPrefix !== undefined && !validAffix(params.defaultPrefix)) return fail("前缀不合法");
      const row = secretRepository(binding.catalog.db).find(userScope(binding.userId), secretName);
      if (!row || row.scope === "app" || row.name.startsWith("app:")) {
        return fail(`引用的密钥 ${secretName} 不存在，请先登录或保存该密钥`);
      }
      const selected = new Map<string, SecretRefTarget & { appName: string }>();
      if (params.credential !== undefined) {
        if (!CREDENTIAL_NAME.test(params.credential)) return fail("凭证标识不合法");
        for (const install of installsForModelContext(binding.catalog, binding.userId, binding.botId)) {
          for (const item of manifestConfigItems(manifestOf(binding.catalog, install.installId)) ?? []) {
            if (item.credential !== params.credential || !item.secret) continue;
            const prefix = choosePrefix(undefined, item.prefix, params.defaultPrefix);
            const target: SecretRefTarget & { appName: string } = {
              installId: install.installId,
              appName: install.name,
              key: item.key,
            };
            if (prefix) target.prefix = prefix;
            selected.set(`${install.installId}\0${item.key}`, target);
          }
        }
      }
      for (const target of params.targets ?? []) {
        if (!CONFIG_KEY.test(target.key)) return fail("配置名不合法");
        if (target.prefix !== undefined && !validAffix(target.prefix)) return fail("前缀不合法");
        const install = listUserInstalls(binding.catalog, binding.userId).find((item) =>
          item.name === target.app && item.desired === "present" && item.state === "installed");
        if (!install) return fail(`应用 ${target.app} 未安装`);
        const declared = manifestConfigItems(manifestOf(binding.catalog, install.id));
        const spec = declared?.find((item) => item.key === target.key);
        if (declared && !spec) return fail(`配置项 ${target.key} 不在应用声明里`);
        if (spec && !spec.secret) return fail(`配置项 ${target.key} 不是密钥`);
        const prefix = choosePrefix(target.prefix, spec?.prefix, params.defaultPrefix);
        const next: SecretRefTarget & { appName: string } = {
          installId: install.id,
          appName: install.name,
          key: target.key,
        };
        if (prefix) next.prefix = prefix;
        selected.set(`${install.id}\0${target.key}`, next);
      }
      if (selected.size === 0) return fail("没有可绑定的应用");
      let bound: Array<{ installId: string; appName: string; key: string; prefix?: string }>;
      try {
        bound = bindSecretRefs(binding.catalog, binding.userId, secretName, [...selected.values()]);
      } catch (error) {
        return fail(error instanceof CatalogRejected ? error.message : "绑定失败");
      }
      const apps = [...new Set(bound.map((item) => item.appName))];
      for (const appName of apps) binding.stopApp(appName);
      auditRepository(binding.catalog.db).write(adminScope(binding.userId), AUDIT_ACTIONS.secretLinkApp, secretName, {
        secretName,
        bindings: bound.map((item) => `${item.appName}:${item.key}${item.prefix ? ":prefix" : ""}`).join(","),
      });
      const lines = bound.map((item) => `- ${item.appName} ${item.key}${item.prefix ? `（前缀 ${JSON.stringify(item.prefix)}）` : ""}`);
      return ok(`已绑定：\n${lines.join("\n")}\n已配置完成，当前任务可直接通过 mcp_inspect / mcp_call 使用这些应用。`);
    },
  };
}

function referencingApps(catalog: CatalogDeps, userId: string, secretName: string): string[] {
  const names = new Set<string>();
  for (const install of listUserInstalls(catalog, userId)) {
    if (install.desired !== "present" || install.state !== "installed") continue;
    for (const value of Object.values(install.config)) {
      if (typeof value !== "string" && "secretRef" in value && value.secretRef === secretName) names.add(install.name);
    }
  }
  return [...names];
}

function manifestOf(catalog: CatalogDeps, installId: string): string {
  const row = catalog.db.$client.prepare(
    "select v.manifest_json as manifest from app_installs i join app_versions v on v.id = i.app_version_id where i.id = ?",
  ).get(installId) as { manifest: string } | undefined;
  return row?.manifest ?? "{}";
}

function choosePrefix(explicit: string | undefined, manifestPrefix: string | undefined, fallback: string | undefined): string | undefined {
  const picked = explicit !== undefined ? explicit : manifestPrefix !== undefined ? manifestPrefix : fallback;
  if (picked === undefined || picked.length === 0) return undefined;
  return picked;
}

function validAffix(value: string): boolean {
  return value.length <= 64 && !CONTROL_CHARS.test(value);
}

function ok(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

function fail(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}
