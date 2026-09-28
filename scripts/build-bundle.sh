#!/usr/bin/env bash
# agent-studio 离线单文件包构建
# 产物: /srv/www/agent-studio-bundle/agent-studio-YYYYMMDD.tar.gz
# 目标机要求: Linux x86_64 + Python 3.13；零 Node、零联网
set -euo pipefail

REPO=/srv/src/agent-studio
OUT=/srv/www/agent-studio-bundle
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
NAME=agent-studio
mkdir -p "$OUT" "$STAGE/$NAME"

cd "$REPO"

# ── 1) 源码 + 静态前端（web/out 运行时零 Node）────────────────
rsync -a \
  --exclude 'data/'            \
  --exclude '.venv/'           \
  --exclude '.git/'            \
  --exclude 'web/node_modules/'\
  --exclude 'web/.next/'       \
  --exclude '_py_tool.py'      \
  --exclude 'hello_world.py'   \
  --exclude '*.db'             \
  --exclude '*.log'            \
  --exclude '__pycache__/'     \
  ./ "$STAGE/$NAME/"

# ── 2) 离线依赖 wheel ────────────────────────────────────────
# 锁定版本：用 .venv 自己的 python 读已装发行版元数据
# （不用 pip freeze --path：它会扫到 conda site-packages，混入 PyPI 不存在的私有版本号）
"$REPO/.venv/bin/python" - <<'PY' > "$STAGE/$NAME/requirements-lock.txt"
import importlib.metadata as m
for d in sorted(m.distributions(), key=lambda x: x.metadata["Name"].lower()):
    name = d.metadata["Name"]
    if name and name.lower() not in ("agent-studio", "agent_studio"):
        print(f"{name}=={d.version}")
PY

# wheel 下载：本机即 x86_64 Linux + cp313，与目标机同平台 → 原生平台标签下载即可。
# 不加 --platform manylinux2014 等过滤：greenlet 等新版 wheel 只带 manylinux_2_28 标签会被误判排除。
echo "[build] 下载离线 wheel（cp313 manylinux，共 $(wc -l < "$STAGE/$NAME/requirements-lock.txt") 项锁定依赖）..."
python3 -m pip download -q --only-binary=:all: \
  --retries 8 --timeout 60 \
  -d "$STAGE/$NAME/vendor/wheels" \
  -r "$STAGE/$NAME/requirements-lock.txt"
echo "[build] wheel 完成: $(ls "$STAGE/$NAME/vendor/wheels" | wc -l) 个"

# ── 3) 一键启动脚本 ──────────────────────────────────────────
cat > "$STAGE/$NAME/start.sh" <<'SH'
#!/usr/bin/env bash
# agent-studio 一键启动（目标机仅需 Python 3.13，无 Node/无网络）
set -euo pipefail
cd "$(dirname "$0")"

PY=python3
# cp313 wheel 只能装到 3.13
if ! $PY -c 'import sys; assert sys.version_info[:2] == (3,13)' 2>/dev/null; then
  echo "[!] 需要 Python 3.13，当前: $($PY --version 2>&1)"
  echo "    （包内 wheel 按 cp313 打包；请先安装 Python 3.13 后重试）"
  exit 1
fi

# 首次运行：创建 venv + 离线安装依赖
if [ ! -x .venv/bin/python ]; then
  echo "[init] 首次运行：创建虚拟环境 + 离线安装依赖..."
  $PY -m venv .venv
  .venv/bin/pip install -q --no-index \
    --find-links vendor/wheels -r requirements-lock.txt
  echo "[init] 完成。"
fi

export STUDIO_WEB_DIST="$(pwd)/web/out"
export STUDIO_DB_PATH="${STUDIO_DB_PATH:-$(pwd)/data/studio.db}"
mkdir -p "$(dirname "$STUDIO_DB_PATH")"

PORT="${PORT:-8848}"
echo "[run] Agent Studio → http://0.0.0.0:${PORT}  (Ctrl+C 停止)"
# --app-dir src：把 src/ 加入 sys.path（agent_studio 包在此），
# 且 __file__.parents[2] 指向包根 → web/out 静态托管自动命中
exec .venv/bin/uvicorn agent_studio.main:app \
  --app-dir src --host 0.0.0.0 --port "$PORT"
SH
chmod +x "$STAGE/$NAME/start.sh"

# ── 4) README ───────────────────────────────────────────────
cat > "$STAGE/$NAME/BUNDLE-README.md" <<'MD'
# Agent Studio 离线部署包

## 要求
- Linux x86_64
- Python 3.13（包内依赖按 cp313 wheel 离线打包）
- 零 Node.js、零外网

## 启动
```bash
tar xzf agent-studio-*.tar.gz && cd agent-studio
./start.sh                # 默认端口 8848，PORT=9999 ./start.sh 可改
```
首次运行自动建 .venv 并从 vendor/wheels 离线装依赖（约 30s）。

## 数据
- SQLite 库: ./data/studio.db（自动创建，随包目录走）
- 访问口令: 环境变量 STUDIO_ACCESS_TOKEN 设置后启用（默认无口令=内网模式）

## 结构
- src/agent_studio/   后端（FastAPI）
- web/out/            静态前端（构建机 Next.js export 产物，运行时零 Node）
- vendor/wheels/      离线依赖 wheel
MD

# ── 5) 打包 ─────────────────────────────────────────────────
TARBALL="$OUT/agent-studio-$(date +%Y%m%d).tar.gz"
cd "$STAGE" && tar -czf "$TARBALL" "$NAME"
echo "── 产物 ──"
ls -lh "$TARBALL"
