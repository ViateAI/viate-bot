import { buildApp, openContext, startReconcileLoop } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const ctx = openContext(config);
const app = buildApp(ctx);
const stop = startReconcileLoop(ctx);
const shutdown = async () => {
  stop();
  await app.close();
  ctx.db.$client.close();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await app.listen({ host: "0.0.0.0", port: config.port });
