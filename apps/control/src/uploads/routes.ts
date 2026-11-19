import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticated } from "../auth.js";
import type { AppDatabase } from "../db/index.js";
import { userScope, type UserScope } from "../scope.js";
import { openMultipartFile } from "./multipart.js";
import { UploadRejected, findOwnedUpload, ownedUploadPath, saveUpload } from "./store.js";

export interface UploadRouteDeps {
  db: AppDatabase;
  dataDir: string;
  now: () => Date;
}

export function registerUploadRoutes(app: FastifyInstance, deps: UploadRouteDeps): void {
  app.addContentTypeParser(/^multipart\/form-data/i, (_request, payload, done) => {
    done(null, payload);
  });

  app.post("/api/uploads", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const body = request.body;
    if (!(body instanceof Readable)) return reply.code(400).send({ error: "\u9700\u8981\u7528 multipart \u4e0a\u4f20\u6587\u4ef6" });
    body.on("error", () => {});
    const header = request.headers["content-type"];
    const contentType = Array.isArray(header) ? header[0] : header;
    if (!contentType) return reply.code(400).send({ error: "\u9700\u8981\u7528 multipart \u4e0a\u4f20\u6587\u4ef6" });
    // \u5148\u5199\u56de\u72b6\u6001\u518d\u5173\u8fde\u63a5\uff0c\u5426\u5219\u8d85\u9650\u4e2d\u6b62\u65f6\u5ba2\u6237\u7aef\u770b\u4e0d\u5230\u539f\u56e0\u3002
    const closeLater = () => {
      reply.raw.once("finish", () => {
        if (!body.destroyed) body.destroy();
      });
    };
    try {
      const opened = await openMultipartFile(body, contentType);
      const saved = await saveUpload({
        db: deps.db,
        dataDir: deps.dataDir,
        userId: scope.userId,
        filename: opened.filename,
        stream: opened.file,
        now: deps.now(),
      });
      closeLater();
      return reply.code(201).send({
        upload: {
          id: saved.id,
          name: saved.name,
          size: saved.size,
          mime: saved.mime,
          kind: saved.kind,
          sha256: saved.sha256,
        },
      });
    } catch (error) {
      closeLater();
      if (error instanceof UploadRejected) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/uploads/:id", async (request, reply) => {
    const scope = scopeOf(request, reply);
    if (!scope) return;
    const row = findOwnedUpload(deps.db, scope.userId, request.params.id);
    const path = row ? ownedUploadPath(deps.dataDir, scope.userId, row.id) : undefined;
    if (!row || !path || !existsSync(path)) return reply.code(404).send({ error: "\u627e\u4e0d\u5230\u9644\u4ef6" });
    if (row.kind === "image") {
      return reply.header("x-content-type-options", "nosniff").type(row.mime).send(createReadStream(path));
    }
    return reply.header("content-disposition", contentDisposition(row.name)).type(row.mime).send(createReadStream(path));
  });
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function scopeOf(
  request: FastifyRequest,
  reply: FastifyReply,
): UserScope | undefined {
  const resolved = authenticated.get(request);
  if (!resolved) {
    reply.code(401).send({ error: "\u672a\u767b\u5f55" });
    return undefined;
  }
  return userScope(resolved.user.id);
}
