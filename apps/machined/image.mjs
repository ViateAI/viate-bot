import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const imageDir = join(repo, "images/machine");
const bundle = join(repo, "apps/machined/dist/machined.mjs");
const worker = join(repo, "apps/machined/dist/fs-worker.mjs");

const build = spawnSync("pnpm", ["--filter", "@viate-bot/machined", "build"], {
  cwd: repo,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(imageDir, { recursive: true });
cpSync(bundle, join(imageDir, "machined.mjs"));
cpSync(worker, join(imageDir, "fs-worker.mjs"));
cpSync(join(repo, "LICENSE"), join(imageDir, "LICENSE"));

const tag = process.argv[2] ?? "viate-bot/machine:dev";
const platform = process.argv[3];
const protocolSrc = readFileSync(join(repo, "packages/protocol/src/index.ts"), "utf8");
const protocol = protocolSrc.match(/export const MACHINE_PROTOCOL_VERSION = (\d+);/)?.[1];
if (!protocol) {
  console.error("找不到 MACHINE_PROTOCOL_VERSION");
  process.exit(1);
}
const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
const revision = rev.status === 0 ? rev.stdout.trim() : "unknown";
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
if (typeof version !== "string" || version.length === 0) {
  console.error("根 package.json 没有 version");
  process.exit(1);
}
const args = [
  "buildx", "build", "--load", "-t", tag, "-f", join(imageDir, "Dockerfile"),
  "--build-arg", `MACHINE_PROTOCOL=${protocol}`,
  "--build-arg", `IMAGE_VERSION=${version}`,
  "--build-arg", `IMAGE_REVISION=${revision}`,
  "--build-arg", "IMAGE_SOURCE=https://github.com/ViateAI/viate-bot",
];
if (platform) args.push("--platform", platform);
args.push(imageDir);

const docker = spawnSync("docker", args, { stdio: "inherit" });
process.exit(docker.status ?? 1);
