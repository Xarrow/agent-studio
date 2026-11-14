## Agent Studio 离线一体包

目标机**零依赖**：不需要 Node.js、不需要系统 Python、不需要联网。解压即跑。

### 本次产物

| 文件 | 说明 |
|---|---|
| `agent-studio-*-x86_64.tar.gz` | Intel/AMD 服务器，内置 CPython + 全部依赖 |
| `agent-studio-*-macos-arm64.tar.gz` | Apple Silicon（本地试跑用，不用于生产） |
| `agent-studio-dev-*.tar.gz` | 开发包：只有源码与配置，机器上自带 Node/Python 时用 |
| `SHA256SUMS.txt` | 上面三个包的校验和 |

### 用法

```bash
tar xzf agent-studio-*-x86_64.tar.gz
cd agent-studio
./start.sh                 # 默认 :8848
```

可选参数：`PORT=9000`、`STUDIO_ACCESS_TOKEN=口令`、`STUDIO_DB_PATH=/data/studio.db`

### 系统要求

Linux **x86_64**，**glibc ≥ 2.28**（Ubuntu 18.04+ / Debian 10+ / Rocky 8+ 均可）。

低于 2.28 会被启动脚本拦下并给出人话提示（不会甩一段动态链接报错），
`ldd --version | head -1` 可自查。

### 本版本已通过的验证

- **构建**：x86_64 打包成功（内置 CPython 3.13，依赖按架构预展开）；macOS arm64 包在 macOS runner 上真实解包启动
- **同机验证**：x86_64 原生运行验证
- **多环境验证**：Ubuntu 22.04（glibc 2.35）/ Ubuntu 24.04（2.39）/ Debian 12（2.36）/ Rocky 9（2.34）/ Rocky 8（2.28）全部通过
- **开发包验证**：在两版 Ubuntu 上真实解包、装依赖、启动并按同一套判据验收

判据包括：`/api/health` 200 且 `runtimes` 含 `agentscope`、7 个页面全 200、
`/.well-known/agent-card.json` 200、SQLite 落盘、以及**服务进程的解释器来自包内
runtime**（证明用的是自带 Python 而非系统 Python）。

构建与验证全程由 GitHub Actions 完成，日志见对应 workflow run。
