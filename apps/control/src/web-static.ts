import { createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const dist = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** 生产构建存在时由 control 同源提供。开发时没有 dist，保持原来的 404。 */
export function registerWeb(app: FastifyInstance): void {
  const index = join(dist, "index.html");
  if (!existsSync(index)) return;
  const root = resolve(dist);
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(404).send({ error: "找不到" });
    }
    const path = (request.url.split("?")[0] ?? "/").split("#")[0] ?? "/";
    if (reserved(path)) return reply.code(404).send({ error: "找不到" });
    let relative = "index.html";
    if (path !== "/") {
      try {
        relative = decodeURIComponent(path).replace(/^\/+/, "");
      } catch {
        return reply.code(400).send({ error: "路径无法解码" });
      }
    }
    const file = resolve(root, relative);
    if (file !== root && !file.startsWith(root + sep)) return reply.code(404).send({ error: "找不到" });
    if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) {
      const type = mime(file);
      if (type) reply.type(type);
      return reply.send(createReadStream(file));
    }
    return reply.type("text/html; charset=utf-8").send(createReadStream(index));
  });
}

function reserved(path: string): boolean {
  path = path.toLowerCase();
  return (
    path === "/health" ||
    path.startsWith("/api/") ||
    path.startsWith("/auth/") ||
    path === "/ws" ||
    path.startsWith("/ws/") ||
    path.startsWith("/dev/")
  );
}

function mime(file: string): string | undefined {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".woff2")) return "font/woff2";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".ico")) return "image/x-icon";
  return undefined;
}
