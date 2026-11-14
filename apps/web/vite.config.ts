import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = process.env.VITE_CONTROL_ORIGIN ?? "http://127.0.0.1:4418";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4420,
    strictPort: true,
    proxy: {
      "/api": target,
      "/auth": target,
      "/ws": { target, ws: true },
    },
  },
});
