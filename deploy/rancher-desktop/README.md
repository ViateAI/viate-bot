# Rancher Desktop 防火墙

目标：Windows + Rancher Desktop WSL2（Alpine、amd64、dockerd/moby），关闭 Kubernetes。Mac 的嵌套 Alpine/Docker 只能验证 Linux 数据路径，不能代替本文的 Windows 验收。未通过行为验收，不应承载用户机器。

## 安装与启动顺序

先运行过一次 Rancher Desktop。若要改私网丢弃列表，**先写好定制文件，再替换脚本**（见「本地定制」）。没有定制就不要放空文件；文件不存在等于仓库默认。在 **PowerShell、仓库根目录**执行：

```powershell
$P = Join-Path $env:LOCALAPPDATA 'rancher-desktop\provisioning'
New-Item -ItemType Directory -Force $P | Out-Null
Copy-Item deploy/rancher-desktop/vb-firewall.start $P
Copy-Item deploy/rancher-desktop/vb-firewall-check.sh $P
wsl.exe -d rancher-desktop -u root -- sh
```

接下来在该 **WSL root shell** 中执行（路径询问只做一次）：

```sh
printf '粘贴 provisioning 的 WSL 路径（如 /mnt/c/Users/Joe/AppData/Local/rancher-desktop/provisioning）： '
read -r P
test -f "$P/vb-firewall.start" && test -f "$P/vb-firewall-check.sh"
apk add --no-cache iptables iproute2 util-linux
sh -n "$P/vb-firewall.start" && sh -n "$P/vb-firewall-check.sh"
sh "$P/vb-firewall.start"
sleep 6
sh "$P/vb-firewall-check.sh"; echo "exit:$?"
```

预期 `PASS (iptables-nft)` 或 `PASS (iptables-legacy)`、`exit:0`。须是 LF 换行。两个文件必须放在一起；`.sh` 不会被 provisioning 自动执行。依赖须在升级后重新检查；安装失败、模块不可用、混用后端或 tc 冲突均不允许忽略。

官方启动顺序是 **provisioning → dockerd → Kubernetes**，因此 `.start` 不能同步等 dockerd。脚本后台每 5 秒等待 Docker 的 `FORWARD → DOCKER-USER`，就绪后下发。首次启动到自检通过前，不要运行机器。只支持 Docker 的 iptables 后端（含 iptables-nft），不支持 Docker 原生 nftables firewall backend。两种 iptables 后端同时有 Docker 跳转时拒绝启动。

在 Windows 用户目录的 `.wslconfig` 中按部署负载分配内存、CPU（例如 `[wsl2]` 下 `memory=12GB`、`processors=4`）；修改后必须退出 Rancher Desktop，再执行 `wsl.exe --shutdown` 并重开。这会停止其它 WSL 发行版，先保存它们的工作。不要把这些配置命令当作防火墙验证。

从旧的未审查脚本切换，先停止用户机器并完整退出/重开 Rancher Desktop，避免旧的后台 shell 继续覆盖新规则。不要按旧 pid 文件盲目 `kill`。新版不创建旧的 `i<hash>` IFB，也不盲删无所有权标记的设备；完整 WSL 重启会清理它们。

## 本地定制

默认丢弃列表仍是 `10.0.0.0/8`、`127.0.0.0/8`、`169.254.0.0/16`、`172.16.0.0/12`、`192.168.0.0/16`、`100.64.0.0/10`。要改这份列表，在脚本同目录放 `vb-firewall.local`。替换 `vb-firewall.start` 不会覆盖它。路径也可用环境变量 `VB_FIREWALL_LOCAL` 指定。文件不存在等于仓库默认。

**先写好定制文件，再替换脚本。** 无参数运行会按合并后的列表整链 `iptables-restore`。若先换成仓库脚本再补文件，中间会把默认的 `10.0.0.0/8` DROP 装回去。

语法：空行和 `#` 注释忽略。

- `omit <cidr>`：从默认列表去掉这一项。必须和默认项逐字相同，否则失败退出，避免拼写错误被当成已经放行。
- `extra <cidr>`：额外丢弃一条 IPv4 CIDR。
- 其他内容失败退出。

规则生成和自检读同一份合并结果。示例（放行整个 `10/8`）：

```
# 公司内网在 10/8
omit 10.0.0.0/8
```

## 实际策略与边界

- 网桥为 `vb` + `sha256(userId)` 前 12 hex，14 字符；只匹配 `vb+`。创建/重建时，已有网络复用前检查 driver/网桥选项/IPv6/Internal；不合规且为空则重建，有端点则明确拒绝。已有容器的启动只校验，不替换网络：即使停机后没有活动端点，它仍引用旧 NetworkID，必须重建机器。对账发现正在运行的旧网机器会停机并报错，不能继续假报健康。管理员重建、缺容器对账创建走相同路径；删除仍保留卷，不强制断开其它端点。
- `VB-GUARD` 在 IPv4 FORWARD 入口兜底私网、TCP 25、INVALID/UNTRACKED；`VB-EGRESS` 在 DOCKER-USER 做同样隔离及 **每源 IP** 新建速率 50/s、TCP 并发 512。`VB-INPUT` 限制 WSL 本机。只允许 `ESTABLISHED,RELATED --ctdir REPLY` 回包先行，避免旧的机器发起私网连接沿 ESTABLISHED 绕过。没有通用内网白名单。
- 私网/特殊目标：`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`、`127/8`。这些是**目的地址**过滤；经过 RFC1918/CGNAT 网关转发到公网 IP 不受影响。要改列表用上一节的 `vb-firewall.local`，不要改脚本里的默认值。若 DNS 上游本身处于这些网段，Docker 转发的 DNS 可能被阻断；应配置可达公网 DNS，不要放开整段。Windows 公网地址、VPN 自定义地址等若不在这些段内，须在部署验收中额外检查，不可据此宣称任意宿主地址均已覆盖。
- ICMP/UDP（含 DNS、QUIC）同样受目的地址隔离；全协议 NEW 流量受 hashlimit，TCP 才有 connlimit。UDP conntrack NEW 可能连续多包，50/s 是保守上限，不承诺精确按 UDP 会话数计量。机器没有 NET_RAW/NET_ADMIN，不能以伪造 SYN-ACK 或源地址当作受支持的合法协议。
- Docker 内置 DNS 是**容器 netns** 的 `127.0.0.11`。不在宿主 DNAT 到这个地址，也不开放宿主/网桥 `:53`。正常解析必须用实际行为验证，不能用 NAT 跳转存在代替。
- IPv6 在 FORWARD/INPUT 对 `vb+` 全丢；同时网络策略禁止 EnableIPv6。必须打开 `bridge-nf-call-iptables` 与 `bridge-nf-call-ip6tables`，确保同桥隔离。它们是**全局开关**，会让默认 bridge 和其它桥接容器也经过现有 iptables/ip6tables FORWARD，可能触发别的默认 DROP/隔离规则。本脚本的跳转只匹配 `vb+`，但无法承诺其它应用完全不受该全局开关影响；部署前后都应冒烟其它容器。不要用关闭 bridge-nf 当作修复，否则同桥隔离消失。
- **当前可验证部署：控制面在 WSL 宿主网络命名空间主动连 machined。仅把控制面容器加入用户网桥不足以支持它主动建连**：它也从 `vb+` 进入，私网规则会拦它。容器模式还需要可信控制面端点的单向发起许可（精确到可信 veth/身份，不能放开整段或整个网桥），控制面接入/断开协调也未由本脚本完成。把控制面放进用户网桥之前，必须先实现并验收这条单向许可；不得用 `VB_ALLOW_CIDRS` 开洞。
- 下行：bridge root TBF；上行：每个宿主 veth ingress **在进入 bridge-nf 前**重定向到该桥专属 `vbi<12hex>` IFB，再 TBF，均为 50 Mbit/s。同桥所有端点共享上行桶；不是每机器覆盖配置。IFB alias 为 `viate-bot:<bridge>`。脚本只从 `ip -j -d link show` 的 `info_kind=ifb` 和 `ifalias` 判断所有权，不读 `/sys/class/net/*/ifalias`，也不另挂 sysfs。alias 为空或属于别的桥时拒绝改名或删除。删网后清理仅自有 IFB。旧版 bridge ingress→IFB 会破坏 conntrack，禁止恢复。
- 规则用单次 `iptables-restore --noflush` filter 事务替换；缺模块/规则失败返回非零，不发布半条链。IPv4/IPv6 是各自事务，不是跨协议原子提交。监视器每 5 秒只修复缺失规则/tc，不反复清计数和限速桶；监督进程由 flock 保持唯一、重启异常退出的监视器。pid 校验含启动时间、命令参数和状态；成功周期超过 15 秒也自检失败。监督进程本身被终止/全体进程被杀时没有系统 init 自动恢复，须告警并重跑 provisioning/重启 RD。DOCKER-USER 跳转被删后，限连接规则最迟下一轮恢复；独立 FORWARD 的私网 guard 仍在。整个 FORWARD 表被外部清空时不能保证零窗口。

阈值只能收紧。`VB_RATE_MBIT=1..50`、`VB_HASHLIMIT=1..50`（整数，每秒）、`VB_HASHLIMIT_BURST=1..50`、`VB_CONNLIMIT=1..512`。每次运行把校验过的配置原子写到 `/run/vb-firewall/config`，监视器读取它；自检也用同一配置。日志 `/var/log/vb-firewall.log`。这些环境变量属于 WSL provisioning，不是控制面 `.env`。

## Windows 行为验收

以下在上面的 WSL root shell 执行；仅使用**专用验收机器**。先启动两个不同用户的机器，给出可从 WSL 正常访问的 Windows/公司内网 HTTP 服务作对照，避免“服务根本没开”的假通过：

```sh
docker ps --format '{{.Names}}'
printf '第一台机器容器名： '; read -r M
printf '第二台机器容器名： '; read -r OTHER
NET=$(docker inspect "$M" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
BR=$(docker network inspect "$NET" --format '{{index .Options "com.docker.network.bridge.name"}}')
MIP=$(docker inspect "$M" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
OIP=$(docker inspect "$OTHER" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
GW=$(docker inspect "$M" --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}')
IFB="vbi${BR#vb}"
printf 'Windows 实际 HTTP URL（含端口）： '; read -r WIN_URL
printf '公司内网实际 HTTP URL（含端口）： '; read -r LAN_URL
printf 'WSL 宿主控制面实际 health URL： '; read -r CONTROL_URL
printf '公网受控探针服务器 IPv4： '; read -r PUB
printf '%s\n' "$NET" "$BR" "$MIP" "$OIP" "$GW"
curl --max-time 5 -I "$WIN_URL"
curl --max-time 5 -I "$LAN_URL"
curl --max-time 5 -I "$CONTROL_URL"
```

最后三条必须有 HTTP 响应；WSL NAT 模式的默认 via 常是 Windows 地址，但 mirrored/VPN 场景不能直接这样推断。请在 PowerShell 用 `Get-NetIPAddress -AddressFamily IPv4` 对照实际 Windows 接口；将每个可达宿主地址重复纳入测试。

### 1. 结构、私网、控制面、公网、DNS、IPv6

```sh
sh "$P/vb-firewall-check.sh"; echo "exit:$?"
for url in "$WIN_URL" "$LAN_URL" "$CONTROL_URL" "http://$GW:7070/health" "http://$OIP:7070/health"; do
  docker exec "$M" curl --max-time 3 -sS -o /dev/null "$url"
  echo "blocked exit:$? $url"
done
curl --max-time 3 -sS -o /dev/null -w 'host→machined HTTP %{http_code}\n' "http://$MIP:7070/health"
docker exec "$M" curl --max-time 10 -I https://example.com/
docker exec "$M" cat /etc/resolv.conf
docker network inspect "$NET" --format 'IPv6={{.EnableIPv6}}'
ip6tables -S VB-EGRESS
docker exec "$M" curl -6 --max-time 3 -I https://example.com/; echo "IPv6 exit:$?"
```

预期：自检 PASS/0；`blocked` 各退出非零；宿主→machined HTTP 200 或认证 401，不能是 000；公网 HTTPS 成功；nameserver 为 127.0.0.11；IPv6=false，链有 DROP，IPv6 访问失败。网关/另一机器端口的“失败”还需用规则 DROP 计数上升证明，不能只靠服务未监听。

同桥隔离可用临时可信服务作正反对照（先确保 Alpine 镜像已拉取）：

```sh
docker run -d --name vb-accept-peer --network "$NET" alpine:3.20 sh -c 'mkdir -p /www; echo ok >/www/index.html; httpd -f -p 8080 -h /www'
PEER=$(docker inspect vb-accept-peer --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
curl --max-time 3 "http://$PEER:8080/"
docker exec "$M" curl --max-time 3 "http://$PEER:8080/"; echo "same-bridge exit:$?"
docker exec vb-accept-peer wget -T 3 -O - "http://$MIP:7070/health"; echo "container-control exit:$?"
docker rm -f vb-accept-peer
```

预期：宿主读到 `ok`；机器→同桥失败；同桥“控制面”主动连机器也失败，明确暴露上述尚不支持的容器控制面模式，不能当作成功验收该模式。

### 2. INVALID 与连接限制：必须实际触发，不是 grep 规则名

先在**你控制的公网 Linux 探针服务器**上执行下列 Python（开放 TCP 25/18080，结束后 Ctrl-C 清理；不要用并未监听的公共地址冒充）：

```sh
sudo python3 -u - <<'PY'
import selectors, socket
s = selectors.DefaultSelector()
for port in (25, 18080):
    sock = socket.socket(); sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('0.0.0.0', port)); sock.listen(1024); sock.setblocking(False)
    s.register(sock, selectors.EVENT_READ, True)
while True:
    for key, _ in s.select():
        if key.data:
            c, _ = key.fileobj.accept(); c.setblocking(False)
            s.register(c, selectors.EVENT_READ, False)
        else:
            c = key.fileobj
            data = c.recv(4096)
            if data.startswith(b'GET'):
                c.send(b'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok'); data = b''
            if not data:
                s.unregister(c); c.close()
PY
```

WSL 的基线 `curl --max-time 3 http://$PUB:25/` 与 `:18080/` 都应返回 `ok`。然后：

```sh
docker exec "$M" curl --max-time 3 "http://$PUB:25/"; echo "SMTP exit:$?"
docker exec "$M" curl --max-time 3 "http://$PUB:18080/"
cat /proc/sys/net/bridge/bridge-nf-call-iptables
iptables -nvxL VB-GUARD
iptables -nvxL VB-EGRESS
```

预期：SMTP 非零，18080 返回 ok，bridge-nf=1；GUARD 的 TCP25 DROP 增加；INVALID/UNTRACKED 不应因合法探针增加。若合法流量落入 INVALID，当前策略是丢弃而不是绕过限制：停止用户机器，保存 `iptables-save -c`、`tc -s qdisc`、`tc -s filter` 和日志；检查 bridge ingress **没有** mirred，重跑 provisioning。仍失败则阻止上线，保留宿主网络控制面；不得用 NOTRACK、关 bridge-nf、去掉 NEW 或放行 INVALID“修复”。仅改成 SYN hashlimit 无法修好依赖 conntrack 的 connlimit。

连接数测试临时收紧到 2（部署无其它活跃用户时执行）：

```sh
VB_CONNLIMIT=2 sh "$P/vb-firewall.start"
docker exec -i "$M" node - "$PUB" <<'JS'
const net = require('node:net');
const held = [];
(async () => {
  for (let i = 1; i <= 3; i++) {
    const result = await new Promise(resolve => {
      const s = net.connect(18080, process.argv[2]);
      s.setTimeout(2000);
      s.once('connect', () => { held.push(s); resolve('connected'); });
      s.once('timeout', () => { s.destroy(); resolve('blocked'); });
      s.once('error', () => resolve('error'));
    });
    console.log(i, result);
  }
  held.forEach(s => s.destroy());
})();
JS
iptables-save -c | grep -- '--connlimit-above'
VB_HASHLIMIT=2 VB_HASHLIMIT_BURST=2 sh "$P/vb-firewall.start"
docker exec -i "$M" node - "$PUB" <<'JS'
const net = require('node:net');
Promise.all(Array.from({length: 20}, () => new Promise(resolve => {
  const s = net.connect(18080, process.argv[2]); s.setTimeout(1000);
  s.once('connect', () => { s.destroy(); resolve(1); });
  s.once('timeout', () => { s.destroy(); resolve(0); });
  s.once('error', () => resolve(0));
}))).then(r => console.log('connected', r.reduce((a,b) => a+b, 0), 'of 20'));
JS
iptables-save -c | grep -- '--hashlimit-above'
sh "$P/vb-firewall.start"
```

预期连接依次 connected、connected、blocked；connlimit DROP >0。速率探针仅少量成功、明显小于20，hashlimit DROP >0。最后恢复默认。`DROP=0` 不能因为“有规则”就算通过。计数器日常只在策略修复/显式重下发时重置，不会每5秒归零。

### 3. 上下行、UDP/QUIC、其它容器

在公网探针机运行 `iperf3 -s`，放通 TCP/UDP 5201；在专用验收机器安装 iperf3（非生产机器）：

```sh
docker exec -u 0 "$M" sh -c 'apt-get update && apt-get install -y iperf3'
docker exec "$M" iperf3 -c "$PUB" -t 10
docker exec "$M" iperf3 -c "$PUB" -R -t 10
docker exec "$M" iperf3 -c "$PUB" -u -b 10M -t 5
tc -s qdisc show dev "$BR"
tc -s qdisc show dev "$IFB"
for dev in $(ip -o link show master "$BR" type veth | awk -F ': ' '{print $2}' | cut -d@ -f1); do tc -s filter show dev "$dev" parent ffff:; done
```

预期公网 TCP 双向约45–50 Mbit/s（宿主公网条件更差时先与无限速基线比较）；UDP 10 Mbit/s 有接收数据。IFB/bridge TBF 都是50Mbit，每个veth都有到对应IFB的all-match redirect，bridge本身无ingress redirect。若 iperf3 段错误，不能算网络通过，应换兼容版本/受控TCP收发工具；本机替身曾遇到该工具问题。

公网 QUIC 是否成功还取决于客户端支持和站点；`docker exec "$M" curl -V` 显示 HTTP3 时才运行 `docker exec "$M" curl --http3-only --max-time 10 -I https://cloudflare-quic.com/`。没有 HTTP3 支持时不宣称 QUIC 已测；UDP 数据路径已由上面的 iperf3 测试覆盖。私网 UDP/ICMP 还应观察 VB-GUARD 对应 CIDR DROP 的增加，例如 `docker exec "$M" node -e 'const s=require("node:dgram").createSocket("udp4");s.send("probe",443,process.argv[1],()=>s.close())' "$OIP"` 后 `iptables -nvxL VB-GUARD`。ICMP ping 需要 NET_RAW，正常机器没有该权限，不要为验收给生产机器加 capability；在独立受控验收容器中测试。

打开 bridge-nf 前后，对部署中**每个已有非 viate 容器**重复其实际健康检查（HTTP、DNS、同桥互联）。记录服务原有地址和响应；只看到本脚本的 `vb+` 限定不足以证明全局开关无副作用。

### 4. 幂等、自检失效、恢复与生命周期

```sh
iptables-save | grep -E '(^:VB-|^-A VB-|^-A (FORWARD|INPUT|DOCKER-USER).*VB-)' >/tmp/vb-before
sh "$P/vb-firewall.start"; sh "$P/vb-firewall.start"
iptables-save | grep -E '(^:VB-|^-A VB-|^-A (FORWARD|INPUT|DOCKER-USER).*VB-)' >/tmp/vb-after
diff -u /tmp/vb-before /tmp/vb-after
cat /run/vb-firewall/supervisor.pid /run/vb-firewall/monitor.pid
sh "$P/vb-firewall-check.sh"; echo "exit:$?"
rm /tmp/vb-before /tmp/vb-after
```

预期 diff 无输出，只有一组有效监督/监视进程，PASS/0。**仅在专用部署**删除一条规则/跳转或tc入口做故障注入：

```sh
iptables -D VB-EGRESS -p tcp --dport 25 -j DROP
sh "$P/vb-firewall-check.sh"; echo "missing-rule exit:$?"
sleep 6
sh "$P/vb-firewall-check.sh"; echo "repaired exit:$?"
iptables -D DOCKER-USER -i vb+ -j VB-EGRESS
sh "$P/vb-firewall-check.sh"; echo "missing-jump exit:$?"
sleep 6
sh "$P/vb-firewall-check.sh"
PORT=$(ip -o link show master "$BR" type veth | awk -F ': ' 'NR==1 {print $2}' | cut -d@ -f1)
tc qdisc del dev "$PORT" ingress
sh "$P/vb-firewall-check.sh"; echo "missing-tc exit:$?"
sleep 6
sh "$P/vb-firewall-check.sh"
```

缺失时预期 exit:1，下一周期恢复 PASS；若监视器恰好先修复了该项，观察日志确认修复而不是误判自检。监视器缺失与自动重启仅在专用环境中测试，先核实 pid + starttime + cmdline（不要杀监督进程）：

```sh
read -r PID START </run/vb-firewall/monitor.pid
if [ "$(awk '{print $22}' "/proc/$PID/stat")" = "$START" ] &&
   tr '\000' '\n' <"/proc/$PID/cmdline" | grep -Fxq -- "$(readlink -f "$P/vb-firewall.start")" &&
   tr '\000' '\n' <"/proc/$PID/cmdline" | grep -Fxq -- --monitor; then
  kill -KILL "$PID"
else
  echo '身份不符，未发送信号'
fi
sh "$P/vb-firewall-check.sh"; echo "missing-monitor exit:$?"
sleep 6
sh "$P/vb-firewall-check.sh"; echo "restarted exit:$?"
cat /run/vb-firewall/monitor.pid
```

预期缺失时1、恢复后0，新的monitor PID不同。生产环境不要为测试杀进程。

创建/删除一个独立验收网络，检查自有IFB清理：

```sh
H=$(date +%s%N | sha256sum | cut -c1-12)
TESTBR="vb$H"
TESTNET=$(docker network create -o "com.docker.network.bridge.name=$TESTBR" "vb-accept-$H")
sleep 6
sh "$P/vb-firewall-check.sh"
ip -d link show dev "vbi$H" | grep -F "alias viate-bot:$TESTBR"
docker network rm "$TESTNET"
sleep 6
if ip link show dev "vbi$H" >/dev/null 2>&1; then echo "IFB removed exit:1"; else echo "IFB removed exit:0"; fi
```

预期 `ip -d link` 里 alias 为 `viate-bot:vb<hash>`，删除后 exit:0。不要用 `/sys/class/net/.../ifalias` 判断：进 dockerd 网络命名空间时 /sys 仍可能是 init 的挂载。通过管理端重建用户机器：空旧网络被重建；仍挂控制面等端点的旧网络明确报错，不强拆端点；新网络的bridge选项必须为上面的稳定短名。删除机器后卷保留；监视器清理自有IFB。

## 重启、升级、Windows 重启

每项都在操作前保存行为基线，在操作后重新设置上述WSL变量，执行第1节全部命令、自检及连接限制探针：

1. 完全退出并重新启动 Rancher Desktop，等待 moby 就绪和自检 PASS。
2. 升级 Rancher Desktop 后首次启动，检查依赖/backend/module，再做同样验收。
3. 重启 Windows，等待 Rancher Desktop 启动，再做同样验收。

三项均须：宿主/内网/其它用户机器失败、公网与DNS成功、宿主主动连machined成功、限连接触发、双向tc完整。只验证链名存在不算通过。失败先停用户机器，保存 `/var/log/vb-firewall.log`，手动 `sh "$P/vb-firewall.start"` 再验；依然失败则禁止上线。控制面用特权一次性容器重新下发防火墙并没有自动化，不能把它当作现成恢复能力。

依据：[Rancher provisioning 启动顺序](https://docs.rancherdesktop.io/how-to-guides/provisioning-scripts/)、[Docker iptables/DOCKER-USER](https://docs.docker.com/engine/network/firewall-iptables/)、[Linux bridge netfilter](https://docs.kernel.org/networking/bridge.html)、[WSL 网络模式](https://learn.microsoft.com/en-us/windows/wsl/networking)。
