import type { Readable } from "node:stream";
import type { UploadStorage } from "./storage.js";

export async function deliverAttachments(
  storage: UploadStorage,
  userId: string,
  files: ReadonlyArray<{ messageId: string; id: string; name: string; place?: string }>,
  upload: (path: string, body: Readable, deliveryId: string) => Promise<void>,
  skip: ReadonlySet<string>,
  markDelivered: (id: string) => void,
  unavailable?: (id: string) => boolean,
): Promise<void> {
  for (const file of files) {
    // 已成功投递的不再上传。机器上的副本可能已被用户或 bot 改过，不能按本地字节覆盖。
    if (skip.has(file.id)) continue;
    const remoteName = file.name.includes("/") || file.name.includes("\\") || file.name.includes("\0") ? "" : file.name;
    if (remoteName.length === 0 || unavailable?.(file.id)) throw new Error(`无法把 ${file.name} 放到机器上`);
    let stream: Readable;
    try {
      stream = await storage.get(userId, file.id);
    } catch {
      throw new Error(`无法把 ${file.name} 放到机器上`);
    }
    try {
      const directory = file.place ?? file.messageId;
      await upload(`/home/bot/uploads/${directory}/${remoteName}`, stream, `${file.id}_${directory}`);
      markDelivered(file.id);
    } catch (error) {
      stream.destroy();
      const reason = error instanceof Error ? error.message : "上传失败";
      throw new Error(`无法把 ${file.name} 放到机器上：${reason}`);
    }
  }
}
