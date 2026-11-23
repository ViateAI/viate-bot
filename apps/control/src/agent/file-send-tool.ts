import { basename } from "node:path";
import type { Readable } from "node:stream";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { ConfinePolicy } from "@viate-bot/protocol";
import { chatRepository } from "../db/chat.js";
import type { AppDatabase } from "../db/index.js";
import { ulid } from "../id.js";
import type { UserScope } from "../scope.js";
import type { UploadStorage } from "../uploads/storage.js";
import { claimUploads, discardUpload, MAX_UPLOAD_BYTES, saveUpload } from "../uploads/store.js";
import { maskSecrets } from "./text.js";

const MAX_TASK_SENDS = 20;
const CAPTION_LIMIT = 1000;

export interface SendFileBinding {
  db: AppDatabase;
  dataDir: string;
  storage: UploadStorage;
  userId: string;
  scope: UserScope;
  taskId: string;
  conversationId: string;
  /** 创建工具时的开关，只写进参数说明。 */
  confined: boolean;
  confineNow: () => boolean;
  confinePolicyNow: () => ConfinePolicy;
  knownSecrets: () => Array<{ name: string; value: string }>;
  now: () => Date;
  files: {
    download(path: string, maxBytes: number, signal?: AbortSignal, confine?: boolean, policy?: ConfinePolicy): Promise<Readable>;
  };
  publish: (messageId: string) => void;
}

/**
 * 把机器上的普通文件发进当前对话。
 * 展示消息不带 pi，避免插进 toolCall 和 toolResult 之间。
 */
export function createSendFileTool(binding: SendFileBinding): AgentTool {
  const pathDescription = binding.confined ? "文件路径，只能在 /home/bot 或 /tmp 下" : "文件路径";
  const parameters = obj({
    path: str({ description: pathDescription }),
    filename: opt(str({ description: "可选的展示文件名。省略时用路径里的文件名。" })),
    caption: opt(str({ description: "可选附言，最多 1000 个字符。空着就只显示附件。" })),
  });
  const tool: AgentTool<typeof parameters> = {
    name: "send_file",
    label: "发送文件",
    description: "把当前用户机器上的文件或图片直接发到对话里给用户查看或下载。用户要求发文件、导出报告、展示生成的图表或截图时调用它，不要只在回复里写机器本地路径。遵守目录访问限制，单文件上限 25 MB。",
    parameters,
    execute: async (_toolCallId, params, signal) => {
      const path = params.path.trim();
      if (path.length === 0) throw new Error("路径不能为空");
      const caption = params.caption?.trim() ?? "";
      if (caption.length > CAPTION_LIMIT) throw new Error("附言不能超过 1000 字");
      const text = maskSecrets(caption, binding.knownSecrets());
      if (sentCount(binding.db, binding.taskId) >= MAX_TASK_SENDS) throw new Error("这个任务最多发送 20 个附件");
      const confine = binding.confineNow();
      const policy = confine ? binding.confinePolicyNow() : undefined;
      const stream = await binding.files.download(path, MAX_UPLOAD_BYTES, signal, confine, policy);
      const filename = params.filename?.trim() || basename(path);
      const saved = await saveUpload({
        db: binding.db,
        dataDir: binding.dataDir,
        storage: binding.storage,
        userId: binding.userId,
        filename,
        stream,
        now: binding.now(),
      });
      const messageId = ulid(binding.now().getTime());
      const contentJson = JSON.stringify({
        text,
        attachments: [{ id: saved.id, name: saved.name, size: saved.size, mime: saved.mime, kind: saved.kind }],
        delivery: "file",
      });
      const chat = chatRepository(binding.db);
      try {
        binding.db.$client.transaction(() => {
          const row = chat.insertMessage(binding.scope, {
            id: messageId,
            conversationId: binding.conversationId,
            role: "assistant",
            contentJson,
            taskId: binding.taskId,
          });
          if (!row) throw new Error("无法发送文件");
          claimUploads(binding.db, binding.userId, row.id, [saved.id]);
          chat.touchConversation(binding.scope, binding.conversationId);
        })();
      } catch (error) {
        await discardUpload(binding.db, binding.storage, binding.userId, saved.id);
        throw error instanceof Error ? error : new Error("无法发送文件");
      }
      binding.publish(messageId);
      const label = saved.kind === "image" ? "图片" : "文件";
      return {
        content: [{ type: "text", text: `已发送${label}：${saved.name}（${formatSize(saved.size)}，${saved.mime}）` }],
        details: { uploadId: saved.id, name: saved.name, size: saved.size, mime: saved.mime, kind: saved.kind },
      };
    },
  };
  return tool;
}

function sentCount(db: AppDatabase, taskId: string): number {
  const rows = db.$client.prepare("select content_json as contentJson from messages where task_id=?").all(taskId) as Array<{ contentJson: string }>;
  return rows.filter((row) => {
    try {
      const value = JSON.parse(row.contentJson) as { delivery?: unknown };
      return value.delivery === "file";
    } catch {
      return false;
    }
  }).length;
}

function formatSize(size: number): string {
  if (size >= 1024 * 1024) {
    const text = (size / (1024 * 1024)).toFixed(1);
    return `${text.endsWith(".0") ? text.slice(0, -2) : text} MB`;
  }
  if (size >= 1024) {
    const text = (size / 1024).toFixed(1);
    return `${text.endsWith(".0") ? text.slice(0, -2) : text} KB`;
  }
  return `${size} B`;
}
