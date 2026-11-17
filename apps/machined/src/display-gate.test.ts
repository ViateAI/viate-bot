import { describe, expect, it } from "vitest";
import { VncClientGate } from "./display.js";

function key(keysym: number): Buffer {
  const frame = Buffer.alloc(8);
  frame[0] = 4;
  frame[1] = 1;
  frame.writeUInt32BE(keysym, 4);
  return frame;
}

function handshake(): Buffer {
  return Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1]), Buffer.from([1])]);
}

describe("VncClientGate", () => {
  it("forwards the handshake, then drops forged key, pointer, and clipboard frames until writable", () => {
    const gate = new VncClientGate();
    const update = Buffer.alloc(10);
    update[0] = 3;
    const pointer = Buffer.alloc(6);
    pointer[0] = 5;
    const clip = Buffer.alloc(8);
    clip[0] = 6;
    const extended = Buffer.alloc(16);
    extended[0] = 6;
    extended.writeInt32BE(-8, 4);
    const blocked = Buffer.concat(gate.push(Buffer.concat([handshake(), update, key(0x76), pointer, clip, extended]), false));
    expect(blocked.subarray(0, 14).toString("latin1")).toBe("RFB 003.008\n\x01\x01");
    expect([...blocked.subarray(14)]).toEqual([...update]);
    const open = Buffer.concat(gate.push(Buffer.concat([key(0x76), pointer]), true));
    expect(open.length).toBe(14);
    expect(open[0]).toBe(4);
    expect(open[8]).toBe(5);
  });
});
