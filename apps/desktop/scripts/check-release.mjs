import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const markers = ["VB_EGRESS_ALLOW_PRIVATE", "devPrivateAllowlist", "allow-private"];
const root = process.argv[2];
if (!root) throw new Error("用法：node scripts/check-release.mjs <输出目录>");

const archives = readdirSync(root, { recursive: true })
  .map(String)
  .filter((file) => file.endsWith("app.asar"))
  .map((file) => join(root, file));
if (archives.length === 0) throw new Error(`${root} 里没有 app.asar`);

for (const archive of archives) {
  const bytes = readFileSync(archive);
  for (const marker of markers) {
    if (bytes.includes(marker)) throw new Error(`发布包 ${archive} 包含测试入口 ${marker}`);
  }
}
console.log(`已检查 ${archives.length} 个发布包，没有测试入口`);
