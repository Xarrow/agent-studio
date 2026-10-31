"""Agent Studio —— FastAPI 入口。

启动：``uv run uvicorn agent_studio.main:app --reload --port 8848``
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .api import api_router
from .api import a2a
from .config import settings
from .db import init_db
from .runner.service import reap_orphan_runs
from .runner.dispatcher import loop as dispatcher_loop
from .scheduler import loop as scheduler_loop
from .runtimes import discover_runtimes, list_runtimes

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)
logger = logging.getLogger("agent_studio")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # 记下进程启动时刻：早于它的在途执行，其协程必然已不存在（见 reap_orphan_runs）
    boot_ms = int(time.time() * 1000)
    await init_db()
    await reap_orphan_runs(boot_ms)
    # 后台进程对账：标着 running 但进程已不在的（服务重启过）改成 unknown，
    # 否则界面永远挂一个"正在运行"，点停止还告诉你"它已经结束了"。
    from . import procs as _procs

    _fixed = await _procs.reconcile()
    if _fixed:
        logger.info("后台进程：%s 个已不在的进程标记为 unknown", _fixed)
    # 给早就存在的助手/流程补一条起点版本（幂等）—— 否则老对象点进去是"还没有历史"
    from .db import SessionLocal
    from .revisions import backfill_initial

    # 模型单价：全新库里是空的 → 花费上限永远拦不住（算不出钱）。
    # 只补参考价，用户填过的绝不覆盖。
    from .pricing import ensure_default_prices

    async with SessionLocal() as _ps:
        _priced = await ensure_default_prices(_ps)
    if _priced:
        logger.info("模型单价：补了 %d 条参考价（可在「模型单价」里改）", _priced)

    # MCP 的 env/headers 历史上是明文存的（里面有别人的 token）→ 启动时就地加密
    from .api.mcp import migrate_plaintext_secrets

    _mcp_moved = await migrate_plaintext_secrets()
    if _mcp_moved:
        logger.info("MCP 凭据：把 %d 条明文 env/headers 迁到了密文列", _mcp_moved)

    async with SessionLocal() as _s:
        _made = await backfill_initial(_s)
    if _made:
        logger.info("版本历史：为 %d 个已有对象补了起点快照", _made)

    # 内置工具先入库（运行时内置 + 平台原生 fetch/web_search/python）——
    # 必须在 ensure_default_agents **之前**：默认助手要按名字挂工具，库里没有就挂不上。
    from .api.tools import sync_builtins

    async with SessionLocal() as _s:
        _sync = await sync_builtins(runtime="agentscope", session=_s)
    if _sync.get("created"):
        logger.info("工具同步：新建 %s 个内置工具", _sync["created"])

    # 开局就有"能干活的两个角色"：编排者（开始/拆分/汇总）+ 通用助手（干活）。
    # 幂等：已存在就不动（用户可能改过提示词/模型）；只在缺的时候补，并保证编排者挂着分派工具。
    from .defaults import ensure_default_agents

    async with SessionLocal() as _s:
        _seed = await ensure_default_agents(_s)
    if _seed["created"] or _seed["attached_fork"] or _seed.get("attached_native"):
        logger.info(
            "默认助手：新建 %s%s%s",
            "、".join(_seed["created"]) or "无",
            "；并给编排者挂上了分派工具" if _seed["attached_fork"] else "",
            f"；补挂内核工具 {_seed['attached_native']} 个" if _seed.get("attached_native") else "",
        )

    # 内置示范 Skill（web-research / data-analysis）：空库时建、已存在不动。
    from .defaults import ensure_default_skills

    async with SessionLocal() as _s:
        _skills = await ensure_default_skills(_s)
    if _skills:
        logger.info("内置示范 Skill：新建 %s", "、".join(_skills))
    discover_runtimes()
    runtimes = [rt.name for rt in list_runtimes()]
    logger.info(
        "Agent Studio 启动 | db=%s | runtimes=%s | 并发上限=%s | 重试=%s",
        settings.db_path,
        runtimes,
        settings.max_concurrent_runs or "不限",
        settings.run_retry_max,
    )
    # 安全红线：没配主密钥 = 密钥等于没加密（源码里那把默认钥匙是公开的）。
    # 这里**大声说出来**，而不是安静地继续跑 —— 否则没人会去配。
    from .security.crypto import master_key

    if not master_key():
        logger.warning(
            "⚠️  未设置 STUDIO_MASTER_KEY —— 密钥加密用的是**公开的默认钥匙**，"
            "拿到库文件的人可以解开全部 LLM key。请设置环境变量；"
            "已有密文的迁移见 scripts/rotate_master_key.py"
        )
    # **自动运行**（无人值守）：进程内一个 20 秒的 tick，不引调度库、不起第二个服务。
    # 它比任何一次执行都更该耐活 —— 挂了就再也没有"自动跑"（见 scheduler.loop）。
    scheduler = asyncio.create_task(scheduler_loop())
    # **执行分发器**：所有执行都由它按并发上限取走（pending 就是队列）——
    # 重启后没跑完的单步执行会被它捡起来续跑（见 runner/dispatcher.py）。
    dispatcher_task = asyncio.create_task(dispatcher_loop())
    try:
        yield
    finally:
        scheduler.cancel()
        dispatcher_task.cancel()
        logger.info("Agent Studio 关闭")


app = FastAPI(
    title="Agent Studio",
    description="可视化 Agent 配置与运行观测平台（运行时无关）",
    version=__version__,
    lifespan=lifespan,
)

# --------------------------------------------------------------------------- #
# 访问口令（HTTP auth）
# --------------------------------------------------------------------------- #
# 背景：平台经 Cloudflare 隧道对外后，公网上任何人都能访问 —— 能看助手/记忆、
# 能读明文 LLM key、能烧 API 额度。这里加一道口令把它挡住。
#
# 设计取舍（刻意的）
# ------------------
# · **只拦"经隧道进来"的请求**（peer 是 cloudflared 所在机器）。内网直连放行 ——
#   这样本机脚本、前端开发、内网浏览器全都不用改，零摩擦，而公网那扇门关上了。
# · 口令留空 = 整个机制不启用（保持原来的内网无认证行为，可随时退回去）。
# · 三种带法都接受：Authorization: Bearer / HTTP Basic / ?token=
#   **为什么必须支持 ?token=** —— SSE 用的是 EventSource，它**无法自定义请求头**，
#   没有查询参数这条路，流式对话和 Playground 会全部 401 断掉。
#
# ⚠️ 局限：口令走查询参数会进浏览器历史/日志。这是为了让 SSE 能用而做的妥协，
#    内网自用可以接受；要做正式鉴权应改用 Cloudflare Access 或短时效 token。
ACCESS_TOKEN = os.getenv("STUDIO_ACCESS_TOKEN", "").strip()

#: 无需口令的路径（健康检查 + 文档，便于监控与排障）
AUTH_EXEMPT = {"/api/health", "/docs", "/openapi.json", "/redoc"}

#: 免口令的**路径前缀**。
#: 目前只有一个：外部触发 ``/api/hooks/{token}`` —— 凭证就在路径里，
#: 而调用方（监控/告警/第三方平台）往往只能配一个 URL，塞不进 header。
#: 口令再叠一层的结果是"所有这类调用都调不通"，所以这里只认 token。
#: 目前两条：
#:   · ``/api/hooks/{token}``     —— 外部触发，凭证在路径里
#:   · ``/api/remote-agents/self`` —— 远端 agent 自注册：它在别人的机器上，
#:     拿不到全站口令；这条端点**自己验**注册口令（见 api/remote_agents.py）
AUTH_EXEMPT_PREFIXES = ("/api/hooks/", "/api/remote-agents/self")

#: 隧道对端（= cloudflared 所在机器）。换机/多台可用环境变量覆盖。
TUNNEL_PEERS = {
    p.strip()
    for p in os.getenv("STUDIO_TUNNEL_PEERS", "192.168.2.7").split(",")
    if p.strip()
}


def _presented_token(request: "Request") -> str:
    """从请求里取出用户提供的口令（三种形式任一）。

    **必须认 cookie**：浏览器地址栏导航（刷新、直接输网址、新标签打开）带不上
    自定义头，也不一定还挂着 ``?token=``。只认 header/query 的结果是
    「刷新一下就变成一段白页 JSON」—— 用户只会说"页面卡住了"，而且没有任何
    入口可以补救（401 是 JSON，页面上没有输入框）。前端过闸时会把口令写进
    ``studio_token`` cookie，之后所有文档请求就带着它。
    """
    auth = request.headers.get("authorization", "")
    low = auth.lower()
    if low.startswith("bearer "):
        return auth[7:].strip()
    if low.startswith("basic "):
        # Basic base64(user:pass) —— 用户名密码任一填口令都认，浏览器弹窗更宽容
        try:
            raw = base64.b64decode(auth[6:]).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            return ""
        user, _, pwd = raw.partition(":")
        return (pwd or user).strip()
    cookie = (request.cookies.get("studio_token") or "").strip()
    if cookie:
        return cookie
    return (request.query_params.get("token") or "").strip()


def _wants_html(request: "Request") -> bool:
    """这次 401 是「浏览器打开页面」还是「页面里的 fetch」？

    判据用 ``Accept``：导航请求一定含 ``text/html``，fetch/EventSource 不会。
    两者的补救办法不同 —— 导航要给一个能输口令的页面，fetch 要给 JSON 让
    前端弹浮层。
    """
    accept = request.headers.get("accept", "")
    return "text/html" in accept


#: 401 时直接返回的口令页（无依赖、无外链，隧道只放行这一个域名时也能用）
_AUTH_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要访问口令</title>
<style>
  :root { color-scheme: light }
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f6f7f9;color:#0f172a;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",
       "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
  .card{width:min(380px,calc(100vw - 32px));background:#fff;border:1px solid #e5e7eb;border-radius:14px;
        padding:22px;box-shadow:0 12px 32px -18px rgba(15,23,42,.28)}
  h1{margin:0 0 6px;font-size:16px;font-weight:600}
  p{margin:0 0 16px;color:#64748b;font-size:12.5px}
  label{display:block;font-size:12px;color:#64748b;margin-bottom:6px}
  input{width:100%;box-sizing:border-box;height:38px;padding:0 10px;font-size:16px;
        border:1px solid #d8dde6;border-radius:9px;outline:none}
  input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
  button{margin-top:12px;width:100%;height:38px;border:0;border-radius:9px;background:#2563eb;
         color:#fff;font-size:14px;font-weight:500;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  .err{margin-top:10px;font-size:12.5px;color:#dc2626;min-height:18px}
</style></head>
<body><div class="card">
  <h1>需要访问口令</h1>
  <p>这个平台对公网访问做了口令保护。输入一次即可，之后这台浏览器会记住。</p>
  <label for="t">访问口令</label>
  <input id="t" type="password" autocomplete="current-password" autofocus>
  <button id="go">进入</button>
  <div class="err" id="e"></div>
</div>
<script>
(function(){
  var inp=document.getElementById('t'),btn=document.getElementById('go'),err=document.getElementById('e');
  function go(){
    var v=(inp.value||'').trim();
    if(!v){err.textContent='请输入访问口令';return;}
    btn.disabled=true;
    // 前端浮层用的同一把钥匙（lib/api.ts 的 TOKEN_KEY），两边都能读到
    try{localStorage.setItem('studio_access_token',v);}catch(_){}
    document.cookie='studio_token='+encodeURIComponent(v)+'; path=/; max-age=2592000; samesite=lax'
      + (location.protocol==='https:'?'; secure':'');
    location.reload();
  }
  btn.addEventListener('click',go);
  inp.addEventListener('keydown',function(e){if(e.key==='Enter')go();});
})();
</script></body></html>"""


@app.middleware("http")
async def require_access_token(request: "Request", call_next):
    if not ACCESS_TOKEN:
        return await call_next(request)          # 未配置 = 不启用
    if request.method == "OPTIONS":
        return await call_next(request)          # 跨域预检必须放行，否则浏览器一律报 CORS
    if request.url.path in AUTH_EXEMPT or request.url.path.startswith(AUTH_EXEMPT_PREFIXES):
        return await call_next(request)

    peer = request.client.host if request.client else ""
    if peer not in TUNNEL_PEERS:
        return await call_next(request)          # 内网直连放行

    if secrets.compare_digest(_presented_token(request), ACCESS_TOKEN):
        return await call_next(request)

    logger.warning(
        "ACCESS 拒绝（口令无效） src=%s via=%s %s %s",
        request.headers.get("cf-connecting-ip") or peer,
        peer,
        request.method,
        request.url.path,
    )
    # 浏览器打开页面（导航请求）给一个能输口令的页面：JSON 401 落到地址栏里
    # 就是一段白页文本，用户既进不去也不知道该干什么 —— 现场反馈是"页面卡住了"。
    if _wants_html(request):
        return HTMLResponse(
            _AUTH_PAGE,
            status_code=401,
            headers={"Cache-Control": "no-store"},
        )
    return JSONResponse(
        status_code=401,
        content={"detail": "需要访问口令。请在页面上输入，或带上 Authorization: Bearer ***"},
        headers={"WWW-Authenticate": 'Basic realm="Agent Studio"'},
    )


# --------------------------------------------------------------------------- #
# 跨域
# --------------------------------------------------------------------------- #
# ⚠️ 注册位置很关键：Starlette 里**后注册的在外层**（add_middleware 插到链表头部，
#    构建时链表第一个是最外层）。所以这里的顺序决定了真实的嵌套：
#
#        访问日志（最外） → CORS → 访问口令 → 业务路由（最内）
#
#    为什么 CORS 必须在「访问口令」**外面**：
#    口令校验失败要返回 401，而 401 **必须带上跨域头**，否则浏览器只会报
#    "CORS policy" 而看不到 401 —— 前端就永远不知道该弹输口令的浮层，
#    排查时也会被"CORS 错误"带偏（这个坑刚踩过一次）。
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# 访问来源日志 —— 让「有没有外人来访问」变成可查的事
# --------------------------------------------------------------------------- #
# 为什么需要它：
#   平台经 Cloudflare 隧道对外时，后端看到的 peer **永远是网关**（192.168.2.7），
#   日志里分不出真实来源 —— 想监控就没抓手。Cloudflare 会把真实客户端 IP 放在
#   ``CF-Connecting-IP`` 头里，这里把它记下来。
#
# 为什么不每条都记：
#   uvicorn 自带访问日志已经记了每一条请求，再全量记一遍只是刷屏。
#   这里只记**真正需要看的**：经隧道进来的（= 来自公网）和命中敏感路径的。
#   想安静地盯，就 `journalctl -u agent-studio-api -f | grep ACCESS`。
#
# 注意：这个中间件**最后注册 = 最外层**，所以上面被 401 拒掉的请求也会被记下来。
SENSITIVE_SUFFIXES = ("/key",)


@app.middleware("http")
async def access_log(request: "Request", call_next):
    peer = request.client.host if request.client else "-"
    src = request.headers.get("cf-connecting-ip") or peer
    path = request.url.path
    via_tunnel = peer in TUNNEL_PEERS

    flags: list[str] = []
    if via_tunnel:
        flags.append("公网来源")
    if path.endswith(SENSITIVE_SUFFIXES):
        flags.append("读明文密钥")

    def emit(status: int | str, extra: str = "") -> None:
        # 只记「公网来源」或「敏感路径」，避免和 uvicorn 日志重复刷屏
        if not (via_tunnel or flags):
            return
        logger.info(
            "ACCESS src=%s via=%s %s %s -> %s%s%s",
            src,
            peer,
            request.method,
            path,
            status,
            ("  [" + " ".join(flags) + "]") if flags else "",
            extra,
        )

    # HEAD 兜底：浏览器预取器 / 健康探测 / iOS Safari 都会发 HEAD。
    # FastAPI 只对显式注册了 HEAD 的路由回 200，其余一律 405 —— 这些 405 没有
    # 业务影响但会打满日志，还会让部分探测方误判「服务不可用」。这里把 HEAD
    # 统一当 GET 处理再由 Starlette 剥掉响应体（RFC 9110：HEAD = 无 body 的 GET）。
    if request.method == "HEAD":
        request.scope["method"] = "GET"
        request.scope["_was_head"] = True

    try:
        response = await call_next(request)
    except Exception as exc:  # noqa: BLE001
        emit("500", f"  {type(exc).__name__}: {exc}")
        raise
    # 响应回程把 method 改回 HEAD：Starlette 的 Response 靠 scope['method'] 决定
    # 是否渲染 body（HEAD 应无 body）。只改进不改回会让 curl -I 看着正常、
    # 但裸连接的 HEAD 带上一段 JSON body —— 探测方可能挂起等 body。
    if request.scope.pop("_was_head", False) and request.scope.get("method") == "GET":
        request.scope["method"] = "HEAD"
    emit(response.status_code)
    return response


app.include_router(api_router)
# 后台进程（会话级：列表 / 日志 / 停止）—— 起进程只能由助手在会话里做
from .api import procs as procs_api  # noqa: E402

app.include_router(procs_api.router)
# 跨会话检索（标题 + 对话内容）—— 与助手的 session_search 工具同一实现
from .api import search as search_api  # noqa: E402

app.include_router(search_api.router)
# 会话定时任务 + 结果投递（定时跑到点上，结果回到对话里 / 推到 webhook）
from .api import jobs as jobs_api  # noqa: E402

app.include_router(jobs_api.router)
# A2A（Agent2Agent）协议入口 —— 根路径 /a2a + /.well-known/agent-card.json
app.include_router(a2a.router)
# 平台级小配置（白名单键）—— 目前是对话页的快捷标签
from .api import app_settings as app_settings_api  # noqa: E402

app.include_router(app_settings_api.router)


@app.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "version": __version__,
        "db": str(settings.db_path),
        "runtimes": [rt.name for rt in list_runtimes()],
        "build": _build_stamp(),
    }


def _build_stamp() -> int:
    """前端产物的构建戳（index.html 的 mtime，秒级）。

    浏览器那边用它判断「我手里这份页面是不是过期的」：chunk 文件名是稳定的
    （不含内容哈希），所以一直开着的标签页不会自己更新 —— 用户看到的还是
    老代码，改了等于没改。有了这个戳，页面能主动提示刷新。
    """
    idx = _WEB_DIST / "index.html"
    try:
        return int(idx.stat().st_mtime) if idx.is_file() else 0
    except OSError:
        return 0


@app.get("/api/version")
async def version() -> dict:
    return {"build": _build_stamp(), "version": __version__}


# --------------------------------------------------------------------------- #
# 前端静态托管 —— 部署机不依赖 Node.js
# --------------------------------------------------------------------------- #
# 为什么后端来托管前端：
#   前端是 Next.js **静态导出**（output:"export"，构建期跑在开发机，产物 out/ 是
#   纯 HTML/JS/CSS）。部署机上没有任何 Node 进程 —— 一个 uvicorn 进程同时把
#   API 和页面都端出去，单端口、单服务、单份配置。
#
# 为什么不用 StaticFiles(html=True) 一步到位：
#   SPA 有**客户端路由**（/agents/detail?id=…、/runs/… 这类没有对应物理文件的
#   路径），StaticFiles 只会 404。所以这里手动分发：物理文件存在就给文件，
#   不存在就回 index.html，交给前端路由接管。
#
# 顺序为什么安全：这条 catch-all **最后定义**，FastAPI 按注册顺序匹配，
#   /api/*、/a2a、/.well-known/* 这些真路由都在它前面命中，轮不到兜底。
_WEB_DIST = Path(
    os.getenv("STUDIO_WEB_DIST", Path(__file__).resolve().parents[2] / "web" / "out")
)

#: 静态资源后缀 —— 命中这些却找不到物理文件时**必须如实 404**，
#: 不能回 index.html：把断链伪装成 200 的 HTML，浏览器报的是另一句
#: 「Unexpected token '<'」，排障时完全看不出是哪个 chunk 丢了。
_STATIC_SUFFIXES = {
    ".js", ".css", ".map", ".json", ".txt", ".xml", ".webmanifest",
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".avif",
    ".woff", ".woff2", ".ttf", ".otf", ".eot", ".wasm",
}

if _WEB_DIST.is_dir():

    #: 静态产物一律走协商缓存。Next 导出的 chunk 文件名是稳定的（不含内容哈希），
    #: 浏览器一旦按启发式缓存住，前端改完用户那边还是旧界面 —— 每次都必须验 ETag。
    _NO_CACHE = {"Cache-Control": "no-cache, must-revalidate"}

    def _serve(path: Path) -> FileResponse:
        return FileResponse(path, headers=_NO_CACHE)

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_web(full_path: str) -> "Response":
        # API 前缀不进 SPA 兜底：路由没命中（404/405）就该如实报错。
        # 否则 /api/xxx 打错字会拿到 200 的 index.html，前端只看到
        # 「Unexpected token '<'」，排障无从下手。
        if full_path == "api" or full_path.startswith("api/"):
            raise StarletteHTTPException(status_code=404)
        # 目录形式（/agents → agents.html）：Next 导出的根级 .html 就这么取
        candidate = _WEB_DIST / f"{full_path}.html" if full_path else _WEB_DIST / "index.html"
        target = _WEB_DIST / full_path
        if full_path and target.is_file():
            return _serve(target)
        if candidate.is_file():
            return _serve(candidate)
        # 静态资源缺文件 = 断链，如实 404（回 index.html 会把 JS 报成 HTML，
        # 浏览器只会甩出「Unexpected token '<'」，谁也看不出 chunk 丢了）。
        if full_path and Path(full_path).suffix.lower() in _STATIC_SUFFIXES:
            raise StarletteHTTPException(status_code=404)
        # SPA 兜底：客户端路由没有物理文件，回 index.html 交给前端路由
        return _serve(_WEB_DIST / "index.html")

    logger.info("静态前端已托管 src=%s", _WEB_DIST)
else:
    logger.warning("未找到前端构建产物 src=%s（仅 API 可用）", _WEB_DIST)