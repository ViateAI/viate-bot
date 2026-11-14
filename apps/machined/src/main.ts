import { lchown, mkdir } from "node:fs/promises";
import { buildServer } from "./server.js";

if (process.getuid?.() === 0) {
  await mkdir("/home/bot", { recursive: true });
  await lchown("/home/bot", 1000, 1000);
}

const token = process.env.VB_MACHINED_TOKEN;
if (!token) {
  console.error("缺少 VB_MACHINED_TOKEN");
  process.exit(1);
}

const app = buildServer({ token, version: process.env.VB_MACHINED_VERSION ?? "0.0.0" });
const port = Number(process.env.VB_MACHINED_PORT ?? 7070);
await app.listen({ host: "0.0.0.0", port });
