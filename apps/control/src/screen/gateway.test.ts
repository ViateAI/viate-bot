import { describe, expect, it } from "vitest";
import { maySendFilteredFrame } from "./gateway.js";

describe("filtered VNC frame authorization", () => {
  it.each([4, 5, 6])("rechecks lease and epoch for input type %i", (type) => {
    let canControl = true;
    let epoch = 1;
    const stillAllowed = (ticket: number) => epoch === ticket && canControl;
    const frame = Buffer.from([type]);

    expect(maySendFilteredFrame(frame, 1, stillAllowed)).toBe(true);
    canControl = false;
    expect(maySendFilteredFrame(frame, 1, stillAllowed)).toBe(false);
    canControl = true;
    epoch += 1;
    expect(maySendFilteredFrame(frame, 1, stillAllowed)).toBe(false);
    expect(maySendFilteredFrame(frame, undefined, stillAllowed)).toBe(false);
  });

  it.each([0, 2, 3])("permits non-input type %i without a lease", (type) => {
    expect(maySendFilteredFrame(Buffer.from([type]), undefined, () => false)).toBe(true);
  });
});
