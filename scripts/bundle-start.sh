#!/usr/bin/env bash
# ============================================================================
#  Agent Studio · 离线一体包启动脚本
#
#  用法：  tar xzf agent-studio-*.tar.gz
#          cd agent-studio
#          ./start.sh
#
#  特点：  零 Node、零系统 Python、零外网 —— Python 运行时与全部依赖都在包内。
#          换端口：PORT=9000 ./start.sh
#          公网口令：STUDIO_ACCESS_TOKEN=你的口令 ./start.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# --- 架构识别（本包含 x86_64 / aarch64 两套运行时） -------------------------
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) echo "[!] 不支持的架构：$ARCH（包内提供 x86_64 / aarch64）"; exit 1 ;;
esac
PY="runtime/$ARCH/python/bin/python3"
if [ ! -x "$PY" ]; then
  echo "[!] 本包不含 $ARCH 运行时 —— 请使用与服务器架构匹配的发行包"; exit 1
fi

echo "[1/3] 内置运行时：$("$PY" -V 2>&1) ($ARCH)"

# --- 依赖与路径（全部指向包内，不碰系统环境） -------------------------------
export PYTHONPATH="$PWD/vendor/$ARCH/site-packages:$PWD/app/src"
export STUDIO_WEB_DIST="$PWD/app/web/out"
export STUDIO_DB_PATH="${STUDIO_DB_PATH:-$PWD/data/studio.db}"
mkdir -p "$(dirname "$STUDIO_DB_PATH")"

# --- 主密钥：首启自动生成并持久化（避免"用公开默认钥匙加密"） ---------------
if [ -z "${STUDIO_MASTER_KEY:-}" ]; then
  KEYFILE="data/.master_key"
  if [ ! -s "$KEYFILE" ]; then
    mkdir -p data
    "$PY" -c "import secrets;print(secrets.token_urlsafe(48))" > "$KEYFILE"
    chmod 600 "$KEYFILE"
    echo "[2/3] 已生成主密钥 → $KEYFILE（请备份，换机迁移时要一起带走）"
  else
    echo "[2/3] 沿用已有主密钥 → $KEYFILE"
  fi
  export STUDIO_MASTER_KEY="$(cat "$KEYFILE")"
else
  echo "[2/3] 使用外部传入的 STUDIO_MASTER_KEY"
fi

# --- 启动 -------------------------------------------------------------------
PORT="${PORT:-8848}"
echo "[3/3] Agent Studio 启动 → http://0.0.0.0:${PORT}   (Ctrl+C 停止)"
exec "$PY" -m uvicorn agent_studio.main:app \
  --app-dir app/src --host 0.0.0.0 --port "$PORT"
