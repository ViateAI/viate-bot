import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const noVncRoot = dirname(dirname(require.resolve("@novnc/novnc")));

const target = process.env.VITE_CONTROL_ORIGIN ?? "http://127.0.0.1:4418";

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: "third-party-sources",
    apply: "build",
    generateBundle() {
      // Minified MPL code is executable form. Ship the exact dependency source and notices alongside it.
      for (const path of readdirSync(noVncRoot, { recursive: true, withFileTypes: true })) {
        if (!path.isFile()) continue;
        const absolute = join(path.parentPath, path.name);
        const relative = absolute.slice(noVncRoot.length + 1).replaceAll("\\", "/");
        this.emitFile({ type: "asset", fileName: `third-party/novnc/${relative}`, source: readFileSync(absolute) });
      }
      this.emitFile({ type: "asset", fileName: "third-party/viate-bot-LICENSE.txt", source: readFileSync(new URL("../../LICENSE", import.meta.url)) });
    },
  }],
  server: {
    port: 4420,
    strictPort: true,
    proxy: {
      "/api": { target, ws: true },
      "/auth": target,
      "/ws": { target, ws: true },
    },
  },
});
