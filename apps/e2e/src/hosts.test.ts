import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hostResolverRules } from "./hosts.js";

const script = join(dirname(fileURLToPath(import.meta.url)), "../docker-run.sh");

test("没有解析参数时不改浏览器 DNS", () => {
  assert.equal(hostResolverRules({}), undefined);
});

test("显式 host-resolver-rules 原样传给浏览器", () => {
  assert.equal(
    hostResolverRules({ VB_E2E_HOST_RESOLVER_RULES: "MAP bot.example.com 127.0.0.1", VB_E2E_RESOLVE: "ignored:443:10.0.0.1" }),
    "MAP bot.example.com 127.0.0.1",
  );
});

test("curl --resolve 转成 MAP", () => {
  assert.equal(
    hostResolverRules({ VB_E2E_RESOLVE: "bot.example.com:443:127.0.0.1, viate.example.com:443:127.0.0.1" }),
    "MAP bot.example.com 127.0.0.1,MAP viate.example.com 127.0.0.1",
  );
});

test("格式不对就拒绝", () => {
  assert.throws(() => hostResolverRules({ VB_E2E_RESOLVE: "bot.example.com:127.0.0.1" }), /host:port:address/);
});

test("主机名不能直接交给 Chromium", () => {
  assert.throws(() => hostResolverRules({ VB_E2E_RESOLVE: "bot.example.com:443:host.docker.internal" }), /IPv4/);
});

test("host.docker.internal 转成 host-gateway，IPv4 原样作为 add-host", () => {
  const out = execFileSync("sh", [script, "--add-host-args"], {
    env: { ...process.env, VB_E2E_RESOLVE: "bot.example.com:443:host.docker.internal, viate.example.com:443:10.0.0.8" },
    encoding: "utf8",
  });
  assert.equal(out, "--add-host\nbot.example.com:host-gateway\n--add-host\nviate.example.com:10.0.0.8\n");
});

test("其它主机名不能当作 add-host 的地址", () => {
  assert.throws(
    () => execFileSync("sh", [script, "--add-host-args"], {
      env: { ...process.env, VB_E2E_RESOLVE: "bot.example.com:443:example.com" },
      encoding: "utf8",
      stdio: "pipe",
    }),
    /IPv4 或 host.docker.internal/,
  );
});

test("容器内把主机名解析成 IPv4 再写入 RESOLVE", () => {
  const out = execFileSync("sh", [script, "--rewrite-resolve"], {
    env: { ...process.env, VB_E2E_RESOLVE: "bot.example.com:443:localhost" },
    encoding: "utf8",
  });
  assert.equal(out.trim(), "bot.example.com:443:127.0.0.1");
});

test("显式规则里的主机名也会解析成 IPv4", () => {
  const out = execFileSync("sh", [script, "--rewrite-rules"], {
    env: { ...process.env, VB_E2E_HOST_RESOLVER_RULES: "MAP bot.example.com localhost, MAP viate.example.com 10.0.0.8" },
    encoding: "utf8",
  });
  assert.equal(out.trim(), "MAP bot.example.com 127.0.0.1,MAP viate.example.com 10.0.0.8");
});
