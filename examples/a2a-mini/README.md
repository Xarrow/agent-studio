# a2a-mini —— 一台机器上的最小 A2A agent

给「跨机器的 agent 互通」一个能跑通的对照物：Agent Studio 把消息发过来，
这里真的去机器上看一眼（负载 / 内存 / 磁盘 / 进程 / 出口 IP），按 A2A 的
Task 结构把结果回去。不是一个只会回 "pong" 的假端点。

## 它对外是什么

| 端点 | 作用 |
|---|---|
| `GET /.well-known/agent-card.json` | 发现：叫什么、会干什么（匿名可读） |
| `POST /a2a` | JSON-RPC 2.0：`message/send` / `tasks/get` / `tasks/cancel` |
| `GET /health` | 探活：只回状态，不产生任务 |

协议版本 A2A 0.3.0，传输 JSONRPC（不实现流式 —— `capabilities.streaming=false`，
调用方会退回轮询）。

## 为什么只用标准库

部署机是裸的 ECS：有 python3，没有 fastapi/uvicorn，也不该为了一个小端点
装一套 web 框架。`http.server` 的线程版足够扛探活 + 单条调用，拷一个文件就能跑。

## 跑起来

```bash
A2A_PORT=8900 \
A2A_TOKEN=<自己定一个> \
A2A_PUBLIC_URL=https://a2a.example.com \
A2A_NAME=阿里云巡检助手 \
python3 a2a_mini.py
```

systemd 单元（`EnvironmentFile=/etc/a2a-mini.env` 放上面那些变量）：

```ini
[Unit]
Description=A2A mini agent
After=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/a2a-mini.env
ExecStart=/usr/bin/python3 /opt/a2a-mini/a2a_mini.py
Restart=always

[Install]
WantedBy=multi-user.target
```

## 接到 Agent Studio 上

两条路，方向相反：

**平台 → 远端（拉）**：在「远程 Agent 管理」点「＋ 注册」，填它的地址
（`https://a2a.example.com`）和 `A2A_TOKEN`。平台会拉卡片、解析技能、
自动建一个可挂载的工具。

**远端 → 平台（推）**：在平台那一页的「远端自注册」里拿注册地址和口令，
在远端跑：

```bash
REG_TOKEN=<平台给的注册口令> \
PUBLIC_URL=https://a2a.example.com \
python3 self_register.py
```

同一地址重推 = 更新卡片（远端加了技能，重推一次即可）。

## 自己验一遍

```bash
# 卡片
curl https://a2a.example.com/.well-known/agent-card.json | head -c 300

# 真的调一次
curl -s -X POST https://a2a.example.com/a2a \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <A2A_TOKEN>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"看看这台机器"}]}}}'
```

## 两个真踩过的坑

1. **必须读完 body，否则连接会串**。Cloudflare 转发到源站可能用
   `Transfer-Encoding: chunked`（没有 Content-Length）。只按 Content-Length
   读 → 读到 0 字节 → body 留在缓冲里 → 下一条请求变成
   `Unsupported method ('{...}POST')`，日志里 401 和 501 交替。
   `_read_body()` 两种编码都处理，并且**先读完再判断鉴权**。
2. **UA 会被 WAF 拦**。Cloudflare 的浏览器完整性检查对默认的
   `python-urllib/x` / 未知 UA 直接 403（error 1010）。调用方要带一个像样的
   User-Agent —— 平台的 `a2a_client.py` 和本目录的 `self_register.py` 都带了。

## 一个取舍

`tasks/get` 只能查内存里最近 200 条。这个 agent 的活都是秒级完成的，
不是长任务队列 —— 要持久化任务历史，那是调用方（平台）该留的审计。
