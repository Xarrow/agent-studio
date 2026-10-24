#!/usr/bin/env python3
"""A2A mini agent —— 一台小机器上的「会自己看一眼再回答」的 agent。

它存在的目的是把 A2A 这件事**跑通并留下证据**：Agent Studio 把一条消息发过来，
这里真的去机器上看一眼（负载/内存/磁盘/进程/时间），把结果按 A2A 的 Task 结构
回过去。不是一个只会回 "pong" 的假端点。

为什么只用标准库
----------------
部署机是裸的阿里云 ECS：有 python3.12，但没有 fastapi/uvicorn，也不该为了
一个小端点去装一套 web 框架。``http.server`` 的线程版足够扛住探活 + 单条调用。

对外三个端点（与 Agent Studio 的 a2a_client.py 完全对齐）
-------------------------------------------------------
  GET  /.well-known/agent-card.json   发现：我叫什么、会干什么
  POST /a2a                           JSON-RPC 2.0：message/send / tasks/get / tasks/cancel
  GET  /health                        探活：只回状态，不产生任务

鉴权：起服务时给 ``A2A_TOKEN`` 就要求 ``Authorization: Bearer <token>``
（卡片地址不鉴权 —— 发现必须能匿名，否则注册时连名字都读不到）。
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# ── 配置（环境变量，systemd 里给） ────────────────────────────────────────
PORT = int(os.environ.get("A2A_PORT", "8900"))
TOKEN = os.environ.get("A2A_TOKEN", "").strip()
PUBLIC_URL = os.environ.get("A2A_PUBLIC_URL", f"http://127.0.0.1:{PORT}").rstrip("/")
AGENT_NAME = os.environ.get("A2A_NAME", "阿里云巡检助手")
AGENT_DESC = os.environ.get(
    "A2A_DESC",
    "一台阿里云 ECS 上的小 agent：查性能指标（CPU/内存/Swap/磁盘占用与读写/网卡收发/"
    "负载/吃内存的进程）和机器巡检（磁盘/内存/负载/进程/出口 IP/运行时长）。只读不写。",
)

STARTED_AT = time.time()

#: 任务表（内存）。重启丢历史可以接受 —— 这是"一次性调用"的场景，
#: 不是持久化工作流；平台的调用记录那一侧已经留了审计。
TASKS: dict[str, dict[str, Any]] = {}
TASKS_LOCK = threading.Lock()


# ── 真活：看一眼这台机器 ────────────────────────────────────────────────
def _read(path: str, default: str = "") -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read().strip()
    except OSError:
        return default


def snapshot() -> str:
    """把机器当前的样子读出来 —— 全部只读，不改任何东西。"""
    lines: list[str] = []

    host = socket.gethostname()
    # /proc/uptime 第一列本身就是「开机到现在的秒数」，别再拿 time.time() 去减它
    try:
        uptime_s = float(_read("/proc/uptime").split()[0])
    except (IndexError, ValueError):
        uptime_s = 0.0
    up_h, up_m = int(uptime_s // 3600), int((uptime_s % 3600) // 60)
    lines.append(f"主机：{host}（{platform.system()} {platform.release()}，{platform.machine()}）")
    lines.append(f"时间：{time.strftime('%Y-%m-%d %H:%M:%S %Z')}　已运行 {up_h} 小时 {up_m} 分")

    # 负载
    load = _read("/proc/loadavg").split()
    if load:
        lines.append(f"负载：1 分钟 {load[0]} · 5 分钟 {load[1]} · 15 分钟 {load[2]}")

    # 内存
    mem = {}
    for line in _read("/proc/meminfo").splitlines():
        k, _, v = line.partition(":")
        mem[k] = int((v.strip().split() or ["0"])[0] or 0)
    total_mb = mem.get("MemTotal", 0) // 1024
    avail_mb = mem.get("MemAvailable", 0) // 1024
    if total_mb:
        used_pct = round((total_mb - avail_mb) / total_mb * 100, 1)
        lines.append(f"内存：{total_mb - avail_mb} / {total_mb} MB（已用 {used_pct}%）")

    # 磁盘（根分区）
    try:
        du = shutil.disk_usage("/")
        lines.append(
            f"磁盘：/ 已用 {du.used // 2**30} GB / 共 {du.total // 2**30} GB"
            f"（{round(du.used / du.total * 100, 1)}%，剩 {du.free // 2**30} GB）"
        )
    except OSError:
        pass

    # 进程数
    try:
        pids = [p for p in os.listdir("/proc") if p.isdigit()]
        lines.append(f"进程：{len(pids)} 个")
    except OSError:
        pass

    # 出口 IP：先问云厂商元数据（阿里云/腾讯云都在内网，毫秒级、不出网），
    # 再退到公网服务。阿里云访问 api.ipify.org 常年超时，先试公网就永远查不到。
    egress = ""
    for url in (
        "http://100.100.100.200/latest/meta-data/eipv4",  # 阿里云 ECS
        "http://169.254.169.254/latest/meta-data/public-ipv4",  # AWS/腾讯云
        "https://api.ipify.org",  # 兜底
    ):
        try:
            import urllib.request

            with urllib.request.urlopen(url, timeout=2) as resp:
                got = resp.read().decode().strip()
            if got and len(got) < 64:
                egress = got
                break
        except Exception:  # noqa: BLE001 —— 环境不支持元数据是常态，换下一个
            continue
    lines.append(f"出口 IP：{egress or '（这次没查到）'}")

    return "\n".join(lines)


# ── 性能指标（比 snapshot 更细，仍然是只读） ──────────────────────────────
#: CPU / 磁盘 / 网络都是「两次采样求差」，间隔太短读数抖动，太长拖慢回答。
_METRICS_SAMPLE_S = 0.35


def _cpu_times() -> list[int]:
    """读 /proc/stat 第一行（cpu 汇总）：user nice system idle iowait irq softirq steal ..."""
    parts = _read("/proc/stat").splitlines()[0].split()
    # parts[0] 是 "cpu"
    out: list[int] = []
    for p in parts[1:9]:
        try:
            out.append(int(p))
        except ValueError:
            out.append(0)
    while len(out) < 8:
        out.append(0)
    return out


def _cpu_pct() -> dict[str, float]:
    """采样两次 /proc/stat，算这段时间里 CPU 各态占比（%）。"""
    a = _cpu_times()
    time.sleep(_METRICS_SAMPLE_S)
    b = _cpu_times()
    d = [max(0, b[i] - a[i]) for i in range(8)]
    total = sum(d) or 1
    idle = d[3] + d[4]  # idle + iowait 都算"没在算"
    return {
        "used": round((total - idle) / total * 100, 1),
        "user": round((d[0] + d[1]) / total * 100, 1),
        "system": round((d[2] + d[5] + d[6]) / total * 100, 1),
        "iowait": round(d[4] / total * 100, 1),
        "steal": round(d[7] / total * 100, 1),
        "idle": round(idle / total * 100, 1),
    }


def _disk_io() -> dict[str, float]:
    """根分区所在整盘的读写速率（KB/s）。/proc/diskstats 的 sectors 是 512B 计数。"""
    def stat_for(dev: str) -> tuple[int, int] | None:
        for line in _read("/proc/diskstats").splitlines():
            f = line.split()
            # 字段：major minor name reads_completed reads_merged sectors_read ...
            if len(f) > 9 and f[2] == dev:
                try:
                    return int(f[5]), int(f[9])  # sectors_read, sectors_written
                except (ValueError, IndexError):
                    return None
        return None

    # 找根分区的物理盘名（/dev/vda1 → vda；/dev/nvme0n1p1 → nvme0n1）
    root_src = ""
    for line in _read("/proc/mounts").splitlines():
        f = line.split()
        if len(f) >= 2 and f[1] == "/":
            root_src = f[0]
            break
    dev = root_src.rsplit("/", 1)[-1]
    while dev and dev[-1].isdigit():
        dev = dev[:-1]
    dev = dev.rstrip("p") if dev.startswith("nvme") and dev.endswith("p") else dev
    if not dev:
        return {}
    a = stat_for(dev)
    if a is None:
        return {}
    time.sleep(_METRICS_SAMPLE_S)
    b = stat_for(dev)
    if b is None:
        return {}
    dt = _METRICS_SAMPLE_S
    return {
        "read_kbs": round((b[0] - a[0]) * 512 / 1024 / dt, 1),
        "write_kbs": round((b[1] - a[1]) * 512 / 1024 / dt, 1),
        "dev": dev,
    }


def _net_io() -> list[dict[str, Any]]:
    """各网卡收发速率（KB/s），跳过 lo。"""
    def read() -> dict[str, tuple[int, int]]:
        out: dict[str, tuple[int, int]] = {}
        for line in _read("/proc/net/dev").splitlines()[2:]:
            name, _, rest = line.partition(":")
            f = rest.split()
            if len(f) >= 9 and name.strip() != "lo":
                try:
                    out[name.strip()] = (int(f[0]), int(f[8]))  # rx_bytes, tx_bytes
                except ValueError:
                    continue
        return out

    a = read()
    time.sleep(_METRICS_SAMPLE_S)
    b = read()
    res: list[dict[str, Any]] = []
    for name, (rx, tx) in b.items():
        if name not in a:
            continue
        res.append({
            "iface": name,
            "rx_kbs": round((rx - a[name][0]) / 1024 / _METRICS_SAMPLE_S, 1),
            "tx_kbs": round((tx - a[name][1]) / 1024 / _METRICS_SAMPLE_S, 1),
            "rx_total_mb": round(rx / 2**20, 1),
            "tx_total_mb": round(tx / 2**20, 1),
        })
    return res


def _top_procs(n: int = 5) -> list[dict[str, Any]]:
    """按常驻内存排序取前 n 个进程（不读 /proc/*/stat 的 CPU 累计，跨核归一化容易算错）。"""
    hz = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
    page = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096
    rows: list[dict[str, Any]] = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/statm", encoding="utf-8") as fh:
                rss_pages = int(fh.read().split()[1])
            with open(f"/proc/{pid}/stat", encoding="utf-8") as fh:
                stat = fh.read()
            # comm 里可能有空格和括号，取最后一个 ')' 之后的部分
            tail = stat[stat.rfind(")") + 2:].split()
            utime, stime = int(tail[11]), int(tail[12])
            with open(f"/proc/{pid}/comm", encoding="utf-8") as fh:
                comm = fh.read().strip()
        except (OSError, ValueError, IndexError):
            continue
        rows.append({
            "pid": int(pid),
            "name": comm[:24],
            "rss_mb": round(rss_pages * page / 2**20, 1),
            "cpu_s": round((utime + stime) / hz, 1),
        })
    rows.sort(key=lambda r: r["rss_mb"], reverse=True)
    return rows[:n]


def _disks() -> list[dict[str, Any]]:
    """每个真实挂载点的占用（跳过 tmpfs / overlay / proc 这些）。"""
    skip_fs = {"tmpfs", "devtmpfs", "overlay", "proc", "sysfs", "cgroup", "cgroup2",
               "squashfs", "nsfs", "ramfs", "debugfs", "tracefs", "securityfs", "pstore",
               "fusectl", "fuse.lxcfs", "devpts", "mqueue", "hugetlbfs", "binfmt_misc",
               "autofs", "configfs", "rpc_pipefs", "efivarfs"}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for line in _read("/proc/mounts").splitlines():
        f = line.split()
        if len(f) < 3:
            continue
        src, mnt, fstype = f[0], f[1], f[2]
        if fstype in skip_fs or mnt in seen:
            continue
        try:
            du = shutil.disk_usage(mnt)
        except OSError:
            continue
        if du.total < 2**28:      # < 256MB 的多是内核伪文件系统，列出来只是噪声
            continue
        seen.add(mnt)
        gb = 2**30
        out.append({
            "mount": mnt,
            "fstype": fstype,
            "used_gb": round(du.used / gb, 2),
            "total_gb": round(du.total / gb, 2),
            "used_pct": round(du.used / du.total * 100, 1) if du.total else 0.0,
        })
    return out


def metrics() -> str:
    """这台机器的性能指标：CPU / 内存 / swap / 磁盘占用与 IO / 网络 / 负载 / 吃内存的进程。"""
    cpu = _cpu_pct()
    cores = os.cpu_count() or 0
    model = ""
    for line in _read("/proc/cpuinfo").splitlines():
        if line.lower().startswith("model name"):
            model = line.split(":", 1)[1].strip()
            break

    mem: dict[str, int] = {}
    for line in _read("/proc/meminfo").splitlines():
        k, _, v = line.partition(":")
        try:
            mem[k] = int((v.strip().split() or ["0"])[0])
        except ValueError:
            mem[k] = 0
    mb = 1024
    total = mem.get("MemTotal", 0) // mb
    avail = mem.get("MemAvailable", 0) // mb
    swap_total = mem.get("SwapTotal", 0) // mb
    swap_free = mem.get("SwapFree", 0) // mb

    load = _read("/proc/loadavg").split()
    io = _disk_io()
    nets = _net_io()
    tops = _top_procs(5)
    disks = _disks()

    lines: list[str] = []
    lines.append(f"主机：{socket.gethostname()}（{platform.machine()}，{cores} 核）")
    if model:
        lines.append(f"CPU：{model}")
    lines.append(
        f"CPU 使用率：{cpu['used']}%（user {cpu['user']}% / system {cpu['system']}%"
        f" / iowait {cpu['iowait']}% / steal {cpu['steal']}% / idle {cpu['idle']}%）"
    )
    if load:
        per = round(float(load[0]) / cores, 2) if cores else 0
        lines.append(
            f"负载：1 分 {load[0]} · 5 分 {load[1]} · 15 分 {load[2]}"
            f"（每核 {per}）　任务 {load[3] if len(load) > 3 else '—'}"
        )
    if total:
        lines.append(
            f"内存：已用 {total - avail} / {total} MB（{round((total - avail) / total * 100, 1)}%）"
            f"　可用 {avail} MB　缓存 {mem.get('Cached', 0) // mb} MB"
            f"　Buffers {mem.get('Buffers', 0) // mb} MB"
        )
    if swap_total:
        lines.append(f"Swap：已用 {swap_total - swap_free} / {swap_total} MB")
    else:
        lines.append("Swap：未启用")

    if disks:
        lines.append("磁盘：")
        for d in disks:
            lines.append(
                f"  - {d['mount']}（{d['fstype']}）{d['used_gb']} / {d['total_gb']} GB"
                f"　已用 {d['used_pct']}%"
            )
    if io:
        lines.append(
            f"磁盘 IO（{io['dev']}）：读 {io['read_kbs']} KB/s　写 {io['write_kbs']} KB/s"
        )
    for n in nets:
        lines.append(
            f"网络 {n['iface']}：收 {n['rx_kbs']} KB/s（累计 {n['rx_total_mb']} MB）"
            f"　发 {n['tx_kbs']} KB/s（累计 {n['tx_total_mb']} MB）"
        )
    if tops:
        lines.append("吃内存最多的进程：")
        for p in tops:
            lines.append(f"  - {p['name']}（PID {p['pid']}）RSS {p['rss_mb']} MB　CPU 时间 {p['cpu_s']}s")

    try:
        up = float(_read("/proc/uptime").split()[0])
        lines.append(f"已运行：{int(up // 86400)} 天 {int(up % 86400 // 3600)} 小时")
    except (IndexError, ValueError):
        pass
    lines.append(f"采样时间：{time.strftime('%Y-%m-%d %H:%M:%S %Z')}（CPU/IO/网络为 {int(_METRICS_SAMPLE_S * 1000)}ms 采样）")
    return "\n".join(lines)


def echo(text: str) -> str:
    return f"收到：{text}\n（我是 {AGENT_NAME}，运行在 {socket.gethostname()}，A2A 链路正常）"


#: 技能 → 处理函数（关键词命中哪个就走哪个；都不命中就走巡检）
def handle_text(text: str) -> tuple[str, str]:
    t = (text or "").strip()
    low = t.lower()
    if not t:
        return "system-status", snapshot()
    if any(k in low for k in ("ping", "echo", "回显", "在吗", "test")) and len(t) < 40:
        return "echo", echo(t)
    # 性能指标：问到 CPU / 内存 / 磁盘 / 网络 / 负载 / 监控 就走细版
    if any(k in low for k in ("性能", "指标", "cpu", "内存", "磁盘", "网络", "负载",
                              "load", "metric", "监控", "io", "swap", "进程")):
        return "metrics", metrics()
    return "system-status", snapshot()


# ── A2A 数据结构 ────────────────────────────────────────────────────────
def card() -> dict[str, Any]:
    return {
        "protocolVersion": "0.3.0",
        "name": AGENT_NAME,
        "description": AGENT_DESC,
        "url": f"{PUBLIC_URL}/a2a",
        "preferredTransport": "JSONRPC",
        "additionalInterfaces": [{"url": f"{PUBLIC_URL}/a2a", "transport": "JSONRPC"}],
        "version": "1",
        "provider": {"organization": "self-hosted", "url": PUBLIC_URL},
        "capabilities": {"streaming": False, "pushNotifications": False, "stateTransitionHistory": False},
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": [
            {
                "id": "system-status",
                "name": "机器巡检",
                "description": "读这台 ECS 的负载、内存、磁盘、进程数、出口 IP 与时间。只读。",
                "tags": ["ops", "readonly", "ecs"],
                "examples": ["看看这台机器现在怎么样", "磁盘还剩多少"],
            },
            {
                "id": "metrics",
                "name": "性能指标",
                "description": "采样 CPU 使用率（user/system/iowait/steal）、内存与 swap、各挂载点占用、"
                               "磁盘读写速率、网卡收发速率、负载与吃内存最多的进程。只读。",
                "tags": ["ops", "readonly", "metrics", "ecs"],
                "examples": ["看看服务器性能指标", "CPU 和内存现在多少", "磁盘 IO 和网络速率"],
            },
            {
                "id": "echo",
                "name": "连通性回显",
                "description": "原样回一句，用于验证 A2A 链路是否通。",
                "tags": ["debug"],
                "examples": ["ping"],
            },
        ],
    }


def _text_of(message: dict[str, Any]) -> str:
    for part in message.get("parts") or []:
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            return part["text"]
    return ""


def new_task(text: str) -> dict[str, Any]:
    """收一条消息 → 跑掉 → 返回终态 Task（这里活都很快，不搞异步轮询）。"""
    skill, answer = handle_text(text)
    tid = f"task-{uuid.uuid4().hex[:12]}"
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    task = {
        "id": tid,
        "contextId": f"ctx-{uuid.uuid4().hex[:8]}",
        "status": {
            "state": "completed",
            "timestamp": now,
            "message": {
                "role": "agent",
                "parts": [{"kind": "text", "text": answer}],
            },
        },
        "artifacts": [
            {
                "artifactId": f"art-{uuid.uuid4().hex[:8]}",
                "name": skill,
                "parts": [{"kind": "text", "text": answer}],
            }
        ],
        "metadata": {"skill": skill},
    }
    with TASKS_LOCK:
        TASKS[tid] = task
        # 只留最近 200 条，别让一个探活机器人把内存吃满
        if len(TASKS) > 200:
            for old in sorted(TASKS, key=lambda k: TASKS[k]["status"]["timestamp"])[: len(TASKS) - 200]:
                TASKS.pop(old, None)
    return task


# ── HTTP ────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version = "a2a-mini/1"
    protocol_version = "HTTP/1.1"

    # 少一点日志噪音：探活每分钟一次，别刷满 journal
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        if "/health" in (self.path or ""):
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: dict[str, Any] | list[Any]) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def _read_body(self) -> bytes:
        """读请求体 —— **必须把 body 读完**，否则残留字节会被当成下一个请求行。

        踩过的坑：Cloudflare 转发到源站时可能用 ``Transfer-Encoding: chunked``
        （不带 Content-Length）。只按 Content-Length 读 ≠ 0 → 读到 0 字节 →
        body 留在缓冲里 → 下一条请求变成 ``Unsupported method ('{...}POST')``，
        日志里 401 和 501 交替出现，看起来像鉴权坏了，其实是连接复用错位。
        """
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in te:
            out: list[bytes] = []
            while True:
                line = self.rfile.readline(65536).strip()
                if not line:
                    break
                try:
                    size = int(line.split(b";")[0], 16)
                except ValueError:
                    break
                if size == 0:
                    self.rfile.readline(65536)  # 末尾的空行
                    break
                out.append(self.rfile.read(size))
                self.rfile.readline(65536)  # 每个 chunk 后面的 CRLF
            return b"".join(out)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        return self.rfile.read(length) if length > 0 else b""

    def _authed(self) -> bool:
        if not TOKEN:
            return True
        got = self.headers.get("Authorization", "")
        expect = f"Bearer {TOKEN}"
        if got != expect:
            # 401 一定要能自证：不打 token 本体，只打长度与前缀是否对得上
            import hashlib

            sys.stderr.write(
                f"[auth-fail] got_len={len(got)} exp_len={len(expect)} "
                f"got_prefix={got[:7]!r} got_sha={hashlib.sha256(got.encode()).hexdigest()[:8]} "
                f"exp_sha={hashlib.sha256(expect.encode()).hexdigest()[:8]} "
                f"all_headers={dict(self.headers)!r}\n"
            )
            return False
        return True

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = (self.path or "/").split("?")[0].rstrip("/") or "/"
        if path in ("/.well-known/agent-card.json", "/agent-card.json"):
            return self._send(200, card())
        if path == "/health":
            return self._send(
                200,
                {"status": "ok", "agent": AGENT_NAME, "uptime_s": round(time.time() - STARTED_AT), "tasks": len(TASKS)},
            )
        if path in ("/", ""):
            return self._send(200, {"agent": AGENT_NAME, "card": "/.well-known/agent-card.json", "rpc": "/a2a"})
        return self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = (self.path or "/").split("?")[0].rstrip("/") or "/"
        if path not in ("/a2a", "/"):
            return self._send(404, {"error": "not found"})
        # 先把 body 读完再判断鉴权：401 也不能把 body 留在连接里
        raw = self._read_body()
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})

        try:
            req = json.loads(raw or b"{}")
        except (ValueError, OSError):
            return self._send(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "解析失败"}})

        rid = req.get("id")
        method = str(req.get("method") or "")
        params = req.get("params") or {}

        def ok(result: Any) -> None:
            self._send(200, {"jsonrpc": "2.0", "id": rid, "result": result})

        def err(code: int, msg: str) -> None:
            self._send(200, {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}})

        if method == "message/send":
            msg = params.get("message") or {}
            text = _text_of(msg) if isinstance(msg, dict) else ""
            return ok(new_task(text))

        if method == "tasks/get":
            tid = str(params.get("id") or "")
            with TASKS_LOCK:
                task = TASKS.get(tid)
            return ok(task) if task else err(-32001, f"没有这个任务：{tid}")

        if method == "tasks/cancel":
            tid = str(params.get("id") or "")
            with TASKS_LOCK:
                task = TASKS.get(tid)
                if task:
                    task["status"]["state"] = "canceled"
            return ok(task) if task else err(-32001, f"没有这个任务：{tid}")

        if method in ("message/stream", "tasks/resubscribe"):
            return err(-32601, "这个 agent 不支持流式（capabilities.streaming=false）")

        return err(-32601, f"不认识的方法：{method}")


def main() -> None:
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"a2a-mini 已启动：{PUBLIC_URL}/a2a（card 在 /.well-known/agent-card.json，鉴权 {'开' if TOKEN else '关'}）", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
