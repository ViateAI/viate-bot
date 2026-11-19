import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttachmentCards, ComposerSend, PendingAttachments, composerEnterSubmits, reserveIncoming, sendBlocked, takeFiles, withoutSent, type LocalFile, type PendingItem } from "./attachments.js";

function hasDisabledAttr(html: string): boolean {
  const tag = html.match(/<button\b[^>]*>/)?.[0] ?? "";
  const withoutClass = tag.replace(/\sclass="[^"]*"/, "");
  return /\sdisabled(?:=""|=|[\s>])/.test(withoutClass);
}

function local(name: string, size: number, type = "text/plain"): LocalFile {
  return { name, size, type };
}

describe("attachment composer", () => {
  it("rejects a file over 25 MB, an 11th file, and a total over 100 MB", () => {
    const big = takeFiles([], [local("big.bin", 25 * 1024 * 1024 + 1)]);
    expect(big.accepted).toEqual([]);
    expect(big.error).toMatch(/25 MB/);

    const many = Array.from({ length: 11 }, (_, index) => local(`f${index}.txt`, 10));
    const counted = takeFiles([], many);
    expect(counted.accepted).toHaveLength(10);
    expect(counted.error).toMatch(/10/);

    const heavy = takeFiles(
      [local("already.bin", 80 * 1024 * 1024)],
      [local("more.bin", 21 * 1024 * 1024)],
    );
    expect(heavy.accepted).toEqual([]);
    expect(heavy.error).toMatch(/100 MB/);

    const first = reserveIncoming([], Array.from({ length: 8 }, (_, index) => local(`a${index}.txt`, 10)));
    const second = reserveIncoming(first.held, Array.from({ length: 4 }, (_, index) => local(`b${index}.txt`, 10)));
    expect(first.accepted).toHaveLength(8);
    expect(second.accepted).toHaveLength(2);
    expect(second.held).toHaveLength(10);
    expect(second.error).toMatch(/10/);
    expect(withoutSent(
      [{ id: "sent" }, { id: "still-uploading" }],
      ["sent"],
    )).toEqual([{ id: "still-uploading" }]);
  });

  it("renders a pending image and file, and the sent message cards", () => {
    const pending = renderToStaticMarkup(
      <PendingAttachments
        items={[
          { id: "p1", name: "dot.png", size: 68, mime: "image/png", kind: "image", preview: "blob:dot" },
          { id: "p2", name: "notes.txt", size: 12, mime: "text/plain", kind: "file" },
        ]}
        onRemove={() => undefined}
      />,
    );
    expect(pending).toContain('data-testid="pending-attachments"');
    expect(pending).toContain('src="blob:dot"');
    expect(pending).toContain("notes.txt");
    expect(pending).toContain('data-testid="remove-attachment-p1"');

    const sent = renderToStaticMarkup(
      <AttachmentCards
        items={[
          { id: "u1", name: "dot.png", size: 68, mime: "image/png", kind: "image" },
          { id: "u2", name: "notes.txt", size: 12, mime: "text/plain", kind: "file" },
        ]}
      />,
    );
    expect(sent).toContain('data-testid="message-image"');
    expect(sent).toContain('src="/api/uploads/u1"');
    expect(sent).toContain('data-testid="message-file"');
    expect(sent).toContain("notes.txt");
    expect(sent).toContain("text/plain");
  });

  it("keeps the send button and enter from posting text while a file is uploading or a failed file is still attached", () => {
    const failed: PendingItem = {
      id: "local-fail",
      name: "notes.txt",
      size: 4,
      mime: "text/plain",
      kind: "file",
      failed: true,
      error: "上传失败",
    };
    const inFlight = sendBlocked({ sending: false, uploading: 1, pending: [], text: "只发文字" });
    const parallel = sendBlocked({ sending: false, uploading: 2, pending: [], text: "只发文字" });
    const oneBatchDone = sendBlocked({ sending: false, uploading: 1, pending: [], text: "只发文字" });
    const failedGate = sendBlocked({ sending: false, uploading: 0, pending: [failed], text: "只发文字" });
    const cleared = sendBlocked({ sending: false, uploading: 0, pending: [], text: "只发文字" });
    expect(inFlight).toBe(true);
    expect(parallel).toBe(true);
    expect(oneBatchDone).toBe(true);
    expect(failedGate).toBe(true);
    expect(cleared).toBe(false);
    expect(composerEnterSubmits({ key: "Enter" }, inFlight)).toBe(false);
    expect(composerEnterSubmits({ key: "Enter" }, failedGate)).toBe(false);
    expect(composerEnterSubmits({ key: "Enter", shiftKey: true }, cleared)).toBe(false);
    expect(composerEnterSubmits({ key: "Enter" }, cleared)).toBe(true);

    const button = renderToStaticMarkup(<ComposerSend blocked={inFlight || failedGate}>发送</ComposerSend>);
    expect(button).toContain('data-testid="send-message"');
    expect(hasDisabledAttr(button)).toBe(true);
    const open = renderToStaticMarkup(<ComposerSend blocked={cleared}>发送</ComposerSend>);
    expect(hasDisabledAttr(open)).toBe(false);

    let retries = 0;
    const row = renderToStaticMarkup(
      <PendingAttachments items={[failed]} onRemove={() => undefined} onRetry={() => { retries += 1; }} />,
    );
    expect(retries).toBe(0);
    expect(row).toContain("notes.txt");
    expect(row).toContain("重试");
    expect(row).toContain('data-testid="remove-attachment-local-fail"');
    const readyOnly = renderToStaticMarkup(
      <PendingAttachments
        items={[{ id: "ready-1", name: "ok.txt", size: 2, mime: "text/plain", kind: "file" }]}
        onRemove={() => undefined}
        onRetry={() => { retries += 1; }}
      />,
    );
    expect(readyOnly).not.toContain("重试");
    expect(retries).toBe(0);
  });
});
