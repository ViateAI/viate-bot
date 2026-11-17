/**
 * 控制面只改 streamId 并转发。不解析 DATA。
 * 出站 bufferedAmount 超过上限就复位这条流，不再把帧排进内存。
 */
import {
  EGRESS_MAX_STREAMS,
  EGRESS_OPEN_TIMEOUT_MS,
  FRAME_OPEN,
  decodeEgressFrame,
  encodeEgressFrame,
  rewriteStreamId,
  type EgressFrame,
} from "@viate-bot/protocol";
import type { RawData } from "ws";

export const RELAY_BUFFER_CAP = 1024 * 1024;

export interface RelaySocket {
  bufferedAmount: number;
  readyState: number;
  send(data: Buffer | string): void;
  terminate(): void;
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): void;
  on(event: "close", listener: () => void): void;
  off(event: "message", listener: (data: RawData, isBinary: boolean) => void): void;
  off(event: "close", listener: () => void): void;
}

export interface Relay {
  close(): void;
  readonly highWater: number;
  readonly forwardedToClient: number;
  readonly forwardedToMachine: number;
}

export function attachRelay(
  machine: RelaySocket,
  client: RelaySocket,
  options: {
    openTimeoutMs?: number;
    onBytes?: (direction: "toClient" | "toMachine", bytes: number) => void;
    onClientOpen?: () => void;
  } = {},
): Relay {
  const openTimeoutMs = options.openTimeoutMs ?? EGRESS_OPEN_TIMEOUT_MS;
  const machineToClient = new Map<number, number>();
  const clientToMachine = new Map<number, number>();
  const timers = new Map<number, NodeJS.Timeout>();
  const half = new Set<string>();
  let nextId = 1;
  let closed = false;
  let highWater = 0;
  let forwardedToClient = 0;
  let forwardedToMachine = 0;

  const note = (amount: number) => {
    if (amount > highWater) highWater = amount;
  };
  const send = (socket: RelaySocket, frame: Buffer): boolean => {
    note(socket.bufferedAmount);
    if (socket.readyState !== 1) return false;
    if (socket.bufferedAmount + frame.length > RELAY_BUFFER_CAP) return false;
    socket.send(frame);
    note(socket.bufferedAmount);
    return true;
  };
  const drop = (machineId: number) => {
    clearTimeout(timers.get(machineId));
    timers.delete(machineId);
    const clientId = machineToClient.get(machineId);
    machineToClient.delete(machineId);
    if (clientId !== undefined) clientToMachine.delete(clientId);
    half.delete(`m:${machineId}`);
    half.delete(`c:${machineId}`);
  };
  const resetBoth = (machineId: number) => {
    const clientId = machineToClient.get(machineId);
    if (!send(machine, encodeEgressFrame({ type: "RESET", streamId: machineId }))) machine.terminate();
    if (clientId !== undefined && !send(client, encodeEgressFrame({ type: "RESET", streamId: clientId }))) client.terminate();
    drop(machineId);
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const machineId of [...machineToClient.keys()]) {
      const clientId = machineToClient.get(machineId);
      if (machine.readyState === 1) {
        const frame = encodeEgressFrame({ type: "RESET", streamId: machineId });
        if (!send(machine, frame)) machine.terminate();
      }
      if (clientId !== undefined && client.readyState === 1) {
        const frame = encodeEgressFrame({ type: "RESET", streamId: clientId });
        if (!send(client, frame)) client.terminate();
      }
    }
    machineToClient.clear();
    clientToMachine.clear();
    machine.off("message", onMachine);
    machine.off("close", finish);
    client.off("message", onClient);
    client.off("close", finish);
  };
  const alloc = (): number | null => {
    if (machineToClient.size >= EGRESS_MAX_STREAMS) return null;
    for (let i = 0; i < 64; i += 1) {
      const id = nextId;
      nextId = nextId === 0xffff_ffff ? 1 : nextId + 1;
      if (!clientToMachine.has(id)) return id;
    }
    return null;
  };
  const noteEnd = (side: "m" | "c", machineId: number) => {
    half.add(`${side}:${machineId}`);
    if (half.has(`m:${machineId}`) && half.has(`c:${machineId}`)) drop(machineId);
  };
  const forward = (socket: RelaySocket, sourceId: number, targetId: number, buf: Buffer, direction: "toClient" | "toMachine", frame: EgressFrame): void => {
    const out = rewriteStreamId(buf, targetId);
    if (frame.type === "DATA") {
      const payload = Math.max(0, buf.length - 5);
      if (direction === "toClient") forwardedToClient += payload;
      else forwardedToMachine += payload;
      options.onBytes?.(direction, payload);
    }
    if (!send(socket, out)) {
      resetBoth(sourceId);
      return;
    }
    if (frame.type === "RESET" || frame.type === "OPEN_FAIL") drop(sourceId);
    else if (frame.type === "END") noteEnd(direction === "toClient" ? "m" : "c", sourceId);
    else if (frame.type === "OPEN_OK") {
      clearTimeout(timers.get(sourceId));
      timers.delete(sourceId);
    }
  };

  const onMachine = (data: RawData, isBinary: boolean) => {
    if (closed) return;
    if (!isBinary) {
      finish();
      machine.terminate();
      return;
    }
    const buf = toBuffer(data);
    let frame: EgressFrame;
    try {
      frame = decodeEgressFrame(buf);
    } catch {
      finish();
      machine.terminate();
      return;
    }
    if (frame.type === "OPEN") {
      if (machineToClient.has(frame.streamId)) resetBoth(frame.streamId);
      const clientId = alloc();
      if (clientId === null) {
        send(machine, encodeEgressFrame({ type: "OPEN_FAIL", streamId: frame.streamId, code: "limit", message: "流数量达到上限" }));
        return;
      }
      machineToClient.set(frame.streamId, clientId);
      clientToMachine.set(clientId, frame.streamId);
      const out = rewriteStreamId(buf, clientId);
      if (!send(client, out)) {
        resetBoth(frame.streamId);
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(frame.streamId);
        if (!machineToClient.has(frame.streamId)) return;
        send(machine, encodeEgressFrame({ type: "OPEN_FAIL", streamId: frame.streamId, code: "timeout", message: "打开超时" }));
        resetBoth(frame.streamId);
      }, openTimeoutMs);
      timer.unref?.();
      timers.set(frame.streamId, timer);
      return;
    }
    const clientId = machineToClient.get(frame.streamId);
    if (clientId === undefined) return;
    if (frame.type === "OPEN_OK" || frame.type === "OPEN_FAIL") return;
    forward(client, frame.streamId, clientId, buf, "toClient", frame);
  };

  const onClient = (data: RawData, isBinary: boolean) => {
    if (closed) return;
    const buf = toBuffer(data);
    if (!isBinary || buf.length < 5 || buf[0] === FRAME_OPEN) {
      options.onClientOpen?.();
      client.terminate();
      finish();
      return;
    }
    let frame: EgressFrame;
    try {
      frame = decodeEgressFrame(buf);
    } catch {
      client.terminate();
      finish();
      return;
    }
    if (frame.type === "OPEN") {
      options.onClientOpen?.();
      client.terminate();
      finish();
      return;
    }
    const machineId = clientToMachine.get(frame.streamId);
    if (machineId === undefined) return;
    if (frame.type === "OPEN_OK" || frame.type === "OPEN_FAIL") {
      clearTimeout(timers.get(machineId));
      timers.delete(machineId);
    }
    const out = rewriteStreamId(buf, machineId);
    if (frame.type === "DATA") {
      const payload = Math.max(0, buf.length - 5);
      forwardedToMachine += payload;
      options.onBytes?.("toMachine", payload);
    }
    if (!send(machine, out)) {
      resetBoth(machineId);
      return;
    }
    if (frame.type === "RESET" || frame.type === "OPEN_FAIL") drop(machineId);
    else if (frame.type === "END") noteEnd("c", machineId);
  };

  machine.on("message", onMachine);
  machine.on("close", finish);
  client.on("message", onClient);
  client.on("close", finish);

  return {
    close: finish,
    get highWater() {
      return highWater;
    },
    get forwardedToClient() {
      return forwardedToClient;
    },
    get forwardedToMachine() {
      return forwardedToMachine;
    },
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
