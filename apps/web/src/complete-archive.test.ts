import { describe, expect, it } from "vitest";
import { consumePrivateUpload } from "./apps-page.js";

const published = {
  appId: "app-1",
  versionId: "v1",
  name: "m2-upload-verify-2",
  version: "1.0.0",
  warnings: ["清单里没有图标"],
};

describe("consumePrivateUpload", () => {
  it("shows the success message and drops busy even if a late progress event arrives and the list refresh never finishes", async () => {
    let percent: number | null = 0;
    let message = "";
    let warnings: string[] = [];
    let onProgress: (percent: number) => void = () => {};
    const pending = consumePrivateUpload({
      upload: (progress) => {
        onProgress = progress;
        progress(100);
        return Promise.resolve(published);
      },
      refresh: () => new Promise(() => {}),
      setPercent: (next) => { percent = next; },
      setMessage: (next) => { message = next; },
      setWarnings: (next) => { warnings = next; },
    });
    await Promise.resolve();
    onProgress(100);
    expect(percent).toBeNull();
    expect(message).toBe("已添加私有应用 m2-upload-verify-2");
    expect(warnings).toEqual(["清单里没有图标"]);
    void pending;
  });

  it("clears busy without a success message when the upload fails or is cancelled", async () => {
    const seen: string[] = [];
    await expect(consumePrivateUpload({
      upload: async () => { throw new Error("上传失败"); },
      refresh: async () => { seen.push("refresh"); },
      setPercent: () => { seen.push("idle"); },
      setMessage: () => { seen.push("message"); },
      setWarnings: () => { seen.push("warnings"); },
    })).rejects.toThrow("上传失败");
    await expect(consumePrivateUpload({
      upload: async () => { throw new Error("上传已取消"); },
      refresh: async () => { seen.push("refresh"); },
      setPercent: () => { seen.push("idle"); },
      setMessage: () => { seen.push("message"); },
      setWarnings: () => { seen.push("warnings"); },
    })).rejects.toThrow("上传已取消");
    expect(seen).toEqual(["idle", "idle"]);
  });
});
