import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCli } from "./cli.js";
import { writeTokenFile } from "./token.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("egress cli", () => {
  it("does not enable the private allow list unless the flag is present", () => {
    expect(parseCli(["run", "--base", "http://127.0.0.1:4418"]).allowPrivate).toBeUndefined();
    expect(() => parseCli(["run", "--base", "http://127.0.0.1:4418", "--allow-private"])).toThrow(/显式/);
    expect(parseCli(["run", "--allow-private", "10.1.2.3"]).allowPrivate).toEqual(["10.1.2.3"]);
  });

  it("writes the token file with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-egress-token-"));
    dirs.push(dir);
    const path = join(dir, "nested", "token");
    writeTokenFile(path, "secret-token");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
