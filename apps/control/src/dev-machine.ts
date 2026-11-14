import { parseArgs } from "node:util";
import { buildApp, openContext } from "./app.js";
import { loadConfig } from "./config.js";

const commands = ["create", "start", "stop", "rebuild", "delete", "inspect"] as const;
type Command = (typeof commands)[number];

const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: true });
const [command, userId] = positionals;
if (!isCommand(command) || !userId) {
  console.error(`用法: pnpm --filter @viate-bot/control machine <${commands.join("|")}> <userId>`);
  process.exit(1);
}

const config = loadConfig();
if (!config.dev) {
  console.error("机器管理命令只在 VB_DEV=1 时可用");
  process.exit(1);
}

const ctx = openContext(config);
const app = buildApp(ctx);
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("控制面没有监听地址");
  const path =
    command === "create" || command === "delete" || command === "inspect"
      ? `/dev/machines/${userId}`
      : `/dev/machines/${userId}/${command}`;
  const method = command === "inspect" ? "GET" : command === "delete" ? "DELETE" : "POST";
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
  const body = await response.text();
  if (!response.ok) {
    console.error(body);
    process.exitCode = 1;
  } else {
    console.log(body);
  }
} finally {
  await app.close();
  ctx.db.$client.close();
}

function isCommand(value: string | undefined): value is Command {
  return commands.some((command) => command === value);
}
