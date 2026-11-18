import { expect, it } from "vitest";
import type { BrowserClient } from "@viate-bot/browser";
import { browserApprovalUrl, type BoundBrowser } from "./browser-session.js";

it("authorizes the indexed tab for close/switch and re-reads the current URL after navigation", async () => {
  let current = "https://allowed.internal";
  const client = {
    evaluate: async () => current,
    listTabs: async () => [
      { index: 0, url: current, title: "allowed", active: true },
      { index: 1, url: "https://outside.example", title: "outside", active: false },
    ],
  } as unknown as BrowserClient;
  const bound: BoundBrowser = { botId: "b", run: (action) => action(client) };
  expect(await browserApprovalUrl(bound, "browser_tabs", { action: "close", index: 1 })).toBe("https://outside.example");
  expect(await browserApprovalUrl(bound, "browser_tabs", { action: "switch", index: 1 })).toBe("https://outside.example");
  expect(await browserApprovalUrl(bound, "browser_tabs", { action: "close", index: 99 })).toBeUndefined();
  current = "https://redirected.example";
  expect(await browserApprovalUrl(bound, "browser_click", { ref: "e1", url: "https://allowed.internal" })).toBe(current);
});
