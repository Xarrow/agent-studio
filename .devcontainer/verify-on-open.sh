#!/usr/bin/env bash
# Codespaces 打开时自动跑：拉最新发布资产 → 调净机验证脚本
# Codespaces 里 gh 已预装并带认证，私有仓库也能直接下载。
set -uo pipefail

echo "=============================================="
echo " Agent Studio 离线包 · Codespaces 净机验证"
echo "=============================================="

DEST=/tmp/pkg
mkdir -p "$DEST"

if ls -1 "$DEST"/*.tar.gz >/dev/null 2>&1; then
  echo "[i] 已存在下载好的包，跳过下载"
else
  echo "[1/2] 从 Releases 下载离线包…"
  if ! gh release download --repo "${GITHUB_REPOSITORY:-Xarrow/agent-studio}" \
        --pattern '*.tar.gz' --dir "$DEST" --clobber; then
    echo "[!] 下载失败。可能原因：仓库还没有 Release / gh 未认证。"
    echo "    可手动下载后执行： bash scripts/verify-bundle.sh /path/to/agent-studio-*.tar.gz"
    exit 1
  fi
fi

TAR=$(ls -1 "$DEST"/*.tar.gz | head -1)
echo "[2/2] 开始验证：$TAR"
echo
bash "$(dirname "$0")/../scripts/verify-bundle.sh" "$TAR" 8848
