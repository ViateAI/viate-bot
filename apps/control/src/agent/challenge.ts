export interface PageSignals {
  url: string;
  iframeUrls: string[];
  scriptUrls: string[];
  markers: string[];
}

const CLOUDFLARE_NOTICE = "注意：页面上检测到 Cloudflare 人机验证（Turnstile/challenge）";
const RECAPTCHA_NOTICE = "注意：页面上检测到 Google reCAPTCHA 人机验证";
const HCAPTCHA_NOTICE = "注意：页面上检测到 hCaptcha 人机验证";
const GEETEST_NOTICE = "注意：页面上检测到极验 GeeTest 人机验证";

/** 在页面里收集地址、iframe、脚本和典型元素。只读，不点击、不拦截。 */
export const CHALLENGE_PROBE = `(() => {
  try {
    const take = (value) => (typeof value === "string" ? value : "");
    const iframeUrls = [...document.querySelectorAll("iframe")].map((el) => take(el.src)).filter((src) => src.length > 0).slice(0, 40);
    const scriptUrls = [...document.scripts].map((el) => take(el.src)).filter((src) => src.length > 0).slice(0, 40);
    const markers = [];
    const interesting = /cf-chl|cf-turnstile|challenges\\.cloudflare\\.com|g-recaptcha|grecaptcha|recaptcha\\/api|h-captcha|hcaptcha\\.com|geetest|gcaptcha4|(^|[^a-z0-9])gt4([^a-z0-9]|$)/i;
    for (const el of document.querySelectorAll("iframe, script, [id], [class]")) {
      const id = take(el.id);
      const cls = typeof el.className === "string" ? el.className : "";
      const marker = [id, cls].filter((part) => part.length > 0).join(" ");
      if (marker.length > 0 && interesting.test(marker)) markers.push(marker.slice(0, 240));
    }
    return { url: location.href, iframeUrls, scriptUrls, markers: markers.slice(0, 40) };
  } catch (error) {
    return { url: "", iframeUrls: [], scriptUrls: [], markers: [] };
  }
})()`;

export function humanCheckNotices(signals: PageSignals): string[] {
  const urls = [signals.url, ...signals.iframeUrls, ...signals.scriptUrls];
  const lines: string[] = [];
  if (urls.some(isCloudflare) || signals.markers.some(isCloudflareMarker)) lines.push(CLOUDFLARE_NOTICE);
  if (urls.some(isRecaptcha) || signals.markers.some(isRecaptchaMarker)) lines.push(RECAPTCHA_NOTICE);
  if (urls.some(isHcaptcha) || signals.markers.some(isHcaptchaMarker)) lines.push(HCAPTCHA_NOTICE);
  if (urls.some(isGeetest) || signals.markers.some(isGeetestMarker)) lines.push(GEETEST_NOTICE);
  return lines;
}

export function annotatePage(text: string, probed: unknown): string {
  const notices = humanCheckNotices(mergeSignals(parsePageSignals(probed), signalsFromText(text)));
  if (notices.length === 0) return text;
  return `${notices.join("\n")}\n${text}`;
}

export function parsePageSignals(value: unknown): PageSignals {
  if (!value || typeof value !== "object") return emptySignals();
  const record = value as Record<string, unknown>;
  return {
    url: typeof record.url === "string" ? record.url : "",
    iframeUrls: stringList(record.iframeUrls),
    scriptUrls: stringList(record.scriptUrls),
    markers: stringList(record.markers),
  };
}

export function signalsFromText(text: string): PageSignals {
  return {
    url: explicitPageUrl(text),
    iframeUrls: [],
    scriptUrls: [],
    markers: [],
  };
}

/** 标签页列表按行标注。提示紧挨着对应标签，不罩在整份列表上。 */
export function annotateTabList(text: string): string {
  return text.split("\n").map(annotateTabLine).join("\n");
}

function explicitPageUrl(text: string): string {
  const labeled = text.match(/(?:^|\n)url:\s*(\S+)/);
  if (labeled?.[1]) return trimUrl(labeled[1]);
  const opened = text.match(/(?:^|\n)已打开\s+(\S+)/);
  if (opened?.[1]) return trimUrl(opened[1]);
  const switched = text.match(/(?:^|\n)已切换到\s+(\S+)/);
  if (switched?.[1]) return trimUrl(switched[1]);
  return "";
}

function trimUrl(raw: string): string {
  return raw.replace(/（.*$/, "").replace(/[.,);]+$/, "");
}

function annotateTabLine(line: string): string {
  const fields = line.split("\t");
  if (fields.length < 3) return line;
  const url = fields[fields.length - 1] ?? "";
  const notices = humanCheckNotices({ url, iframeUrls: [], scriptUrls: [], markers: [] });
  if (notices.length === 0) return line;
  const index = (fields[0] ?? "").replace(/\s+\*$/, "").trim();
  const owned = notices.map((notice) => notice.replace("页面上检测到", `标签页 ${index} 检测到`));
  return `${owned.join("\n")}\n${line}`;
}

function emptySignals(): PageSignals {
  return { url: "", iframeUrls: [], scriptUrls: [], markers: [] };
}

function mergeSignals(left: PageSignals, right: PageSignals): PageSignals {
  return {
    url: left.url || right.url,
    iframeUrls: unique([...left.iframeUrls, ...right.iframeUrls]),
    scriptUrls: unique([...left.scriptUrls, ...right.scriptUrls]),
    markers: unique([...left.markers, ...right.markers]),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((item) => item.trim().length > 0))];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

interface UrlParts {
  host: string;
  pathname: string;
  search: string;
}

function parts(raw: string): UrlParts {
  const trimmed = raw.trim();
  if (!trimmed) return { host: "", pathname: "", search: "" };
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : trimmed.startsWith("//")
      ? `https:${trimmed}`
      : `https://signals.invalid${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
  try {
    const url = new URL(absolute);
    return {
      host: url.hostname === "signals.invalid" ? "" : url.hostname.toLowerCase(),
      pathname: url.pathname.toLowerCase(),
      search: url.search.toLowerCase(),
    };
  } catch {
    return { host: "", pathname: trimmed.toLowerCase(), search: "" };
  }
}

function hostIs(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

function isCloudflare(raw: string): boolean {
  const { host, pathname, search } = parts(raw);
  if (hostIs(host, "challenges.cloudflare.com")) return true;
  if (pathname.includes("/cdn-cgi/challenge-platform")) return true;
  return pathname.includes("cf-chl") || search.includes("cf-chl") || pathname.includes("cf_chl") || search.includes("cf_chl");
}

function isCloudflareMarker(marker: string): boolean {
  return /cf-turnstile|cf-chl|cf_chl|challenges\.cloudflare\.com/i.test(marker);
}

function isRecaptcha(raw: string): boolean {
  const { host, pathname } = parts(raw);
  if (hostIs(host, "recaptcha.net")) return true;
  const google = host === "google.com" || host === "www.google.com" || host === "www.gstatic.com";
  return google && pathname.includes("/recaptcha");
}

function isRecaptchaMarker(marker: string): boolean {
  return /(^|[^a-z0-9])g-recaptcha([^a-z0-9]|$)|grecaptcha|recaptcha-anchor|recaptcha\/api\.js/i.test(marker);
}

function isHcaptcha(raw: string): boolean {
  return hostIs(parts(raw).host, "hcaptcha.com");
}

function isHcaptchaMarker(marker: string): boolean {
  return /(^|[^a-z0-9])h-captcha([^a-z0-9]|$)|hcaptcha\.com/i.test(marker);
}

function isGeetest(raw: string): boolean {
  const { host, pathname } = parts(raw);
  if (hostIs(host, "geetest.com")) return true;
  return /(^|\/)(gt4|gcaptcha4)(\/|\.|$)/.test(pathname);
}

function isGeetestMarker(marker: string): boolean {
  return /(^|[^a-z0-9])geetest([^a-z0-9]|$)|gcaptcha4|(^|[^a-z0-9])gt4([^a-z0-9]|$)/i.test(marker);
}
