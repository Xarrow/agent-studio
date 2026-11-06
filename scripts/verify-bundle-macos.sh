#!/usr/bin/env bash
# ============================================================================
#  Agent Studio · macOS（Apple Silicon）一体包验证
#
#  用法：bash scripts/verify-bundle-macos.sh <包文件.tar.gz> [端口]
#
#  验什么（每条都真跑，不看"应该没问题"）：
#    1) 包里的 Python 确实是 arm64 的 macOS 可执行文件
#    2) 解包 → ./start.sh 在 macOS 上真能起（不依赖系统 Python / Node）
#    3) /api/health、/api/agents、/api/credentials 与首页静态页都能取到
#    4) SQLite 真落库（greenlet 缺失时第一次查库就会炸，这里必现）
#
#  注意：macOS 没有 GNU timeout / sha256sum / ldd，本脚本只用两边都有的命令。
# ============================================================================
set -uo pipefail

TAR="${1:?用法: verify-bundle-macos.sh <包文件.tar.gz> [端口]}"
PORT="${2:-8899}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/as-mac.XXXXXX")"
PID=""
FAIL=0

ok()   { echo "  [OK]   $*"; }
bad()  { echo "  [FAIL] $*"; FAIL=$((FAIL + 1)); }
note() { echo "  [i]    $*"; }

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
  fi
  # 子进程（uvicorn）可能比 start.sh 活得久，按端口再收一次
  for _ in 1 2 3; do
    PIDS="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
    [ -z "$PIDS" ] && break
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null || true
    sleep 1
  done
}
trap cleanup EXIT

echo "=== 环境信息 ==="
echo "  系统   : $(uname -s) $(uname -r) $(uname -m)"
echo "  macOS  : $(sw_vers -productVersion 2>/dev/null || echo '?')"
echo "  包     : $TAR ($(du -h "$TAR" | cut -f1))"

echo "=== 1) 解包与结构 ==="
tar xzf "$TAR" -C "$WORK" || { bad "解包失败"; exit 1; }
PKG="$WORK/agent-studio"
[ -x "$PKG/start.sh" ] && ok "start.sh 可执行" || bad "start.sh 缺失"
[ -d "$PKG/runtime/aarch64/python" ] && ok "内置 aarch64 运行时在" || bad "缺 runtime/aarch64"
[ -f "$PKG/app/web/out/index.html" ] && ok "前端静态产物在" || bad "缺 web/out/index.html"
# 只看包根下的这些目录：site-packages 里本来就有 numpy/.../tests/data 这类
# 深路径，用「/data/」全串匹配会把合法依赖误判成"夹带数据库"（真踩过）。
if tar tzf "$TAR" | grep -qE '^agent-studio/(node_modules|\.venv|\.git|data)/'; then
  bad "包里夹带了依赖/虚拟环境/数据/git"
else
  ok "无 node_modules / .venv / data / git 夹带"
fi

echo "=== 2) 运行时是不是 macOS arm64 ==="
PY="$PKG/runtime/aarch64/python/bin/python3"
if [ -x "$PY" ]; then
  ARCHS="$(lipo -archs "$PY" 2>/dev/null || file -b "$PY")"
  echo "  架构: $ARCHS"
  case "$ARCHS" in
    *arm64*) ok "二进制含 arm64" ;;
    *) bad "不是 arm64（${ARCHS}）" ;;
  esac
  "$PY" -V 2>&1 | sed 's/^/  /'
  "$PY" - <<'PYEOF' || bad "运行时自检失败"
import platform, sys
assert sys.platform == "darwin", sys.platform
assert platform.machine() == "arm64", platform.machine()
print(f"  [OK]   {sys.platform} / {platform.machine()} / macOS {platform.mac_ver()[0]} / {sys.version.split()[0]}")
PYEOF
else
  bad "找不到内置 python（${PY}）"
fi

echo "=== 3) 启动（真跑 start.sh）==="
cd "$PKG"
PORT="$PORT" STUDIO_DB_PATH="$WORK/data/studio.db" ./start.sh > "$WORK/start.log" 2>&1 &
PID=$!
code=""
for i in $(seq 1 90); do
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || true)"
  [ "$code" = "200" ] && break
  kill -0 "$PID" 2>/dev/null || { bad "start.sh 提前退出"; tail -25 "$WORK/start.log"; break; }
  if [ $((i % 10)) -eq 0 ]; then echo "  … 等待启动（已等 $((i * 2))s，最后 HTTP=${code:-000}）"; fi
  sleep 2
done
if [ "$code" = "200" ]; then
  ok "后端 /api/health → 200"
else
  bad "后端未就绪（最后 HTTP=${code:-000}）"
  tail -30 "$WORK/start.log"
fi

echo "=== 4) 接口与静态页 ==="
for p in /api/health /api/agents /api/credentials; do
  c="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$PORT$p")"
  [ "$c" = "200" ] && ok "$p → 200" || bad "$p → $c"
done
h="$(curl -s -m 10 "http://127.0.0.1:$PORT/api/health" | head -c 120)"
echo "  health: $h"
w="$(curl -s -o /dev/null -L -m 20 -w '%{http_code}' "http://127.0.0.1:$PORT/")"
case "$w" in
  200|307|308) ok "首页 → $w" ;;
  *) bad "首页 → $w" ;;
esac

echo "=== 5) SQLite 真落库（greenlet / aiosqlite 一起验）==="
if [ -s "$WORK/data/studio.db" ]; then
  ok "数据库已创建（$(du -h "$WORK/data/studio.db" | cut -f1)）"
else
  bad "数据库未创建（异步引擎多半没起来）"
fi
curl -s -m 10 -X POST "http://127.0.0.1:$PORT/api/agents" \
  -H 'Content-Type: application/json' \
  -d '{"name":"macOS 验证-临时","definition":{"runtime":"agentscope","name":"macOS 验证-临时","system_prompt":"ping","model":{"provider":"deepseek","name":"deepseek-flash"},"tools":[],"skills":[]}}' \
  -o "$WORK/agent.json" -w '%{http_code}' > "$WORK/agent.code" 2>/dev/null || true
ac="$(cat "$WORK/agent.code" 2>/dev/null || echo 000)"
if [ "$ac" = "200" ] || [ "$ac" = "201" ]; then
  ok "写入助手 → ${ac}（SQLAlchemy async 正常）"
  AID="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WORK/agent.json" | head -1)"
  if [ -n "$AID" ]; then
    n="$(curl -s -m 10 "http://127.0.0.1:$PORT/api/agents" | grep -c "$AID" || true)"
    [ "$n" -ge 1 ] && ok "读回刚写的助手（${AID}）" || bad "读不回刚写的助手"
    curl -s -m 10 -X DELETE "http://127.0.0.1:$PORT/api/agents/$AID" -o /dev/null || true
  fi
else
  bad "写入助手 → ${ac}（异步引擎/数据库有问题）"
  tail -20 "$WORK/start.log"
fi

echo "=== 结论 ==="
if [ "$FAIL" -eq 0 ]; then
  echo "  全部通过 ✓"
else
  echo "  存在 $FAIL 项失败"
fi
[ "$FAIL" -eq 0 ]
