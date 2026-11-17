import { describe, expect, it } from "vitest";
import { EGRESS_INITIAL_WINDOW, EGRESS_MAX_STREAMS, decodeEgressFrame, encodeEgressFrame, type EgressFrame } from "./egress.js";
import { createClientPeer, createMachinePeer, type BytePipe } from "./egress-peer.js";

function scriptedPipe(chunks: Buffer[]): BytePipe & { written: Buffer[]; send: (chunk: Buffer) => void; finish: () => void } {
  const written: Buffer[] = [];
  let onData: ((chunk: Buffer) => void) | null = null;
  let onDrain: (() => void) | null = null;
  let onEnd: (() => void) | null = null;
  return {
    send(chunk) { onData?.(chunk); },
    finish() { onEnd?.(); },
    written,
    write(chunk) {
      written.push(Buffer.from(chunk));
      return true;
    },
    end() {},
    destroy() {},
    pause() {},
    resume() {
      onDrain?.();
    },
    onData(cb) {
      onData = cb;
      for (const chunk of chunks) cb(chunk);
    },
    onEnd(cb) {
      onEnd = cb;
    },
    onDrain(cb) {
      onDrain = cb;
    },
    onError() {},
  };
}

describe("egress peer window", () => {
  it("reports a reset delivered immediately after OPEN_OK to a late close listener", async () => {
    const peer = createMachinePeer(() => undefined);
    const stream = peer.open("example.com", 443);
    peer.ingest(encodeEgressFrame({ type: "OPEN_OK", streamId: stream.id }));
    peer.ingest(encodeEgressFrame({ type: "RESET", streamId: stream.id }));
    await stream.ready;
    const closed: string[] = [];
    stream.onClose((info) => closed.push(info.kind));
    expect(closed).toEqual(["reset"]);
  });

  it("bounds pending dials even when the machine immediately resets each stream", async () => {
    let dials = 0;
    const { promise, resolve } = Promise.withResolvers<{ ok: true; pipe: BytePipe }>();
    const peer = createClientPeer(() => undefined, () => { dials++; return promise; });
    for (let id = 1; id <= EGRESS_MAX_STREAMS + 1; id++) {
      peer.ingest(encodeEgressFrame({ type: "OPEN", streamId: id, host: "example.com", port: 443 }));
      peer.ingest(encodeEgressFrame({ type: "RESET", streamId: id }));
    }
    expect(dials).toBe(EGRESS_MAX_STREAMS);
    peer.close();
    resolve({ ok: true, pipe: scriptedPipe([]) });
    await promise;
  });

  it("flushes a window-blocked final chunk before emitting END", async () => {
    const pipe = scriptedPipe([]);
    let fromClient: (frame: Buffer) => void = () => undefined;
    const client = createClientPeer((frame) => fromClient(frame), async () => ({ ok: true, pipe }));
    const machine = createMachinePeer((frame) => client.ingest(frame));
    fromClient = (frame) => machine.ingest(frame);
    const stream = machine.open("example.com", 443);
    await stream.ready;
    const chunks: Buffer[] = [];
    stream.onData((chunk) => chunks.push(chunk));
    pipe.send(Buffer.alloc(EGRESS_INITIAL_WINDOW + 17, 65));
    pipe.finish();
    stream.consumed(EGRESS_INITIAL_WINDOW);
    expect(Buffer.concat(chunks).length).toBe(EGRESS_INITIAL_WINDOW + 17);
    stream.reset();
    client.close();
  });

  it("buffers response bytes received in the OPEN_OK turn until the consumer attaches", async () => {
    const peer = createMachinePeer(() => undefined);
    const stream = peer.open("example.com", 443);
    peer.ingest(encodeEgressFrame({ type: "OPEN_OK", streamId: stream.id }));
    peer.ingest(encodeEgressFrame({ type: "DATA", streamId: stream.id, payload: Buffer.from("response") }));
    await stream.ready;
    const received: Buffer[] = [];
    stream.onData((chunk) => received.push(chunk));
    expect(Buffer.concat(received).toString()).toBe("response");
  });

  it("resets a sender that exceeds the unconsumed receive window", async () => {
    const sent: EgressFrame[] = [];
    const peer = createMachinePeer((frame) => sent.push(decodeEgressFrame(frame)));
    const stream = peer.open("example.com", 443);
    peer.ingest(encodeEgressFrame({ type: "OPEN_OK", streamId: stream.id }));
    await stream.ready;
    stream.onData(() => undefined);
    for (let i = 0; i < 5; i++) peer.ingest(encodeEgressFrame({ type: "DATA", streamId: stream.id, payload: Buffer.alloc(65536) }));
    expect(peer.openStreams).toBe(0);
    expect(sent.at(-1)?.type).toBe("RESET");
  });

  it("rejects credit that was never consumed instead of inflating the window", async () => {
    const peer = createMachinePeer(() => undefined);
    const stream = peer.open("example.com", 443);
    peer.ingest(encodeEgressFrame({ type: "OPEN_OK", streamId: stream.id }));
    await stream.ready;
    peer.ingest(encodeEgressFrame({ type: "CREDIT", streamId: stream.id, credit: 1 }));
    expect(peer.openStreams).toBe(0);
  });

  it("rejects duplicate OPEN while preserving the original pending dial", async () => {
    const { promise, resolve } = Promise.withResolvers<{ ok: true; pipe: BytePipe }>();
    let dials = 0;
    const peer = createClientPeer(() => undefined, () => { dials++; return promise; });
    const open = encodeEgressFrame({ type: "OPEN", streamId: 9, host: "example.com", port: 80 });
    peer.ingest(open);
    expect(() => peer.ingest(open)).toThrow();
    expect(dials).toBe(1);
    peer.close();
    resolve({ ok: true, pipe: scriptedPipe([]) });
    await promise;
  });

  it("does not send DATA beyond the initial window until CREDIT arrives", async () => {
    const sent: EgressFrame[] = [];
    const peer = createMachinePeer((frame) => sent.push(decodeEgressFrame(frame)));
    const tunnel = peer.open("example.com", 443);
    peer.ingest(encodeEgressFrame({ type: "OPEN_OK", streamId: tunnel.id }));
    await tunnel.ready;
    const extra = 32;
    expect(tunnel.write(Buffer.alloc(EGRESS_INITIAL_WINDOW + extra, 7))).toBe(EGRESS_INITIAL_WINDOW);
    expect(tunnel.write(Buffer.alloc(extra))).toBe(0);
    const sentBytes = sent
      .filter((frame) => frame.type === "DATA")
      .reduce((sum, frame) => sum + (frame.type === "DATA" ? frame.payload.length : 0), 0);
    expect(sentBytes).toBe(EGRESS_INITIAL_WINDOW);
    peer.ingest(encodeEgressFrame({ type: "CREDIT", streamId: tunnel.id, credit: extra }));
    expect(tunnel.write(Buffer.alloc(extra, 9))).toBe(extra);
  });

  it("returns OPEN_FAIL when the dialer rejects a private target", async () => {
    const sent: EgressFrame[] = [];
    const peer = createClientPeer(
      (frame) => sent.push(decodeEgressFrame(frame)),
      async () => ({ ok: false, code: "blocked", message: "目标地址不允许" }),
    );
    peer.ingest(encodeEgressFrame({ type: "OPEN", streamId: 4, host: "127.0.0.1", port: 80 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual([{ type: "OPEN_FAIL", streamId: 4, code: "blocked", message: "目标地址不允许" }]);
  });

  it("credits the sender only after the local pipe accepts the bytes", async () => {
    const sent: EgressFrame[] = [];
    const pipe = scriptedPipe([]);
    const peer = createClientPeer(
      (frame) => sent.push(decodeEgressFrame(frame)),
      async () => ({ ok: true, pipe }),
    );
    peer.ingest(encodeEgressFrame({ type: "OPEN", streamId: 3, host: "example.com", port: 443 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent[0]).toEqual({ type: "OPEN_OK", streamId: 3 });
    peer.ingest(encodeEgressFrame({ type: "DATA", streamId: 3, payload: Buffer.from("hi") }));
    expect(pipe.written).toEqual([Buffer.from("hi")]);
    expect(sent.at(-1)).toEqual({ type: "CREDIT", streamId: 3, credit: 2 });
  });
});
