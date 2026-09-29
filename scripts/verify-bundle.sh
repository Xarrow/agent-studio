#!/usr/bin/env bash
# ============================================================================
#  离线包净机验证脚本（GitHub Actions / Codespaces 通用）
#
#  做四件事：下载发布资产 → 全新目录解包 → 启动 → 逐项取证（失败即非零退出）
#  用法：  bash scripts/verify-bundle.sh [资产URL或本地tar路径] [端口]
# ============================================================================
set -uo pipefail

SRC="${1:-}"
PORT="${2:-8848}"
WORK="$(mktemp -d /tmp/asb-verify-XXXXXX)"
FAIL=0
note() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  [OK]   %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1"; FAIL=1; }

note "环境信息"
echo "  系统     : $(uname -srm)"
echo "  发行版   : $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
echo "  glibc    : $(ldd --version 2>/dev/null | head -1)"
echo "  Node     : $(command -v node >/dev/null && node -v || echo '未安装（包不需要）')"
echo "  Python   : $(command -v python3 >/dev/null && python3 -V || echo '未安装（包自带）')"

note "1) 取包"
cd "$WORK"
if [ -z "$SRC" ]; then
  echo "  未传参数，跳过取包（需手动放 tar 到当前目录）"; ls -1 *.tar.gz 2>/dev/null || { bad "没有 tar.gz"; exit 1; }
elif [[ "$SRC" =~ ^https?:// ]]; then
  echo "  从 URL 下载：$SRC"
  curl -fL --retry 3 -m 900 -o pkg.tar.gz "$SRC" || { bad "下载失败"; exit 1; }
else
  cp "$SRC" pkg.tar.gz || { bad "复制失败"; exit 1; }
fi
PKG=$(ls -1 pkg.tar.gz *.tar.gz 2>/dev/null | head -1)
echo "  包大小   : $(du -h "$PKG" | cut -f1)"
gzip -t "$PKG" && ok "gzip 完整性通过" || bad "包损坏"

note "2) 解包（全新空目录）"
tar xzf "$PKG" || { bad "解包失败"; exit 1; }
cd agent-studio || { bad "缺 agent-studio 目录"; exit 1; }
ls -1 | sed 's/^/  /'
[ -x start.sh ] || { chmod +x start.sh; }

note "3) 启动"
unset STUDIO_MASTER_KEY STUDIO_DB_PATH STUDIO_WEB_DIST STUDIO_ACCESS_TOKEN
PORT="$PORT" ./start.sh > "$WORK/run.log" 2>&1 &
for i in $(seq 1 40); do
  sleep 1
  curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
done
sed 's/^/  /' "$WORK/run.log" | head -8

note "4) 取证"
H=$(curl -s -m 8 "http://127.0.0.1:$PORT/api/health")
echo "  health   : $H"
echo "$H" | grep -q '"status":"ok"' && ok "health ok" || bad "health 异常"
# 决定性判据：运行时被正确发现（动态导入在打包/冻结环境下最容易断的一环）
echo "$H" | grep -q 'agentscope' && ok "运行时已发现：agentscope" || bad "运行时未发现（动态导断链）"

echo "  页面："
for p in / /agents /workflows /playground /settings /exec /metrics; do
  C=$(curl -s -o /dev/null -w '%{http_code}' -m 6 "http://127.0.0.1:$PORT$p")
  printf '    %-12s %s\n' "$p" "$C"
  [ "$C" = "200" ] || FAIL=1
done

T=$(curl -s -m 8 "http://127.0.0.1:$PORT/" | grep -o '<title>[^<]*</title>' | head -1)
echo "  title    : $T"
[[ "$T" == *"Agent Studio"* ]] && ok "首页标题正确" || bad "首页标题异常"

A=$(curl -s -m 8 "http://127.0.0.1:$PORT/api/agents")
echo "  agents   : ${A:0:110}"
echo "$A" | grep -q '"id"' && ok "API 返回真实数据" || bad "API 无数据"
CARD=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "http://127.0.0.1:$PORT/.well-known/agent-card.json")
echo "  A2A card : $CARD"
[ "$CARD" = "200" ] && ok "A2A 入口可用" || bad "A2A 入口异常"

echo "  数据目录："
ls -la data | sed 's/^/    /'
[ -s data/studio.db ] && ok "SQLite 已创建" || bad "SQLite 未创建"

note "5) 证明用的是包内 Python（而非系统 Python）"
PID=$(pgrep -f 'uvicorn agent_studio.main' | head -1)
if [ -n "$PID" ]; then
  EXE=$(readlink -f "/proc/$PID/exe" 2>/dev/null || echo unknown)
  echo "  服务进程 : PID $PID"
  echo "  解释器   : $EXE"
  case "$EXE" in *runtime/*python*) ok "解释器来自包内 runtime/" ;; *) bad "解释器不是包内自带的" ;; esac
else
  bad "找不到服务进程"
fi

note "6) 结果"
pkill -f 'uvicorn agent_studio.main' 2>/dev/null
sleep 1
if [ "$FAIL" = "0" ]; then
  echo "  全部通过 ✅"
else
  echo "  存在失败项 ❌（见上方 [FAIL]）"
fi
cd / && rm -rf "$WORK"
exit "$FAIL"
