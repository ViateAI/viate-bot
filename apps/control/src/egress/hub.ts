/**
 * 每个用户一条机器连接和若干设备连接。只有当前选中的设备接到 relay。
 * 客户端发来 OPEN 时 relay 会拆掉这条设备连接。
 */
import { EGRESS_PING_INTERVAL_MS, EGRESS_PONG_TIMEOUT_MS } from "@viate-bot/protocol";
import { WebSocket } from "ws";
import { egressRepository } from "../db/egress.js";
import { eventRepository } from "../db/events.js";
import type { AppDatabase } from "../db/index.js";
import { ulid } from "../id.js";
import { userScope } from "../scope.js";
import { attachRelay, type Relay, type RelaySocket } from "./relay.js";

export interface EgressEndpoint {
  host: string;
  port: number;
  token: string;
}

interface DeviceLink {
  userId: string;
  deviceId: string;
  socket: RelaySocket & HeartbeatSocket;
  stopHeartbeat: () => void;
}

interface Lane {
  userId: string;
  machineId: string;
  machine: RelaySocket | null;
  endpointKey: string;
  stopHeartbeat: () => void;
  relay: Relay | null;
  wasOnline: boolean;
  deviceId: string | null;
  toClient: number;
  toMachine: number;
  hour: string;
}

export interface EgressHub {
  connectEndpoint(userId: string, endpoint: EgressEndpoint): void;
  machineConnected(userId: string): boolean;
  attachClient(deviceId: string, userId: string, socket: RelaySocket & HeartbeatSocket, ip: string | null): boolean;
  disconnectDevice(deviceId: string): void;
  disconnectUser(userId: string): void;
  deviceOnline(userId: string, deviceId: string | null): boolean;
  onlineDeviceIds(userId: string): string[];
  paused(userId: string): boolean;
  pushConfig(userId: string): void;
  notifySettings(userId: string): void;
  onSelectedChange(listener: (userId: string, online: boolean) => void): void;
  flush(): void;
  close(): void;
}

export function createEgressHub(db: AppDatabase, now: () => Date = () => new Date()): EgressHub {
  const repo = egressRepository(db);
  const events = eventRepository(db);
  const lanes = new Map<string, Lane>();
  const devices = new Map<string, DeviceLink>();
  const listeners: Array<(userId: string, online: boolean) => void> = [];
  let stopped = false;
  const timer = setInterval(() => flushAll(), 30_000);
  timer.unref?.();

  function laneFor(userId: string): Lane | undefined {
    const settings = repo.settings(userScope(userId));
    if (!settings) return undefined;
    let lane = lanes.get(userId);
    if (!lane) {
      lane = {
        userId,
        machineId: settings.machineId,
        machine: null,
        endpointKey: "",
        stopHeartbeat: () => undefined,
        relay: null,
        wasOnline: false,
        deviceId: null,
        toClient: 0,
        toMachine: 0,
        hour: hourOf(now()),
      };
      lanes.set(userId, lane);
    }
    lane.machineId = settings.machineId;
    return lane;
  }

  function selectedSocket(userId: string): { deviceId: string; socket: RelaySocket } | null {
    const settings = repo.settings(userScope(userId));
    if (!settings?.deviceId) return null;
    const link = devices.get(settings.deviceId);
    if (!link || link.userId !== userId || link.socket.readyState !== 1) return null;
    return { deviceId: settings.deviceId, socket: link.socket };
  }

  function rebind(userId: string): void {
    if (stopped) return;
    const lane = laneFor(userId);
    if (!lane) return;
    flushLane(lane);
    lane.relay?.close();
    lane.relay = null;
    const selected = selectedSocket(userId);
    const online = Boolean(selected && lane.machine && lane.machine.readyState === 1);
    if (online && selected && lane.machine) {
      lane.deviceId = selected.deviceId;
      lane.relay = attachRelay(lane.machine, selected.socket, {
        onBytes(direction, bytes) {
          addBytes(lane, direction, bytes);
        },
        onClientOpen() {
          disconnectDevice(selected.deviceId);
        },
      });
    } else {
      lane.deviceId = null;
    }
    const changed = lane.wasOnline !== online;
    lane.wasOnline = online;
    if (changed) {
      if (!online && lane.machineId) {
        const settings = repo.settings(userScope(userId));
        if (settings?.mode === "user_network" && settings.offlinePolicy === "fallback_direct") {
          events.insert({
            id: ulid(now().getTime()),
            ts: now().toISOString(),
            userId,
            machineId: lane.machineId,
            type: "egress.fallback_direct",
            attrs: { machineId: lane.machineId },
          });
        }
      }
      for (const listener of listeners) listener(userId, online);
    }
    pushConfig(userId);
  }

  function addBytes(lane: Lane, direction: "toClient" | "toMachine", bytes: number): void {
    const hour = hourOf(now());
    if (hour !== lane.hour) flushLane(lane);
    lane.hour = hour;
    if (direction === "toClient") lane.toClient += bytes;
    else lane.toMachine += bytes;
  }

  function flushLane(lane: Lane): void {
    if (!lane.deviceId) {
      lane.toClient = 0;
      lane.toMachine = 0;
      return;
    }
    repo.addBytes(lane.machineId, lane.deviceId, lane.hour, lane.toClient, lane.toMachine);
    lane.toClient = 0;
    lane.toMachine = 0;
  }

  function flushAll(): void {
    for (const lane of lanes.values()) flushLane(lane);
  }

  function pushConfig(userId: string): void {
    const lane = lanes.get(userId);
    const settings = repo.settings(userScope(userId));
    if (!lane?.machine || lane.machine.readyState !== 1 || !settings) return;
    const payload = JSON.stringify({
      type: "config",
      egressMode: settings.mode,
      offlinePolicy: settings.offlinePolicy,
      deviceOnline: lane.wasOnline,
    });
    if (lane.machine.bufferedAmount + Buffer.byteLength(payload) > 64 * 1024) return;
    lane.machine.send(payload);
  }

  function disconnectDevice(deviceId: string): void {
    const link = devices.get(deviceId);
    if (!link) return;
    devices.delete(deviceId);
    link.stopHeartbeat();
    if (link.socket.readyState === 1) link.socket.terminate();
    rebind(link.userId);
  }

  function connectEndpoint(userId: string, endpoint: EgressEndpoint): void {
    const lane = laneFor(userId);
    if (!lane) return;
    const key = `${endpoint.host}:${endpoint.port}`;
    if (lane.machine && lane.machine.readyState === 1 && lane.endpointKey === key) {
      pushConfig(userId);
      return;
    }
    const previous = lane.machine;
    lane.machine = null;
    lane.stopHeartbeat();
    lane.stopHeartbeat = () => undefined;
    previous?.terminate();
    lane.endpointKey = key;
    const ws = new WebSocket(`ws://${endpoint.host}:${endpoint.port}/egress`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      maxPayload: 70 * 1024,
    });
    const stopHeartbeat = armHeartbeat(ws, () => ws.terminate());
    ws.on("open", () => {
      lane.machine = ws;
      lane.stopHeartbeat = stopHeartbeat;
      rebind(userId);
    });
    ws.on("close", () => {
      stopHeartbeat();
      if (lane.machine === ws) {
        lane.machine = null;
        lane.stopHeartbeat = () => undefined;
        rebind(userId);
      }
    });
    ws.on("error", () => ws.terminate());
  }

  return {
    connectEndpoint,
    machineConnected(userId) {
      return lanes.get(userId)?.machine?.readyState === 1;
    },
    attachClient(deviceId, userId, socket, ip) {
      if (repo.userStatus(userId) === "disabled") {
        socket.terminate();
        return false;
      }
      const previous = devices.get(deviceId);
      if (previous) {
        previous.stopHeartbeat();
        previous.socket.terminate();
        devices.delete(deviceId);
      }
      const stopHeartbeat = armHeartbeat(socket, () => disconnectDevice(deviceId));
      socket.on("close", () => {
        if (devices.get(deviceId)?.socket === socket) disconnectDevice(deviceId);
      });
      socket.on("pong", () => repo.touchDevice(deviceId, now().toISOString(), ip));
      devices.set(deviceId, { userId, deviceId, socket, stopHeartbeat });
      repo.touchDevice(deviceId, now().toISOString(), ip);
      rebind(userId);
      return true;
    },
    disconnectDevice,
    disconnectUser(userId) {
      for (const [deviceId, link] of [...devices]) {
        if (link.userId === userId) disconnectDevice(deviceId);
      }
    },
    deviceOnline(userId, deviceId) {
      if (!deviceId) return false;
      const link = devices.get(deviceId);
      return Boolean(link && link.userId === userId && link.socket.readyState === 1);
    },
    onlineDeviceIds(userId) {
      const ids: string[] = [];
      for (const link of devices.values()) {
        if (link.userId === userId && link.socket.readyState === 1) ids.push(link.deviceId);
      }
      return ids;
    },
    paused(userId) {
      const settings = repo.settings(userScope(userId));
      if (!settings || settings.mode !== "user_network" || settings.offlinePolicy !== "pause") return false;
      return !this.deviceOnline(userId, settings.deviceId);
    },
    pushConfig,
    notifySettings(userId) {
      rebind(userId);
    },
    onSelectedChange(listener) {
      listeners.push(listener);
    },
    flush: flushAll,
    close() {
      stopped = true;
      clearInterval(timer);
      flushAll();
      for (const deviceId of [...devices.keys()]) disconnectDevice(deviceId);
      for (const lane of lanes.values()) {
        lane.stopHeartbeat();
        lane.relay?.close();
        const machine = lane.machine;
        lane.machine = null;
        machine?.terminate();
      }
      lanes.clear();
    },
  };
}

export interface HeartbeatSocket {
  ping(): void;
  on(event: "pong", listener: () => void): void;
  off(event: "pong", listener: () => void): void;
}

function hourOf(date: Date): string {
  return date.toISOString().slice(0, 13);
}

export function armHeartbeat(socket: HeartbeatSocket, onDead: () => void): () => void {
  let last = Date.now();
  const onPong = () => {
    last = Date.now();
  };
  socket.on("pong", onPong);
  const timer = setInterval(() => {
    if (Date.now() - last > EGRESS_PONG_TIMEOUT_MS) {
      onDead();
      return;
    }
    try {
      socket.ping();
    } catch {
      onDead();
    }
  }, EGRESS_PING_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    socket.off("pong", onPong);
  };
}
