---
title: "OpenResty 用 Durpina 做滚动重启和发布"
excerpt: "滚动重启按批摘流、重启 supervisord 再挂回。滚动发布先同步新目录，再摘流、切软链、重启，由 Jenkins 调 Ansible。加减机器才改 nginx.conf 并 reload。"
category: "Reliability"
date: 2026-09-20
updatedDate: 2026-10-15
author:
  name: "Kaysen"
  role: "安全与可靠性"
cover:
  src: "./cover.jpg"
  alt: "机柜里一束网线从主干分到多条链路"
---

滚动重启和滚动发布，解决的是发版、重启窗口里用户请求报错。`supervisord` 拉起进程的那几秒，端口会断、旧连接会掉。这时 OpenResty 还把流量打过去，用户就会看到 502、连接拒绝、偶发超时。先从 upstream 里把机器 `down` 掉再动进程，这两种方式对用户侧都可以做到 0 报错。作者在线上实测过，有效。

三件事不要混：

- **滚动重启**：不换代码。按批把这批机器从 upstream 里 `down` 掉，`supervisorctl restart`，端口起来后再 `up`。
- **滚动发布**：先把新版本目录同步到所有机器，再按批 `down`、切软链、重启、`up`。Jenkins 的 Execute shell 调 Ansible。
- **加减机器**：先改 `nginx.conf` 里的 `server`，再 `openresty -s reload`，再跑管理脚本的 `sync`，让 Durpina 的 peer 列表跟当前 conf 对齐。

[Durpina](https://github.com/slact/durpina) 负责运行时改 peer 的 `up` / `down`。它是 OpenResty 上的动态 upstream 库，全称 Dynamic Upstream Reverse Proxying with Nice API，从 toruneko 的 `lua-resty-upstream` 分出来。peer 状态进 `lua_shared_dict`，`balancer_by_lua` 每次选后端时读这份状态。管理口只留探活、看节点、改状态、和 `nginx.conf` 对齐、一键全开。日常操作不手搓 curl，包一层 `durpina-manager.sh`。

## 为什么用 Durpina

静态 `upstream` 的问题很具体：

- 摘一台机器要改 conf、reload。reload 会换 worker，对长连接和 in-flight 请求不友好。滚动发版每台都摘一次，不能每摘一次就 reload 一次 Nginx。
- `nginx plus` 有 `upstream_conf`，Kong、APISIX 有自己的 upstream API。已经在跑 OpenResty、不想再挂一套控制面时，这些都偏重。
- 只靠 `max_fails` / `fail_timeout` 不够。健康检查摘的是已经失败的机器。滚动发布摘的是**还活着、只是马上要重启**的机器。必须先摘，再杀进程。顺序反了，客户就会打到正在重启的端口上。

Durpina 把 peer 标成 `up`、`down`、`failing`。`down` 是人设的，balancer 不再选它；`failing` 是失败计数或健康检查打出来的。滚动发布用的是 `down`。

安装：

```bash
opm install slact/durpina
```

库本身不带管理 HTTP。管理口是自己用 `content_by_lua_file` 包的，Lua 放在 `/usr/local/openresty/nginx/lua/durpina/`。

## 配置怎么拆

`nginx.conf` 的 `http` 里只加两行 include：共享内存和管理口。发行版通常已经 `include conf.d/*.conf`，有了就不要再写一遍。每个要交给 Durpina 调度的 `upstream`，再在那个块里 include `durpina-balancer.conf`。业务 `upstream` 和 `server` 仍放在 `conf.d`，不要把 Lua 块直接写进主配置。

`/usr/local/openresty/nginx/conf/nginx.conf`：

```nginx
http {
    include /usr/local/openresty/nginx/conf/durpina/durpina-http.conf;
    include /usr/local/openresty/nginx/conf/durpina/durpina-admin.conf;
    include /usr/local/openresty/nginx/conf/conf.d/*.conf;
}
```

三份片段各管一件事。

### http：共享内存和初始化

`durpina-http.conf` 放在 http 级。`lua_package_path` 指向 `opm` 装出来的 `resty_modules`，worker 才能 `require "durpina.upstream"`。Durpina **必须**在 `init_worker_by_lua` 里调用 `Upstream.init`，参数是共享内存的名字，要和 `lua_shared_dict` 一致。这里用 `durpina_upstream`，10m。后端全是 IPv4 直连，不传 `resolver`。

`/usr/local/openresty/nginx/conf/durpina/durpina-http.conf`：

```nginx
lua_package_path
    "/usr/local/openresty/nginx/resty_modules/lualib/?.lua;/usr/local/openresty/nginx/resty_modules/lualib/?/init.lua;;";

lua_shared_dict durpina_upstream 10m;

lua_socket_log_errors off;

init_worker_by_lua_block {
    local Upstream = require "durpina.upstream"
    Upstream.init("durpina_upstream")
}
```

`lua_socket_log_errors off` 是 Durpina 文档里的建议：peer 探活失败时不要把 error log 刷满。

OpenResty 一个 master 带多个 worker。每个 worker 有自己的 Lua 虚拟机，进程内的局部变量互不相通。`lua_shared_dict` 是 master 建出来的一块 mmap 内存，所有 worker 映射的是同一份。`init_worker_by_lua` 每个 worker 启动时都会跑，`Upstream.init("durpina_upstream")` 绑的就是这块 dict。

`peer:set_state("down")` 底层是 `shdict:set(down 的 key, true)`。管理口的请求只会落到其中一个 worker，但写进共享内存之后，别的 worker 下一次 `balancer_by_lua` 选路时 `is_down` 读到的也是这个 key。所以不用逐个通知、也不用 reload，所有 worker 都会跳过这台。返回里的 `worker_id` / `worker_pid` 只说明这次请求打到了哪个进程，不是「只改了这一个进程」。

### upstream：把选路交给 Lua

`durpina-balancer.conf` 只有这一段：

`/usr/local/openresty/nginx/conf/durpina/durpina-balancer.conf`：

```nginx
balancer_by_lua_block {
    require("durpina.balancer")("round-robin")
}
```

`balancer_by_lua_block` 只能写在 `upstream {}` 里，写到 `http` 或 `server` 会直接报错。所以业务配置要把这行 include 塞进对应的 `upstream` 块，放在 `server` 列表后面、块结束之前。抽成独立文件是为了多个 upstream 复用，业务 conf 里不再堆 Lua。不要把这段 Lua 再抄进 `conf.d`，include 一次即可。

线上这份在 `conf.d`。域名、证书路径、机器名都换成示例：

`/usr/local/openresty/nginx/conf/conf.d/openapi.conf`：

```nginx
upstream openapiserver-group {
    #least_conn;
    #ip_hash;
    server  10.0.0.11:8080  weight=5 max_fails=2 fail_timeout=10s;
    server  10.0.0.12:8080  weight=5 max_fails=2 fail_timeout=10s;
    server  10.0.0.13:8080  weight=5 max_fails=2 fail_timeout=10s;
    server  10.0.0.14:8080  weight=5 max_fails=2 fail_timeout=10s;
    server  10.0.0.15:8080  weight=5 max_fails=2 fail_timeout=10s;
    server  10.0.0.16:8080  weight=5 max_fails=2 fail_timeout=10s;
    include /usr/local/openresty/nginx/conf/durpina/durpina-balancer.conf;
}

server {
    listen 443 ssl;
    server_name api.example.com;

    ssl_certificate     /usr/local/openresty/nginx/ssl/api.example.com.pem;
    ssl_certificate_key /usr/local/openresty/nginx/ssl/api.example.com.key;

    location / {
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_send_timeout 10s;
        proxy_read_timeout 30s;
        proxy_pass http://openapiserver-group/;
        proxy_next_upstream error timeout invalid_header http_502 http_504 http_404;
        proxy_next_upstream_tries 2;
        proxy_next_upstream_timeout 60s;
    }
}
```

`least_conn` 和 `ip_hash` 要注释掉。选路已经交给 `balancer_by_lua`，再开 nginx 原生算法会和 Durpina 抢。`weight` 仍有效，Durpina 的 `round-robin` 是加权轮询，会读这一列。`max_fails` / `fail_timeout` 管的是失败计数打成 `failing`，和滚动时人设的 `down` 不是一回事。

`round-robin` 之外，库还提供 `unweighted-round-robin`、`ip-hash`、`consistent-hash`。滚动时池子里还 `up` 的节点继续轮询，正在重启的那台不在里面。`server 0.0.0.0` 在 Durpina 里当占位符，会被忽略。

业务 `location` 仍然 `proxy_pass http://openapiserver-group;`，应用层无感知。不走 Durpina 的其他 upstream，不要加这行 include。

### admin：只绑内网

管理口单独一个 `server`，不要和对外 80/443 共用。监听回环和内网地址，白名单放本机和运维跳板，其余一律 `deny`。

`/usr/local/openresty/nginx/conf/durpina/durpina-admin.conf`：

```nginx
server {
    listen 127.0.0.1:18081;
    listen 172.31.1.197:18081;
    server_name localhost 127.0.0.1;

    allow 127.0.0.1;
    allow 172.31.1.214;
    deny all;

    access_log /data/log/nginx/access.durpina.log json_combined;
    error_log  /data/log/nginx/error.durpina.log warn;

    location = /durpina/ping {
        default_type text/plain;
        return 200 "durpina-ok\n";
    }

    location = /durpina/info {
        content_by_lua_file /usr/local/openresty/nginx/lua/durpina/info.lua;
    }

    location = /durpina/set {
        content_by_lua_file /usr/local/openresty/nginx/lua/durpina/set.lua;
    }

    location = /durpina/sync {
        content_by_lua_file /usr/local/openresty/nginx/lua/durpina/sync.lua;
    }

    location = /durpina/enable-all {
        content_by_lua_file /usr/local/openresty/nginx/lua/durpina/enable_all.lua;
    }
}
```

`set` / `sync` / `enable-all` 在 Lua 里还卡了一次方法：不是 `POST` 直接 405。浏览器地址栏、监控探活、爬虫都不会误摘节点。`info` 和 `ping` 允许 GET。

## 五个接口

管理面入口统一是 `http://127.0.0.1:18081`。所有写操作带 `upstream=`，节点名和 conf 里的 `server` 一致，形如 `10.0.0.11:8080`。下面 curl 用来说明接口本身；滚动发版和加减机器用的是下一节的 `durpina-manager.sh`。

| 路径 | 方法 | 作用 |
| --- | --- | --- |
| `/durpina/ping` | GET | 进程活着 |
| `/durpina/info?upstream=` | GET | 当前 peer 列表，按 IP 分组 |
| `/durpina/set?upstream=&node=&action=` | POST | 单节点 `up` / `down` |
| `/durpina/sync?upstream=` | POST | 用 nginx 静态 server 列表对齐 Durpina |
| `/durpina/enable-all?upstream=` | POST | 该 upstream 全部设为 `up` |

返回里都带 `worker_id`、`worker_pid`。用来对照 error log。状态在共享内存里，打到任意 worker 都对所有进程生效。

### ping

```bash
curl -s http://127.0.0.1:18081/durpina/ping
# durpina-ok
```

只说明这个 `server` 在听，不说明 Durpina 已经 `Upstream.init`。init 失败时 ping 仍然 200，真正要看的是 `info`。

### info：按 IP 分组

`info` 调 `upstream:info()`，得到 JSON 后再做两件事：按 IPv4 数值排序，再按 IP 收成 `peer_groups`。同一台机器开多个端口时，滚动经常是「整机先全部 down，再动 supervisord」，分组是给人看的。

排序按数值而不是字符串，否则 `10.0.0.9` 会排到 `10.0.0.10` 后面。

```bash
curl -s 'http://127.0.0.1:18081/durpina/info?upstream=openapiserver-group' | jq .
```

结构大致是：

```json
{
  "ok": true,
  "worker_id": 0,
  "worker_pid": 12345,
  "upstream": {
    "name": "openapiserver-group",
    "peers": [
      {
        "name": "10.0.0.11:8080",
        "address": "10.0.0.11",
        "weight": 1,
        "state": "up"
      }
    ],
    "peer_groups": [
      {
        "address": "10.0.0.11",
        "total": 2,
        "up_count": 1,
        "down_count": 1,
        "failing_count": 0,
        "other_count": 0,
        "peers": []
      }
    ]
  }
}
```

缺 `upstream` 参数返回 400；名字不存在返回 404。每台 `down` / `up` 前后都打一次，不要只看 `set` 的 `ok`。

### set：摘一台、挂一台

滚动发布每台都走这一对调用：先 `down`，重启完再 `up`。

```bash
curl -s -X POST \
  'http://127.0.0.1:18081/durpina/set?upstream=openapiserver-group&node=10.0.0.11:8080&action=down'
```

`action` 只接受 `up` 或 `down`。内部是：

`/usr/local/openresty/nginx/lua/durpina/set.lua`：

```lua
local peer = upstream:get_peer(node)
local call_ok, set_result = pcall(peer.set_state, peer, action)
```

`pcall` 是防止 `set_state` 抛错把整个请求打成 500 且没有 JSON。成功时返回：

```json
{
  "ok": true,
  "upstream": "openapiserver-group",
  "node": "10.0.0.11:8080",
  "state": "down"
}
```

节点不在这个 upstream 里是 404。`set_state` 抛错，或者返回值不是 `true`，是 500。Durpina 文档没有保证 `set_state` 的返回值，有的版本成功时返回 `nil`。`set` 接口把「不是 true」当成失败，可能节点其实已经改了，接口却 500。碰到这种情况先打 `info`，不要连着重试，更不要在状态还没变成 `down` 时去重启 supervisord。管理脚本里对「HTTP 500 但 `ok=true`」按成功处理，就是为这个。

### enable-all：中途恢复

滚到一半要停的时候，把该 upstream 里**所有** peer 设成 `up`，让还能响应的机器全部回来接流量。

```bash
curl -s -X POST \
  'http://127.0.0.1:18081/durpina/enable-all?upstream=openapiserver-group'
```

返回里几个字段要一起看：

| 字段 | 含义 |
| --- | --- |
| `ok` | 这次 `set_state` 有没有失败 |
| `all_currently_up` | 读回来是不是已经全是 `up` |
| `non_up_nodes` | `set_state` 成功了，状态却还不是 `up` 的节点 |
| `results` | 每个节点的 before / requested / success |

`ok == true` 但 `all_currently_up == false` 是常见情况：节点被健康检查打成 `failing`，人设 `up` 清不掉。该去看进程、端口、探活 URI，而不是再 enable-all 一次。

正在重启、代码还没起来的那台，enable-all 也会把它标成 `up`。supervisord 还没起来的话，请求会打到死端口上。中途恢复前，先确认当前这台是已经重启完，还是卡在重启中。

### sync：以 nginx.conf 为准

`lua_shared_dict` **在 reload 之后还在**。这是 Durpina 能跨 reload 记住 `down` 的原因，也是列表会漂的原因：

- conf 里删了某台，共享内存里的 peer 可能还在
- conf 里加了某台，Durpina 可能还没 `add_peer`
- 有的 IPv4 节点只有 `name`，没有 `address`，balancer 选到它会出问题

`sync` 用 `ngx.upstream.get_servers()` 当期望列表，和 `upstream:get_peers("all")` 做差：缺的加，多的删，IPv4 却没有 address 的删掉重建，权重变了就 `set_weight`。`backup` 节点和 `0.0.0.0` 占位符直接跳过。

加减机器的顺序是：改 `nginx.conf` → `openresty -s reload` → `durpina-manager.sh sync`。滚动发版不走 sync，也不 reload Nginx。

## 管理脚本

接口可以直接 curl，日常用 `durpina-manager.sh`。默认打本机 `http://127.0.0.1:18081`，默认 upstream 是 `openapiserver-group`。依赖 `curl` 和 `jq`。从跳板机跑就改 `DURPINA_ADMIN_URL`。

```bash
durpina-manager.sh ping
durpina-manager.sh info
durpina-manager.sh list
durpina-manager.sh status 10.0.0.11:8080
durpina-manager.sh down   10.0.0.11:8080
durpina-manager.sh up     10.0.0.11:8080
durpina-manager.sh non-up
durpina-manager.sh enable-all
durpina-manager.sh sync
```

| 命令 | 做什么 |
| --- | --- |
| `ping` | 管理口是否返回 `durpina-ok` |
| `info` | 原始 JSON |
| `list` | 按 IP 分组打印 `up` / `down` / `failing` |
| `status` | 看单个 `IP:PORT` |
| `down` / `up` | 调 `/durpina/set` |
| `non-up` | 列出不是 `up` 的节点，有则退出码 2 |
| `enable-all` | 清掉全部人设的 `down` |
| `sync` | 等 Nginx reload 完成后，按当前 conf 对齐 Durpina |

`sync` 里的 `wait_reload_settled` 会看三件事：worker 进程列表是否还在变、磁盘 conf 的 mtime 是否已经早于 worker 启动时间、稳定后再等一秒。conf 改了但还没 reload，脚本会堵住，不会拿着旧 `get_servers()` 去 sync。差量以 sync 前后两次 `info` 对比为准，不盲信接口里的 `added` / `removed`。

`curl_request` 失败会重试。HTTP 500 但 body 里 `ok=true` 按成功处理，对应前面 `set_state` 返回值不稳的问题。

脚本按 Linux 的 `ps --ppid`、`stat -c %Y` 写，要放在 OpenResty 那台机器上跑。

完整脚本：

```bash
#!/usr/bin/env bash
set -euo pipefail
# ============================================================
# Durpina 管理脚本
# ============================================================
ADMIN_URL="${DURPINA_ADMIN_URL:-http://127.0.0.1:18081}"
UPSTREAM="${DURPINA_UPSTREAM:-openapiserver-group}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-3}"
CURL_MAX_TIME="${CURL_MAX_TIME:-15}"
CURL_RETRIES="${CURL_RETRIES:-4}"
NGINX_PID_FILE="${NGINX_PID_FILE:-/var/run/nginx.pid}"
NGINX_CONF_DIR="${NGINX_CONF_DIR:-/usr/local/openresty/nginx/conf}"
SYNC_WAIT_TIMEOUT="${SYNC_WAIT_TIMEOUT:-0}"

usage() {
    cat <<'EOF'
用法：
  durpina-manager.sh ping
  durpina-manager.sh info
  durpina-manager.sh list
  durpina-manager.sh sync
  durpina-manager.sh non-up
  durpina-manager.sh status <IP:PORT>
  durpina-manager.sh down   <IP:PORT>
  durpina-manager.sh up     <IP:PORT>
  durpina-manager.sh enable-all
示例：
  durpina-manager.sh info
  durpina-manager.sh sync
环境变量：
  DURPINA_ADMIN_URL     默认 http://127.0.0.1:18081
  DURPINA_UPSTREAM      默认 openapiserver-group
  CURL_RETRIES          失败后额外重试次数，默认 4（总共 5 次）
  NGINX_PID_FILE        默认 /var/run/nginx.pid
  NGINX_CONF_DIR        默认 /usr/local/openresty/nginx/conf
  SYNC_WAIT_TIMEOUT     等待 reload 超时秒数，0 表示一直等
EOF
}

die() {
    echo "ERROR: $*" >&2
    exit 1
}

check_commands() {
    command -v curl >/dev/null 2>&1 || die "未找到 curl"
    command -v jq >/dev/null 2>&1 || die "未找到 jq"
}

validate_node() {
    local node="$1"
    if [[ ! "$node" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+$ ]]; then
        die "节点格式错误，应为 IP:PORT，例如 10.0.0.11:8080"
    fi
    local ip="${node%:*}"
    local port="${node##*:}"
    local octet
    IFS='.' read -r -a octets <<< "$ip"
    if [[ "${#octets[@]}" -ne 4 ]]; then
        die "IP 地址格式错误：$ip"
    fi
    for octet in "${octets[@]}"; do
        if (( octet < 0 || octet > 255 )); then
            die "IP 地址格式错误：$ip"
        fi
    done
    if (( port < 1 || port > 65535 )); then
        die "端口范围错误：$port"
    fi
}

curl_request() {
    local attempt=0
    local max=$((CURL_RETRIES + 1))
    local http_code=""
    local body=""
    local curl_err=""
    local bodyfile errfile rc

    bodyfile="$(mktemp)"
    errfile="$(mktemp)"

    while (( attempt < max )); do
        attempt=$((attempt + 1))
        set +e
        http_code="$(
            curl -sS \
                --connect-timeout "$CURL_CONNECT_TIMEOUT" \
                --max-time "$CURL_MAX_TIME" \
                -o "$bodyfile" \
                -w '%{http_code}' \
                "$@" \
                2>"$errfile"
        )"
        rc=$?
        set -e
        body="$(cat "$bodyfile" 2>/dev/null || true)"
        curl_err="$(cat "$errfile" 2>/dev/null || true)"

        if [[ "$rc" -eq 0 && "$http_code" =~ ^2[0-9][0-9]$ ]]; then
            rm -f "$bodyfile" "$errfile"
            printf '%s' "$body"
            return 0
        fi

        if [[ "$rc" -eq 0 && "$http_code" == "500" ]]; then
            if jq -e '.ok == true' >/dev/null 2>&1 <<< "$body"; then
                echo "WARN: HTTP 500 但业务结果 ok=true，按成功处理" >&2
                rm -f "$bodyfile" "$errfile"
                printf '%s' "$body"
                return 0
            fi
        fi

        if (( attempt < max )); then
            echo "WARN: curl 第 ${attempt}/${max} 次失败，准备重试 (http=${http_code:-n/a} rc=${rc})" >&2
            sleep 2
        fi
    done

    echo "ERROR: curl 失败，已重试 ${CURL_RETRIES} 次" >&2
    echo "  url/args: $*" >&2
    echo "  http_code: ${http_code:-n/a}" >&2
    if [[ -n "$curl_err" ]]; then
        echo "  curl_stderr: $curl_err" >&2
    fi
    if [[ -n "$body" ]]; then
        echo "  response:" >&2
        echo "$body" >&2
    fi
    rm -f "$bodyfile" "$errfile"
    exit 1
}

nginx_master_pid() {
    if [[ ! -r "$NGINX_PID_FILE" ]]; then
        die "找不到 pid 文件：$NGINX_PID_FILE"
    fi
    cat "$NGINX_PID_FILE"
}

nginx_worker_pids() {
    local master
    master="$(nginx_master_pid)"
    ps -o pid= --ppid "$master" 2>/dev/null | awk '{print $1}' | sort | tr '\n' ' '
}

conf_newest_mtime() {
    local f newest=0 m
    shopt -s nullglob
    for f in \
        "${NGINX_CONF_DIR}/nginx.conf" \
        "${NGINX_CONF_DIR}/conf.d/"*.conf \
        "${NGINX_CONF_DIR}/durpina/"*.conf
    do
        [[ -f "$f" ]] || continue
        m="$(stat -c %Y "$f")"
        if (( m > newest )); then
            newest="$m"
        fi
    done
    shopt -u nullglob
    echo "$newest"
}

workers_oldest_start() {
    local master etimes max_etimes=0
    master="$(nginx_master_pid)"
    while read -r etimes; do
        [[ -n "$etimes" ]] || continue
        if (( etimes > max_etimes )); then
            max_etimes="$etimes"
        fi
    done < <(ps -o etimes= --ppid "$master" 2>/dev/null)
    if (( max_etimes == 0 )); then
        echo 0
        return
    fi
    echo $(( $(date +%s) - max_etimes ))
}

wait_reload_settled() {
    local prev="" curr
    local conf_mtime worker_start
    local started now
    started="$(date +%s)"

    echo "等待 Nginx 加载完当前磁盘配置..."
    while true; do
        now="$(date +%s)"
        if (( SYNC_WAIT_TIMEOUT > 0 && now - started >= SYNC_WAIT_TIMEOUT )); then
            die "等待 reload 超时（${SYNC_WAIT_TIMEOUT}s），配置仍未被 worker 加载"
        fi

        curr="$(nginx_worker_pids)"
        conf_mtime="$(conf_newest_mtime)"
        worker_start="$(workers_oldest_start)"

        if [[ -z "$curr" || "$worker_start" -eq 0 ]]; then
            echo "worker 列表为空或无法读取，等待中..."
            sleep 3
            continue
        fi

        if [[ -n "$prev" && "$curr" != "$prev" ]]; then
            echo "worker 仍在切换（reload 进行中）..."
            prev="$curr"
            sleep 3
            continue
        fi

        if (( worker_start < conf_mtime )); then
            echo "配置已更新但尚未 reload（conf=$(date -d "@$conf_mtime" '+%H:%M:%S') worker=$(date -d "@$worker_start" '+%H:%M:%S')），阻塞等待..."
            prev="$curr"
            sleep 3
            continue
        fi

        if [[ -z "$prev" ]]; then
            prev="$curr"
            sleep 3
            continue
        fi

        echo "reload 已完成，worker 已稳定：${curr}"
        echo "再等待 1 秒后同步"
        sleep 1
        return 0
    done
}

peer_names_json() {
    api_get_info | jq -c '[.upstream.peers[]?.name] | unique | sort'
}

api_get_info() {
    curl_request \
        -G "${ADMIN_URL}/durpina/info" \
        --data-urlencode "upstream=${UPSTREAM}"
}

api_set_state() {
    local node="$1"
    local action="$2"
    curl_request \
        -X POST \
        -G "${ADMIN_URL}/durpina/set" \
        --data-urlencode "upstream=${UPSTREAM}" \
        --data-urlencode "node=${node}" \
        --data-urlencode "action=${action}"
}

api_sync() {
    curl_request \
        -X POST \
        -G "${ADMIN_URL}/durpina/sync" \
        --data-urlencode "upstream=${UPSTREAM}"
}

cmd_ping() {
    local response
    response="$(curl_request "${ADMIN_URL}/durpina/ping")"
    response="$(echo "$response" | tr -d '\r\n')"
    if [[ "$response" != "durpina-ok" ]]; then
        die "Durpina 管理接口异常：${response}"
    fi
    echo "OK: Durpina 管理接口正常"
}

cmd_info() {
    api_get_info | jq .
}

cmd_sync() {
    local response ok
    local before after
    local added removed kept

    wait_reload_settled

    before="$(peer_names_json)"
    echo "同步前节点：$(jq -r 'join(", ")' <<< "$before")"

    response="$(api_sync)"
    echo "$response" | jq .

    ok="$(jq -r '.ok // false' <<< "$response")"
    if [[ "$ok" != "true" ]]; then
        die "sync 接口执行失败"
    fi

    after="$(peer_names_json)"
    added="$(jq -n --argjson b "$before" --argjson a "$after" '$a - $b')"
    removed="$(jq -n --argjson b "$before" --argjson a "$after" '$b - $a')"
    kept="$(jq -n --argjson b "$before" --argjson a "$after" '$a - ($a - $b)')"

    echo
    echo "实际差量（以 info 同步前后对比，不依赖接口内 removed/added）："
    echo "  added:    $(jq -c '.' <<< "$added")"
    echo "  removed:  $(jq -c '.' <<< "$removed")"
    echo "  kept:     $(jq -c '.' <<< "$kept")"
    echo
    echo "OK: Upstream ${UPSTREAM} 已按当前 Nginx upstream 同步"
}

cmd_list() {
    local response
    response="$(api_get_info)"
    echo "Upstream: $UPSTREAM"
    echo
    if jq -e '
        .upstream.peer_groups
        and (.upstream.peer_groups | type == "array")
        and (.upstream.peer_groups | length > 0)
    ' <<< "$response" >/dev/null; then
        jq -r '
            .upstream.peer_groups[]
            |
            "IP：\(.address // (.peers[0].name | split(":")[0]))",
            "总数：\(.total)  UP：\(.up_count)  DOWN：\(.down_count)  FAILING：\(.failing_count)  OTHER：\(.other_count)",
            (
                .peers[]
                | "  \(.name)\t\(.state)"
            ),
            ""
        ' <<< "$response"
    else
        jq -r '
            .upstream.peers
            | group_by(.address)[]
            |
            "IP：\(.[0].address // (.[0].name | split(":")[0]))",
            (
                .[]
                | "  \(.name)\t\(.state)"
            ),
            ""
        ' <<< "$response"
    fi
}

cmd_status() {
    local node="$1"
    local response
    local count
    validate_node "$node"
    response="$(api_get_info)"
    count="$(
        jq --arg node "$node" \
            '[.upstream.peers[] | select(.name == $node)] | length' \
            <<< "$response"
    )"
    if [[ "$count" -eq 0 ]]; then
        die "Upstream ${UPSTREAM} 中不存在节点：${node}"
    fi
    jq --arg node "$node" '.upstream.peers[] | select(.name == $node)' <<< "$response"
}

cmd_set_state() {
    local node="$1"
    local action="$2"
    local response returned_state returned_node ok
    validate_node "$node"
    response="$(api_set_state "$node" "$action")"
    ok="$(jq -r '.ok // false' <<< "$response")"
    returned_state="$(jq -r '.state // empty' <<< "$response")"
    returned_node="$(jq -r '.node // empty' <<< "$response")"
    if [[ "$ok" != "true" ]]; then
        echo "$response" | jq .
        die "设置节点状态失败"
    fi
    if [[ "$returned_node" != "$node" || "$returned_state" != "$action" ]]; then
        echo "$response" | jq .
        die "接口返回不一致"
    fi
    echo "$response" | jq .
    echo
    echo "OK: ${node} 已设置为 ${action}"
}

cmd_enable_all() {
    local response ok non_up_count
    response="$(
        curl_request \
            -X POST \
            -G "${ADMIN_URL}/durpina/enable-all" \
            --data-urlencode "upstream=${UPSTREAM}"
    )"
    echo "$response" | jq .
    ok="$(jq -r '.ok // false' <<< "$response")"
    non_up_count="$(jq '.non_up_nodes // [] | length' <<< "$response")"
    if [[ "$ok" != "true" ]]; then
        die "enable-all 接口执行失败"
    fi
    if [[ "$non_up_count" -gt 0 ]]; then
        echo
        echo "WARNING: 已解除全部显式 down，但仍有节点不是 up："
        jq -r '.non_up_nodes[] | "  \(.node)\t\(.state)"' <<< "$response"
        exit 2
    fi
    echo
    echo "OK: Upstream ${UPSTREAM} 全部节点已启用"
}

cmd_non_up() {
    local response count
    response="$(api_get_info)"
    count="$(jq '[.upstream.peers[] | select(.state != "up")] | length' <<< "$response")"
    if [[ "$count" -eq 0 ]]; then
        echo "OK: Upstream ${UPSTREAM} 当前全部节点均为 up"
        return
    fi
    echo "发现 ${count} 个非 up 节点："
    jq -r '.upstream.peers[] | select(.state != "up") | "  \(.name)\t\(.state)"' <<< "$response"
    exit 2
}

main() {
    check_commands
    local command="${1:-}"
    case "$command" in
        ping) [[ "$#" -eq 1 ]] || { usage; exit 1; }; cmd_ping ;;
        info) [[ "$#" -eq 1 ]] || { usage; exit 1; }; cmd_info ;;
        list) [[ "$#" -eq 1 ]] || { usage; exit 1; }; cmd_list ;;
        sync) [[ "$#" -eq 1 ]] || { usage; exit 1; }; cmd_sync ;;
        status) [[ "$#" -eq 2 ]] || { usage; exit 1; }; cmd_status "$2" ;;
        down) [[ "$#" -eq 2 ]] || { usage; exit 1; }; cmd_set_state "$2" "down" ;;
        up) [[ "$#" -eq 2 ]] || { usage; exit 1; }; cmd_set_state "$2" "up" ;;
        enable-all) [[ "$#" -eq 1 ]] || { usage; exit 1; }; cmd_enable_all ;;
        non-up) [[ "$#" -eq 1 ]] || { usage; exit 1; }; cmd_non_up ;;
        help|-h|--help|"") usage ;;
        *) echo "未知命令：${command}" >&2; echo; usage; exit 1 ;;
    esac
}

main "$@"
```

## 滚动发布

对 `upstream` 里的每一台，顺序固定。先 `down`，确认 balancer 不再选它，再动这台机器，探活通过后再 `up`。滚动重启只拉起进程。滚动发布还要把软链切到已经同步好的新目录。下面这段是手工滚一台时的样子，Ansible 按同一顺序包成两份剧本。

```
down → 换代码（发布才有）→ supervisorctl restart → 探活 → up → 下一台
```

这一步**不 reload Nginx**。要重启的是这台机器上的应用进程。客户请求一直打在还 `up` 的节点上，不会打到正在重启的那台，所以不会因为这次发版出现报错或请求不通。

```bash
NODE=10.0.0.11:8080

./durpina-manager.sh ping
./durpina-manager.sh list
./durpina-manager.sh down "$NODE"
./durpina-manager.sh status "$NODE"
# 确认 state 已经是 down，再换代码、重启 supervisord
# ssh 10.0.0.11
# 发布新代码
# supervisorctl restart <program>
# 本机探活通过后再挂回来
./durpina-manager.sh up "$NODE"
./durpina-manager.sh status "$NODE"
```

等价的 curl 是 `POST /durpina/set?...&action=down`。脚本只是把这组请求和校验包起来。`status` 里还不是 `down`，就不要重启这台的 supervisord。

开始前用 `list` 看剩下的 `up` 能不能扛住少一台之后的流量。扛不住就先扩容，不要硬滚。手工滚时一台异常就停。Ansible 允许单台失败后继续，失败记日志，并尝试把这台挂回。

整机多个端口时，把该 IP 下每个 `name` 都 `down` 一遍，再动 supervisord。只摘一个端口、同机另一个端口还在 `up`，重启时仍可能伤到那条端口上的请求。

已建立的 keepalive 不会在 `down` 的瞬间消失。`down` 之后按 `keepalive_timeout` 等一轮，再重启。

滚到一半要停：已经重启完并且探活通过的节点保持 `up`；正在重启的保持 `down`。整池不稳再用 `enable-all`，但不要把还没起来的节点一起标成 `up`。

```bash
./durpina-manager.sh enable-all
```

`enable-all` 是「把人设的 down 清掉」，不是「把坏掉的机器救活」。

## 滚动重启

不换代码。playbook 把 `openapiserver_group` 里的机器按 `serial` 分批处理，默认一批 5 台。`-f` 只提高 Ansible 的并发连接数，一批几台仍由 `serial` 决定。

Durpina 的请求都 `delegate_to: localhost`，从跑 playbook 的控制机访问管理口 `http://172.31.1.197:18081`。管理口的 `allow` 要放行这台控制机，前面的例子是 `172.31.1.214`。节点名用这台机器的默认 IPv4，加上 inventory 里的 `upstream_ports`。它可以是列表，也可以是逗号分隔的字符串。拼出来的 `IP:PORT` 必须和 `nginx.conf` 里的 `server` 一致。

```ini
[openapiserver_group]
10.0.0.11 upstream_ports=8080
10.0.0.12 upstream_ports=8080
10.0.0.13 upstream_ports=8080
```

一台失败不让整批停下：`any_errors_fatal: false`。失败的那台进入 rescue，把错误追加到 `/var/log/openapiserver-rolling-restart-error.log`，再尝试 `action=up`，然后继续其他机器。rescue 里的任务都成功时，这台机器不算 play 失败。收尾在控制机上打一次 `info`。还有非 `up` 节点就再记一行日志，playbook 仍以 0 退出。`ansible_failed_result` 只在 rescue 里有定义，所以收尾用 `register` 判断要不要写日志。

另一批机器复制这份剧本，改 `hosts`、`durpina_admin_url` 和错误日志路径。

`openapi-rolling-restart.yml`：

```yaml
---
- name: Openapiserver Durpina rolling restart
  hosts: openapiserver_group
  gather_facts: true
  serial: "{{ rolling_batch_size | default(5) }}"
  any_errors_fatal: false
  vars:
    durpina_admin_url: "http://172.31.1.197:18081"
    durpina_upstream: "openapiserver-group"
    drain_seconds: 5
    startup_timeout: 120
    durpina_timeout: 10
    error_log: "/var/log/openapiserver-rolling-restart-error.log"

  tasks:
    - name: 设置应用 IP
      set_fact:
        app_ip: "{{ ansible_default_ipv4.address }}"

    - name: 解析应用端口
      set_fact:
        app_ports: "{{ upstream_ports if (upstream_ports is sequence and upstream_ports is not string) else (upstream_ports | string).split(',') | map('trim') | reject('equalto', '') | list }}"

    - name: 生成 Durpina 节点列表
      set_fact:
        durpina_nodes: "{{ app_ports | map('regex_replace', '^(.*)$', app_ip + ':\\1') | list }}"

    - name: 输出当前节点信息
      debug:
        msg: "开始处理 {{ inventory_hostname }} ({{ app_ip }}) → 节点: {{ durpina_nodes | join(', ') }}"

    - name: 滚动重启主流程
      block:
        - name: 检查 Durpina 接口
          uri:
            url: "{{ durpina_admin_url }}/durpina/ping"
            method: GET
            return_content: true
            timeout: "{{ durpina_timeout }}"
          delegate_to: localhost
          register: durpina_ping
          failed_when: durpina_ping.status != 200

        - name: 下线 Durpina 节点
          uri:
            url: "{{ durpina_admin_url }}/durpina/set?upstream={{ durpina_upstream | urlencode }}&node={{ item | urlencode }}&action=down"
            method: POST
            status_code: [200]
            timeout: "{{ durpina_timeout }}"
          loop: "{{ durpina_nodes }}"
          delegate_to: localhost
          no_log: true

        - name: 等待连接释放
          pause:
            seconds: "{{ drain_seconds }}"

        - name: 重启 Openapiserver
          shell: supervisorctl restart 'openapiserver:*'
          register: restart_result
          failed_when: restart_result.rc != 0

        - name: 等待应用端口启动
          wait_for:
            host: "{{ app_ip }}"
            port: "{{ item }}"
            state: started
            timeout: "{{ startup_timeout }}"
          loop: "{{ app_ports }}"
          register: wait_result
          no_log: true

        - name: 端口启动结果
          debug:
            msg: "{{ inventory_hostname }} 端口 {{ item.item }} 已启动"
          loop: "{{ wait_result.results }}"
          when: item is succeeded
          loop_control:
            label: "{{ item.item }}"

        - name: 恢复 Durpina 节点
          uri:
            url: "{{ durpina_admin_url }}/durpina/set?upstream={{ durpina_upstream | urlencode }}&node={{ item | urlencode }}&action=up"
            method: POST
            status_code: [200]
            timeout: "{{ durpina_timeout }}"
          loop: "{{ durpina_nodes }}"
          delegate_to: localhost
          no_log: true

        - name: 等待 Durpina 状态同步
          pause:
            seconds: 3

        - name: 查询恢复后 Durpina 状态
          uri:
            url: "{{ durpina_admin_url }}/durpina/info?upstream={{ durpina_upstream }}"
            method: GET
            return_content: true
            timeout: "{{ durpina_timeout }}"
          delegate_to: localhost
          register: _durpina_raw
          no_log: true

        - name: 提取当前节点状态
          set_fact:
            current_peers: "{{ _durpina_raw.json.upstream.peers | selectattr('name', 'in', durpina_nodes) | list }}"
          no_log: true

        - name: 检查当前节点是否恢复 up
          assert:
            that:
              - item.state == "up"
            fail_msg: "Durpina 节点未恢复: {{ item.name }}"
            success_msg: "Durpina 节点已恢复: {{ item.name }}"
          loop: "{{ current_peers }}"
          loop_control:
            label: "{{ item.name }}"
          delegate_to: localhost

        - name: 本批完成
          debug:
            msg: "{{ inventory_hostname }} 重启成功"

      rescue:
        - name: 记录失败信息
          lineinfile:
            path: "{{ error_log }}"
            line: "{{ ansible_date_time.iso8601 }} | FAILED | {{ inventory_hostname }} | {{ ansible_failed_task.name | default('unknown') }} | {{ ansible_failed_result.msg | default(ansible_failed_result | string) | truncate(300) }}"
            create: yes
            mode: "0644"
          delegate_to: localhost
          ignore_errors: true

        - name: 失败后尝试把节点重新上线
          uri:
            url: "{{ durpina_admin_url }}/durpina/set?upstream={{ durpina_upstream | urlencode }}&node={{ item | urlencode }}&action=up"
            method: POST
            status_code: [200, 400, 500]
            timeout: "{{ durpina_timeout }}"
          loop: "{{ durpina_nodes | default([]) }}"
          delegate_to: localhost
          no_log: true
          ignore_errors: true

        - name: 标记本机失败并继续
          debug:
            msg: "{{ inventory_hostname }} 重启失败，已跳过，继续处理其他主机"
          failed_when: false

- name: Openapiserver Durpina final check
  hosts: localhost
  gather_facts: false
  vars:
    durpina_admin_url: "http://172.31.1.197:18081"
    durpina_upstream: "openapiserver-group"
    error_log: "/var/log/openapiserver-rolling-restart-error.log"
  tasks:
    - name: 查询最终 Durpina 状态
      uri:
        url: "{{ durpina_admin_url }}/durpina/info?upstream={{ durpina_upstream }}"
        method: GET
        return_content: true
        timeout: 10
      register: final_durpina
      no_log: true

    - name: 检查是否存在非 up 节点
      assert:
        that:
          - >
            (
              final_durpina.json.upstream.peers
              | selectattr('state','ne','up')
              | list
              | length
            ) == 0
        fail_msg: "发现非 up 节点，请检查 Durpina 状态"
        success_msg: "所有节点状态正常"
      register: final_assert
      ignore_errors: true

    - name: 最终失败记录
      lineinfile:
        path: "{{ error_log }}"
        line: "{{ lookup('pipe', 'date -u +%Y-%m-%dT%H:%M:%SZ') }} | FINAL_CHECK_FAILED | non-up peers remain"
        create: yes
        mode: "0644"
      when: final_assert is failed
      ignore_errors: true
```

`selectattr('name', 'in', durpina_nodes)` 对不上名字时，列表是空的，assert 的循环一次都不跑，单台检查会放过。节点名和 conf 不一致时，先看 `list`，不要只看这条成功。

摘流和挂回加了 `no_log`。Ansible 输出里看不到 URL 和返回体，失败详情在错误日志里。

## 滚动发布

Jenkins 任务的 Build Steps 里选 Execute shell：

```bash
ansible-playbook /etc/ansible/playbooks/openapi-rolling-deploy.yml \
  -e target_group=openapiserver_group \
  -e backup_dir=${BACKUP_DIR} \
  -e rolling_batch_size=5
```

`${BACKUP_DIR}` 是控制机上新版本目录的绝对路径。剧本分三段。

第一段不摘流，也不切软链。`synchronize` 把这个目录推到每台机器的同一路径。`delete: true` 会删掉目标里多出来的文件，所以这个目录必须是完整版本树。控制机和业务机都要有 `rsync`。这一段失败的机器不会进入后面的滚动，软链还指着旧目录。

第二段才按批滚动。集群变量放在 `group_vars/openapiserver_group.yml`，不要写进 play vars：

```yaml
durpina_admin_url: "http://172.31.1.197:18081"
durpina_upstream: "openapiserver-group"
link_path: "/srv/openapiserver/current"
drain_seconds: 5
startup_timeout: 120
durpina_timeout: 10
```

`link_path` 换成机器上软链的真实路径。`upstream_ports` 仍是 host 变量，和滚动重启用同一份 inventory。

每台的顺序是 `down`，等 `drain_seconds`，把 `link_path` 指向 `backup_dir`，`supervisorctl restart 'openapiserver:*'`，等端口，`up`，等 3 秒，再断言 `info` 里这台的 `state` 是 `up`。切软链和 `supervisorctl` 用 inventory 里的连接用户，这个用户要有这两项权限。

切软链之后失败，剧本不会把软链切回旧目录。rescue 把失败写到 `/var/log/openapiserver-rolling-deploy-error.log`，然后最多再挂回两次，不给 `uri` 加 `retries`。单台失败继续下一台。要回到旧代码，就用旧目录再发一次。

第三段在控制机上收尾。还有非 `up` 节点会记日志。每轮先记一个 `deploy_run_id`，失败行带上它。日志里只要有这一轮的 `FAILED`，playbook 就非 0 退出，Jenkins 能看出这次发布有机器没成。旧日志里的失败不会把后来的成功发布打红。

`openapi-rolling-deploy.yml`：

```yaml
---
- name: Stamp this deploy
  hosts: localhost
  gather_facts: false
  tasks:
    - name: 记录本轮编号
      set_fact:
        deploy_run_id: "{{ '%Y%m%d%H%M%S' | strftime }}"

- name: Sync new directory without switching link or draining
  hosts: "{{ target_group }}"
  gather_facts: false
  become: false
  tasks:
    - name: 要求用额外变量传入新版本目录
      assert:
        that:
          - backup_dir is defined
          - backup_dir is match('^/')
        fail_msg: "用 -e backup_dir=/绝对路径 传入新版本目录"
      run_once: true

    - name: 把新版本目录推到相同绝对路径
      ansible.builtin.synchronize:
        src: "{{ backup_dir }}/"
        dest: "{{ backup_dir }}/"
        recursive: true
        delete: true
        mode: push

- name: Rolling switch link and restart
  hosts: "{{ target_group }}"
  gather_facts: true
  serial: "{{ rolling_batch_size | default(5) }}"
  any_errors_fatal: false
  vars:
    error_log: "/var/log/openapiserver-rolling-deploy-error.log"
  tasks:
    - name: 确认集群变量来自 group_vars
      assert:
        that:
          - durpina_admin_url is defined
          - durpina_admin_url | length > 0
          - durpina_upstream is defined
          - link_path is defined
          - drain_seconds is defined
          - startup_timeout is defined
          - durpina_timeout is defined
          - backup_dir is defined
        fail_msg: >-
          缺少集群变量。确认 -e target_group 指向的组有
          group_vars，并且这些变量没有被 play vars 盖掉。

    - name: 设置应用 IP
      set_fact:
        app_ip: "{{ ansible_default_ipv4.address }}"

    - name: 解析应用端口
      set_fact:
        app_ports: "{{ upstream_ports if (upstream_ports is sequence and upstream_ports is not string) else (upstream_ports | string).split(',') | map('trim') | reject('equalto', '') | list }}"

    - name: 生成 Durpina 节点列表
      set_fact:
        durpina_nodes: "{{ app_ports | map('regex_replace', '^(.*)$', app_ip + ':\\1') | list }}"

    - name: 滚动发布主流程
      block:
        - name: 检查 Durpina 接口
          uri:
            url: "{{ durpina_admin_url }}/durpina/ping"
            method: GET
            return_content: true
            timeout: "{{ durpina_timeout }}"
          delegate_to: localhost
          register: durpina_ping
          failed_when: durpina_ping.status != 200

        - name: 下线 Durpina 节点
          uri:
            url: "{{ durpina_admin_url }}/durpina/set?upstream={{ durpina_upstream | urlencode }}&node={{ item | urlencode }}&action=down"
            method: POST
            status_code: [200]
            timeout: "{{ durpina_timeout }}"
          loop: "{{ durpina_nodes }}"
          delegate_to: localhost
          no_log: true

        - name: 等待连接释放
          pause:
            seconds: "{{ drain_seconds }}"

        - name: 把软链切到新目录
          file:
            src: "{{ backup_dir }}"
            dest: "{{ link_path }}"
            state: link
            force: true

        - name: 重启 Openapiserver
          shell: supervisorctl restart 'openapiserver:*'
          register: restart_result
          failed_when: restart_result.rc != 0

        - name: 等待应用端口启动
          wait_for:
            host: "{{ app_ip }}"
            port: "{{ item }}"
            state: started
            timeout: "{{ startup_timeout }}"
          loop: "{{ app_ports }}"
          register: wait_result
          no_log: true

        - name: 恢复 Durpina 节点
          uri:
            url: "{{ durpina_admin_url }}/durpina/set?upstream={{ durpina_upstream | urlencode }}&node={{ item | urlencode }}&action=up"
            method: POST
            status_code: [200]
            timeout: "{{ durpina_timeout }}"
          loop: "{{ durpina_nodes }}"
          delegate_to: localhost
          no_log: true

        - name: 等待 Durpina 状态同步
          pause:
            seconds: 3

        - name: 查询恢复后 Durpina 状态
          uri:
            url: "{{ durpina_admin_url }}/durpina/info?upstream={{ durpina_upstream }}"
            method: GET
            return_content: true
            timeout: "{{ durpina_timeout }}"
          delegate_to: localhost
          register: _durpina_raw
          no_log: true

        - name: 提取当前节点状态
          set_fact:
            current_peers: "{{ _durpina_raw.json.upstream.peers | selectattr('name', 'in', durpina_nodes) | list }}"
          no_log: true

        - name: 检查当前节点是否恢复 up
          assert:
            that:
              - item.state == "up"
            fail_msg: "Durpina 节点未恢复: {{ item.name }}"
            success_msg: "Durpina 节点已恢复: {{ item.name }}"
          loop: "{{ current_peers }}"
          loop_control:
            label: "{{ item.name }}"
          delegate_to: localhost

        - name: 本机发布成功
          debug:
            msg: "{{ inventory_hostname }} -> {{ backup_dir }}"

      rescue:
        - name: 记录失败信息
          lineinfile:
            path: "{{ error_log }}"
            line: "{{ ansible_date_time.iso8601 }} run_id={{ hostvars['localhost'].deploy_run_id }} FAILED {{ inventory_hostname }} backup_dir={{ backup_dir }} target_group={{ target_group }} task={{ ansible_failed_task.name | default('unknown') }}"
            create: yes
            mode: "0644"
          delegate_to: localhost
          ignore_errors: true

        - name: 失败后第 1 次挂回
          uri:
            url: "{{ durpina_admin_url }}/durpina/set?upstream={{ durpina_upstream | urlencode }}&node={{ item | urlencode }}&action=up"
            method: POST
            status_code: [200]
            timeout: "{{ durpina_timeout }}"
          loop: "{{ durpina_nodes | default([]) }}"
          delegate_to: localhost
          no_log: true
          ignore_errors: true

        - name: 失败后第 2 次挂回
          uri:
            url: "{{ durpina_admin_url }}/durpina/set?upstream={{ durpina_upstream | urlencode }}&node={{ item | urlencode }}&action=up"
            method: POST
            status_code: [200]
            timeout: "{{ durpina_timeout }}"
          loop: "{{ durpina_nodes | default([]) }}"
          delegate_to: localhost
          no_log: true
          ignore_errors: true

        - name: 标记本机失败并继续
          debug:
            msg: "{{ inventory_hostname }} 发布失败，已跳过，继续处理其他主机"
          failed_when: false

- name: Openapiserver Durpina final check
  hosts: localhost
  gather_facts: false
  vars:
    durpina_admin_url: "http://172.31.1.197:18081"
    durpina_upstream: "openapiserver-group"
    error_log: "/var/log/openapiserver-rolling-deploy-error.log"
  tasks:
    - name: 查询最终 Durpina 状态
      uri:
        url: "{{ durpina_admin_url }}/durpina/info?upstream={{ durpina_upstream }}"
        method: GET
        return_content: true
        timeout: 10
      register: final_durpina
      no_log: true

    - name: 检查是否存在非 up 节点
      assert:
        that:
          - >
            (
              final_durpina.json.upstream.peers
              | selectattr('state','ne','up')
              | list
              | length
            ) == 0
        fail_msg: "发现非 up 节点，请检查 Durpina 状态"
        success_msg: "所有节点状态正常"
      register: final_assert
      ignore_errors: true

    - name: 记录非 up 节点
      lineinfile:
        path: "{{ error_log }}"
        line: "{{ lookup('pipe', 'date -u +%Y-%m-%dT%H:%M:%SZ') }} FINAL_CHECK_FAILED run_id={{ deploy_run_id }} non-up peers remain"
        create: yes
        mode: "0644"
      when: final_assert is failed
      ignore_errors: true

    - name: 读取本轮失败记录
      shell: grep -F "run_id={{ deploy_run_id }} FAILED" {{ error_log }} || true
      args:
        executable: /bin/bash
      register: failed_marks
      changed_when: false

    - name: 本轮有失败则非 0 退出
      fail:
        msg: "{{ failed_marks.stdout }}"
      when: "failed_marks.stdout | default('') | length > 0"
```

收尾这条 `grep` 查的是带 `FAILED` 的主机记录。非 `up` 的收尾行写的是 `FINAL_CHECK_FAILED`，不会被这句当成主机失败。两者都留在同一份日志里。

## 添加或移除节点

upstream 里要加机器或删机器，不走上面的 `down` / `up`。顺序是：

1. 改 `nginx.conf`（或 `conf.d`）里这个 `upstream` 的 `server`
2. `openresty -s reload`
3. `./durpina-manager.sh sync`

```bash
# 1. 编辑 nginx.conf，例如在 openapiserver-group 里增加：
#    server 10.0.0.14:8080;

openresty -t && openresty -s reload
./durpina-manager.sh sync
./durpina-manager.sh list
```

`sync` 会先等到 worker 已经加载完磁盘上的新配置，再调 `/durpina/sync`。打印出来的 `added` / `removed` 应当和刚改的 conf 对得上。对不上就停。

新加进来的节点默认是 `up`，会立刻进轮询。如果新机器上的进程还没起来，先不要 reload，或者 sync 之后立刻把它 `down`，等 supervisord 起来再 `up`。

从集群里拿掉一台，也是先改 conf 删掉这行 `server`，reload，再 sync。不要只 `down` 而不改 conf：reload 之后共享内存里的 peer 可能还在，下次 sync 才会按 conf 删掉。

## 几个坑

**先 down，再重启 supervisord。** 顺序反了，Nginx 还会把请求打到这台，客户就会在进程退出的窗口里看到报错或不通。

**加减机器是改 conf → reload → sync。** 滚动重启和滚动发布不 reload Nginx。三套流程不要叠在一次变更里。

**失败补偿会把节点标回 up。** 重启或切链没成功时，剧本仍尝试 `action=up`，避免机器被忘在 `down`。进程没起来的话，请求会打到死端口上。看错误日志，不要只看 playbook 退出码。滚动重启的收尾检查失败也是 0 退出。

**`down` 和 `failing` 不是一回事。** `down` 是人设，balancer 跳过。`failing` 是 `fail_timeout` 窗口里失败次数超了，或 monitor 没过。enable-all 只能把 `down` 改回 `up`。节点马上又变成 `failing`，说明探活或真实请求仍在失败——常见原因是 supervisord 没起来、新代码起不来、或探活 URI 变了。

**共享内存活过 reload。** reload 不会把昨天摘掉的节点自动拉起来，也不会自动删掉 conf 里已经没有的 peer。所以加减机器之后一定要 sync。

**管理口是写接口。** 绑在 80 上、不设 `allow`/`deny`、再被扫描打到 `enable-all`，就是一次全量误操作。白名单、只听内网、独立 access log，这三件要同时有。

**`set` 和 `enable-all` 对返回值的态度不一致。** `set` 要求 `set_state == true`，enable-all 把非 `false` 当成功。以 `info` / `status` 为准，不以 HTTP 状态码为准。

**sync 会删 peer。** conf 里没有的名字会被 `remove_peer`。运行时 `add_peer` 加进去、却没写回 conf 的节点，sync 一次就没了。nginx.conf 是源，Durpina 是投影。

**多 worker 时看同一份 dict。** 若 `info` 在不同请求里看到不一样的 peer 列表，先确认 `Upstream.init` 用的是同一个 `lua_shared_dict`。

## 小结

Durpina 不负责发版，也不负责健康检查。它只让 OpenResty 在不 reload 的前提下，把某几个 peer 从轮询里拿掉或放回去。

滚动重启：

```
openapi-rolling-restart.yml
down → supervisorctl restart → 探活 → up → 下一批
```

滚动发布：

```
Jenkins → synchronize 新目录 → openapi-rolling-deploy.yml
down → 切软链 → supervisorctl restart → 探活 → up → 下一批
```

加减机器：

```
改 nginx.conf → openresty -s reload → durpina-manager.sh sync
```

每次写操作前后都看 `list` 或 `status`。状态以读回来的 `state` 为准。`state` 还不是 `down`，就不要重启那台的 supervisord。
