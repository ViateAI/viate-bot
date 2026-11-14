/**
 * 对一台正在运行的机器验证：两个 bot 的窗口并发输入和下载互不干扰，并且共享登录态。
 * 用法: tsx scripts/browser-probe.ts --base http://<ip>:7070 --token <token> [--rounds 5] [--concurrent]
 * 默认带用户级浏览器锁。--concurrent 关掉锁，用来复现并发输入和下载互相干扰。
 */
import net from "node:net";
import { parseArgs } from "node:util";
import { BrowserClient, UserBrowserLock } from "@viate-bot/browser";
import type { BrowserStatusResponse, ExecEvent } from "@viate-bot/protocol";

const PAGE = "http://127.0.0.1:8765/index.html";
const PAYLOAD = "payload-ok";
const INDEX_HTML = `<!doctype html>
<meta charset="utf-8">
<title>probe</title>
<input id="box" autocomplete="off">
`;

const PROC_SCRIPT = `
import os
port = 9222
hexport = "%04X" % port
def scan(path):
    try:
        lines = open(path).read().splitlines()[1:]
    except FileNotFoundError:
        return []
    hits = []
    for line in lines:
        parts = line.split()
        if len(parts) < 4:
            continue
        local = parts[1]
        ip, _, p = local.rpartition(":")
        if p.upper() != hexport:
            continue
        hits.append("%s:%s state=%s" % (ip, p, parts[3]))
    return hits
print("tcp " + (" ".join(scan("/proc/net/tcp")) or "-"))
print("tcp6 " + (" ".join(scan("/proc/net/tcp6")) or "-"))
try:
    status = open("/proc/1/status").read().splitlines()
except FileNotFoundError:
    status = []
for line in status:
    if line.startswith("CapEff") or line.startswith("CapBnd"):
        print(line)
found = False
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        raw = open("/proc/%s/cmdline" % pid, "rb").read().replace(bytes([0]), b" ").decode("utf-8", "replace")
        uid = os.stat("/proc/%s" % pid).st_uid
    except OSError:
        continue
    if "remote-debugging-port=9222" in raw:
        found = True
        print("chrome uid=%s" % uid)
        print(raw)
if not found:
    print("chrome missing")
`;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    token: { type: "string" },
    rounds: { type: "string", default: "5" },
    concurrent: { type: "boolean", default: false },
  },
});

const rounds = Number(values.rounds);
if (!values.base || !values.token || !Number.isInteger(rounds) || rounds < 1) {
  console.error(
    "用法: tsx scripts/browser-probe.ts --base http://<ip>:7070 --token <token> [--rounds 5] [--concurrent]",
  );
  process.exit(2);
}

const base = values.base.replace(/\/$/, "");
const token = values.token;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

async function main(): Promise<void> {
  console.log(values.concurrent ? "mode concurrent" : "mode exclusive");
  const status = await waitRunning(90_000);
  console.log(`status ${JSON.stringify(status)}`);
  const bindPass = await checkBind();
  await seedSite();
  const auth = { authorization: `Bearer ${token}` };
  const lock = values.concurrent ? undefined : new UserBrowserLock();
  const client = lock
    ? await BrowserClient.connect(cdpUrl(base), { headers: auth, lock })
    : await BrowserClient.connect(cdpUrl(base), { headers: auth });
  let failed = bindPass ? 0 : 1;
  try {
    for (let round = 1; round <= rounds; round += 1) {
      try {
        failed += await runRound(round, client);
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.log(`round ${round} fail ${message}`);
      } finally {
        await client.closeWindow("bot-a").catch(() => undefined);
        await client.closeWindow("bot-b").catch(() => undefined);
      }
    }
  } finally {
    await client.close();
  }
  failed += await restartBrowser();
  console.log(`summary fail=${failed}`);
  if (failed > 0) process.exit(1);
}

async function runRound(round: number, client: BrowserClient): Promise<number> {
  const cleared = await run(
    "rm -rf /home/bot/Downloads/bot-a /home/bot/Downloads/bot-b && mkdir -p /home/bot/Downloads/bot-a /home/bot/Downloads/bot-b",
  );
  if (cleared.code !== 0) throw new Error(cleared.stderr || cleared.stdout || "清理下载目录失败");
  await client.openWindow("bot-a", PAGE);
  await client.openWindow("bot-b", PAGE);
  let failed = 0;
  failed += (await checkInput(round, client)) ? 0 : 1;
  failed += (await checkKeys(round, client)) ? 0 : 1;
  failed += (await checkDownload(round, client)) ? 0 : 1;
  if (round === 1) failed += (await checkScreenshot(client)) ? 0 : 1;
  failed += (await checkSession(round, client)) ? 0 : 1;
  return failed;
}

async function checkInput(round: number, client: BrowserClient): Promise<boolean> {
  const insertedA = `AAA-INS-${round}`;
  const insertedB = `BBB-INS-${round}`;
  const focus = "(() => { const el = document.querySelector('#box'); el.focus(); el.value = ''; return 'ok'; })()";
  const [valueA, valueB] = await Promise.all([
    client.use(async () => {
      await client.evaluate("bot-a", focus);
      await client.insertText("bot-a", insertedA);
      return client.evaluate<string>("bot-a", "document.querySelector('#box').value");
    }),
    client.use(async () => {
      await client.evaluate("bot-b", focus);
      await client.insertText("bot-b", insertedB);
      return client.evaluate<string>("bot-b", "document.querySelector('#box').value");
    }),
  ]);
  const pass = valueA === insertedA && valueB === insertedB;
  console.log(`round ${round} insertText ${pass ? "pass" : "fail"} A=${valueA} B=${valueB}`);
  return pass;
}

async function checkKeys(round: number, client: BrowserClient): Promise<boolean> {
  const expectedA = `AAA-INS-${round}X`;
  const expectedB = `BBB-INS-${round}Y`;
  const [boxA, boxB] = await Promise.all([
    client.use(async () => typeKey(client, "bot-a", "X", expectedA)),
    client.use(async () => typeKey(client, "bot-b", "Y", expectedB)),
  ]);
  const pass = boxA.value === expectedA && boxB.value === expectedB;
  console.log(
    `round ${round} dispatchKeyEvent ${pass ? "pass" : "fail"} A=${boxA.value} ${boxA.width}x${boxA.height} ${boxA.state} B=${boxB.value} ${boxB.width}x${boxB.height} ${boxB.state}`,
  );
  return pass;
}

async function typeKey(client: BrowserClient, botId: string, key: string, expected: string): Promise<BoxSnapshot> {
  await client.activate(botId);
  const focused = await client.evaluate<string>(
    botId,
    "(() => { const el = document.querySelector('#box'); el.focus(); return document.activeElement === el ? 'box' : ''; })()",
  );
  if (focused !== "box") throw new Error(`${botId} 输入框没有焦点`);
  await sendKey(client, botId, key);
  let box = await waitBox(client, botId, expected, 400);
  if (box.value !== expected) {
    await client.activate(botId);
    await client.evaluate(botId, "(() => { document.querySelector('#box').focus(); return 'ok'; })()");
    await sendKey(client, botId, key);
    box = await waitBox(client, botId, expected, 400);
  }
  return box;
}

async function sendKey(client: BrowserClient, botId: string, key: string): Promise<void> {
  const code = `Key${key.toUpperCase()}`;
  const windowsVirtualKeyCode = key.toUpperCase().charCodeAt(0);
  await client.dispatchKeyEvent(botId, { type: "keyDown", key, code, text: key, unmodifiedText: key, windowsVirtualKeyCode });
  await client.dispatchKeyEvent(botId, { type: "keyUp", key, code, windowsVirtualKeyCode });
}

async function waitBox(client: BrowserClient, botId: string, expected: string, timeoutMs = 400): Promise<BoxSnapshot> {
  let last: BoxSnapshot = { value: "", active: "", focus: false, width: 0, height: 0, state: "" };
  const deadline = Date.now() + timeoutMs;
  do {
    last = await readBox(client, botId);
    if (last.value === expected) return last;
    await delay(25);
  } while (Date.now() < deadline);
  return last;
}

async function readBox(client: BrowserClient, botId: string): Promise<BoxSnapshot> {
  const raw = await client.evaluate<string>(
    botId,
    "JSON.stringify({value:document.querySelector('#box').value,active:(document.activeElement&&document.activeElement.id)||'',focus:document.hasFocus(),width:window.innerWidth,height:window.innerHeight,state:document.visibilityState})",
  );
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    return { value: "", active: "", focus: false, width: 0, height: 0, state: "" };
  }
  const value = "value" in parsed && typeof parsed.value === "string" ? parsed.value : "";
  const active = "active" in parsed && typeof parsed.active === "string" ? parsed.active : "";
  const focus = "focus" in parsed && parsed.focus === true;
  const width = "width" in parsed && typeof parsed.width === "number" ? parsed.width : 0;
  const height = "height" in parsed && typeof parsed.height === "number" ? parsed.height : 0;
  const state = "state" in parsed && typeof parsed.state === "string" ? parsed.state : "";
  return { value, active, focus, width, height, state };
}

interface BoxSnapshot {
  value: string;
  active: string;
  focus: boolean;
  width: number;
  height: number;
  state: string;
}

async function checkDownload(round: number, client: BrowserClient): Promise<boolean> {
  const [okA, okB] = await Promise.all([
    client.use(async () => {
      await client.setDownloadBehavior("bot-a", "/home/bot/Downloads/bot-a");
      await triggerDownload(client, "bot-a", "bot-a.txt");
      return filesMatch(await waitFiles("/home/bot/Downloads/bot-a"), "/home/bot/Downloads/bot-a");
    }),
    client.use(async () => {
      await client.setDownloadBehavior("bot-b", "/home/bot/Downloads/bot-b");
      await triggerDownload(client, "bot-b", "bot-b.txt");
      return filesMatch(await waitFiles("/home/bot/Downloads/bot-b"), "/home/bot/Downloads/bot-b");
    }),
  ]);
  const listingA = await listDir("/home/bot/Downloads/bot-a");
  const listingB = await listDir("/home/bot/Downloads/bot-b");
  const pass = okA && okB;
  console.log(`round ${round} download ${pass ? "pass" : "fail"} A=${listingA} B=${listingB}`);
  return pass;
}

async function triggerDownload(client: BrowserClient, botId: string, fileName: string): Promise<void> {
  const expression =
    `(() => { const a = document.createElement('a'); a.href = '/payload.txt'; a.download = ${JSON.stringify(fileName)};` +
    " document.body.appendChild(a); a.click(); return 'clicked'; })()";
  await client.evaluate(botId, expression);
}

async function filesMatch(names: string[], dir: string): Promise<boolean> {
  if (names.length !== 1) return false;
  const name = names[0];
  if (!name) return false;
  const text = await readText(`${dir}/${name}`);
  return text?.trim() === PAYLOAD;
}

async function checkScreenshot(client: BrowserClient): Promise<boolean> {
  const png = await client.screenshot("bot-a");
  const pass = png.length > 32 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
  console.log(`round 1 screenshot ${pass ? "pass" : "fail"} bytes=${png.length}`);
  return pass;
}

async function checkSession(round: number, client: BrowserClient): Promise<boolean> {
  await client.closeWindow("bot-b");
  const tokenValue = `alpha-${round}`;
  const cookie = `via_session=${tokenValue}`;
  await client.evaluate(
    "bot-a",
    `document.cookie = ${JSON.stringify(`${cookie}; path=/`)}; localStorage.setItem('via_auth', ${JSON.stringify(tokenValue)}); 'set'`,
  );
  await client.openWindow("bot-b", PAGE);
  const seen = await client.evaluate<string>(
    "bot-b",
    "document.cookie + '|' + (localStorage.getItem('via_auth') || '')",
  );
  const sep = seen.lastIndexOf("|");
  const cookieText = sep >= 0 ? seen.slice(0, sep) : seen;
  const storage = sep >= 0 ? seen.slice(sep + 1) : "";
  const pass = cookieText.includes(cookie) && storage === tokenValue;
  console.log(`round ${round} session ${pass ? "pass" : "fail"} cookie=${cookieText} storage=${storage}`);
  return pass;
}

async function checkBind(): Promise<boolean> {
  const encoded = Buffer.from(PROC_SCRIPT, "utf8").toString("base64");
  const inspected = await run(`python3 -c "import base64; exec(base64.b64decode('${encoded}'))"`);
  console.log(inspected.stdout.trim());
  if (inspected.stderr.trim()) console.log(inspected.stderr.trim());
  const text = inspected.stdout;
  const listens = text.split("\n").filter((line) => line.includes(":2406"));
  const wildcard = listens.some(
    (line) => line.includes("00000000:2406") || line.includes("00000000000000000000000000000000:2406"),
  );
  const loopback = listens.some((line) => line.includes("0100007F:2406") || line.includes("01000000:2406"));
  const host = new URL(base).hostname;
  const external = await canConnect(host, 9222);
  const uidOk = text.includes("chrome uid=1000");
  const pass = loopback && !wildcard && !external && uidOk && inspected.code === 0;
  console.log(
    `bind ${pass ? "pass" : "fail"} loopback=${loopback} wildcard=${wildcard} external=${external} uid1000=${uidOk}`,
  );
  return pass;
}

async function seedSite(): Promise<void> {
  await writeText("/home/bot/probe-www/index.html", INDEX_HTML);
  await writeText("/home/bot/probe-www/payload.txt", PAYLOAD);
  const started = await run(
    "pkill -f 'http.server 8765' || true; mkdir -p /home/bot/probe-www /home/bot/Downloads && nohup python3 -m http.server 8765 --bind 127.0.0.1 --directory /home/bot/probe-www >/tmp/probe-http.log 2>&1 & echo started",
  );
  if (!started.stdout.includes("started")) throw new Error(`测试页没启动: ${started.stderr}`);
  const deadline = Date.now() + 10_000;
  let last = "";
  while (Date.now() < deadline) {
    const probe = await run(
      "python3 -c 'import urllib.request; print(urllib.request.urlopen(\"http://127.0.0.1:8765/payload.txt\", timeout=2).read().decode())'",
    );
    last = `${probe.stdout}${probe.stderr}`;
    if (probe.code === 0 && probe.stdout.includes(PAYLOAD)) return;
    await delay(300);
  }
  throw new Error(`测试页不可用: ${last}`);
}

async function restartBrowser(): Promise<number> {
  const response = await fetch(`${base}/browser/restart`, {
    method: "POST",
    headers,
    body: "{}",
  });
  const text = await response.text();
  console.log(`restart http ${response.status} ${text}`);
  if (!response.ok) return 1;
  try {
    const status = await waitRunning(60_000);
    console.log(`restart pass ${JSON.stringify(status)}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`restart fail ${message}`);
    return 1;
  }
}

async function waitRunning(timeoutMs: number): Promise<BrowserStatusResponse> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/browser/status`, { headers }).catch((error: unknown) => error);
    if (response instanceof Response) {
      last = await response.text();
      if (response.ok) {
        const body = JSON.parse(last) as BrowserStatusResponse;
        if (body.running && body.version) return body;
      }
    } else {
      last = response instanceof Error ? response.message : String(response);
    }
    await delay(1000);
  }
  throw new Error(`Chromium 未就绪: ${last}`);
}

async function waitFiles(dir: string): Promise<string[]> {
  const deadline = Date.now() + 15_000;
  let names: string[] = [];
  while (Date.now() < deadline) {
    names = await listNames(dir);
    if (names.length > 0) return names;
    await delay(300);
  }
  return names;
}

async function listNames(dir: string): Promise<string[]> {
  const result = await run(`ls -1 ${dir}`);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith(".crdownload"));
}

async function listDir(dir: string): Promise<string> {
  const result = await run(`ls -la ${dir}`);
  return `${result.stdout}${result.stderr}`.trim().replace(/\s+/g, " ");
}

async function writeText(path: string, content: string): Promise<void> {
  const response = await fetch(`${base}/fs/write`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path, content }),
  });
  if (!response.ok) throw new Error(`写入 ${path} 失败: ${await response.text()}`);
}

async function readText(path: string): Promise<string | null> {
  const response = await fetch(`${base}/fs/read`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { content?: string };
  return typeof body.content === "string" ? body.content : null;
}

async function run(cmd: string, timeoutSec = 30): Promise<RunResult> {
  const response = await fetch(`${base}/exec`, {
    method: "POST",
    headers,
    body: JSON.stringify({ cmd, timeoutSec }),
  });
  if (!response.ok || !response.body) throw new Error(`exec ${response.status} ${await response.text()}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as ExecEvent;
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "stderr") stderr += event.data;
      if (event.type === "exit") code = event.code;
    }
  }
  return { code, stdout, stderr };
}

function cdpUrl(httpBase: string): string {
  const url = new URL(httpBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/browser/cdp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
