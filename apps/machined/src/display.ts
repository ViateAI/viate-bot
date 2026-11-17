import { execFile, spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { WebSocketServer } from "ws";

const exec = promisify(execFile);
const env = { ...process.env, DISPLAY: ":1" };

/** 这次量到的窗口裁剪没能约束弹窗、文件选择器和全屏。交付共享屏幕、同一个 Chromium profile，以及每用户的浏览器和输入互斥。 */
export function screenMode(): "shared" { return "shared"; }

export function registerDisplayRoutes(app: FastifyInstance, options: { token: string }): void {
  const displays = new Set<number>();
  const writable = new Map<string, boolean>();
  const wss = new WebSocketServer({ noServer: true });
  let vnc: ChildProcess | undefined;
  const displayNumber = (value: string) => /^\d{1,6}$/.test(value) ? Number(value) : undefined;
  const run = async (command: string, args: string[]) => exec(command, args, { env, maxBuffer: 16 * 1024 * 1024, encoding: "buffer" });

  app.post<{ Params: { n: string } }>("/displays/:n", async (request, reply) => {
    const n = displayNumber(request.params.n);
    if (n === undefined) return reply.code(400).send({ error: "显示器编号无效" });
    displays.add(n);
    if (!vnc || vnc.exitCode !== null) {
      vnc = spawn("x11vnc", ["-display", ":1", "-localhost", "-rfbport", "5901", "-forever", "-shared", "-nopw"], { env, stdio: "ignore" });
      vnc.on("error", () => { vnc = undefined; });
    }
    return { display: n, mode: screenMode(), clip: { x: 0, y: 0, width: 1280, height: 720 } };
  });
  app.delete<{ Params: { n: string } }>("/displays/:n", async (request, reply) => {
    const n = displayNumber(request.params.n);
    if (n === undefined) return reply.code(400).send({ error: "显示器编号无效" });
    displays.delete(n);
    if (!displays.size) { vnc?.kill(); vnc = undefined; }
    return { ok: true };
  });
  app.post<{ Params: { n: string } }>("/displays/:n/screenshot", async (request, reply) => {
    const n = displayNumber(request.params.n);
    if (n === undefined || !displays.has(n)) return reply.code(404).send({ error: "找不到显示器" });
    const { stdout } = await run("import", ["-window", "root", "png:-"]);
    return { mime: "image/png", pngBase64: stdout.toString("base64"), width: stdout.readUInt32BE(16), height: stdout.readUInt32BE(20) };
  });
  app.post<{ Params: { n: string }; Body: { conn?: string; input?: boolean } }>("/displays/:n/vnc-mode", async (request, reply) => {
    const n = displayNumber(request.params.n);
    const conn = request.body?.conn;
    if (n === undefined || !displays.has(n) || typeof conn !== "string" || !/^[a-f0-9]{32}$/.test(conn) || !writable.has(conn)) {
      return reply.code(404).send({ error: "找不到画面连接" });
    }
    writable.set(conn, request.body?.input === true);
    return { ok: true };
  });
  app.post<{ Params: { n: string }; Body: Record<string, unknown> }>("/displays/:n/input", async (request, reply) => {
    const n = displayNumber(request.params.n);
    if (n === undefined || !displays.has(n)) return reply.code(404).send({ error: "找不到显示器" });
    const body = request.body;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "输入无效" });
    let args: string[];
    if (body.type === "text" && typeof body.text === "string") args = ["type", "--", body.text];
    else if (body.type === "key" && typeof body.key === "string" && typeof body.down === "boolean" && /^[A-Za-z0-9_+-]{1,64}$/.test(body.key)) args = [body.down ? "keydown" : "keyup", "--", body.key];
    else if (body.type === "mouse" && Number.isInteger(body.x) && Number.isInteger(body.y) && (body.x as number) >= 0 && (body.x as number) < 1280 && (body.y as number) >= 0 && (body.y as number) < 720 && [0, 1, 2].includes(body.button as number) && ["move", "down", "up"].includes(body.action as string)) {
      args = ["mousemove", String(body.x), String(body.y)];
      if (body.action !== "move") args.push(body.action === "down" ? "mousedown" : "mouseup", String((body.button as number) + 1));
    } else if (body.type === "wheel" && Number.isInteger(body.x) && Number.isInteger(body.y) && (body.x as number) >= 0 && (body.x as number) < 1280 && (body.y as number) >= 0 && (body.y as number) < 720 && Number.isInteger(body.dx) && Number.isInteger(body.dy) && Math.abs(body.dx as number) <= 100 && Math.abs(body.dy as number) <= 100) {
      args = ["mousemove", String(body.x), String(body.y)];
      const dx = body.dx as number;
      const dy = body.dy as number;
      if (dy) args.push("click", "--repeat", String(Math.abs(dy)), dy < 0 ? "4" : "5");
      if (dx) args.push("click", "--repeat", String(Math.abs(dx)), dx < 0 ? "6" : "7");
    } else return reply.code(400).send({ error: "输入无效" });
    await run("xdotool", args);
    return { ok: true };
  });
  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/displays\/(\d{1,6})\/vnc$/.exec(url.pathname);
    if (!match) return;
    const conn = url.searchParams.get("conn");
    if (request.headers.authorization !== `Bearer ${options.token}` || !displays.has(Number(match[1])) || !conn || !/^[a-f0-9]{32}$/.test(conn) || writable.has(conn)) { socket.destroy(); return; }
    writable.set(conn, false);
    wss.handleUpgrade(request, socket, head, (client) => {
      const tcp = connect(5901, "127.0.0.1");
      const gate = new VncClientGate();
      tcp.on("data", (data) => { if (client.readyState === client.OPEN) client.send(data); });
      tcp.on("error", () => client.close());
      tcp.on("close", () => client.close());
      client.on("message", (data) => {
        try {
          const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
          const frames = gate.push(chunk, writable.get(conn) === true);
          if (frames.length) tcp.write(Buffer.concat(frames));
        } catch {
          client.close();
        }
      });
      client.on("close", () => { writable.delete(conn); tcp.destroy(); });
      client.on("error", () => tcp.destroy());
    });
  });
  app.addHook("preClose", async () => { for (const client of wss.clients) client.terminate(); vnc?.kill(); });
  app.addHook("onClose", async () => { wss.close(); });
}

const MAX_VNC_MESSAGE = 1024 * 1024;

/** 无写授权时丢掉 KeyEvent、PointerEvent、ClientCutText。授权是这条连接上的服务端标志，不是浏览器里的 viewOnly。握手三步原样转发。 */
export class VncClientGate {
  private pending = Buffer.alloc(0);
  private handshake = 0;

  push(chunk: Buffer, writable: boolean): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > MAX_VNC_MESSAGE) throw new Error("RFB message too large");
    const output: Buffer[] = [];
    while (this.handshake < 3) {
      const length = this.handshake === 0 ? 12 : 1;
      if (this.pending.length < length) return output;
      const part = this.pending.subarray(0, length);
      if (this.handshake === 0 && part.toString() !== "RFB 003.008\n") throw new Error("RFB handshake invalid");
      output.push(part);
      this.pending = this.pending.subarray(length);
      this.handshake += 1;
    }
    while (this.pending.length) {
      const type = this.pending[0];
      let length: number;
      switch (type) {
        case 0: length = 20; break;
        case 2:
          if (this.pending.length < 4) return output;
          length = 4 + this.pending.readUInt16BE(2) * 4;
          break;
        case 3: length = 10; break;
        case 4: length = 8; break;
        case 5: length = 6; break;
        case 6: {
          if (this.pending.length < 8) return output;
          const payload = Math.abs(this.pending.readInt32BE(4));
          if (payload > MAX_VNC_MESSAGE - 8) throw new Error("RFB message too large");
          length = 8 + payload;
          break;
        }
        default: throw new Error("Unsupported RFB client message");
      }
      if (length > MAX_VNC_MESSAGE) throw new Error("RFB message too large");
      if (this.pending.length < length) break;
      if (type === 0 || type === 2 || type === 3 || writable) output.push(this.pending.subarray(0, length));
      this.pending = this.pending.subarray(length);
    }
    return output;
  }
}
