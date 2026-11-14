#!/usr/bin/env bash
# ============================================================================
#  远端一体化包部署（agent-studio）
#
#  为什么需要它：东京那台**没有 git 仓库**，前端产物目录由 start.sh 里的
#  STUDIO_WEB_DIST 决定（app/web/out）。之前手工往 web/out 覆盖，后端是新的、
#  前端一直是旧包 —— 用户那边表现成"改了没生效"，排查了几轮才定位。
#  这个脚本只做一件事：**问远端它到底从哪读静态文件**，然后只往那儿写，
#  最后用 /api/version 回报的 commit 和文件数做验收。
#
#  用法：
#    scripts/deploy-remote.sh <ssh主机> [--no-web] [--no-api]
#  例：
#    scripts/deploy-remote.sh tokyo
#
#  约定（远端）：
#    · unit：agent-studio（systemd），服务用户 agentstudio
#    · 包根：/opt/agent-studio
#    · 后端源码：/opt/agent-studio/app/src
#    · 静态目录：由 start.sh 的 STUDIO_WEB_DIST 决定，脚本运行时读取
# ============================================================================
set -euo pipefail

HOST="${1:-}"
shift || true
DO_WEB=1
DO_API=1
for a in "$@"; do
  case "$a" in
    --no-web) DO_WEB=0 ;;
    --no-api) DO_API=0 ;;
    *) echo "未知参数: $a"; exit 2 ;;
  esac
done
if [ -z "$HOST" ]; then
  echo "用法: $0 <ssh主机> [--no-web] [--no-api]"; exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOCAL_COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
echo "[1/5] 本地 commit=$LOCAL_COMMIT"

# 静态目录必须由构建产物存在才发；否则不发，避免把空目录同步上去变成白屏
if [ "$DO_WEB" = 1 ] && [ ! -f web/out/index.html ]; then
  echo "[!] web/out 不存在或没有 index.html —— 先构建： cd web && npm run build"; exit 1
fi

REMOTE_BASE="${REMOTE_BASE:-/opt/agent-studio}"
UNIT="${UNIT:-agent-studio}"

echo "[2/5] 问远端：静态目录在哪、服务是谁"
REMOTE_INFO="$(ssh "$HOST" "sudo grep -oE 'STUDIO_WEB_DIST=\"?\\\$PWD[^\" ]*' $REMOTE_BASE/start.sh 2>/dev/null | head -1 | sed 's/.*PWD//;s/\"//g'; systemctl show -p MainPID --value $UNIT")"
WEB_SUFFIX="$(echo "$REMOTE_INFO" | head -1 | tr -d '\r')"
MAIN_PID="$(echo "$REMOTE_INFO" | tail -1 | tr -d '\r')"
if [ -z "$WEB_SUFFIX" ]; then
  echo "[!] 远端 start.sh 里没找到 STUDIO_WEB_DIST（包结构变了？）"; exit 1
fi
REMOTE_WEB="$REMOTE_BASE$WEB_SUFFIX"
echo "      静态目录 = $REMOTE_WEB   MainPID=${MAIN_PID:-none}"

if [ "$DO_API" = 1 ]; then
  echo "[3/5] 同步后端源码 → $REMOTE_BASE/app/src"
  tar -cf - src/agent_studio | ssh "$HOST" "sudo tar -C $REMOTE_BASE/app -xf - && sudo chown -R agentstudio:agentstudio $REMOTE_BASE/app/src"
fi

if [ "$DO_WEB" = 1 ]; then
  echo "[4/5] 同步前端产物 → $REMOTE_WEB（保留一份 prev 便于回滚）"
  tar -C web/out -cf - . | ssh "$HOST" "sudo rm -rf $REMOTE_WEB.prev && sudo cp -a $REMOTE_WEB $REMOTE_WEB.prev 2>/dev/null; sudo rm -rf $REMOTE_WEB && sudo mkdir -p $REMOTE_WEB && sudo tar -C $REMOTE_WEB -xf - && sudo chown -R agentstudio:agentstudio $REMOTE_WEB"
fi

echo "[5/5] 重启并按 /api/version 验收"
ssh "$HOST" "sudo systemctl restart $UNIT && sleep 7 && curl -s http://127.0.0.1:8891/api/version" | tee /tmp/deploy-version.json
echo

python3 - "$LOCAL_COMMIT" <<'PY'
import json, sys
local = sys.argv[1]
try:
    d = json.load(open("/tmp/deploy-version.json"))
except Exception:
    print("[!] 远端 /api/version 不可读 —— 服务可能没起来"); sys.exit(1)
ok = True
if local != "unknown" and d.get("commit") not in (local, "unknown"):
    print(f"[!] commit 不一致：本地 {local} / 远端 {d.get('commit')}"); ok = False
if d.get("web_files", 0) < 20:
    print(f"[!] 远端静态文件数异常：{d.get('web_files')}（可能是空目录或指错路径）"); ok = False
print(("✓ 部署验收通过：" if ok else "✗ 部署验收失败：") + json.dumps(d, ensure_ascii=False))
sys.exit(0 if ok else 1)
PY
