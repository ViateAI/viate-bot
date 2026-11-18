#!/bin/sh
# 不改本机网络、iptables 或 tc。ip 只能是这里的伪造命令。
set -eu
cd "$(dirname "$0")"
sh -n vb-firewall.start
sh -n vb-firewall-check.sh

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/ip" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-j" ] && [ "${2:-}" = "-d" ] && [ "${3:-}" = "link" ] && [ "${4:-}" = "show" ]; then
  cat "$VB_IP_FIXTURE"
  exit 0
fi
printf 'refusing unexpected ip invocation: %s\n' "$*" >&2
exit 97
EOF
chmod +x "$TMP/ip"

cat >"$TMP/links.json" <<'EOF'
[{"ifindex":1,"ifname":"lo","flags":["LOOPBACK","UP"],"link_type":"loopback"},{"ifindex":5,"ifname":"vbi0123456789ab","flags":["NOARP","UP"],"mtu":1500,"linkinfo":{"info_kind":"ifb","info_data":{}},"ifalias":"viate-bot:vb0123456789ab"},{"ifindex":6,"ifname":"vbi000000000000","flags":["NOARP"],"linkinfo":{"info_kind":"ifb"}},{"ifindex":7,"ifname":"vbiabcdefabcdef","flags":["NOARP"],"linkinfo":{"info_kind":"ifb"},"ifalias":"viate-bot:vbffffffffffff"},{"ifindex":8,"ifname":"vbi111111111111","flags":["BROADCAST"],"linkinfo":{"info_kind":"bridge"},"ifalias":"viate-bot:vb111111111111"},{"ifindex":9,"ifname":"vbiemptyalias00","flags":["NOARP"],"linkinfo":{"info_kind":"ifb"},"ifalias":""}]
EOF

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

owned() {
  PATH="$TMP:$PATH" VB_IP_FIXTURE="$TMP/links.json" VB_FIREWALL_SOURCE_ONLY=1 \
    sh -c '. ./vb-firewall.start; owned_ifb "$1" "$2"' sh "$1" "$2"
}

expect_owned() {
  if owned "$1" "$2"; then
    return 0
  fi
  fail "应该是自有 IFB：$1 $2"
}

expect_foreign() {
  if owned "$1" "$2"; then
    fail "不该改动：$1 $2"
  fi
}

expect_owned vbi0123456789ab vb0123456789ab
expect_foreign vbi000000000000 vb000000000000
expect_foreign vbiemptyalias00 vbemptyalias00
expect_foreign vbiabcdefabcdef vbabcdefabcdef
expect_foreign vbi111111111111 vb111111111111

# JSON escapes must not turn a different kernel alias into our ownership marker.
cp "$TMP/links.json" "$TMP/original.json"
cat >"$TMP/links.json" <<'EOF'
[{"ifalias":"viate-bo\t:vb0123456789ab","linkinfo":{"info_kind":"ifb"},"ifname":"vbi0123456789ab"}]
EOF
expect_foreign vbi0123456789ab vb0123456789ab
cat >"$TMP/links.json" <<'EOF'
[{"linkinfo":{"info_data":{"ifalias":"viate-bot:vb0123456789ab"},"info_kind":"ifb"},"ifname":"vbi0123456789ab"},{"ifalias":"viate-bot:vb000000000000","ifname":"vbi000000000000"},{"ifalias":"quoted\"},[{\\alias\n","ifname":"other","linkinfo":{"info_kind":"ifb"}},{"ifalias":"viate-bot:vbabcdefabcdef","flags":["UP"],"linkinfo":{"info_kind":"ifb"},"ifname":"vbiabcdefabcdef"}]
EOF
expect_foreign vbi0123456789ab vb0123456789ab
expect_foreign vbi000000000000 vb000000000000
expect_owned vbiabcdefabcdef vbabcdefabcdef
mv "$TMP/original.json" "$TMP/links.json"

private_of() {
  PATH="$TMP:$PATH" VB_FIREWALL_LOCAL="$1" VB_FIREWALL_SOURCE_ONLY=1 \
    sh -c '. ./vb-firewall.start; load_private; printf "%s\n" "$PRIVATE"; rules4' sh
}

expect_fail() {
  if private_of "$1" >/dev/null 2>"$TMP/err"; then
    fail "应该失败退出：$2"
  fi
}

printf '%s\n' '# 放行公司 10/8' '' '  omit 10.0.0.0/8' >"$TMP/omit-hit"
hit=$(private_of "$TMP/omit-hit")
printf '%s\n' "$hit" | grep -F '10.0.0.0/8' >/dev/null && fail 'omit 命中后仍在列表里'
printf '%s\n' "$hit" | grep -F '192.168.0.0/16' >/dev/null || fail 'omit 不该拿掉其他默认项'
printf '%s\n' "$hit" | grep -F -- '-d 10.0.0.0/8' >/dev/null && fail '规则仍丢弃 10.0.0.0/8'
printf '%s\n' "$hit" | grep -c -F -- '-d 192.168.0.0/16' | grep -qx 2 || fail 'GUARD 和 EGRESS 应该各丢弃 192.168.0.0/16'

printf '%s\n' 'omit 10.1.2.0/24' >"$TMP/omit-miss"
expect_fail "$TMP/omit-miss" 'omit 未命中'

printf '%s\n' '# extra' '' 'extra 203.0.113.0/24' >"$TMP/extra"
extra=$(private_of "$TMP/extra")
printf '%s\n' "$extra" | grep -F '203.0.113.0/24' >/dev/null || fail 'extra 没有进列表'
printf '%s\n' "$extra" | grep -F '10.0.0.0/8' >/dev/null || fail 'extra 不该拿掉默认项'
printf '%s\n' "$extra" | grep -c -F -- '-d 203.0.113.0/24' | grep -qx 2 || fail 'GUARD 和 EGRESS 应该各丢弃 extra'
printf '%s\n' "$extra" | grep -c -F -- '-d 10.0.0.0/8' | grep -qx 2 || fail 'extra 时规则仍要丢弃默认 10.0.0.0/8'

printf '%s\n' '# 只有注释' '' '# omit 不在这里' >"$TMP/comments"
comments=$(private_of "$TMP/comments")
printf '%s\n' "$comments" | head -n 1 | grep -F '10.0.0.0/8' >/dev/null || fail '注释不该改掉默认列表'

printf '%s\n' 'allow 10.0.0.0/8' >"$TMP/illegal"
expect_fail "$TMP/illegal" '非法行'

for line in 'extra 999.0.0.0/8' 'extra 10.0.0.0/33' 'extra 10.0.0.0/8 trailing' 'extra 01.0.0.0/8' 'omit 10.0.0.0/8 # inline'; do
  printf '%s\n' "$line" >"$TMP/invalid-cidr"
  expect_fail "$TMP/invalid-cidr" "$line"
done

missing=$(private_of "$TMP/does-not-exist")
printf '%s\n' "$missing" | head -n 1 | grep -F '10.0.0.0/8' >/dev/null || fail '文件不存在应该等于默认列表'
printf '%s\n' "$missing" | grep -c -F -- '-d 10.0.0.0/8' | grep -qx 2 || fail '缺文件时规则仍要丢弃 10.0.0.0/8'

printf 'firewall tests passed\n'
