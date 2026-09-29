#!/usr/bin/env bash
# ============================================================================
#  反向验收：确认"系统太旧"时会被版本守卫**拦下**，而不是甩一段难懂的报错
#
#  用法： check-version-guard.sh <包.tar.gz>
#  判定： start.sh 非零退出 **且** 输出里出现 glibc 字样 → 通过
#         若服务真跑起来了（说明门槛写严了）或失败原因另有其因 → 失败
#
#  只依赖 tar 与 coreutils，不需要联网装任何东西 —— 这样在已归档的老发行版
#  容器里也能跑（Debian 11 的 apt 源已 404，装不了 curl，正因如此才拆出这一步）。
# ============================================================================
set -uo pipefail

TAR="${1:?用法: check-version-guard.sh <包.tar.gz>}"
[ -f "$TAR" ] || { echo "找不到包：$TAR"; exit 2; }

W="$(mktemp -d)"
tar xzf "$TAR" -C "$W" || { echo "::error::解包失败"; exit 2; }
if [ -d "$W/agent-studio" ]; then cd "$W/agent-studio"; else cd "$W"; fi
chmod +x start.sh 2>/dev/null || true

echo "[i] 环境：$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") / $(uname -m)"
echo "[i] $(ldd --version 2>/dev/null | head -1)"
echo "[i] 直接执行 start.sh（20 秒超时；正常情况下应立刻被拦下）"

set +e
OUT="$(timeout 20 ./start.sh 2>&1)"
RC=$?
set -e

echo "--- start.sh 输出 ---"
printf '%s\n' "$OUT"
echo "--- 退出码：$RC ---"

if [ "$RC" = "124" ] || [ "$RC" = "0" ]; then
  echo "::error::该环境竟然启动成功了（退出码 $RC）—— 文档里 glibc ≥ 2.34 的门槛过严，需要订正"
  exit 1
fi

if printf '%s' "$OUT" | grep -qi 'glibc'; then
  echo "✅ 版本守卫生效：被正确拦下，且给的是人话提示（不是难懂的动态链接报错）"
  exit 0
fi

echo "::error::确实失败了，但不是版本守卫拦的（退出码 $RC，输出见上）"
exit 1
