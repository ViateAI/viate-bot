/**
 * 机器侧和客户端共用的流复用。窗口用完之前不再发 DATA，本地消费后用 CREDIT 归还。
 * 窗口上限是初始窗口的 8 倍：对端可以把已消费的额度还回来，不能靠发 CREDIT 把发送窗口撑到无界。
 */
import {
  EGRESS_INITIAL_WINDOW,
  EGRESS_MAX_DATA,
  EGRESS_MAX_STREAMS,
  decodeEgressFrame,
  encodeEgressFrame,
  type EgressFailCode,
  type EgressFrame,
} from "./egress.js";

const WINDOW_CAP = EGRESS_INITIAL_WINDOW * 8;

export class EgressOpenError extends Error {
  readonly code: EgressFailCode;
  constructor(code: EgressFailCode, message: string) {
    super(message);
    this.name = "EgressOpenError";
    this.code = code;
  }
}

export interface CloseInfo {
  kind: "end" | "reset" | "fail";
  code?: EgressFailCode;
  message?: string;
}

export interface Tunnel {
  readonly id: number;
  readonly ready: Promise<void>;
  write(chunk: Buffer): number;
  consumed(bytes: number): void;
  end(): void;
  reset(): void;
  onData(cb: (chunk: Buffer) => void): void;
  onDrain(cb: () => void): void;
  onClose(cb: (info: CloseInfo) => void): void;
}

export interface BytePipe {
  write(chunk: Buffer): boolean;
  end(): void;
  destroy(): void;
  pause(): void;
  resume(): void;
  onData(cb: (chunk: Buffer) => void): void;
  onEnd(cb: () => void): void;
  onDrain(cb: () => void): void;
}

export interface MachinePeer {
  open(host: string, port: number): Tunnel;
  ingest(frame: Buffer): void;
  failAll(code: EgressFailCode, message: string): void;
  readonly openStreams: number;
}

export interface ClientPeer {
  ingest(frame: Buffer): void;
  close(): void;
  readonly openStreams: number;
}

interface StreamState {
  id: number;
  sendWindow: number;
  ready: boolean;
  localEnded: boolean;
  remoteEnded: boolean;
  dead: boolean;
  onData: ((chunk: Buffer) => void) | null;
  onDrain: (() => void) | null;
  onClose: ((info: CloseInfo) => void) | null;
  resolve?: () => void;
  reject?: (error: Error) => void;
}

export function createMachinePeer(send: (frame: Buffer) => void): MachinePeer {
  const streams = new Map<number, StreamState>();
  let nextId = 1;
  const emit = (frame: EgressFrame) => {
    try {
      send(encodeEgressFrame(frame));
    } catch {
      /* 链路已经断开时由 failAll 收尾 */
    }
  };
  const api: MachinePeer = {
    get openStreams() {
      return streams.size;
    },
    open(host, port) {
      const id = allocate(streams, () => {
        const current = nextId;
        nextId = current === 0xffff_ffff ? 1 : current + 1;
        return current;
      });
      if (id === null) {
        const error = new EgressOpenError("limit", "流数量达到上限");
        const ready = Promise.reject(error);
        ready.catch(() => undefined);
        return closedTunnel(0, ready);
      }
      const state = makeState(id);
      const ready = new Promise<void>((resolve, reject) => {
        state.resolve = resolve;
        state.reject = reject;
      });
      ready.catch(() => undefined);
      streams.set(id, state);
      emit({ type: "OPEN", streamId: id, host, port });
      return tunnel(state, ready, emit, () => streams.delete(id));
    },
    ingest(frame) {
      const decoded = decodeEgressFrame(frame);
      const state = streams.get(decoded.streamId);
      if (!state || state.dead) return;
      if (decoded.type === "OPEN") {
        emit({ type: "RESET", streamId: state.id });
        finish(state, { kind: "reset" }, () => streams.delete(state.id));
        return;
      }
      applyPeerFrame(state, decoded, emit, () => streams.delete(state.id));
    },
    failAll(code, message) {
      for (const state of [...streams.values()]) {
        finish(state, { kind: "fail", code, message }, () => streams.delete(state.id));
      }
    },
  };
  return api;
}

export function createClientPeer(
  send: (frame: Buffer) => void,
  dial: (host: string, port: number) => Promise<{ ok: true; pipe: BytePipe } | { ok: false; code: EgressFailCode; message: string }>,
): ClientPeer {
  const streams = new Map<number, StreamState>();
  const pipes = new Map<number, BytePipe>();
  const emit = (frame: EgressFrame) => {
    try {
      send(encodeEgressFrame(frame));
    } catch {
      /* 同上 */
    }
  };
  return {
    get openStreams() {
      return streams.size;
    },
    close() {
      for (const pipe of pipes.values()) pipe.destroy();
      pipes.clear();
      for (const state of [...streams.values()]) finish(state, { kind: "reset" }, () => streams.delete(state.id));
    },
    ingest(frame) {
      const decoded = decodeEgressFrame(frame);
      if (decoded.type === "OPEN") {
        if (streams.size >= EGRESS_MAX_STREAMS) {
          emit({ type: "OPEN_FAIL", streamId: decoded.streamId, code: "limit", message: "流数量达到上限" });
          return;
        }
        const state = makeState(decoded.streamId);
        state.ready = true;
        streams.set(state.id, state);
        const tunnelApi = tunnel(state, Promise.resolve(), emit, () => {
          streams.delete(state.id);
          pipes.get(state.id)?.destroy();
          pipes.delete(state.id);
        });
        void dial(decoded.host, decoded.port)
          .then((result) => {
            if (state.dead) {
              if (result.ok) result.pipe.destroy();
              return;
            }
            if (!result.ok) {
              emit({ type: "OPEN_FAIL", streamId: state.id, code: result.code, message: result.message });
              finish(state, { kind: "fail", code: result.code, message: result.message }, () => streams.delete(state.id));
              return;
            }
            pipes.set(state.id, result.pipe);
            emit({ type: "OPEN_OK", streamId: state.id });
            result.pipe.onData((chunk) => pump(tunnelApi, chunk, result.pipe));
            result.pipe.onEnd(() => tunnelApi.end());
            tunnelApi.onData((chunk) => {
              const ok = result.pipe.write(chunk);
              if (ok) tunnelApi.consumed(chunk.length);
              else result.pipe.onDrain(() => tunnelApi.consumed(chunk.length));
            });
            tunnelApi.onClose((info) => {
              if (info.kind === "end") result.pipe.end();
              else result.pipe.destroy();
            });
          })
          .catch(() => {
            if (state.dead) return;
            emit({ type: "OPEN_FAIL", streamId: state.id, code: "connect", message: "连接失败" });
            finish(state, { kind: "fail", code: "connect", message: "连接失败" }, () => streams.delete(state.id));
          });
        return;
      }
      const state = streams.get(decoded.streamId);
      if (!state || state.dead) return;
      applyPeerFrame(state, decoded, emit, () => {
        pipes.get(state.id)?.destroy();
        pipes.delete(state.id);
        streams.delete(state.id);
      });
    },
  };
}

function pump(stream: Tunnel, chunk: Buffer, pipe: BytePipe): void {
  let offset = 0;
  const step = () => {
    while (offset < chunk.length) {
      const accepted = stream.write(chunk.subarray(offset));
      if (accepted <= 0) {
        pipe.pause();
        stream.onDrain(step);
        return;
      }
      offset += accepted;
    }
    pipe.resume();
  };
  step();
}

function allocate(streams: Map<number, StreamState>, next: () => number): number | null {
  if (streams.size >= EGRESS_MAX_STREAMS) return null;
  for (let i = 0; i < 64; i += 1) {
    const id = next();
    if (!streams.has(id)) return id;
  }
  return null;
}

function makeState(id: number): StreamState {
  return {
    id,
    sendWindow: EGRESS_INITIAL_WINDOW,
    ready: false,
    localEnded: false,
    remoteEnded: false,
    dead: false,
    onData: null,
    onDrain: null,
    onClose: null,
  };
}

function tunnel(state: StreamState, ready: Promise<void>, emit: (frame: EgressFrame) => void, release: () => void): Tunnel {
  return {
    id: state.id,
    ready,
    write(chunk) {
      if (!state.ready || state.dead || state.localEnded) return 0;
      let accepted = 0;
      while (accepted < chunk.length && state.sendWindow > 0) {
        const size = Math.min(state.sendWindow, EGRESS_MAX_DATA, chunk.length - accepted);
        emit({ type: "DATA", streamId: state.id, payload: chunk.subarray(accepted, accepted + size) });
        state.sendWindow -= size;
        accepted += size;
      }
      return accepted;
    },
    consumed(bytes) {
      if (state.dead || bytes <= 0) return;
      const credit = Math.min(bytes, 0xffff_ffff);
      emit({ type: "CREDIT", streamId: state.id, credit });
    },
    end() {
      if (state.dead || state.localEnded) return;
      state.localEnded = true;
      if (state.ready) emit({ type: "END", streamId: state.id });
      if (state.remoteEnded) finish(state, { kind: "end" }, release);
    },
    reset() {
      if (state.dead) return;
      emit({ type: "RESET", streamId: state.id });
      finish(state, { kind: "reset" }, release);
    },
    onData(cb) {
      state.onData = cb;
    },
    onDrain(cb) {
      state.onDrain = cb;
    },
    onClose(cb) {
      state.onClose = cb;
    },
  };
}

function applyPeerFrame(state: StreamState, frame: EgressFrame, emit: (frame: EgressFrame) => void, release: () => void): void {
  if (frame.type === "OPEN_OK") {
    if (!state.ready && !state.dead) {
      state.ready = true;
      state.resolve?.();
      const drain = state.onDrain;
      state.onDrain = null;
      drain?.();
    }
    return;
  }
  if (frame.type === "OPEN_FAIL") {
    finish(state, { kind: "fail", code: frame.code, message: frame.message }, release);
    return;
  }
  if (frame.type === "DATA") {
    if (!state.ready) {
      emit({ type: "RESET", streamId: state.id });
      finish(state, { kind: "reset" }, release);
      return;
    }
    state.onData?.(frame.payload);
    return;
  }
  if (frame.type === "CREDIT") {
    const room = WINDOW_CAP - state.sendWindow;
    if (room > 0) state.sendWindow += Math.min(frame.credit, room);
    if (state.sendWindow > 0) {
      const drain = state.onDrain;
      state.onDrain = null;
      drain?.();
    }
    return;
  }
  if (frame.type === "END") {
    state.remoteEnded = true;
    state.onClose?.({ kind: "end" });
    if (state.localEnded) finish(state, { kind: "end" }, release);
    return;
  }
  if (frame.type === "RESET") finish(state, { kind: "reset" }, release);
}

function finish(state: StreamState, info: CloseInfo, release: () => void): void {
  if (state.dead) return;
  state.dead = true;
  if (!state.ready) state.reject?.(new EgressOpenError(info.code ?? "connect", info.message ?? "流已关闭"));
  state.onClose?.(info);
  release();
}

function closedTunnel(id: number, ready: Promise<void>): Tunnel {
  return {
    id,
    ready,
    write: () => 0,
    consumed: () => undefined,
    end: () => undefined,
    reset: () => undefined,
    onData: () => undefined,
    onDrain: () => undefined,
    onClose: () => undefined,
  };
}
