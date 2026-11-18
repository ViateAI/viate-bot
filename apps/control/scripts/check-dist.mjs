import { access } from "node:fs/promises";

// Importing the built package exercises its import-time asset read, without a src fallback.
await access(new URL("../dist/main.js", import.meta.url));
await access(new URL("../dist/apps/link-mcp.mjs", import.meta.url));
await import("../dist/apps/package-command.js");
console.log("dist smoke: main.js and linker exist; compiled package-command imports successfully");
