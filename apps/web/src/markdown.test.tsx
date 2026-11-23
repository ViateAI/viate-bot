import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./markdown.js";
import { usesMarkdown } from "./markdown-policy.js";

const sample = [
  "# 标题",
  "",
  "**粗** *斜* ~~删~~",
  "",
  "- 一项",
  "1. 有序",
  "",
  "- [ ] 待办",
  "- [x] 完成",
  "",
  "> 引用",
  "",
  "行内 `code`",
  "",
  "```",
  "const value = \"ok\";",
  "```",
  "",
  "| 列 | 值 |",
  "| --- | --- |",
  "| A | 1 |",
  "",
  "---",
  "",
  "[安全](https://example.com/docs)",
  "[邮件](mailto:ada@example.com)",
  "[脚本](javascript:alert(1))",
  "[数据](data:text/html,hi)",
  "",
  "![示意图](https://images.example/pic.png)",
  "",
  "<script>alert(1)</script>",
].join("\n");

describe("markdown replies", () => {
  it("renders the gfm elements used in a bot reply", () => {
    const html = renderToStaticMarkup(<MarkdownView text={sample} />);
    expect(html).toContain("<h1");
    expect(html).toContain("标题");
    expect(html).toContain("<strong");
    expect(html).toContain("粗");
    expect(html).toContain("<em");
    expect(html).toContain("斜");
    expect(html).toContain("删");
    expect(html).toMatch(/<del|<s/);
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain("一项");
    expect(html).toContain("有序");
    expect(html).toContain("type=\"checkbox\"");
    expect(html).toContain("待办");
    expect(html).toContain("<blockquote");
    expect(html).toContain("引用");
    expect(html).toContain("<code");
    expect(html).toContain("code");
    expect(html).toContain("<pre");
    expect(html).toContain("const value");
    expect(html).toContain("复制");
    expect(html).toContain("overflow-x-auto");
    const fenced = html.slice(html.indexOf("<pre"));
    expect(fenced).not.toContain("bg-code px-1");
    expect(html.slice(0, html.indexOf("<pre"))).toContain("bg-code px-1");
    expect(html).toContain("<table");
    expect(html).toContain("<hr");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
    expect(html).toContain("noreferrer");
    expect(html).toContain("nofollow");
    expect(html).toContain('href="mailto:ada@example.com"');
  });

  it("shows raw html as text and does not create an executable tag", () => {
    const html = renderToStaticMarkup(<MarkdownView text={'<script>alert(1)</script> <b onclick="x">hi</b>'} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b");
    expect(html).toContain("alert(1)");
    expect(html).toContain("hi");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("does not make javascript or data urls clickable", () => {
    const html = renderToStaticMarkup(<MarkdownView text={"[脚本](javascript:alert(1)) [data](data:text/html,hi)"} />);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:");
    expect(html).toContain("脚本");
    expect(html).toContain("data");
    expect(html).not.toMatch(/<a[^>]*>脚本/);
  });

  it("turns images into links and does not load them", () => {
    const html = renderToStaticMarkup(<MarkdownView text={"![示意图](https://images.example/pic.png)"} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("示意图");
    expect(html).toContain("https://images.example/pic.png");
    expect(html).toContain("<a");
  });

  it("does not throw when a code fence is still open", () => {
    const partial = "说明\n\n```\nconst value = 1\n";
    expect(() => renderToStaticMarkup(<MarkdownView text={partial} />)).not.toThrow();
    const html = renderToStaticMarkup(<MarkdownView text={partial} />);
    expect(html).toContain("const value = 1");
    const finished = partial + "```\n";
    expect(renderToStaticMarkup(<MarkdownView text={finished} />)).toContain("const value = 1");
  });

  it("keeps markdown for assistant replies only", () => {
    expect(usesMarkdown("assistant", false)).toBe(true);
    expect(usesMarkdown("assistant", true)).toBe(false);
    expect(usesMarkdown("user", false)).toBe(false);
    expect(usesMarkdown("toolResult", false)).toBe(false);
  });

  it("scrolls wide tables and long code lines inside the message", () => {
    const html = renderToStaticMarkup(
      <MarkdownView
        text={[
          "| 周会 | 纪要 |",
          "| --- | --- |",
          "| 密钥 | 轮换 |",
          "",
          "```",
          "const token = \"abcdefghijklmnopqrstuvwxyz0123456789\";",
          "```",
        ].join("\n")}
      />,
    );
    const table = html.match(/<table[^>]*>/)?.[0] ?? "";
    expect(table).toContain("w-max");
    expect(table).toContain("min-w-full");
    expect(table.split(/[\s"]+/)).not.toContain("w-full");
    expect(html).toContain('class="table-wrap my-2 min-w-0 max-w-full"');
    expect(html.match(/<th\s[^>]*>/)?.[0]).toContain("whitespace-nowrap");
    const pre = html.match(/<pre[^>]*>/)?.[0] ?? "";
    expect(pre).toContain("overflow-x-auto");
    expect(pre).toContain("max-w-full");
    expect(pre).toContain("whitespace-pre");
    expect(pre).toContain("break-normal");
    const blockCode = html.slice(html.indexOf("<pre")).match(/<code[^>]*>/)?.[0] ?? "";
    expect(blockCode).toContain("inline-block");
    expect(blockCode).toContain("min-w-full");
    expect(blockCode).toContain("whitespace-pre");
    expect(blockCode).toContain("break-normal");
    expect(blockCode).not.toContain("overflow-x-auto");
  });
});
