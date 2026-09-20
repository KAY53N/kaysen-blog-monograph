---
title: "OpenResty 用 Durpina 做滚动发布"
excerpt: "滚动发版先把 upstream 节点 down 掉，再换代码、重启 supervisord。加减机器则改 nginx.conf，reload 之后跑管理脚本 sync。客户请求不会打到正在重启的那台。"
category: "Reliability"
date: 2026-09-20
author:
  name: "Kaysen"
  role: "安全与可靠性"
cover:
  src: "./cover.jpg"
  alt: "机柜里一束网线从主干分到多条链路"
---

滚动发布要重启的是后端进程，不是 Nginx。一台机器换新代码、`supervisord` 拉起新进程的那几秒里，端口会断、旧连接会掉。如果 Nginx 这时还把请求打过去，客户看到的就是 502、连接拒绝、偶发超时。

两件事不要混：

- **滚动发版**：先把这台从 upstream 里 `down` 掉，再换代码、重启 `supervisord`，探活通过后再 `up`。这一步不 reload Nginx。
- **加减机器**：先改 `nginx.conf` 里的 `server`，再 `nginx -s reload`，再跑管理脚本的 `sync`，让 Durpina 的 peer 列表跟当前 conf 对齐。

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

`nginx.conf` 里只加两行 http 级 include，每个要交给 Durpina 调度的 `upstream` 再加一行 balancer include。不要把 Lua 块直接写进主配置。

```nginx
http {
    include /usr/local/openresty/nginx/conf/durpina/durpina-http.conf;
    include /usr/local/openresty/nginx/conf/durpina/durpina-admin.conf;

    upstream openapiserver-group {
        server 10.0.0.11:8080;
        server 10.0.0.12:8080;
        server 10.0.0.13:8080;
        # ...
        include /usr/local/openresty/nginx/conf/durpina/durpina-balancer.conf;
    }

    server {
        listen 80;
        location / {
            proxy_pass http://openapiserver-group;
        }
    }
}
```

三份片段各管一件事。

### http：共享内存和初始化

Durpina **必须**在 `init_worker_by_lua` 里调用 `Upstream.init`。共享内存名字要和这里一致。1m 对小集群够用，节点多、还要存监控信息时可以开到 10m。

```nginx
lua_shared_dict upstream 10m;
lua_socket_log_errors off;

init_worker_by_lua_block {
    local Upstream = require "durpina.upstream"
    Upstream.init("upstream", {
        resolver = "8.8.8.8"
    })
}
```

全是 IPv4 直连、不靠 hostname 解析的话，`resolver` 可以不写。`lua_socket_log_errors off` 是 Durpina 文档里的建议：peer 探活失败时不要把 error log 刷满。

### upstream：把选路交给 Lua

```nginx
balancer_by_lua_block {
    require("durpina.balancer")("round-robin")
}
```

`round-robin` 是加权轮询。库还提供 `unweighted-round-robin`、`ip-hash`、`consistent-hash`。滚动时池子里还 `up` 的节点继续轮询，正在重启的那台不在里面。`server 0.0.0.0` 在 Durpina 里当占位符，会被忽略。

业务 `location` 仍然 `proxy_pass http://openapiserver-group;`，应用层无感知。

### admin：只绑内网

管理口单独一个 `server`，不要和对外 80/443 共用。监听回环和内网地址，白名单放本机和运维跳板，其余一律 `deny`。

```nginx
server {
    listen 127.0.0.1:18081;
    listen 10.0.0.10:18081;
    server_name localhost 127.0.0.1;

    allow 127.0.0.1;
    allow 10.0.0.20;
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

返回里都带 `worker_id`、`worker_pid`。Durpina 的 `set_state` 走共享内存，打到任意 worker 都应该生效；worker 字段是为了对照 error log，不是「只改了这一个进程」。

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

加减机器的顺序是：改 `nginx.conf` → `nginx -s reload` → `durpina-manager.sh sync`。滚动发版不走 sync，也不 reload Nginx。

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

对 `upstream` 里的每一台，顺序固定。先 `down`，确认 balancer 不再选它，再换代码、重启 `supervisord`。

```
down → 换代码 → supervisorctl restart → 探活 → up → 下一台
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

开始前用 `list` 看剩下的 `up` 能不能扛住少一台之后的流量。扛不住就先扩容，不要硬滚。一台异常就停。

整机多个端口时，把该 IP 下每个 `name` 都 `down` 一遍，再动 supervisord。只摘一个端口、同机另一个端口还在 `up`，重启时仍可能伤到那条端口上的请求。

已建立的 keepalive 不会在 `down` 的瞬间消失。`down` 之后按 `keepalive_timeout` 等一轮，再重启。

滚到一半要停：已经重启完并且探活通过的节点保持 `up`；正在重启的保持 `down`。整池不稳再用 `enable-all`，但不要把还没起来的节点一起标成 `up`。

```bash
./durpina-manager.sh enable-all
```

`enable-all` 是「把人设的 down 清掉」，不是「把坏掉的机器救活」。

## 添加或移除节点

upstream 里要加机器或删机器，不走上面的 `down` / `up`。顺序是：

1. 改 `nginx.conf`（或 `conf.d`）里这个 `upstream` 的 `server`
2. `nginx -s reload`
3. `./durpina-manager.sh sync`

```bash
# 1. 编辑 nginx.conf，例如在 openapiserver-group 里增加：
#    server 10.0.0.14:8080;

nginx -t && nginx -s reload
./durpina-manager.sh sync
./durpina-manager.sh list
```

`sync` 会先等到 worker 已经加载完磁盘上的新配置，再调 `/durpina/sync`。打印出来的 `added` / `removed` 应当和刚改的 conf 对得上。对不上就停。

新加进来的节点默认是 `up`，会立刻进轮询。如果新机器上的进程还没起来，先不要 reload，或者 sync 之后立刻把它 `down`，等 supervisord 起来再 `up`。

从集群里拿掉一台，也是先改 conf 删掉这行 `server`，reload，再 sync。不要只 `down` 而不改 conf：reload 之后共享内存里的 peer 可能还在，下次 sync 才会按 conf 删掉。

## 几个坑

**先 down，再重启 supervisord。** 顺序反了，Nginx 还会把请求打到这台，客户就会在进程退出的窗口里看到报错或不通。

**加减机器是改 conf → reload → sync，不是 down/up。** 滚动发版不 reload Nginx。两套流程不要叠在一次变更里。

**`down` 和 `failing` 不是一回事。** `down` 是人设，balancer 跳过。`failing` 是 `fail_timeout` 窗口里失败次数超了，或 monitor 没过。enable-all 只能把 `down` 改回 `up`。节点马上又变成 `failing`，说明探活或真实请求仍在失败——常见原因是 supervisord 没起来、新代码起不来、或探活 URI 变了。

**共享内存活过 reload。** reload 不会把昨天摘掉的节点自动拉起来，也不会自动删掉 conf 里已经没有的 peer。所以加减机器之后一定要 sync。

**管理口是写接口。** 绑在 80 上、不设 `allow`/`deny`、再被扫描打到 `enable-all`，就是一次全量误操作。白名单、只听内网、独立 access log，这三件要同时有。

**`set` 和 `enable-all` 对返回值的态度不一致。** `set` 要求 `set_state == true`，enable-all 把非 `false` 当成功。以 `info` / `status` 为准，不以 HTTP 状态码为准。

**sync 会删 peer。** conf 里没有的名字会被 `remove_peer`。运行时 `add_peer` 加进去、却没写回 conf 的节点，sync 一次就没了。nginx.conf 是源，Durpina 是投影。

**多 worker 时看同一份 dict。** 若 `info` 在不同请求里看到不一样的 peer 列表，先确认 `Upstream.init` 用的是同一个 `lua_shared_dict`。

## 小结

Durpina 不负责发版，也不负责健康检查。它只让 OpenResty 在不 reload 的前提下，把某几个 peer 从轮询里拿掉或放回去。

滚动发版：

```
down → 换代码 → supervisorctl restart → 探活 → up → 下一台
```

加减机器：

```
改 nginx.conf → nginx -s reload → durpina-manager.sh sync
```

每次写操作前后都看 `list` 或 `status`。状态以读回来的 `state` 为准。`state` 还不是 `down`，就不要重启那台的 supervisord。
