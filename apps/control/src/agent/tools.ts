import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { MachinedClient } from "../machines/client.js";
import { capHeadTail, FS_READ_LIMIT } from "./text.js";

const shellSchema = Type.Object({
  cmd: Type.String({ description: "要执行的命令" }),
  cwd: Type.Optional(Type.String({ description: "工作目录，缺省是 /home/bot" })),
  timeoutSec: Type.Optional(Type.Number({ description: "超时秒数，1 到 600，缺省 30" })),
});

const readSchema = Type.Object({
  path: Type.String({ description: "文件路径，只能在 /home/bot 或 /tmp 下" }),
  maxBytes: Type.Optional(Type.Number({ description: "最多读取的字节数，上限 64KB" })),
});

const writeSchema = Type.Object({
  path: Type.String({ description: "文件路径，只能在 /home/bot 或 /tmp 下" }),
  content: Type.String({ description: "文件内容" }),
});

const listSchema = Type.Object({
  path: Type.String({ description: "目录路径，只能在 /home/bot 或 /tmp 下" }),
});

const searchSchema = Type.Object({
  path: Type.String({ description: "搜索起点，只能在 /home/bot 或 /tmp 下" }),
  pattern: Type.String({ description: "ripgrep 正则" }),
  maxResults: Type.Optional(Type.Number({ description: "最多返回多少条，上限 100" })),
});

/**
 * 工具在创建时绑定到这一个 MachinedClient。
 * 参数里没有主机、用户或机器 id，模型写什么都换不了目标。
 * 名字用下划线：OpenAI function name 不接受 shell.exec 这种点号。
 */
export function machineTools(client: MachinedClient): AgentTool[] {
  const shell: AgentTool<typeof shellSchema> = {
    name: "shell_exec",
    label: "执行命令",
    description: "在当前用户的机器上以 bot 用户执行命令。不能选择别的机器。输出只保留首尾各 8KB。",
    parameters: shellSchema,
    execute: async (_toolCallId, params, signal) => {
      const timeoutSec = params.timeoutSec ?? 30;
      if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 600) {
        throw new Error("timeoutSec 必须是 1 到 600 的整数");
      }
      const result = await client.exec({
        cmd: params.cmd,
        timeoutSec,
        ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
        ...(signal ? { signal } : {}),
      });
      const stdout = capHeadTail(result.stdout);
      const stderr = capHeadTail(result.stderr);
      const lines = [`exit=${result.code ?? "null"}${result.timedOut ? " timeout" : ""}`];
      if (stdout) lines.push(`stdout:\n${stdout}`);
      if (stderr) lines.push(`stderr:\n${stderr}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { code: result.code, timedOut: result.timedOut },
      };
    },
  };

  const read: AgentTool<typeof readSchema> = {
    name: "fs_read",
    label: "读文件",
    description: "读取当前用户机器上的文本文件。单次最多 64KB。",
    parameters: readSchema,
    execute: async (_toolCallId, params, signal) => {
      const requested = params.maxBytes ?? FS_READ_LIMIT;
      const maxBytes = Math.min(Math.max(1, Math.floor(requested)), FS_READ_LIMIT);
      const result = await client.read(params.path, maxBytes, signal);
      const raw = Buffer.from(result.content);
      const text = raw.length > maxBytes ? raw.subarray(0, maxBytes).toString("utf8") : result.content;
      const note = result.truncated || text !== result.content ? "\n…[内容已截断]…" : "";
      return { content: [{ type: "text", text: text + note }], details: { path: result.path, truncated: note !== "" } };
    },
  };

  const write: AgentTool<typeof writeSchema> = {
    name: "fs_write",
    label: "写文件",
    description: "把文本写入当前用户机器上的文件。单次最多 1MB。",
    parameters: writeSchema,
    execute: async (_toolCallId, params, signal) => {
      if (Buffer.byteLength(params.content) > 1024 * 1024) throw new Error("写入内容超过 1MB");
      const result = await client.write(params.path, params.content, signal);
      return { content: [{ type: "text", text: `已写入 ${result.path}（${result.bytes} 字节）` }], details: result };
    },
  };

  const list: AgentTool<typeof listSchema> = {
    name: "fs_list",
    label: "列目录",
    description: "列出当前用户机器上的目录。",
    parameters: listSchema,
    execute: async (_toolCallId, params, signal) => {
      const result = await client.list(params.path, signal);
      const text = capHeadTail(result.entries.map((entry) => `${entry.type}\t${entry.size}\t${entry.name}`).join("\n"));
      return { content: [{ type: "text", text: text || "（空目录）" }], details: { path: result.path, count: result.entries.length } };
    },
  };

  const search: AgentTool<typeof searchSchema> = {
    name: "fs_search",
    label: "搜索文件",
    description: "在当前用户机器上按正则搜索文件内容。最多 100 条。",
    parameters: searchSchema,
    execute: async (_toolCallId, params, signal) => {
      const maxResults = Math.min(params.maxResults ?? 50, 100);
      const result = await client.search(params.path, params.pattern, maxResults, signal);
      const text = capHeadTail(result.hits.map((hit) => `${hit.path}:${hit.line}:${hit.text}`).join("\n"));
      const note = result.truncated ? "\n…[结果已截断]…" : "";
      return {
        content: [{ type: "text", text: (text || "（没有匹配）") + note }],
        details: { count: result.hits.length, truncated: result.truncated },
      };
    },
  };

  return [shell, read, write, list, search];
}
