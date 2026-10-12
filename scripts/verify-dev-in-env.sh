#!/usr/bin/env bash
# ============================================================================
#  开发包环境验证脚本（CI 用）
#
#  做四件事：全新目录解包 → 跑包自带的一键启动脚本 → 轮询后端健康检查 → 前端可访问
#  用途：bash scripts/verify-dev-in-env.sh <开发包 tar.gz> [后端端口] [前端端口]
#  要求：环境里有 uv 与 Node ≥20（CI 里用 setup-uv + setup-node 准备）
# ============================================================================
set -uo pipefail

TAR="${1:?用法: verify-dev-in-env.sh <tar.gz> [api端口] [web端口]}"
API_PORT="${2:-8861}"
WEB_PORT="${3:-3100}"
WORK="$(mktemp -d /tmp/asd-verify-XXXXXX)"
FAIL=0
ok()  { printf '  [OK]   %s\n' "$1"; }
bad() { printf '  [FAIL] %s\n' "$1"; FAIL=1; }

echo "=== 环境信息 ==="
echo "  系统   : $(uname -srm)"
echo "  发行版 : $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
echo "  Node   : $(command -v node >/dev/null && node -v || echo '未安装')"
echo "  uv     : $(command -v uv >/dev/null && uv --version || echo '未安装')"
echo "  包     : $TAR ($(du -h "$TAR" | cut -f1))"

command -v uv   >/dev/null || { bad "缺少 uv"; exit 1; }
command -v node >/dev/null || { bad "缺少 Node"; exit 1; }

# 端口占用前置检查：若被占用，验证会取到"别人的服务"而假通过
port_pid() { ss -ltnpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1; }
for P in "$API_PORT" "$WEB_PORT"; do
  OP="$(port_pid "$P")"
  if [ -n "$OP" ]; then
    bad "端口 $P 已被占用（pid $OP）——拒绝在复用端口上验证，否则会假通过"
    exit 1
  fi
done
echo "  端口 $API_PORT/$WEB_PORT 均为空闲 ✓"

echo "=== 1) 解包 ==="
tar xzf "$TAR" -C "$WORK" || { bad "解包失败"; exit 1; }
PKG="$WORK/agent-studio"
[ -x "$PKG/start.sh" ] && ok "start.sh 可执行" || bad "start.sh 缺失或不可执行"
[ -f "$PKG/pyproject.toml" ] && ok "后端源码在" || bad "缺 pyproject.toml"
[ -f "$PKG/web/package.json" ] && ok "前端源码在" || bad "缺 web/package.json"
if tar tzf "$TAR" | grep -qE "node_modules|\.next/|\.venv/|/data/|\.git/"; then
  bad "包里夹带了依赖/产物/数据库/git"
else
  ok "无依赖/产物/数据库/git 夹带"
fi

echo "=== 2) 一键启动 ==="
cd "$PKG"
STUDIO_PORT="$API_PORT" WEB_PORT="$WEB_PORT" bash start.sh > "$WORK/start.log" 2>&1 &
SPID=$!
for i in $(seq 1 90); do
  code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$API_PORT/api/health" || true)
  [ "$code" = "200" ] && break
  kill -0 "$SPID" 2>/dev/null || { bad "启动脚本提前退出"; tail -30 "$WORK/start.log"; break; }
  sleep 2
done
[ "$code" = "200" ] && ok "后端 /api/health → 200" || { bad "后端未就绪（最后 HTTP=$code）"; tail -30 "$WORK/start.log"; }

echo "=== 3) 接口与前端 ==="
h=$(curl -s -m 10 "http://127.0.0.1:$API_PORT/api/health")
echo "  health: $(printf '%s' "$h" | head -c 120)"
c=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$API_PORT/api/credentials")
[ "$c" = "200" ] && ok "凭据接口 → 200（空库应为 []）" || bad "凭据接口 → $c"
d=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$API_PORT/docs")
[ "$d" = "200" ] && ok "API 文档 /docs → 200" || bad "/docs → $d"
w=$(curl -s -o /dev/null -L -m 25 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/")
# next dev 冷启动比后端慢，单独轮询等待（首编译要几十秒）
for i in $(seq 1 45); do
  case "$w" in 200|307|308) break;; esac
  sleep 4
  w=$(curl -s -o /dev/null -L -m 25 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/" || true)
done
case "$w" in
  200) ok "前端 dev server → 200";;
  307|308) ok "前端 dev server → $w（重定向到具体页面，属正常）";;
  *) bad "前端 → $w";;
esac
echo "=== start.sh 日志尾部 ==="
tail -12 "$WORK/start.log"

kill "$SPID" 2>/dev/null || true
# 按端口精确清理（不用 pkill -f next，否则会误杀用户 :3000 上的开发服务器）
for P in "$API_PORT" "$WEB_PORT"; do
  for _ in 1 2 3 4 5; do
    PID="$(port_pid "$P")"
    [ -n "$PID" ] || break
    kill "$PID" 2>/dev/null || true
    sleep 1
  done
done
echo "=== 结论 ==="
[ "$FAIL" = "0" ] && echo "  全部通过" || echo "  存在失败项"
exit "$FAIL"
