import { spawn } from "node:child_process";

const [, , cwd, command] = process.argv;
if (!cwd || command === undefined) {
  process.stderr.write("usage: run-as-bot <cwd> <command>\n");
  process.exit(2);
}

if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  process.stderr.write("run-as-bot 必须以 root 启动\n");
  process.exit(127);
}

process.setgroups?.([]);
process.setgid(1000);
process.setuid(1000);

const child = spawn("/bin/sh", ["-c", command], {
  cwd,
  env: { ...process.env, HOME: "/home/bot", USER: "bot", LOGNAME: "bot" },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(127);
});
