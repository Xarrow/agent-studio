#!/usr/bin/env bash
# agent-studio 离线部署包自举脚本 —— 用法: tar xf agent-studio-*.tar.gz && cd agent-studio && bash start.sh
set -euo pipefail
cd "$(dirname "$0")"

PY="python3.13"
command -v "$PY" >/dev/null 2>&1 || PY=python3
echo "[1/3] Python: $($PY --version) ($($PY -c 'import platform;print(platform.machine())'))"

# 建 venv（已存在则跳过）
if [ ! -x .venv/bin/python ]; then
  echo "[2/3] 创建 venv 并离线安装依赖 (wheels/pkgs)…"
  $PY -m venv .venv
  # 无 pip 的 venv 先补 pip（用 ensurepip，离线可用）
  .venv/bin/python -m ensurepip --upgrade >/dev/null 2>&1 || true
  .venv/bin/python -m pip install --no-index --find-links wheels/pkgs \
      "uvicorn[standard]" $(grep -E '^\s+"' pyproject.toml | tr -d ' ",' | sed 's/>=.*//;s/\[standard\]//' | grep -v pytest) \
      >/dev/null
  echo "      依赖安装完成: $(.venv/bin/python -m pip list 2>/dev/null | wc -l) 个包"
else
  echo "[2/3] .venv 已存在，跳过安装"
fi

# 数据目录
mkdir -p data

echo "[3/3] 启动 agent-studio (端口 ${STUDIO_PORT:-8848})…"
echo "    内网入口: http://127.0.0.1:${STUDIO_PORT:-8848}"
exec .venv/bin/python -m uvicorn agent_studio.main:app \
  --host 0.0.0.0 --port "${STUDIO_PORT:-8848}" \
  --app-dir src
