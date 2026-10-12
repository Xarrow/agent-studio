#!/bin/bash
# ============================================================================
#  Agent Studio · 开发包构建脚本
#
#  产物：一个 tar.gz，解包后一条命令即可起来（后端 :8848 + 前端 dev :3000）。
#  与部署包的区别：
#    部署包（build-offline-bundle.sh）= 内置 CPython + 预装依赖 + 编译好的 web/out，
#      目标机零依赖、零联网、零 Node —— 用于「拿去就跑」。
#    开发包（本脚本）= 源码 + web 源码 + 锁文件 + 一键启动脚本，
#      依赖目标机的 uv 与 Node ≥20（启动脚本会自己 uv sync / npm install）—— 用于「接着开发」。
#
#  用法：bash scripts/build-dev-bundle.sh
#  产物目录：/srv/www/agent-studio-bundle/（可用 OUT= 覆盖）
# ============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-/srv/www/agent-studio-bundle}"
DATE="$(date +%Y%m%d)"
STAGE="$(mktemp -d /tmp/asb-dev-XXXXXX)/agent-studio"
PKG="$STAGE"

echo "[1/4] 准备目录 $PKG"
mkdir -p "$PKG"

echo "[2/4] 拷源码（排除构建产物、依赖、数据库、git）"
tar cf - -C "$REPO" \
  --exclude='./web/node_modules' \
  --exclude='./web/.next*' \
  --exclude='./web/out' \
  --exclude='./web/tsconfig.tsbuildinfo' \
  --exclude='./.venv' \
  --exclude='./.git' \
  --exclude='./data' \
  --exclude='./data-staging' \
  --exclude='./__pycache__' \
  --exclude='./.pytest_cache' \
  --exclude='./.ruff_cache' \
  --exclude='*.pyc' \
  --exclude='*.log' \
  --exclude='./dist' \
  --exclude='./_py_tool.py' \
  . | tar xf - -C "$PKG"

# 清掉可能夹带的缓存与本地状态
find "$PKG" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$PKG/src/agent_studio/.local" 2>/dev/null || true
rm -f "$PKG/web/.env.local" 2>/dev/null || true

[ -f "$PKG/pyproject.toml" ] || { echo "缺少 pyproject.toml"; exit 1; }
[ -f "$PKG/web/package.json" ] || { echo "缺少 web/package.json"; exit 1; }

echo "[3/4] 放入一键启动脚本"
cp "$REPO/scripts/dev-start.sh" "$PKG/start.sh"
chmod +x "$PKG/start.sh"
cp "$REPO/scripts/dev-README.md" "$PKG/README.md"

echo "[4/4] 打包"
mkdir -p "$OUT"
TAR="$OUT/agent-studio-dev-$DATE.tar.gz"
tar czf "$TAR" -C "$(dirname "$PKG")" agent-studio
gzip -t "$TAR"
ls -lh "$TAR"
echo "完成：$TAR"
