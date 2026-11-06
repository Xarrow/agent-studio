# Agent Studio · 离线一体包（Linux x86_64）

可视化 Agent 配置与运行观测平台（运行时无关）。**开箱即用**：包内自带 Python 3.13 运行时与全部依赖，
不依赖 Node.js、不依赖系统 Python、不需要联网。

## 在全新的 Intel 机器上启动

```bash
# 1) 把包拷过去（任选其一）
#    a. 内网直接下载
curl -O http://192.168.2.11:8081/agent-studio-bundle/agent-studio-20260928-x86_64.tar.gz
#    b. 从别的机器推过去
scp agent-studio-20260928-x86_64.tar.gz user@新机器:/opt/
#    c. U 盘 / 网盘拷过去，也一样

# 2) 解包
tar xzf agent-studio-20260928-x86_64.tar.gz -C /opt
cd /opt/agent-studio

# 3) 启动
./start.sh
```

看到 `Uvicorn running on http://0.0.0.0:8848` 就成功了。浏览器打开：

```
http://<新机器IP>:8848
```

首次启动会自动建 `data/`（SQLite 库 + 主密钥），约 2~5 秒进入可用状态。

## 系统要求

| 项 | 要求 |
|---|---|
| CPU | Intel/AMD x86_64 |
| 系统 | Linux，**glibc ≥ 2.34** → Ubuntu 22.04+ / Debian 12+ / RHEL·Rocky·CentOS Stream 9+ |
| 内存 | ≥ 1 GB 可用 |
| 磁盘 | ≥ 1 GB（解包后约 330 MB） |
| 需要装的东西 | **什么都不用装**（无 Node、无 Python、无 pip） |

先自查一行：`ldd --version | head -1`（低于 2.34 请换系统或索取旧系统兼容包）

## 想让 Agent 用浏览器（全新机器必看）

包里的 Python、依赖都是自带的，但**浏览器内核不是**：Chromium 有 900 MB，且必须由
平台自己管理（「环境配置 → 浏览器驱动」里装、切、删）。所以全新机器上用浏览器分两步：

```bash
# 步骤 1：装浏览器内核（页面里点「装一个新版本」，或直接调接口）
#   选 Google Chrome（Chrome for Testing）任一版本，装完平台会自动做一次自检

# 步骤 2：把 Chrome 需要的系统库补上（只有这一步需要 root，且只需做一次）
apt-get install -y libnss3 libnspr4 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libatspi2.0-0t64 libcairo2 libcups2t64 libgbm1 libpango-1.0-0 libxcomposite1 \
  libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libdrm2 fonts-liberation
```

页面上的「装系统依赖」按钮做的就是这一步：服务进程要是 root 就顺手装完；
不是 root（systemd 的 `User=agentstudio` 就是这种）它会把上面这条命令原样显示出来，
复制执行即可。装完点一次「自检」——**自检是真拉起一个 headless 实例跑一遍**，
通过才代表 Agent 真能用浏览器。

### 不想装系统包？

`scripts/collect-browser-deps.sh <chrome可执行文件> <目标目录>` 可以把 Chrome 依赖的
共享库整包收下来，放到 `<数据目录>/browser-deps/lib`（或用 `STUDIO_BROWSER_LIBS` 指定），
平台启动浏览器时会自动带上 `LD_LIBRARY_PATH`，不需要 root。

⚠ 这条路**必须在同一种发行版上收集**：NSS 是运行时 `dlopen` 一堆同伴库的，
把 Ubuntu 的 libnss3 塞进 Debian 会因为模块不匹配直接 `SIGABRT`（实测）。
跨发行版时用上面的 apt 那条路。

## 常用参数

| 需求 | 命令 |
|---|---|
| 换端口 | `PORT=9000 ./start.sh` |
| 加访问口令（公网必加） | `STUDIO_ACCESS_TOKEN=你的口令 ./start.sh` |
| 数据换位置 | `STUDIO_DB_PATH=/data/studio.db ./start.sh` |
| 后台常驻 | `nohup ./start.sh > studio.log 2>&1 &` |
| 开机自启 | 见下方 systemd 单元 |

### 开机自启（systemd）

```ini
# /etc/systemd/system/agent-studio.service
[Unit]
Description=Agent Studio
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/agent-studio
Environment=PORT=8848
Environment=STUDIO_ACCESS_TOKEN=你的口令
ExecStart=/opt/agent-studio/start.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now agent-studio
```

## 目录说明

```
agent-studio/
├── start.sh                       启动脚本（唯一入口）
├── app/src/agent_studio/          后端源码
├── app/web/out/                   前端静态资源（Next.js 静态导出，无 Node 依赖）
├── runtime/<arch>/python/         内置 Python 3.13 运行时
├── vendor/<arch>/site-packages/   预装好的全部依赖（含原生扩展）
├── data/                          数据目录（SQLite + 主密钥，首启自动创建）
└── requirements-lock.txt          依赖版本清单
```

## 数据与密钥

- **数据库**：`data/studio.db`（首启自动建表；默认每天自动留一份副本）
- **主密钥**：`data/.master_key`（首启自动生成，用于加密库中的 LLM 密钥）
- **迁移机器**：把整个 `data/` 一起带走，否则库里的 LLM 密钥无法解密
- **换机不换密钥**：也可直接 `STUDIO_MASTER_KEY=<原密钥> ./start.sh`

## 常见问题

| 现象 | 处理 |
|---|---|
| `Permission denied` | `chmod +x start.sh` |
| 提示 glibc 版本过低 | 系统太旧，换 Ubuntu 22.04+/Debian 12+，或索取兼容旧系统的包 |
| `Address already in use` | 端口被占：`PORT=9000 ./start.sh` |
| 页面打不开 | 确认服务在跑：`curl http://127.0.0.1:8848/api/health` 应返回 `{"status":"ok",...}` |
| 外部访问不了 | 放行防火墙：`firewall-cmd --add-port=8848/tcp`（或 `ufw allow 8848`） |
| 提示「不支持的架构」 | 用与服务器架构匹配的发行包（-x86_64 / -aarch64） |
