#!/bin/bash
# ============================================================================
#  Agent Studio · 开发环境一键启动
#
#  做四件事：检查 uv/Node → 装依赖（uv sync / npm install）→ 起后端 → 起前端
#  端口可用环境变量覆盖：STUDIO_PORT（后端，默认 8848）、WEB_PORT（前端，默认 3000）
#  用法：./start.sh
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"

API_PORT="${STUDIO_PORT:-8848}"
WEB_PORT="${WEB_PORT:-3000}"
API_HOST="${STUDIO_HOST:-0.0.0.0}"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

say "== 1/5 环境检查 =="
command -v uv  >/dev/null || die "缺少 uv（装法：curl -LsSf https://astral.sh/uv/install.sh | sh）"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "缺少 Node.js（需要 ≥20；建议用 nvm 装：nvm install 22）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 版本过低（当前 $(node -v)，需要 ≥20）"
echo "  uv    : $(uv --version)"
echo "  node  : $(node -v) @ $NODE_BIN"

say "== 2/5 后端依赖（uv sync）=="
if [ -d .venv ]; then echo "  .venv 已存在，跳过"; else uv sync || die "uv sync 失败"; fi

say "== 3/5 前端依赖（npm install）=="
cd web
if [ -d node_modules ]; then echo "  node_modules 已存在，跳过"; else
  if [ -f package-lock.json ]; then npm ci || die "npm ci 失败"; else npm install || die "npm install 失败"; fi
fi
# 前端要知道后端在哪：同源不可用（dev server 在 :3000），必须显式指向后端
if [ ! -f .env.local ]; then
  printf '# 开发环境：前端 dev server 指向本机后端\nNEXT_PUBLIC_API_BASE=http://127.0.0.1:%s\n' "$API_PORT" > .env.local
  echo "  已生成 web/.env.local → http://127.0.0.1:$API_PORT"
fi
cd ..

say "== 4/5 启动后端（:$API_PORT）=="
mkdir -p data
uv run uvicorn agent_studio.main:app --host "$API_HOST" --port "$API_PORT" > /tmp/agent-studio-api.log 2>&1 &
API_PID=$!
trap 'echo; say "正在停止…"; kill $API_PID 2>/dev/null; wait $API_PID 2>/dev/null' INT TERM EXIT

for i in $(seq 1 30); do
  curl -s -o /tmp/.as-health -m 3 "http://127.0.0.1:$API_PORT/api/health" >/tmp/.as-h 2>&1 && break
  kill -0 "$API_PID" 2>/dev/null || { echo "  后端启动失败，日志尾部："; tail -20 /tmp/agent-studio-api.log; exit 1; }
  sleep 1
done
echo "  后端就绪：http://127.0.0.1:$API_PORT  (健康检查: $(head -c 80 /tmp/.as-h 2>/dev/null))"
echo "  API 文档：http://127.0.0.1:$API_PORT/docs"
echo "  日志：/tmp/agent-studio-api.log"

say "== 5/5 启动前端（:$WEB_PORT，热更新）=="
echo "  打开：http://127.0.0.1:$WEB_PORT   （局域网内用本机 IP: $WEB_PORT）"
echo "  Ctrl-C 停止（会一并停掉后端）"
cd web && npm run dev -- -H 0.0.0.0 -p "$WEB_PORT"
