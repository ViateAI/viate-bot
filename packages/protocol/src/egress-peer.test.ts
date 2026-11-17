import { describe, expect, it } from "vitest";
import { EGRESS_INITIAL_WINDOW, decodeEgressFrame, encodeEgressFrame, type EgressFrame } from "./egress.js";
import { createClientPeer, createMachinePeer, type BytePipe } from "./egress-peer.js";

function scriptedPipe(chunks: Buffer[]): BytePipe & { written: Buffer[] } {
  const written: Buffer[] = [];
  let onData: ((chunk: Buffer) => void) | null = null;
  let onDrain: (() => void) | null = null;
  return {
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
      void cb;
    },
    onDrain(cb) {
      onDrain = cb;
    },
  };
}

describe("egress peer window", () => {
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
