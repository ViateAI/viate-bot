import type { ReactNode } from "react";

export const FILE_LIMIT = 25 * 1024 * 1024;
export const MESSAGE_FILE_LIMIT = 10;
export const MESSAGE_BYTE_LIMIT = 100 * 1024 * 1024;

export interface LocalFile {
  name: string;
  size: number;
  type: string;
}

export interface AttachmentView {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: "image" | "file";
}

export interface PendingItem extends AttachmentView {
  preview?: string;
  failed?: boolean;
  error?: string;
  file?: File;
}

export function reserveIncoming<T extends LocalFile>(
  held: readonly LocalFile[],
  incoming: readonly T[],
): { held: LocalFile[]; accepted: T[]; error: string } {
  const decision = takeFiles([...held], incoming);
  return {
    held: [...held, ...decision.accepted.map((file) => ({ name: file.name, size: file.size, type: file.type }))],
    accepted: decision.accepted,
    error: decision.error,
  };
}

export function sendBlocked(input: {
  sending: boolean;
  uploading: number;
  pending: readonly PendingItem[];
  text: string;
}): boolean {
  if (input.sending || input.uploading > 0 || input.pending.some((item) => item.failed)) return true;
  const ready = input.pending.filter((item) => !item.failed);
  return input.text.trim().length === 0 && ready.length === 0;
}

export function composerEnterSubmits(
  event: { key: string; shiftKey?: boolean; composing?: boolean },
  blocked: boolean,
): boolean {
  if (blocked || event.key !== "Enter" || event.shiftKey || event.composing) return false;
  return true;
}

export function ComposerSend({ blocked, children }: { blocked: boolean; children: ReactNode }) {
  return (
    <button
      data-testid="send-message"
      aria-label="发送"
      className="mb-0.5 grid size-10 shrink-0 place-items-center rounded-full bg-neutral-900 text-white disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
      type="submit"
      disabled={blocked}
    >
      {children}
    </button>
  );
}

export function withoutSent<T extends { id: string }>(items: readonly T[], sentIds: readonly string[]): T[] {
  const sent = new Set(sentIds);
  return items.filter((item) => !sent.has(item.id));
}

export function takeFiles<T extends LocalFile>(current: LocalFile[], incoming: readonly T[]): { accepted: T[]; error: string } {
  const accepted: T[] = [];
  let error = "";
  let count = current.length;
  let total = 0;
  for (const file of current) total += file.size;
  for (const file of incoming) {
    if (file.size > FILE_LIMIT) {
      error = `单个文件不能超过 25 MB：${file.name}`;
      continue;
    }
    if (count >= MESSAGE_FILE_LIMIT) {
      error = "一条消息最多 10 个附件";
      continue;
    }
    if (total + file.size > MESSAGE_BYTE_LIMIT) {
      error = "一条消息的附件合计不能超过 100 MB";
      continue;
    }
    accepted.push(file);
    count += 1;
    total += file.size;
  }
  return { accepted, error };
}

export function formatBytes(size: number): string {
  if (size >= 1024 * 1024) {
    const text = (size / (1024 * 1024)).toFixed(1);
    return `${text.endsWith(".0") ? text.slice(0, -2) : text} MB`;
  }
  if (size >= 1024) {
    const text = (size / 1024).toFixed(1);
    return `${text.endsWith(".0") ? text.slice(0, -2) : text} KB`;
  }
  return `${size} B`;
}

export function PendingAttachments({
  items,
  onRemove,
  onRetry,
}: {
  items: PendingItem[];
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul data-testid="pending-attachments" className="mx-auto mb-2 flex w-full max-w-3xl gap-2 overflow-x-auto px-4">
      {items.map((item) => (
        <li key={item.id} data-testid="pending-attachment" className="flex items-center gap-2 rounded-2xl bg-white px-2 py-2 text-sm ring-1 ring-black/10">
          {item.kind === "image" && item.preview ? (
            <img src={item.preview} alt={item.name} className="size-12 rounded-lg object-cover" />
          ) : (
            <span className="max-w-40 truncate">{item.name}</span>
          )}
          <span className="text-neutral-500">{formatBytes(item.size)}</span>
          {item.failed && onRetry ? (
            <button type="button" data-testid={`retry-attachment-${item.id}`} className="px-1 text-neutral-700" onClick={() => onRetry(item.id)}>
              重试
            </button>
          ) : null}
          <button type="button" data-testid={`remove-attachment-${item.id}`} className="px-1 text-neutral-500" onClick={() => onRemove(item.id)}>
            移除
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AttachmentCards({ items }: { items: AttachmentView[] }) {
  if (items.length === 0) return null;
  return (
    <ul data-testid="message-attachments" className="mt-2 grid gap-2">
      {items.map((item) => (
        <li key={item.id}>
          {item.kind === "image" ? (
            <a href={`/api/uploads/${item.id}`} target="_blank" rel="noreferrer">
              <img data-testid="message-image" src={`/api/uploads/${item.id}`} alt={item.name} className="max-h-40 rounded-lg" />
            </a>
          ) : (
            <a data-testid="message-file" href={`/api/uploads/${item.id}`} className="flex items-center gap-2 rounded-xl bg-neutral-100 px-3 py-2 text-sm text-neutral-800">
              <span className="truncate">{item.name}</span>
              <span className="text-neutral-500">{formatBytes(item.size)}</span>
              <span className="text-neutral-500">{item.mime}</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
