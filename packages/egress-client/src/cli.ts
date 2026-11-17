#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { allowPrivatePredicate } from "@viate-bot/protocol";
import { bindDevice, egressWebSocketUrl, startEgressClient } from "./client.js";
import { readTokenFile } from "./token.js";
import { readFileSync } from "node:fs";

interface Parsed {
  command: string;
  base: string;
  name: string;
  tokenFile: string;
  allowPrivate: string[] | undefined;
}

export function parseCli(argv: string[]): Parsed {
  let command = "";
  let base = "";
  let name = "这台电脑";
  let tokenFile = join(homedir(), ".viate-bot", "egress-token");
  let allowPrivate: string[] | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") base = argv[++i] ?? "";
    else if (arg === "--name") name = argv[++i] ?? "";
    else if (arg === "--token-file") tokenFile = argv[++i] ?? "";
    else if (arg === "--allow-private") {
      const value = argv[++i];
      if (!value) throw new Error("--allow-private 需要显式的地址列表");
      allowPrivate = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
      if (allowPrivate.length === 0) throw new Error("--allow-private 需要显式的地址列表");
    } else if (arg && !arg.startsWith("-") && !command) command = arg;
  }
  if (command !== "link" && command !== "run" && command !== "status") throw new Error("用法：viate-egress link|run|status");
  return { command, base, name, tokenFile, allowPrivate };
}

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed.command === "status") {
    let online = false;
    try {
      online = JSON.parse(readFileSync(`${parsed.tokenFile}.status`, "utf8")).online === true;
    } catch {
      online = false;
    }
    let hasToken = false;
    try {
      hasToken = readTokenFile(parsed.tokenFile).length > 0;
    } catch {
      hasToken = false;
    }
    process.stdout.write(`${JSON.stringify({ token: hasToken, online })}\n`);
    return;
  }
  if (!parsed.base) throw new Error("需要 --base");
  if (parsed.command === "link") {
    const bound = await bindDevice({
      baseUrl: parsed.base,
      deviceName: parsed.name,
      tokenFile: parsed.tokenFile,
      onUrl(url) {
        process.stdout.write(`${url}\n`);
      },
    });
    process.stdout.write(`${bound.url}\n`);
    process.stdout.write(`device ${bound.deviceId}\n`);
    return;
  }
  const token = readTokenFile(parsed.tokenFile);
  const allowPrivate = parsed.allowPrivate ? allowPrivatePredicate(parsed.allowPrivate) : undefined;
  const client = startEgressClient({
    url: egressWebSocketUrl(parsed.base),
    token,
    statusFile: `${parsed.tokenFile}.status`,
    ...(allowPrivate ? { allowPrivate } : {}),
  });
  const stop = () => {
    void client.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "失败"}\n`);
    process.exit(1);
  });
}
