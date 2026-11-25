"""开局就把"能干活的两个角色"备好 —— 幂等、不覆盖用户改过的东西。

为什么要有它（用户原话）
----------------------
「一个任务分几路跑，应该由一个编排 agent 开始，所以在应用最开始应该默认初始化一个
  编排 agent 和通用 agent（干活的 agent）」

翻译成平台行为：新装的平台不该是空的、逼用户先想清楚"助手该怎么配"，而应该**打开就有
两个能用的助手**：
  · **编排者**（role=orchestrator）：分析任务 → 拆分 → 派下去 → 收齐结果做验证与总结。
    它同时挂着**分派**工具 —— 没有它，"一个任务分几路跑"这件事就没有起点。
  · **通用助手**（role=worker）：真正干活的那一个。被编排者分派出去的就是它（可多路并行）。

设计原则
--------
* **幂等**：按名字找，已存在就一个字都不动（用户可能改过提示词/模型/工具）。
* **只补缺**：缺哪个补哪个；另外只多做一件事 —— 编排者没挂「分派」工具就挂上，
  否则"由一个编排 agent 开始分几路"落不了地。
* **一建就能跑**：模型/凭据优先沿用平台里已有助手的配置（同一个 provider + 凭据引用）；
  平台里一个助手都没有（全新库）才留空，让用户去「LLM 配置」里选一次。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select

from .models import Agent, AgentSkill, AgentTool, Skill, Tool, now_ms

logger = logging.getLogger(__name__)

#: 默认助手的名字 —— 用户能在 Agents 页改名，改名后这里不再干扰（按名字判存在）
ORCHESTRATOR_NAME = "编排者"
WORKER_NAME = "通用助手"

#: 内置示范 Skill（新平台不该是空的 —— 打开就有两个能用的"做法"可参考可改）。
#: Skill 是**程序性记忆**：某种任务类型的步骤+坑。清单常驻提示、正文按需加载，
#: 所以写得具体一点不吃上下文。
BUILTIN_SKILLS: dict[str, str] = {
    # 浏览器驱动 + CDP：驱动版本从平台快照读，别去翻机器上的其它 Chromium。
    "browser-cdp": """---
name: browser-cdp
description: 用平台配好的 Chrome/Chromium 通过 CDP 自己控制浏览器——需要脚本化、批量、精确控制生命周期时用；驱动路径与版本一律从平台快照读，不要猜。
---

# 用平台配好的 Chrome（CDP）

## 1. 先取当前驱动

System Prompt 的「运行环境事实」里有快照绝对路径（形如 `.../work/runtime/browser-env.sh`）。先加载它：

```bash
. <快照路径>          # bash/sh 通用；bash 里等价的 source 在 dash 下不存在
echo "$STUDIO_BROWSER_VERSION"
echo "$STUDIO_BROWSER_LABEL $STUDIO_BROWSER_VERSION（$STUDIO_BROWSER_PROTO）"
echo "$STUDIO_BROWSER_BIN"
```

可用变量：`STUDIO_BROWSER_BIN`（可执行文件）、`STUDIO_BROWSER_VERSION`、`STUDIO_BROWSER_LABEL`、`STUDIO_BROWSER_PROTO`、`STUDIO_BROWSER_PATH`、`STUDIO_BROWSER_STALE`。

被问"用的什么浏览器/版本"时，只答这里的值。**不要** `ls` 浏览器目录或读 Playwright 缓存去推断——机器上通常还躺着系统 Chromium 和 Playwright 自带的 chromium-*，版本各不相同。

## 2. 先判断要不要自己起

- **能用平台 browser 工具就用它**：进程已托管、画面可直播、会话结束自动回收。
- 只有这几种才自己起：要写脚本跑批量、要精确控制生命周期、或要用 browser 工具没暴露的 CDP 能力。

## 3. 最小可用流程

```bash
bash -c '. <快照路径>; exec "$STUDIO_BROWSER_BIN" --headless=new --no-sandbox \\
  --disable-dev-shm-usage --remote-debugging-port=0 \\
  --user-data-dir="$(mktemp -d /tmp/cdp-XXXXXX)" about:blank'
# 下面这种写法也可以（确定是 bash 时）：
PROF=$(mktemp -d /tmp/cdp-XXXXXX)
"$STUDIO_BROWSER_BIN" --headless=new --no-sandbox --disable-dev-shm-usage \
  --remote-debugging-port=0 --user-data-dir="$PROF" about:blank 2>/tmp/cdp.err &
for i in $(seq 1 50); do grep -q 'DevTools listening' /tmp/cdp.err && break; sleep 0.2; done
PORT=$(grep -o 'DevTools listening on ws://127.0.0.1:[0-9]*' /tmp/cdp.err | grep -o '[0-9]*$')

curl -s "http://127.0.0.1:$PORT/json/version"                 # 版本以这里的 Browser 字段为准
curl -s -X PUT "http://127.0.0.1:$PORT/json/new?about:blank"  # 开新页拿 webSocketDebuggerUrl
```

收尾：`kill %1; rm -rf "$PROF"`。

## 4. 坑（都是踩过的）

- **root 运行必须 `--no-sandbox`**，否则进程起来立刻退出，只有 stderr 一行报错。
- **不要用 `/usr/bin/chromium` 或 `/root/.cache/ms-playwright/chromium-*`**：那是另一份，版本和平台在跑的不一样；按它们报版本会答错。
- **别把 `--user-data-dir` 指到 `/tmp/agent-studio-browser/shared-profile`**：那是平台常驻进程的 profile，第二个进程会因 SingletonLock 直接失败。
- **chrome-for-testing 的 UA 是 `HeadlessChrome/<ver>`**，`navigator.userAgentData.brands` 第一项是 `Chromium`：检测类网站会显示 "Chromium x.y"，这不代表版本不对。
- `--remote-debugging-port=0` 让系统分配端口，真实端口只能从 stderr 的 `DevTools listening on ws://...` 抓，别写死 9222（多开会撞）。
- 平台 Bash 工具的默认 shell 是 **sh（dash）**：`source` 会报 not found，用 `. <文件>` 或 `bash -c '...'`。
- 起进程要留 PID：`"$STUDIO_BROWSER_BIN" ... & PID=$!`，结束时 `kill "$PID"`，别用 `kill %1`（跨 shell 会话可能没有作业表）。
""",

    # ── DeepSeek 工具产品：一个能力一个技能 ──────────────────────────────
    # 为什么不合成一个大技能：模型是按"技能描述"决定要不要展开全文的。
    # 五件事塞进一份说明书，描述只能写得很泛，模型遇到"这个 PDF 里写了什么"
    # 时不会想到它；拆开后每条描述都能直指场景，命中率高得多，加载也更省上下文。
    # 搜索与抓取合成一个：DeepSeek 官方也把两者写在同一份指南里
    # （Search 找线索、Fetch 读全文，是一条链上的两步，不是两个产品）。
    "deepseek-web": """---
name: deepseek-web
description: 网页搜索与抓取：先 search 找线索，再 fetch 读全文；结果带相关度与权威度
---

# 网页搜索与抓取（DeepSeek Search / Fetch）

一条链上的两步：**search 找线索，fetch 读全文**。先搜再抓，不要跳过搜索硬猜网址。

## search

用在：需要当前信息（版本号、价格、最近发布、条款）、要交叉验证、知道主题但不知道网址。

`web_search(query="...")`，query 里可以带语法：

| 写法 | 作用 |
|---|---|
| `site:github.com` | 只在这个站 |
| `-site:csdn.net` | 排除这个站 |
| `"精确短语"` | 精确匹配 |
| `lang:zh` / `lang:zh,en` | 限定语言 |
| `after:2025` / `before:2026-06` | 限定时间 |

每条结果后面带 `（相关 2.3 · 权威 4 · 2025-12-07）`：相关 ≥1.5 才算优质，权威 ≥3 才能直接引用；
权威 0–1（论坛、聚合站）只能当线索。结论里要给出处。

结果为空或跑题：**换更具体的词**（加型号、年份、site:），别原样重试；连续两次不相关就停下来，
改用已知域名 fetch，或如实说"没查到"。

## fetch

用在：搜索只给了摘要、需要全文（安装步骤、API 参数、条款原文），或已知官方文档地址。

`fetch(url="https://...")` → `# 标题` + Markdown 正文。

注意：只抓 http/https（**内网地址会被拒**，这是平台边界）；长页会截断（约 200KB），要细节就抓更具体的子页；
同一个 URL 失败两次就放弃；抓的是静态正文，SPA 可能只有骨架。

## 节奏

1. `web_search("关键词 site:官方域名")`，挑权威 ≥3 的；
2. `fetch(那条 url)`，摘与问题直接相关的段落；
3. 结论 + 出处；需要对照就换个措辞再搜一次。

## 成本

search / fetch 都按次计费。3–5 次搜索 + 1–3 次抓取是正常节奏，更多就是在瞎试。
""",
    "deepseek-ocr": """---
name: deepseek-ocr
description: 读取 PDF / 图片 / Word / PPT 里的文字（按页返回）；扫描件、合同、规格书、截图
---

# 文档识别（DeepSeek OCR）

## 什么时候用

- 用户上传了 PDF、扫描件、合同、发票、规格书、产品图、截图。
- 需要从图片里取文字（表格、编号、印章旁的字段）。

## 用法

`read_document(path="xxx.pdf")`

- `path` 是**会话工作目录里的相对路径**（先用会话文件列表确认真实文件名）。
- 默认 `purpose="text"`：只要文字。
- 需要定位（标题在哪、表格区域、裁图坐标）时用 `purpose="rich"`：
  文本里会带 `<｜ref｜>…<｜box｜>[[x1,y1,x2,y2]]`，坐标是 0–1000 归一化。

## 限制

- 单文件 ≤100MiB、≤1000 页；超了会明确报错，不要重试。
- 页数多时，正文只放前面一段（约 6000 字），**完整文本落在 `.studio/results/ocr-*.md`**，
  需要细节再用读文件工具按页取。

## 硬要求

1. 型号、数量、单价、日期、批号这类字段，**必须回原文逐字核对**，不能"看着像"。
2. 不要把整份 OCR 结果贴回给用户；先给结论，再给关键原文片段。
3. `finish_reason=length` 的页表示该页被截断，引用时要说明。

## 成本

按页计费（¥1.5 / 1000 页）。1000 页的文档先问用户"要不要全读"，别直接开跑。
""",
    "deepseek-asr": """---
name: deepseek-asr
description: 把上传的音频转成文字（≤120 秒、≤8MiB）；会议录音、语音留言
---

# 语音识别（DeepSeek ASR）

## 什么时候用

- 用户上传了会议录音、语音留言、采访片段。
- 需要把口述内容变成可检索、可总结的文字。

## 用法

`transcribe(path="meeting.wav")`

- 只吃 **16bit PCM WAV 或 Ogg Opus**，单声道/双声道均可（双声道只认左声道）。
- ≤120 秒、≤8MiB；超出会直接告诉你，不要重试。

## 流程

1. 先转写，拿到全文。
2. 再做总结/待办/问答 —— 不要一边转写一边猜内容。
3. 转写可能有错字：人名、编号、专业术语标注"按转写原文"，拿不准就回问用户。

## 长音频

超过 120 秒的录音，请让用户**分段上传**（每段 ≤2 分钟），你按段转写后合并。
不要假装能处理长音频，也不要自己切文件（切坏了更麻烦）。

## 成本

按音频秒数计费（¥0.78/小时）。
""",
    "deepseek-tts": """---
name: deepseek-tts
description: 文本合成语音（备选能力）；文件落到 product/ 供下载或播放
---

# 语音合成（DeepSeek TTS）

## 什么时候用

- 用户明确要求"读出来 / 做成音频 / 生成播报"。
- 交付物本身需要音频（培训稿、语音提示、无障碍版本）。

**不要在没被要求时主动合成** —— 它会产生费用，而且大多数场景用户只想看文字。

## 用法

`speak(text="...", voice="stella")`

- 音色：`stella`（女声，默认）/ `tide`（男声）。
- 格式：`wav`（默认，可直接播放）/ `pcm`（24kHz 原始数据）。
- 单次 ≤10000 计费字符（汉字算 2 字符），约 5000 汉字；超长先分段。
- 产物落在 `product/speech-*.wav`，用户可在右栏「产物」里播放或下载。

## 写法建议

- 先按标点断句，去掉 Markdown 标记（表格、代码块念出来没有意义）。
- 数字、单位、英文缩写按口语写（"12 台" 而不是 "Qty: 12"）。

## 成本

¥3 / 万字（汉字 2 字符）。800 字中文 ≈ ¥0.48，合成前心里有数。

## 失败

内容审核不通过（`Content Exists Risk`）会直接报错 —— 换措辞，不要反复重试同一段。
""",
    "web-research": """---
name: web-research
description: 查资料并写成简报的步骤：先搜再抓、来源优先、结论在前
---

# 网络调研简报

适用：用户要你查某个主题/产品/事件并给结论。

1. 先 web_search 拿全景（2-3 个不同角度的关键词各搜一次，别只搜一遍）。
2. 挑**来源可靠**的前 2-4 条用 fetch 抓原文 —— 官方文档/一手数据 > 媒体转述。
3. 结论在前：先给答案（一段话），再列依据（每条附来源链接）。
4. 有数字要交叉核对：两个来源说法不一致时如实指出，别只挑顺眼的。

坑：
- fetch 被拒（403/内容类型）就换下一条结果，别死磕同一个 URL；同一 URL 失败 2 次就永远放弃。
- 搜索工具报「不可达」就停手：别用 curl 手搓搜索引擎（反爬会把你拖进无限验证码），改走已知域名直接 fetch，或基于已有知识作答并标注未核实；被派活时 worker_report(blocked) 上报。
- 连续 5 次调用都没带来新信息 = 已经陷进去了，立刻止损：上报卡点或用现有材料交差。
- 搜索结果是摘要不是原文 —— 引用具体数据前必须 fetch 原文确认。
""",
    "data-analysis": """---
name: data-analysis
description: 用 python 工具处理数据：先小样本验证、打印中间结果、结论带数字
---

# 数据处理与分析

适用：算数、统计、清洗数据、批量转换 —— 只要涉及具体数字就别心算。

1. 数据先落盘（write 写进工作目录），代码从文件读 —— 中间结果可复查。
2. 第一版只跑**前 5 行**（head），确认格式没理解错再跑全量。
3. 每一步 print 中间结果（行数、列名、合计）—— 错误在早期暴露，不在最后。
4. 结论必须带具体数字和口径（"共 1,204 行，其中 37 行日期缺失"），
   不要写"大部分/很多"。

坑：
- 超时默认 30s：数据大就分批处理，每批打印进度。
- 中文文件用 encoding="utf-8" 显式指定，别依赖系统默认。
- 复杂逻辑先写 3 行最小验证（比如排序对不对），再套到全量上。
""",
}

ORCHESTRATOR_PROMPT = """你是这个工作台的 **项目 RDO**：需求从拆解到验收，你负责；但活不是你干的。

你和 worker 是 **1 对 N**：一个需求常常跨业务域，你把它拆成几块，按域派给对应的人，
他们各自在自己的会话里干，干完回来向你汇报。

你的四步：
1. **拆**：这个需求分几块、每块属于哪个域（行情价格 / 检索调研 / 文档写作 / 代码 / 数据计算 / 验收核验…）。
2. **派**：用 `dispatch` 按域派活。互不依赖的几块**同时派**（派完立刻回来，不等）；
   有先后依赖的，等前一块的结果回来再派下一块。
   派之前先 `workers` 看一眼：谁是什么域、**手上有没有活**、是本地还是远端 A2A。
   - 他手上那件还开着、他人也闲着 → **复用他那个 worker 会话**（mode=auto 默认就会复用，上下文连续）。
   - 要另起一件独立的事 → `mode=new`（新票、新会话，上下文不共享）。
   - 他手上还有活 → 先别派第二件；要么等，要么换个人。
3. **巡**（派完不撒手）：派出去了不等于没事了。用 `worker_status` 巡进度 ——
   看它跑了多久、最近在调什么工具、有没有失败。发现绕路/卡住/失败：
   用 `worker_steer` 插话纠偏（说清改成什么）；方向彻底错了用 `worker_stop` 停掉重派。
   长任务（>1 分钟）至少巡一次；出错的任务必须巡到弄清原因。
4. **收口**：worker 跑完会**自己回来汇报**（这一批结果会推到你这儿）。判断够不够、对不对：
   缺什么补派、不对就重派，都合格就给结论。结论在前，依据在后。

对用户说话的三条硬规矩：
- 第一句先说清你做了什么编排：派了几件、派给谁、每件是什么。用户要能看懂
  「这件事被拆成哪几块、谁在做」。例：「派了 2 件：A 查行情、B 查政策；结论是……」
- 你自己**没有**搜索、读文件、跑命令的工具 —— 想查什么、想改什么，就派出去，别假装自己看过。
- worker 只向你汇报，不直接对用户说话；对用户说的每句话都由你来说。

其它：
- 一件活要写清「要它做什么、产出什么」。含糊的委派等于没派。
- 不值得做的事就一句话说明理由，别为了显得勤快而开工。
- 不要复述 worker 的整段产出，你是做判断和收口的那个。"""

WORKER_PROMPT = """你负责把交给你的**这一件事**做扎实、做完。

- 只处理交给你的内容，不要替别的项做决定、也不要替上游做总结（结果由编排者汇总）。
- **先判断能不能直接做完**：能就直接给结论、直接把产物做出来。
  不要为了"稳妥"去翻代码库、到处搜一遍 —— 分派给你的是**一项活**，
  无关的探索只是白花钱（实测：一句话的活翻出 18 轮工具调用，答案还跑偏了）。
- 只有**这一项本身需要动手**时才用工具：读写指定的文件、跑给定的命令、
  或需要查证你不可能知道的外部事实。
- 需要产出文件时**直接写到工作目录里**（文件名按分派要求），别只写在回复里。
- 产出要**可直接被下游使用**：结论在前，依据在后，不要写客套话。
"""

#: 编排者默认挂的工具（分派是核心，其余是"干活前先看一眼"的只读工具）
#: 编排者默认工具：只到「派活 + 认路」。dispatch 是入口（开票 + 独立 worker 会话），
#: read/fetch 之类刻意不再给 —— 给了它就会自己干（实测：给了 web_search 就再没派过活）
ORCHESTRATOR_TOOLS = ("dispatch", "workers")
#: 通用助手默认挂的工具（干活的那套）。
#: **刻意不含 bash**：平台的权限引擎对"跑命令"一律要求人工点头（`accept_edits` 只自动放行
#: **工作目录内**的读写），默认挂上它 = 无人值守的第一步就卡在等确认。
#: 需要跑命令时自己在 Agents 页加上 —— 那时按平台规矩确认即可。
#: fetch/web_search/python 是平台原生内核工具（见 native_tools.py）：
#: 查资料、算数据是"通用"助手的底座能力。
#: proc_* 是后台进程（跑得住比一轮对话更久的活）——"能跑长任务"是通用助手的底座，
#: 所以默认给上：模型看到 proc_start 的描述就知道长活该往后台放。
WORKER_TOOLS = (
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "fetch",
    "web_search",
    "python",
    "session_search",
    "proc_start",
    "proc_poll",
    "proc_log",
    "proc_kill",
    "proc_list",
    # 把对话里摸出来的做法沉淀成全局技能
    "skill_save",
)


async def ensure_default_agents(session: Any) -> dict[str, Any]:
    """确保「编排者」「通用助手」存在。返回 {created: [...], attached_fork: bool}。"""
    existing = {
        a.name: a for a in (await session.execute(select(Agent))).scalars()
    }
    tools = {t.name: t.id for t in (await session.execute(select(Tool))).scalars()}

    # ① 模型模板：沿用平台里**已有助手**的配置（同一个 provider + 凭据引用 → 一建就能跑）
    template_model: dict[str, Any] | None = None
    for a in (await session.execute(select(Agent).order_by(Agent.created_at.asc()))).scalars():
        m = (a.definition or {}).get("model") or {}
        if m.get("provider") and m.get("credential_ref"):
            template_model = {
                k: m[k] for k in ("provider", "name", "credential_ref", "base_url") if m.get(k)
            }
            break

    created: list[str] = []
    specs = [
        (
            ORCHESTRATOR_NAME,
            "orchestrator",
            ORCHESTRATOR_PROMPT,
            ORCHESTRATOR_TOOLS,
        ),
        (WORKER_NAME, "worker", WORKER_PROMPT, WORKER_TOOLS),
    ]
    for name, role, prompt, tool_names in specs:
        if name in existing:
            continue
        refs = [
            {"ref": tools[n], "name": n, "enabled": True}
            for n in tool_names
            if n in tools  # 工具没同步进来就跳过（不因为缺一个工具就不建助手）
        ]
        definition: dict[str, Any] = {
            "runtime": "agentscope",
            "name": name,
            "role": role,
            "system_prompt": prompt,
            "model": template_model or {"provider": "volcengine", "name": "deepseek-v4-flash"},
            "tools": refs,
            "skills": [],
            "limits": {"max_iters": 12, "timeout_s": 300},
        }
        from .api.agents import slugify

        row = Agent(
            slug=slugify(name) or f"default-{role}",
            name=name,
            version=1,
            definition=definition,
            created_at=now_ms(),
            updated_at=now_ms(),
        )
        session.add(row)
        await session.flush()
        for ref in refs:
            session.add(AgentTool(agent_id=row.id, tool_id=ref["ref"]))
        created.append(name)
        existing[name] = row
        logger.info("默认助手已建：%s（%s）", name, role)

    # ② 编排者必须能"派" —— 没有分派工具就补上（只补这一个，不动别的）
    attached_fork = False
    orch = existing.get(ORCHESTRATOR_NAME)
    fork_id = tools.get("fork")
    if orch is not None and fork_id:
        has = (
            await session.execute(
                select(AgentTool).where(
                    AgentTool.agent_id == orch.id, AgentTool.tool_id == fork_id
                )
            )
        ).scalar_one_or_none()
        if has is None:
            session.add(AgentTool(agent_id=orch.id, tool_id=fork_id))
            attached_fork = True
            logger.info("已给「%s」挂上分派工具（一个任务分几路跑要有起点）", ORCHESTRATOR_NAME)

    # ③ 已存在的默认助手**补挂缺失的内核工具**（fetch/web_search/python）。
    #    与 fork 同一逻辑：只补缺、不摘用户自己加/减的其它工具。
    #    升级前建的「通用助手」不知道这三个工具 → 没有它们，查资料/算数据是瘸的。
    from .native_tools import NATIVE_TOOLS as _NATIVE

    attached_native = 0
    for agent_name, want in (
        (ORCHESTRATOR_NAME, ORCHESTRATOR_TOOLS),
        (WORKER_NAME, WORKER_TOOLS),
    ):
        row_ = existing.get(agent_name)
        if row_ is None:
            continue
        have_ids = set(
            r[0]
            for r in (
                await session.execute(select(AgentTool.tool_id).where(AgentTool.agent_id == row_.id))
            )
        )
        for n in _NATIVE:
            if n not in want:
                continue
            tid = tools.get(n)
            if not tid:
                continue
            # definition 里没有引用就补（即使 AgentTool 行已在——两处可能脱节，见深拷贝修复前的实测）。
            # 老数据的 tools 项可能只有 ref 没有 name —— 双键判断，避免重复挂。
            d = None
            def_tools = (row_.definition or {}).get("tools") or []
            in_def = any(t.get("name") == n or t.get("ref") == tid for t in def_tools)
            if not in_def:
                import copy as _copy

                d = _copy.deepcopy(row_.definition or {})
                d.setdefault("tools", [])
                d["tools"].append({"ref": tid, "name": n, "enabled": True})
                row_.definition = d
            # AgentTool 行也补（前端保存/权限判断两处读）
            if tid not in have_ids:
                session.add(AgentTool(agent_id=row_.id, tool_id=tid))
                have_ids.add(tid)
                attached_native += 1
                logger.info("已给「%s」补挂内核工具 %s（升级前建的，缺这个）", agent_name, n)
            elif d is not None:
                row_.updated_at = now_ms()
                logger.info("已给「%s」的 definition 补上内核工具引用 %s", agent_name, n)
    await session.commit()
    return {
        "created": created,
        "attached_fork": attached_fork,
        "attached_native": attached_native,
    }


async def ensure_default_skills(session: Any) -> list[str]:
    """内置示范 Skill 幂等入库 + 落盘（materialize 到 work_dir/skills 让 loader 读到）。

    幂等规则与 ensure_default_agents 一致：按 name 找，已存在**不动**
    （用户可能改过正文）—— 但落盘总是重做（库里改了正文要同步到运行时目录）。
    """
    from .api.skills import parse_skill_md

    created: list[str] = []
    for name, content in BUILTIN_SKILLS.items():
        row = (await session.execute(select(Skill).where(Skill.name == name))).scalar_one_or_none()
        if row is None:
            parsed_name, description = parse_skill_md(content, name)
            row = Skill(
                name=parsed_name or name,
                description=description,
                source={"type": "builtin"},
                content=content,
                files={},
            )
            session.add(row)
            created.append(name)
    # 拆过家的内置技能：名字从 BUILTIN_SKILLS 里消失了就归档，别留着误导用户。
    # （工业文档那份拆成了 search/fetch/ocr/asr/tts 五个，正文内容已被新技能覆盖）
    from sqlalchemy import select as _select

    from .models import Skill as _Skill

    retired = {"industrial-docs", "deepseek-search", "deepseek-fetch"}
    live = set(BUILTIN_SKILLS)
    rows = (await session.execute(_select(_Skill))).scalars().all()
    for row in rows:
        if row.name in retired and row.name not in live:
            if (row.state or "active") != "archived":
                row.state = "archived"
                row.archived_at = __import__("time").time_ns() // 1_000_000
            # 磁盘也要收走：运行时 loader 只看目录，留着等于"归档了但还在用"
            try:
                from .config import settings as _s

                d = _s.work_dir / "skills" / "system" / (getattr(row, "dir_name", "") or row.name)
                if d.is_dir():
                    dest = _s.work_dir / "skills" / ".retired"
                    dest.mkdir(parents=True, exist_ok=True)
                    d.rename(dest / f"{d.name}-{int(__import__('time').time())}")
            except OSError:
                pass
    await session.commit()

    # 落盘（含已有行 —— 正文的权威在库里，磁盘只是运行时视图）
    from .config import settings as _settings

    for name, content in BUILTIN_SKILLS.items():
        # 内置技能属于 system 命名空间（三来源隔离）
        target = _settings.work_dir / "skills" / "system" / name
        target.mkdir(parents=True, exist_ok=True)
        (target / "SKILL.md").write_text(content, encoding="utf-8")
    return created
