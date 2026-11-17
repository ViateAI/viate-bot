import { buildApp, openContext, startIntegrationJobs, startOpsMaintenance, startReconcileLoop, startRoutineLoop } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const ctx = openContext(config);
const app = buildApp(ctx);
const stopJobs = startIntegrationJobs(app);
const stop = startReconcileLoop(ctx);
const stopRoutines = startRoutineLoop(app, ctx);
const stopOps = startOpsMaintenance(ctx);
const shutdown = async () => {
  stopJobs();
  stop();
  stopRoutines();
  stopOps();
  await app.close();
  ctx.db.$client.close();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await app.listen({ host: "0.0.0.0", port: config.port });
