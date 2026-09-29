## Agent Studio 离线一体包

目标机**零依赖**：不需要 Node.js、不需要系统 Python、不需要联网。解压即跑。

### 本次产物

| 文件 | 说明 |
|---|---|
| `agent-studio-*-x86_64.tar.gz` | Intel/AMD x86_64 服务器 |
| `SHA256SUMS.txt` | 校验和 |

> 本版只提供 x86_64。ARM64 的构建流水线已在 workflow 中备好（交叉下载依赖 +
> qemu 模拟验证），需要时把矩阵里的 `aarch64` 加回来即可。

### 用法

```bash
tar xzf agent-studio-*-x86_64.tar.gz
cd agent-studio
./start.sh                 # 默认 :8848
```

可选参数：`PORT=9000`、`STUDIO_ACCESS_TOKEN=口令`、`STUDIO_DB_PATH=/data/studio.db`

### 系统要求

Linux **x86_64** 或 **aarch64**，**glibc ≥ 2.34**（Ubuntu 22.04+ / Debian 12+ / RHEL·Rocky·CentOS Stream 9+）。

低版本系统会被启动脚本拦下并给出人话提示（不会甩一段动态链接报错），
`ldd --version | head -1` 可自查。

### 本版本已通过的验证

- **构建**：x86_64 打包成功（内置 CPython 3.13，依赖按架构预展开）
- **同机验证**：x86_64 原生运行验证
- **多环境验证**：Ubuntu 22.04 / Ubuntu 24.04 / Debian 12 / Rocky 9 全部通过
- **反向验收**：Rocky 8（glibc 2.28）按预期被版本守卫拦下并给出人话提示

判据包括：`/api/health` 200 且 `runtimes` 含 `agentscope`、7 个页面全 200、
`/.well-known/agent-card.json` 200、SQLite 落盘、以及**服务进程的解释器来自包内
runtime**（证明用的是自带 Python 而非系统 Python）。

构建与验证全程由 GitHub Actions 完成，日志见对应 workflow run。
