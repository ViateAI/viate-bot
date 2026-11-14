import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const BOT_HOME = "/home/bot";
export const BOT_TMP = "/tmp";
const ROOTS = [BOT_HOME, BOT_TMP];
let roots = ROOTS;

/** 测试用。生产代码不调用。 */
export function __setRootsForTest(next: string[]): void {
  roots = next;
}

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
  }
}

/**
 * 把请求路径限制在 /home/bot 或 /tmp。
 * 先按词法拒绝 .. 逃逸，再把路径里每一层已经存在的符号链接解析掉。
 * 根目录本身是符号链接时（macOS 的 /tmp → /private/tmp）保留为允许范围。
 */
export function resolveConfined(requested: string): string {
  if (!isAbsolute(requested)) throw new PathEscapeError("路径必须是绝对路径");
  const lexical = resolve(requested);
  const root = roots.find(
    (candidate) => lexical === candidate || (lexical.startsWith(`${candidate}/`) && !lexical.includes("\0")),
  );
  if (!root) throw new PathEscapeError(`路径超出 /home/bot 和 /tmp：${lexical}`);

  const rootReal = existingReal(root);
  let resolved = root;
  const rest = relative(root, lexical);
  if (rest === "") return resolved;

  for (const segment of rest.split("/")) {
    const next = resolve(resolved, segment);
    let stat: Stats;
    try {
      stat = lstatSync(next);
    } catch (error) {
      const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
      if (!missing) throw error;
      resolved = next;
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = realpathSync(next);
      if (target !== rootReal && !target.startsWith(`${rootReal}/`)) {
        throw new PathEscapeError(`符号链接超出 /home/bot 和 /tmp：${target}`);
      }
      resolved = target;
      continue;
    }
    resolved = next;
  }

  const resolvedReal = existingReal(resolved);
  if (resolvedReal !== rootReal && !resolvedReal.startsWith(`${rootReal}/`)) {
    throw new PathEscapeError(`解析后的路径超出 /home/bot 和 /tmp：${resolved}`);
  }
  return resolved;
}

function existingReal(path: string): string {
  let cursor = path;
  while (true) {
    try {
      return realpathSync(cursor);
    } catch (error) {
      const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
      if (!missing) throw error;
      const parent = resolve(cursor, "..");
      if (parent === cursor) return path;
      cursor = parent;
    }
  }
}

