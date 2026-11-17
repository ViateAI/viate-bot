const MAX_MESSAGE = 1024 * 1024;

export class RfbClientFilter {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer, canControl: () => boolean): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > MAX_MESSAGE) throw new Error("RFB message too large");
    const output: Buffer[] = [];
    while (this.pending.length) {
      const type = this.pending[0];
      let length: number;
      switch (type) {
        case 0: length = 20; break;
        case 2:
          if (this.pending.length < 4) return output;
          length = 4 + this.pending.readUInt16BE(2) * 4;
          break;
        case 3: length = 10; break;
        case 4: length = 8; break;
        case 5: length = 6; break;
        case 6: {
          if (this.pending.length < 8) return output;
          const payload = Math.abs(this.pending.readInt32BE(4));
          if (payload > MAX_MESSAGE - 8) throw new Error("RFB message too large");
          length = 8 + payload;
          break;
        }
        default: throw new Error("Unsupported RFB client message");
      }
      if (length > MAX_MESSAGE) throw new Error("RFB message too large");
      if (this.pending.length < length) break;
      if (type === 0 || type === 2 || type === 3 || canControl()) output.push(this.pending.subarray(0, length));
      this.pending = this.pending.subarray(length);
    }
    return output;
  }
}
