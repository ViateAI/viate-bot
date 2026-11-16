import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { DEFAULT_PLATFORM_PROMPT } from "../db/settings.js";
import { annotatePage, annotateTabList, CHALLENGE_PROBE, humanCheckNotices, type PageSignals } from "./challenge.js";

const CLEAN: PageSignals = {
  url: "https://shop.example/login",
  iframeUrls: [],
  scriptUrls: ["https://cdn.example/app.js", "https://www.google-analytics.com/analytics.js", "https://www.googletagmanager.com/gtag/js"],
  markers: ["login-form", "password", "submit-order"],
};

function page(patch: Partial<PageSignals>): PageSignals {
  return {
    url: patch.url ?? "https://shop.example/login",
    iframeUrls: patch.iframeUrls ?? [],
    scriptUrls: patch.scriptUrls ?? [],
    markers: patch.markers ?? [],
  };
}

describe("human check notices", () => {
  it("names Cloudflare from the challenge host, a same-origin challenge path, cf-chl, or the turnstile element", () => {
    expect(humanCheckNotices(page({
      iframeUrls: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0/rcv/0"],
    }))).toEqual(["注意：页面上检测到 Cloudflare 人机验证（Turnstile/challenge）"]);
    expect(humanCheckNotices(page({
      url: "https://shop.example/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1",
    }))).toEqual(["注意：页面上检测到 Cloudflare 人机验证（Turnstile/challenge）"]);
    expect(humanCheckNotices(page({
      url: "https://shop.example/login?__cf_chl_tk=abc",
    }))).toEqual(["注意：页面上检测到 Cloudflare 人机验证（Turnstile/challenge）"]);
    expect(humanCheckNotices(page({ markers: ["cf-turnstile"] }))).toEqual([
      "注意：页面上检测到 Cloudflare 人机验证（Turnstile/challenge）",
    ]);
  });

  it("names Google reCAPTCHA from google.com/recaptcha, recaptcha.net, or the widget element", () => {
    expect(humanCheckNotices(page({
      scriptUrls: ["https://www.google.com/recaptcha/api.js"],
    }))).toEqual(["注意：页面上检测到 Google reCAPTCHA 人机验证"]);
    expect(humanCheckNotices(page({
      iframeUrls: ["https://www.recaptcha.net/recaptcha/api2/anchor?ar=1"],
    }))).toEqual(["注意：页面上检测到 Google reCAPTCHA 人机验证"]);
    expect(humanCheckNotices(page({ markers: ["g-recaptcha"] }))).toEqual([
      "注意：页面上检测到 Google reCAPTCHA 人机验证",
    ]);
  });

  it("names hCaptcha from hcaptcha.com or the widget element", () => {
    expect(humanCheckNotices(page({
      scriptUrls: ["https://js.hcaptcha.com/1/api.js"],
    }))).toEqual(["注意：页面上检测到 hCaptcha 人机验证"]);
    expect(humanCheckNotices(page({ markers: ["h-captcha"] }))).toEqual([
      "注意：页面上检测到 hCaptcha 人机验证",
    ]);
  });

  it("names GeeTest from geetest.com, gt4, gcaptcha4, or the widget element", () => {
    expect(humanCheckNotices(page({
      scriptUrls: ["https://static.geetest.com/v4/gt4.js"],
    }))).toEqual(["注意：页面上检测到极验 GeeTest 人机验证"]);
    expect(humanCheckNotices(page({
      scriptUrls: ["https://cdn.example/static/gcaptcha4.js"],
    }))).toEqual(["注意：页面上检测到极验 GeeTest 人机验证"]);
    expect(humanCheckNotices(page({ markers: ["geetest_radar_tip"] }))).toEqual([
      "注意：页面上检测到极验 GeeTest 人机验证",
    ]);
    expect(humanCheckNotices(page({
      iframeUrls: ["https://gcaptcha4.geetest.com/index.html"],
    }))).toEqual(["注意：页面上检测到极验 GeeTest 人机验证"]);
  });

  it("does not flag a normal page, a search link, or a product path that only resembles a check", () => {
    expect(humanCheckNotices(CLEAN)).toEqual([]);
    expect(humanCheckNotices(page({
      url: "https://www.google.com/search?q=recaptcha",
      scriptUrls: ["https://www.google.com/js/bg/ga.js"],
      markers: ["captcha-news", "budget4", "cloudflare-vs-fastly"],
    }))).toEqual([]);
    expect(humanCheckNotices(page({
      url: "https://blog.example/why-cloudflare-is-fast",
      scriptUrls: ["https://cdn.example/products/gt4-review.js"],
    }))).toEqual([]);
    const snapshot = [
      "url: https://shop.example/login",
      '[e1] button "我不是机器人 recaptcha"',
      '[e2] heading "Cloudflare 和 GeeTest 的区别"',
    ].join("\n");
    expect(annotatePage(snapshot, null)).toBe(snapshot);
  });

  it("puts every matching notice before the page text and leaves the text intact", () => {
    const snapshot = "url: https://shop.example/checkout\n[e1] button \"继续\"";
    const text = annotatePage(snapshot, {
      url: "https://shop.example/checkout",
      iframeUrls: ["https://challenges.cloudflare.com/turnstile/v0/api.js"],
      scriptUrls: ["https://www.google.com/recaptcha/api.js"],
      markers: [],
    });
    expect(text.startsWith([
      "注意：页面上检测到 Cloudflare 人机验证（Turnstile/challenge）",
      "注意：页面上检测到 Google reCAPTCHA 人机验证",
    ].join("\n"))).toBe(true);
    expect(text.endsWith(snapshot)).toBe(true);
  });

  it("reads a challenge URL out of a snapshot when the probe returned nothing", () => {
    const text = annotatePage("url: https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate\n[e1] button \"确认\"", null);
    expect(text.startsWith("注意：页面上检测到 Cloudflare 人机验证（Turnstile/challenge）")).toBe(true);
  });

  it("does not treat a content link or another tab as a resource loaded by this page", () => {
    const snapshot = 'url: https://blog.example/\n[e1] link "hCaptcha home https://www.hcaptcha.com/"';
    expect(annotatePage(snapshot, null)).toBe(snapshot);
    const opened = "已打开 https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate（窗口 w1）";
    expect(annotatePage(opened, null).startsWith("注意：页面上检测到 Cloudflare 人机验证（Turnstile/challenge）")).toBe(true);
    const list = [
      "0 *\t商店\thttps://shop.example/",
      "1\t验证\thttps://challenges.cloudflare.com/turnstile/",
    ].join("\n");
    const annotated = annotateTabList(list);
    expect(annotated.startsWith("0 *")).toBe(true);
    expect(annotated).toContain("注意：标签页 1 检测到 Cloudflare 人机验证（Turnstile/challenge）\n1\t验证\thttps://challenges.cloudflare.com/turnstile/");
    expect(annotated).not.toContain("页面上检测到");
  });

  it("runs the page probe and does not mark a product script whose name only contains gt4", () => {
    const product = runProbe({
      href: "https://shop.example/products/widget",
      nodes: [
        node("script", { src: "https://cdn.example/products/gt4-review.js" }),
        node("a", { id: "buy", className: "product-card" }),
      ],
    });
    const snapshot = "url: https://shop.example/products/widget\n[e1] link \"gt4 review\"";
    expect(annotatePage(snapshot, product)).toBe(snapshot);

    const widget = runProbe({
      href: "https://shop.example/login",
      nodes: [node("div", { className: "cf-turnstile" })],
    });
    expect(annotatePage("url: https://shop.example/login\n[e1] checkbox", widget).startsWith(
      "注意：页面上检测到 Cloudflare 人机验证（Turnstile/challenge）",
    )).toBe(true);
  });

  it("keeps the builtin platform prompt and adds the one-attempt rule", () => {
    expect(DEFAULT_PLATFORM_PROMPT.startsWith("你是 viate-bot 中的助手，只能操作当前用户自己的那一台机器。")).toBe(true);
    expect(DEFAULT_PLATFORM_PROMPT).toContain(
      "遇到人机验证，可以按页面提示尝试一次（例如点击复选框）；没有通过就停止，告诉用户卡在哪个网站、什么验证，请用户决定。不要反复尝试，也不要寻求绕过或破解验证。",
    );
  });
});

function node(tag: string, props: { id?: string; className?: string; src?: string }) {
  const src = props.src ?? "";
  return {
    tagName: tag,
    id: props.id ?? "",
    className: props.className ?? "",
    src,
    getAttribute(name: string) {
      return name === "src" ? src : null;
    },
  };
}

function runProbe(page: { href: string; nodes: ReturnType<typeof node>[] }): unknown {
  const scripts = page.nodes.filter((item) => item.tagName === "script");
  const sandbox = {
    document: {
      scripts,
      querySelectorAll() {
        return page.nodes;
      },
    },
    location: { href: page.href },
  };
  return vm.runInNewContext(CHALLENGE_PROBE, sandbox);
}
