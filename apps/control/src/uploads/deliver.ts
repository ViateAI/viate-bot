import { createReadStream, existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { ownedUploadPath } from "./store.js";

export async function deliverAttachments(
  dataDir: string,
  userId: string,
  files: ReadonlyArray<{ messageId: string; id: string; name: string; place?: string }>,
  upload: (path: string, body: Readable, deliveryId: string) => Promise<void>,
  skip: ReadonlySet<string>,
  markDelivered: (id: string) => void,
): Promise<void> {
  for (const file of files) {
    // 已成功投递的不再上传。机器上的副本可能已被用户或 bot 改过，不能按本地字节覆盖。
    if (skip.has(file.id)) continue;
    const remoteName = file.name.includes("/") || file.name.includes("\\") || file.name.includes("\0") ? "" : file.name;
    const local = remoteName.length > 0 ? ownedUploadPath(dataDir, userId, file.id) : undefined;
    if (!local || !existsSync(local)) throw new Error(`无法把 ${file.name} 放到机器上`);
    const stream = createReadStream(local);
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
