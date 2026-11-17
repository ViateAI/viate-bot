import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** machined has SETUID/SETGID but no CAP_KILL; bot owns its execution groups. */
export async function killProcessGroup(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    if ((error as NodeJS.ErrnoException).code !== "EPERM" || process.getuid?.() !== 0) throw error;
    await execFileAsync(process.execPath, ["-e", "try { process.kill(-Number(process.argv[1]), 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }", String(pid)], { uid: 1000, gid: 1000 });
  }
}
