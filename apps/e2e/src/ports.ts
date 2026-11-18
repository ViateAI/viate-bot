import { execFile } from "node:child_process";

export interface Ports {
  control: number;
  web: number;
  idp: number;
  model: number;
  machine: number;
}

export async function pickPorts(): Promise<Ports> {
  const preferred: Ports = { control: 4418, web: 4420, idp: 4421, model: 4422, machine: 4423 };
  if (!(await anyBusy(preferred))) return preferred;
  const fallback: Ports = { control: 4430, web: 4431, idp: 4432, model: 4433, machine: 4434 };
  if (await anyBusy(fallback)) throw new Error("4418/4420-4423 和 4430-4434 都有端口被占用");
  return fallback;
}

async function anyBusy(ports: Ports): Promise<boolean> {
  const checks = await Promise.all(Object.values(ports).map((port) => listening(port)));
  return checks.some(Boolean);
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], (error) => resolve(!error));
  });
}
