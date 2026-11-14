import { cpSync, mkdirSync } from "node:fs";
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

const tag = process.argv[2] ?? "viate-bot/machine:dev";
const platform = process.argv[3];
const args = ["buildx", "build", "--load", "-t", tag, "-f", join(imageDir, "Dockerfile")];
if (platform) args.push("--platform", platform);
args.push(imageDir);

const docker = spawnSync("docker", args, { stdio: "inherit" });
process.exit(docker.status ?? 1);
