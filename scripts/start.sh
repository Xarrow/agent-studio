#!/usr/bin/env bash
# agent-studio 离线部署包自举脚本
# 用法: tar xf agent-studio-*.tar.gz && cd agent-studio && bash start.sh
# 零 Node、零外网：依赖已随包离线就位（vendor/site-packages），venv 首次运行本地拷入
set -euo pipefail
cd "$(dirname "$0")"

PY="$(command -v python3.13 || command -v python3)"
echo "[1/3] Python: $($PY --version 2>&1) ($($PY -c 'import platform;print(platform.machine())'))"
"$PY" -c 'import sys; assert (3,13) <= sys.version_info < (3,14)' || {
  echo "[!] 需要 Python 3.13（包内依赖按 cp313 打包）"; exit 1; }

# 首次运行：建 venv + 拷入随包依赖（无网络动作）
if [ ! -x .venv/bin/python ]; then
  echo "[2/3] 创建虚拟环境 + 拷入离线依赖..."
  "$PY" -m venv .venv
  cp -a vendor/site-packages/. .venv/lib/python3.13/site-packages/
  echo "      完成: $(ls .venv/lib/python3.13/site-packages | wc -l) 个顶层条目"
else
  echo "[2/3] .venv 已存在，跳过"
fi

# 静态前端与数据库路径（显式指定，防 --app-dir 改变解析基准）
export STUDIO_WEB_DIST="$(pwd)/web/out"
export STUDIO_DB_PATH="${STUDIO_DB_PATH:-$(pwd)/data/studio.db}"
mkdir -p "$(dirname "$STUDIO_DB_PATH")"

PORT="${PORT:-8848}"
echo "[3/3] 启动 Agent Studio → http://0.0.0.0:${PORT}  (Ctrl+C 停止)"
# python -m uvicorn：vendor 的 site-packages 拷贝式安装不带 console-script（bin/uvicorn 缺失）
# --app-dir src：src/ 入 sys.path（agent_studio 包在此）
exec .venv/bin/python -m uvicorn agent_studio.main:app \
  --app-dir src --host 0.0.0.0 --port "$PORT"
