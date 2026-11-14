import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("integration package boundary", () => {
  it("imports the viate package only from the composition root", () => {
    const hits = sourceFiles(sourceRoot)
      .filter((path) => !path.endsWith(".test.ts"))
      .filter((path) => readFileSync(path, "utf8").includes('from "@viate-bot/integration-viate"'))
      .map((path) => relative(sourceRoot, path))
      .sort();
    expect(hits).toEqual(["compose.ts"]);
  });
});
