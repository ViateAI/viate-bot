import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

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

export interface ConfinePolicy {
  allow: string[];
  deny: string[];
}

/**
 * 把请求路径限制在 /home/bot 或 /tmp。
 * 先按词法拒绝 .. 逃逸，再把路径里每一层已经存在的符号链接解析掉。
 * 根目录本身是符号链接时（macOS 的 /tmp → /private/tmp）保留为允许范围。
 */
export function resolveConfined(requested: string): string {
  return resolveAccessible(requested, true);
}

/**
 * confine 为 false 时跳过根目录，仍拒绝空路径和相对路径。
 * 已经存在的符号链接会解析掉：打开文件用了 O_NOFOLLOW，不解析最后一层就读不到链接目标。
 * 只有布尔 false 放开。缺省和其它值继续限制。
 * 未传 confinePolicy，或 allow 与 deny 都为空时，仍用内置 /home/bot 与 /tmp。
 * allow 非空时替换这两个默认根；deny 优先于 allow。
 */
export function resolveAccessible(requested: string, confine: boolean, policy?: ConfinePolicy): string {
  if (requested.length === 0) throw new PathEscapeError("路径不能为空");
  if (requested.includes("\0")) throw new PathEscapeError("路径无效");
  if (!isAbsolute(requested)) throw new PathEscapeError("路径必须是绝对路径");
  if (!confine) return resolveOpen(requested);
  if (policy === undefined) return resolveInsideRoots(requested);
  const parsed = parseConfinePolicy(policy);
  if (parsed.allow.length === 0 && parsed.deny.length === 0) return resolveInsideRoots(requested);
  const allow = parsed.allow.length > 0 ? parsed.allow : [BOT_HOME, BOT_TMP];
  return resolveInsidePolicy(requested, allow, parsed.deny);
}

/** 畸形名单直接拒绝。`.` 和重复斜杠先收成词法路径，`..` 仍拒绝。 */
export function parseConfinePolicy(value: unknown): ConfinePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PathEscapeError("confinePolicy 必须是对象");
  }
  const record = value as { allow?: unknown; deny?: unknown };
  if (!Array.isArray(record.allow) || !Array.isArray(record.deny)) {
    throw new PathEscapeError("confinePolicy 的 allow 和 deny 必须是字符串数组");
  }
  if (record.allow.some((item) => typeof item !== "string") || record.deny.some((item) => typeof item !== "string")) {
    throw new PathEscapeError("confinePolicy 的 allow 和 deny 必须是字符串数组");
  }
  return { allow: record.allow.map((item) => canonicalPrefix(item)), deny: record.deny.map((item) => canonicalPrefix(item)) };
}

function boundaryMatch(prefix: string, target: string): boolean {
  return prefix === "/" || target === prefix || target.startsWith(`${prefix}/`);
}

function canonicalPrefix(path: string): string {
  if (typeof path !== "string" || path.includes("\0") || !path.startsWith("/")) {
    throw new PathEscapeError("目录限制名单含有非法路径");
  }
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new PathEscapeError("目录限制名单含有非法路径");
    parts.push(segment);
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

/**
 * 已存在的那一段做 realpath，再把尚未创建的后缀接回去。
 * 不能只返回存在的祖先，否则 deny `/work/secret` 不存在时会把整个 `/work` 拒绝，
 * allow 同理会把整个父目录放行。
 */
function anchoredReal(path: string): string | undefined {
  const missing: string[] = [];
  let cursor = path;
  while (true) {
    try {
      const real = realpathSync(cursor);
      if (missing.length === 0) return real;
      const suffix = missing.join("/");
      return real === "/" ? `/${suffix}` : `${real}/${suffix}`;
    } catch (error) {
      const missingFile = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
      if (!missingFile) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function expandedPrefixes(paths: string[], kind: "allow" | "deny"): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const prefix = canonicalPrefix(path);
    out.push(prefix);
    const real = anchoredReal(prefix);
    if (!real || real === prefix) continue;
    // `/tmp -> /private/tmp` 叶子名相同，真实路径也要算进范围。
    // 叶子名不同的符号链接（预置的 `workspace -> /etc`）不能把目标整棵放进白名单。
    if (kind === "allow" && basename(real) !== basename(prefix)) continue;
    out.push(real);
  }
  return out;
}

function assertTrustedAllowRoot(root: string, allowPrefixes: string[]): void {
  let stat: Stats;
  try {
    stat = lstatSync(root);
  } catch (error) {
    const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    if (missing) return;
    throw error;
  }
  if (!stat.isSymbolicLink()) return;
  const target = realpathSync(root);
  if (basename(target) === basename(root)) return;
  if (allowPrefixes.some((prefix) => prefix !== root && boundaryMatch(prefix, target))) return;
  throw new PathEscapeError(`路径不在允许目录范围内：${target}`);
}

function matchesPrefix(target: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => boundaryMatch(prefix, target));
}

function resolveInsidePolicy(requested: string, allow: string[], deny: string[]): string {
  const lexical = resolve(requested);
  const lexicalReal = anchoredReal(lexical);
  const allowPrefixes = expandedPrefixes(allow, "allow");
  const denyPrefixes = expandedPrefixes(deny, "deny");
  const denyHit = (target: string) => {
    if (matchesPrefix(target, denyPrefixes)) throw new PathEscapeError(`路径被目录限制黑名单拒绝：${target}`);
  };
  const allowMiss = (target: string) => {
    if (!matchesPrefix(target, allowPrefixes)) throw new PathEscapeError(`路径不在允许目录范围内：${target}`);
  };
  denyHit(lexical);
  if (lexicalReal && lexicalReal !== lexical) denyHit(lexicalReal);
  const lexicalOk = matchesPrefix(lexical, allowPrefixes);
  const realOk = lexicalReal !== undefined && matchesPrefix(lexicalReal, allowPrefixes);
  // 词法命中还不够：符号链接解析后的路径也必须落在白名单里。
  if (lexicalReal && lexicalReal !== lexical && !realOk) allowMiss(lexicalReal);
  if (!lexicalOk && !realOk) allowMiss(lexical);
  const walkPath = lexicalOk ? lexical : lexicalReal ?? lexical;
  const matched = allowPrefixes
    .filter((candidate) => boundaryMatch(candidate, walkPath))
    .sort((left, right) => right.length - left.length)[0];
  if (!matched) throw new PathEscapeError(`路径不在允许目录范围内：${walkPath}`);
  const root: string = matched;
  assertTrustedAllowRoot(root, allowPrefixes);

  let resolved = root;
  const rest = relative(root, walkPath);
  if (rest === "") return finish(resolved);

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
      denyHit(target);
      allowMiss(target);
      resolved = target;
      continue;
    }
    resolved = next;
  }
  return finish(resolved);

  function finish(path: string): string {
    const resolvedReal = existingReal(path);
    denyHit(path);
    denyHit(resolvedReal);
    const rootReal = existingReal(root);
    const realOk = resolvedReal === rootReal || resolvedReal.startsWith(`${rootReal}/`) || matchesPrefix(resolvedReal, allowPrefixes);
    if (!realOk) allowMiss(resolvedReal);
    allowMiss(path);
    return path;
  }
}

function resolveInsideRoots(requested: string): string {
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

function resolveOpen(requested: string): string {
  const lexical = resolve(requested);
  if (lexical.includes("\0")) throw new PathEscapeError("路径无效");
  let stat: Stats;
  try {
    stat = lstatSync(lexical);
  } catch (error) {
    const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    if (!missing) throw error;
    return lexical;
  }
  // 中间目录的符号链接交给 open 自己跟。只解开最后一层，否则 O_NOFOLLOW 读不到链接目标。
  if (!stat.isSymbolicLink()) return lexical;
  return realpathSync(lexical);
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

