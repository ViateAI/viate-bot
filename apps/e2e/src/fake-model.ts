import { createServer } from "node:http";
import { crc32, deflateSync, inflateSync } from "node:zlib";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

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
  const files = new Map<string, string>();
  const uploaded = new Map<string, Buffer>();
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
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/fs/upload") {
        const path = url.searchParams.get("path") ?? "";
        uploaded.set(path, raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path, bytes: raw.length, sha256: "abc" }));
        return;
      }
      const body = raw.toString("utf8");
      if (req.url === "/fs/read") {
        const parsed = JSON.parse(body) as { path?: string; encoding?: string };
        const content = parsed.encoding === "base64" ? PNG.toString("base64") : "hello";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: parsed.path, content, truncated: false }));
        return;
      }
      if (req.url === "/fs/write") {
        const parsed = JSON.parse(body) as { path?: string; content?: string };
        const path = parsed.path ?? "";
        const content = parsed.content ?? "";
        files.set(path, content);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path, bytes: Buffer.byteLength(content) }));
        return;
      }
      if (req.url === "/fs/pack") {
        const parsed = JSON.parse(body) as { path?: string };
        const root = (parsed.path ?? "").replace(/\/$/, "");
        const packed = [...files.entries()]
          .filter(([path]) => path === root || path.startsWith(`${root}/`))
          .map(([path, content]) => ({ path: path.slice(root.length + 1), data: Buffer.from(content) }));
        if (packed.length === 0 || packed.some((file) => file.path.length === 0)) {
          res.writeHead(400).end("empty");
          return;
        }
        res.writeHead(200, { "content-type": "application/x-tar" });
        res.end(tar(packed));
        return;
      }
      if (req.url?.startsWith("/apps/install")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ routines: [] }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/apps/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ mcpServers: [] }));
        return;
      }
      let stdout = "ok\n";
      try {
        const parsed = JSON.parse(body) as { cmd?: string };
        const match = parsed.cmd ? /\/home\/bot\/uploads\/\S+/.exec(parsed.cmd)?.[0] : undefined;
        if (match) stdout = `${uploaded.get(match)?.toString("utf8") ?? "missing"}\n`;
      } catch {
        stdout = "ok\n";
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "stdout", data: stdout })}\n\ndata: ${JSON.stringify({ type: "exit", code: 0, signal: null, timedOut: false })}\n\n`);
    });
  });
  return listen(server, port);
}

function tar(files: Array<{ path: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const field = (block: Buffer, value: number, start: number, length: number) => {
    block.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length, "ascii");
  };
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const header = Buffer.alloc(512);
    let name = file.path;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const split = name.lastIndexOf("/");
      prefix = name.slice(0, split);
      name = name.slice(split + 1);
    }
    header.write(name, 0, 100);
    field(header, 0o644, 100, 8);
    field(header, 0, 108, 8);
    field(header, 0, 116, 8);
    field(header, file.data.length, 124, 12);
    field(header, 0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    header.write(prefix, 345, 155);
    field(header, header.reduce((sum, byte) => sum + byte, 0), 148, 8);
    chunks.push(header, file.data, Buffer.alloc((512 - (file.data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function script(body: string): string {
  const text = lastUser(body);
  const recent = JSON.stringify(messagesSinceUser(body));
  const tools = toolCount(recent);
  if (text.includes("e2e-bot-send")) {
    if (tools === 0) {
      const name = /e2e-bot-send\s+(\S+)/.exec(text)?.[1] ?? "";
      return toolSse("send_to_bot", { bot: name, text: "请给出结论 e2e-bot-work" });
    }
    return textSse("已派出");
  }
  if (text.includes("【bot 消息")) return textSse("e2e-bot-result");
  if (text.includes("【bot 回复")) return textSse("e2e-bot-continued");
  if (text.includes("e2e-upload")) {
    if (tools === 0) {
      const path = /\/home\/bot\/uploads\/[^\s"\\]+notes\.txt/.exec(text)?.[0] ?? "";
      return toolSse("shell_exec", { cmd: `cat ${path}` });
    }
    const stdout = toolText(body).trim();
    const colors = imageColors(body);
    if (colors.length === 0) return textSse(`工具读到 ${stdout}，没有看到图片`);
    return textSse(`工具读到 ${stdout}，图片是${colors.join("、")}`);
  }
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
  if (text.includes("e2e-publish")) {
    const plugin = JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "e2enotes",
      description: "private notes",
    });
    const skill = "---\nname: e2enotes\ndescription: private notes\n---\nhello\n";
    if (!recent.includes("plugin.json")) return toolSse("fs_write", { path: "/tmp/e2enotes/plugin.json", content: plugin });
    if (!recent.includes("SKILL.md")) return toolSse("fs_write", { path: "/tmp/e2enotes/skills/e2enotes/SKILL.md", content: skill });
    if (!recent.includes("package_app")) return toolSse("package_app", { path: "/tmp/e2enotes", version: "1.0.0" });
    if (!recent.includes("install_mcp")) return toolSse("install_mcp", { catalog: { name: "e2enotes", version: "1.0.0" }, reason: "装到自己的机器" });
    if (!recent.includes("request_app_publish")) return toolSse("request_app_publish", { name: "e2enotes", version: "1.0.0", note: "请公开这个笔记技能" });
    return textSse("发布申请已提交");
  }
  return textSse("在");
}

function imageColors(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return [];
  }
  const colors: string[] = [];
  walk(parsed, (value) => {
    const marker = "base64,";
    const at = value.indexOf(marker);
    if (!value.startsWith("data:image/png;") || at < 0) return;
    const color = pngColor(Buffer.from(value.slice(at + marker.length), "base64"));
    if (color) colors.push(color);
  });
  return colors;
}

function walk(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) walk(Reflect.get(value, key), visit);
  }
}

function pngColor(bytes: Buffer): string | undefined {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) return undefined;
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) return undefined;
    const data = bytes.subarray(start, end);
    if (type === "IHDR") {
      if (data.length < 13 || data[8] !== 8 || data[12] !== 0) return undefined;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9] ?? 0;
      if (colorType !== 2 && colorType !== 6) return undefined;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }
  if (width < 1 || height < 1 || idat.length === 0) return undefined;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return undefined;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const rowSize = stride + 1;
  if (raw.length < rowSize * height) return undefined;
  const prior = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * rowSize];
    if (filter === undefined || filter > 4) return undefined;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * rowSize + 1 + x] ?? 0;
      const left = x >= channels ? current[x - channels] ?? 0 : 0;
      const up = prior[x] ?? 0;
      const upLeft = x >= channels ? prior[x - channels] ?? 0 : 0;
      current[x] = unfilter(filter, value, left, up, upLeft);
    }
    if (y === Math.floor((height - 1) / 2)) {
      const x = Math.floor((width - 1) / 2) * channels;
      red = current[x] ?? 0;
      green = current[x + 1] ?? 0;
      blue = current[x + 2] ?? 0;
    }
    prior.set(current);
  }
  if (red >= 180 && green <= 80 && blue <= 80) return "红色";
  if (blue >= 180 && red <= 80 && green <= 80) return "蓝色";
  if (green >= 180 && red <= 80 && blue <= 80) return "绿色";
  return `${red},${green},${blue}`;
}

function unfilter(filter: number, value: number, left: number, up: number, upLeft: number): number {
  if (filter === 1) return (value + left) & 255;
  if (filter === 2) return (value + up) & 255;
  if (filter === 3) return (value + Math.floor((left + up) / 2)) & 255;
  if (filter === 4) return (value + paeth(left, up, upLeft)) & 255;
  return value;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonal = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonal) return left;
  if (upDistance <= diagonal) return up;
  return upLeft;
}

function toolText(body: string): string {
  const json = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
  const tools = (json.messages ?? []).filter((message) => message.role === "tool");
  const content = tools[tools.length - 1]?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
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

