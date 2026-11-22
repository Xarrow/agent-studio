#!/usr/bin/env bash
# ============================================================================
#  自建 TURN（coturn）—— 只给 WebRTC 视频用
#
#  为什么需要它：东京这台 VPS 的公网入口只放通了 TCP，UDP 入站被服务商挡掉
#  （实测从上海/NYC 打任意 UDP 端口都超时）。浏览器与服务端直连（host/srflx）
#  因此必然失败，媒体只能经 TURN 走 TCP 中转 —— coturn 与 API 同机，
#  视频包在本机回环转发，不额外花钱，也不出机房。
#
#  设计要点（别改成公网 relay-ip）：
#   · listening-ip / relay-ip = 内网地址（10.x）。浏览器连的是公网 TCP 3478，
#     NAT 转进来；它拿到自己的 relay 地址（内网）只写进 SDP 交给对端（媒流体
#     服务器在同一台机器上，能直达这个内网地址）。
#   · 不设 external-ip：设了就会把 relay 地址改成公网 IP，而同机回打公网 IP
#     常常没有 hairpin NAT —— 媒体反而断。
#   · 用静态密钥 + 临时凭据（TURN REST API），浏览器每次拿一小时有效的账号，
#     密钥不落前端。
#
#  用法（在目标机上）：
#    STUDIO_TURN_SECRET=<32字节hex> sudo -E bash scripts/setup-turn.sh
# ============================================================================
set -euo pipefail

SECRET="${STUDIO_TURN_SECRET:-}"
PRIVATE_IP="${STUDIO_TURN_PRIVATE_IP:-10.7.0.2}"
PUBLIC_IP="${STUDIO_TURN_HOST:-}"
PUBLIC_PORT="${STUDIO_TURN_PORT:-3478}"
if [ -z "$SECRET" ]; then
  echo "[!] 缺 STUDIO_TURN_SECRET" >&2
  exit 2
fi

if ! command -v turnserver >/dev/null 2>&1; then
  echo "[1/4] 安装 coturn"
  apt-get -qq update
  DEBIAN_FRONTEND=noninteractive apt-get -y -qq install coturn
fi

echo "[2/4] 写 /etc/turnserver.conf（listening/relay = $PRIVATE_IP）"
python3 - "$SECRET" "$PRIVATE_IP" "$PUBLIC_PORT" <<'PY'
import os
import stat
import sys

secret, private_ip, port = sys.argv[1], sys.argv[2], sys.argv[3]
conf = f"""# Agent Studio · WebRTC TURN（由 scripts/setup-turn.sh 生成，改这里没用）
listening-port={port}
listening-ip={private_ip}
relay-ip={private_ip}
realm=agent-studio
fingerprint
use-auth-secret
static-auth-secret={secret}
no-multicast-peers
no-cli
stale-nonce=600
user-quota=8
total-quota=64
min-port=49200
max-port=49300
log-file=/var/log/turnserver.log
simple-log
"""
path = "/etc/turnserver.conf"
with open(path, "w", encoding="utf-8") as fh:
    fh.write(conf)
os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
PY

echo "[3/4] 打开 coturn 服务开关"
sed -i 's/^#TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

echo "[4/5] 启动并自检"
systemctl enable coturn
systemctl start coturn
sleep 1
systemctl is-active coturn
ss -ltn | grep -q ":${PUBLIC_PORT}" && echo "TCP ${PUBLIC_PORT} listening"

# API 需要知道 TURN 地址和密钥（临时凭据由它签）。只写 TCP —— 这台机器的
# UDP 入站被服务商挡掉，给浏览器 UDP 候选只会浪费时间。
if [ -n "$PUBLIC_IP" ] && [ -f /etc/agent-studio/env ]; then
  echo "[5/5] 把 TURN 配置写进 /etc/agent-studio/env"
  python3 - "$SECRET" "$PUBLIC_IP" "$PUBLIC_PORT" <<'PY'
import sys

secret, host, port = sys.argv[1], sys.argv[2], sys.argv[3]
path = "/etc/agent-studio/env"
with open(path, encoding="utf-8") as fh:
    lines = [ln for ln in fh if not ln.startswith(("STUDIO_TURN_SECRET=", "STUDIO_TURN_URLS="))]
lines.append(f"STUDIO_TURN_SECRET={secret}\n")
lines.append(f"STUDIO_TURN_URLS=turn:{host}:{port}?transport=tcp\n")
with open(path, "w", encoding="utf-8") as fh:
    fh.writelines(lines)
PY
  chmod 600 /etc/agent-studio/env
else
  echo "[5/5] 没给 STUDIO_TURN_HOST 或没有 /etc/agent-studio/env —— 跳过 API 配置"
fi

echo "完成：turn:${PUBLIC_IP:-<公网IP>}:${PUBLIC_PORT}?transport=tcp"
