import { createServer } from "node:http";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function startFakeModel(port: number): Promise<import("node:http").Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(script(body));
    });
  });
  return listen(server, port);
}

export function startFakeMachine(port: number, token: string): Promise<import("node:http").Server> {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/fs/read") {
        const parsed = JSON.parse(body) as { path?: string; encoding?: string };
        const content = parsed.encoding === "base64" ? PNG.toString("base64") : "hello";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: parsed.path, content, truncated: false }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "stdout", data: "ok\n" })}\n\ndata: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
    });
  });
  return listen(server, port);
}

function script(body: string): string {
  const text = lastUser(body);
  const recent = JSON.stringify(messagesSinceUser(body));
  const tools = toolCount(recent);
  if (text.includes("e2e-tools")) return tools >= 6 ? textSse("结论已经给出") : toolSse("shell_exec", { cmd: `echo round-${tools}` });
  if (text.includes("e2e-rename")) {
    return tools === 0
      ? toolSse("update_bot_profile", { name: "改名后的助手", bio: "E2E 简介", avatarPath: "/home/bot/face.png" })
      : textSse("名字已改");
  }
  if (text.includes("e2e-prompt")) return recent.includes("update_bot_profile") ? textSse("提示词保持原样") : toolSse("update_bot_profile", { instructions: "第二行\n改过的提示词" });
  if (text.includes("e2e-routine")) {
    return tools === 0
      ? toolSse("propose_routine", { cron: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "每天看一眼" })
      : textSse("草稿已提交");
  }
  if (text.includes("e2e-allow")) return tools === 0 ? toolSse("shell_exec", { cmd: "echo ok" }) : textSse("命令已执行");
  if (text.includes("e2e-deny")) return tools === 0 ? toolSse("shell_exec", { cmd: "echo no; true" }) : textSse("命令被拒绝");
  if (text.includes("e2e-skip-prompt")) return recent.includes("update_bot_profile") ? textSse("提示词已改") : toolSse("update_bot_profile", { instructions: "免审批提示词" });
  if (text.includes("e2e-skip-install")) {
    return recent.includes("install_mcp")
      ? textSse("安装步骤结束")
      : toolSse("install_mcp", { remote: { name: /app=([a-z0-9-]+)/.exec(text)?.[1] ?? "e2edemo", url: "http://127.0.0.1:9/mcp" }, reason: "端到端" });
  }
  if (text.includes("e2e-propose-deny")) {
    return recent.includes("propose_approval_rule")
      ? textSse("提议被拒绝")
      : toolSse("propose_approval_rule", { category: "shell", match: { prefix: "echo denied" } });
  }
  if (text.includes("e2e-propose")) {
    if (!recent.includes("propose_approval_rule")) return toolSse("propose_approval_rule", { category: "shell", match: { prefix: "echo proposed" } });
    if (!recent.includes("echo proposed")) return toolSse("shell_exec", { cmd: "echo proposed" });
    return textSse("规则已用");
  }
  if (text.includes("e2e-flip")) return recent.includes("update_bot_profile") ? textSse("尝试结束") : toolSse("update_bot_profile", { approveNone: false, name: "开关不该被关" });
  if (text.includes("e2e-budget")) return textSse("超预算", 5, 5);
  return textSse("在");
}

function lastUser(body: string): string {
  const json = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
  const users = (json.messages ?? []).filter((message) => message.role === "user");
  const last = users[users.length - 1]?.content;
  return typeof last === "string" ? last : JSON.stringify(last ?? "");
}

function messagesSinceUser(body: string): Array<{ role?: string; tool_calls?: unknown[] }> {
  const json = JSON.parse(body) as { messages?: Array<{ role?: string; tool_calls?: unknown[] }> };
  const messages = json.messages ?? [];
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      start = index + 1;
      break;
    }
  }
  return messages.slice(start);
}

function toolCount(body: string): number {
  const json = JSON.parse(body) as { messages?: Array<{ role?: string; tool_calls?: unknown[] }> } | Array<{ role?: string; tool_calls?: unknown[] }>;
  const messages = Array.isArray(json) ? json : json.messages ?? [];
  let results = 0;
  let calls = 0;
  for (const message of messages) {
    if (message.role === "tool" || message.role === "toolResult") results += 1;
    if (Array.isArray(message.tool_calls)) calls += message.tool_calls.length;
  }
  return Math.max(results, calls);
}

function textSse(text: string, prompt = 1, completion = 1): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: prompt, completion_tokens: completion } })}\n\ndata: [DONE]\n\n`;
}

function toolSse(name: string, args: unknown): string {
  const encoded = JSON.stringify(args);
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${name}`, function: { name, arguments: "" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: encoded } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function listen(server: import("node:http").Server, port: number): Promise<import("node:http").Server> {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

