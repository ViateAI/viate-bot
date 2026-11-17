/**
 * 先解析再检查 IP，然后只按解析结果拨号。允许私网的谓词必须由调用方显式传入。
 */
import net from "node:net";
import {
  checkEgressTarget,
  defaultResolve,
  portAllowed,
  type BytePipe,
  type EgressFailCode,
} from "@viate-bot/protocol";

export interface DialOptions {
  allowFakeIp?: boolean;
  resolve?: (host: string) => Promise<string[]>;
  /** 缺省不传，私网一律拒绝。测试要放行时必须自己传入。 */
  allowPrivate?: (ip: string) => boolean;
  connect?: (address: string, port: number) => net.Socket;
}

export async function dialTarget(
  host: string,
  port: number,
  options: DialOptions = {},
): Promise<{ ok: true; pipe: BytePipe; address: string } | { ok: false; code: EgressFailCode; message: string }> {
  if (!portAllowed(port)) return { ok: false, code: "blocked", message: "端口不允许" };
  const resolve = options.resolve ?? defaultResolve;
  const decision = await checkEgressTarget(host, resolve, (ip) =>
    (options.allowFakeIp === true && /^198\.(18|19)\./.test(ip)) || options.allowPrivate?.(ip) === true,
  );
  if (!decision.ok) {
    if (decision.message.includes("198.18.0.0/15")) return { ...decision, message: `${decision.message}；客户端可显式启用 --allow-fake-ip（存在内网风险）` };
    return decision;
  }
  const connect = options.connect ?? ((address: string, target: number) => net.connect({ host: address, port: target, family: net.isIP(address) === 6 ? 6 : 4, allowHalfOpen: true }));
  const socket = connect(decision.address, port);
  const timer = setTimeout(() => socket.destroy(new Error("连接超时")), 10_000);
  const { promise, resolve: markOpen, reject: markFailed } = Promise.withResolvers<void>();
  socket.once("connect", () => markOpen());
  socket.once("error", () => markFailed(new Error("连接失败")));
  socket.once("close", () => markFailed(new Error("连接关闭")));
  try {
    await promise;
  } catch {
    return { ok: false, code: "connect", message: "连接失败" };
  } finally {
    clearTimeout(timer);
  }
  return { ok: true, pipe: socketPipe(socket), address: decision.address };
}

export function socketPipe(socket: net.Socket): BytePipe {
  return {
    write(chunk) {
      return socket.write(chunk);
    },
    end() {
      socket.end();
    },
    destroy() {
      socket.destroy();
    },
    pause() {
      socket.pause();
    },
    resume() {
      socket.resume();
    },
    onData(cb) {
      socket.on("data", (chunk: Buffer) => cb(Buffer.from(chunk)));
    },
    onEnd(cb) {
      socket.on("end", () => cb());
    },
    onDrain(cb) {
      socket.once("drain", () => cb());
    },
    onError(cb) {
      socket.on("error", () => cb());
    },
  };
}
