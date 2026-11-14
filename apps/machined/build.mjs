import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
};

await build({ ...shared, entryPoints: ["src/main.ts"], outfile: "dist/machined.mjs" });
await build({ ...shared, entryPoints: ["src/fs-worker.ts"], outfile: "dist/fs-worker.mjs" });
