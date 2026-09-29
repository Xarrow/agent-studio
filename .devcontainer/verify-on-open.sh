#!/usr/bin/env bash
# ============================================================================
#  Codespaces 打开即自动执行：取 CI 打出的包 → 净机验证 → 把记录回报到 issue
#
#  为什么回报到 issue：Codespaces 里的终端输出出了会话就没了。写成 issue 评论后
#  验证记录可追溯、可复核、也能被 API 读回来，不再是"某台机器终端里的一句话"。
# ============================================================================
set -uo pipefail

REPO="${GITHUB_REPOSITORY:-Xarrow/agent-studio}"
ISSUE="${VERIFY_ISSUE:-1}"
DEST=/tmp/pkg
LOG=/tmp/verify-transcript.txt
mkdir -p "$DEST"

{
echo "## Codespaces 净机验证"
echo
echo '| 项 | 值 |'
echo '|---|---|'
echo "| 时间 | $(date -u '+%Y-%m-%d %H:%M:%S UTC') |"
echo "| 系统 | $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") $(uname -m) |"
echo "| glibc | $(ldd --version 2>/dev/null | head -1) |"
echo "| Node | $(command -v node >/dev/null && node -v || echo '未安装（包不需要）') |"
echo "| 系统 Python | $(command -v python3 >/dev/null && python3 -V || echo '未安装（包自带）') |"
echo

echo '### 取包'
TAR=""
# 1) 优先取 CI 最近一次成功的 artifact（与 CI 验证的是同一个产物）
if gh run download -R "$REPO" --name agent-studio-x86_64 --dir "$DEST" >/dev/null 2>&1; then
  TAR=$(ls -1 "$DEST"/*.tar.gz 2>/dev/null | head -1)
  echo "- 来源：CI workflow artifact（最近一次成功 run）"
fi
# 2) 退回 Release 资产
if [ -z "$TAR" ]; then
  if gh release download -R "$REPO" --pattern '*.tar.gz' --dir "$DEST" --clobber >/dev/null 2>&1; then
    TAR=$(ls -1 "$DEST"/*.tar.gz 2>/dev/null | head -1)
    echo "- 来源：Release 资产"
  fi
fi
if [ -z "$TAR" ]; then
  echo "- ❌ 取包失败（artifact 与 Release 资产都拿不到）"
  TAIL="取包失败，未能验证。"
  RC=1
else
  echo "- 文件：\`$(basename "$TAR")\`  $(du -h "$TAR" | cut -f1)"
  echo "- sha256：\`$(sha256sum "$TAR" | cut -d' ' -f1)\`"
  echo
  echo '### 验证输出'
  echo '```'
  bash scripts/verify-bundle.sh "$TAR" 8848 2>&1 | sed -E 's/(github_pat_|ghp_)[A-Za-z0-9_]+/[REDACTED]/g'
  RC=${PIPESTATUS[0]}
  echo '```'
  TAIL=""
fi
} > "$LOG" 2>&1

rc=$?
[ -n "${RC:-}" ] && rc=$RC
if [ "$rc" = "0" ]; then
  echo "" >> "$LOG"; echo "**结论：✅ 全部通过**" >> "$LOG"
else
  echo "" >> "$LOG"; echo "**结论：❌ 存在失败项（见上方输出）**" >> "$LOG"
fi

cat "$LOG"

# 回报到 issue（失败不影响本地结论）
if gh issue comment "$ISSUE" -R "$REPO" --body-file "$LOG" >/dev/null 2>&1; then
  echo
  echo "[i] 验证记录已写入 issue #$ISSUE：https://github.com/$REPO/issues/$ISSUE"
else
  echo
  echo "[!] 写入 issue 失败（权限不足？）。记录已保存在 $LOG，可手动粘贴。"
fi

exit "$rc"
