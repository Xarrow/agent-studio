/**
 * UI 结构护栏测试 —— node --test，零依赖
 * ============================================
 *
 * 守的是**这一轮重做里真出过的两类问题**，靠自觉会再犯：
 *
 * ① `[data-tap]{display:inline-flex}`（触屏可点区，≤1023px）与常见的
 *    `hidden lg:flex`（窄屏藏、宽屏显示）同权重且更靠后 → 盖掉 `.hidden`，
 *    于是「只在宽屏出现」的控件在手机上照样占位。实测：对话页右栏把手在
 *    390px 视口硬占 44px，把对话区从 390 挤到 346。
 *
 * ② 空间分配退化：本该「空状态占位归零」的区域又变回常驻（右栏 420px /
 *    手机会话列表在流内吃 40% 屏高），以及配置页又长出对话页的第二道门
 *    （内嵌会话列表 + 三视图）。
 *
 * 这些都是**源码里可判定的结构不变量**，不需要跑浏览器就能守。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(WEB, p), "utf8");

/** 去掉 CSS 注释 —— 注释里也会出现 `[data-tap]` 这类字样，不剥掉会误报 */
const stripCssComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 取出所有**会设 display** 的 `[data-tap...]{...}` 规则（含媒体查询里的）。
 * 只看设 display 的：`[data-tap]{min-height:44px}` 这类只放大点按区，
 * 不会盖掉 .hidden，不该被判为违规（判宽了会误报）。
 */
function dataTapDisplayRules(css: string): string[] {
  const rules: string[] = [];
  for (const m of css.matchAll(/\[data-tap(?![-\w])[^\]]*\][^{]*\{([^}]*)\}/g)) {
    if (/display\s*:/.test(m[1])) rules.push(m[0].replace(/\s+/g, " ").slice(0, 100));
  }
  return rules;
}

test("触屏 data-tap 规则不得盖掉 .hidden（窄屏藏/宽屏显的控件）", () => {
  const css = stripCssComments(read("app/globals.css"));
  const rules = dataTapDisplayRules(css);
  assert.ok(rules.length > 0, "应当仍然存在设 display 的 data-tap 触屏规则（否则本测试失去意义）");
  const evil = rules.filter((r) => !r.includes(":not(.hidden)"));
  assert.deepEqual(
    evil,
    [],
    `这些 data-tap 规则设了 display 却没有 :not(.hidden)，会在 ≤1023px 把 .hidden 盖掉：\n${evil.join("\n")}`,
  );
});

test("所有 data-tap 规则都带 :not(.hidden)（特异性不一致就会被压掉）", () => {
  const css = stripCssComments(read("app/globals.css"));
  // 只看选择器本身：`[data-tap...]` 后面跟任意非 `{` 字符再 `{`
  const sels = [...css.matchAll(/\[data-tap(?![-\\w])[^\]]*\][^{,]*\{/g)].map((m) => m[0].replace(/\s+/g, " "));
  // ≥1 条即可（手机与桌面现在共用 36px 一套，不再有 ≤767 的那条覆盖）
  assert.ok(sels.length >= 1, "应当仍存在 data-tap 的触屏规则（否则本测试失去意义）");
  const missing = sels.filter((s) => !s.includes(":not(.hidden)"));
  assert.deepEqual(
    missing,
    [],
    `这些 data-tap 规则缺 :not(.hidden) —— 特异性和另一条不一致，会被压掉：\n${missing.join("\n")}`,
  );
});

test("对话页：会话栏窄屏不得在流内（必须 hidden + 抽屉）", () => {
  const src = read("components/ChatConsole.tsx");
  // 桌面会话栏：in-flow aside 必须带 hidden lg:flex
  assert.match(
    src,
    /<aside className="hidden lg:flex w-\[\d+px\][^"]*"/,
    "会话栏 <aside> 应当是 `hidden lg:flex`（窄屏不出现在流内）",
  );
  // 窄屏必须有覆盖式抽屉
  assert.match(src, /fixed inset-0 z-40/, "缺手机会话抽屉（覆盖式，不能占对话高度）");
  // 抽屉默认关闭
  assert.match(src, /const \[mobileNav, setMobileNav\] = useState\(false\)/, "手机会话抽屉默认应当是关的");
});

test("对话页：Chrome 直播栏默认收起，只在有画面时自动展开", () => {
  const src = read("components/ChatConsole.tsx");
  assert.match(src, /const \[railOpen, setRailOpen\] = useState\(false\)/, "直播栏默认应当收起");
  assert.match(
    src,
    /if \(browserFrame && !railTouched\.current\) setRailOpen\(true\)/,
    "缺「有直播画面时自动展开」的效果（否则画面来了要手动点）",
  );
  // 收起态的把手必须只在宽屏出现
  assert.match(
    src,
    /className="hidden lg:flex w-11 shrink-0 flex-col items-center gap-2 py-3 border-l/,
    "直播栏把手应当是 `hidden lg:flex`",
  );
});

test("对话页：消息流阅读列封顶（一行横扫整屏是阅读负担）", () => {
  const src = read("components/ChatConsole.tsx");
  assert.match(src, /max-w-3xl mx-auto px-4 sm:px-5 py-6 space-y-5/, "消息流缺 max-w-3xl 阅读列");
});

test("对话页：不能有「同一件事的第二道门」（顶栏本轮详情 vs 消息自带记录）", () => {
  const src = read("components/ChatConsole.tsx");
  // 只看 JSX 按钮文本，不看注释里提到的历史（注释里出现是正常的）
  assert.doesNotMatch(src, />\s*本轮详情\s*</, "顶栏又放了「本轮详情」——每条助手消息已自带完整记录");
});

test("配置页：不得内嵌对话页的会话列表 / 三视图（第二道门 + tabs）", () => {
  const src = read("components/AgentDetail.tsx");
  assert.doesNotMatch(src, /<RunPanel/, "配置页又引回了 RunPanel（内嵌会话列表 + 三视图）");
  assert.doesNotMatch(src, /"原始 JSON"/, "配置页又出现了原始 JSON 视图");
  assert.match(src, /AgentQuickRun/, "配置页应当用 AgentQuickRun（单轮试跑）");
});

test("配置页：主操作（试跑）不得埋在后面 —— 常驻卡片 + 窄屏提前", () => {
  const src = read("components/AgentDetail.tsx");
  assert.match(src, /快速试跑/, "缺快速试跑卡");
  assert.match(src, /max-xl:order-first/, "试跑卡缺窄屏提前（否则手机上排在三屏之后）");
  assert.match(src, /max-xl:contents/, "右列包裹层缺窄屏 contents（contents + order-first 是一对）");
  assert.match(src, /xl:grid xl:grid-cols-\[minmax\(0,1fr\)_400px\]/, "缺桌面双列网格");
});

test("配置页：概览数字不得再占一张四格卡（下面每节已有完整信息）", () => {
  const src = read("components/AgentDetail.tsx");
  assert.doesNotMatch(src, /最近一次执行：/, "四格概览卡又回来了（与下面各节重复）");
});

test("快速试跑：Enter 必须有输入法守卫（走 isImeEvent）", () => {
  const src = read("components/AgentQuickRun.tsx");
  assert.match(src, /isImeEvent/, "缺 IME 守卫");
  assert.match(src, /origin: "preview"/, "试跑应当归类为 preview（与对话页的执行区分）");
  assert.doesNotMatch(src, /session_id/, "试跑是单轮 —— 不该带 session_id（那是对话页的事）");
});

test("图片出现在三处：消息正文 / 执行过程 / 完整记录 都要渲染成图（不是路径）", () => {
  const md = read("components/Markdown.tsx");
  assert.match(md, /from "@\/lib\/work-paths"/, "Markdown 应当用共享的路径解析");
  assert.match(md, /linkifyWorkPaths/, "正文转换要走共享实现");
  assert.match(md, /<a key=\{key\} href=\{src\}/, "正文里的图片应当可点开看原图");
  assert.match(md, /max-h-\[420px\]/, "正文图片要有高度上限（1920×1080 截图会顶满整屏）");

  const tl = read("components/ui/run-timeline.tsx");
  assert.match(tl, /from "@\/lib\/work-paths"/, "时间线应当用共享的路径解析");
  assert.match(tl, /const urls = workImageUrls\(s\.body\)/, "时间线要把任何步骤输出里的图片显示出来");
  assert.match(tl, /<Markdown text=\{s\.body\} \/>/, "思考/回答这类正话要用 Markdown 渲染");

  const rd = read("components/RunDetailDialog.tsx");
  assert.match(rd, /<Markdown text=\{outputText\} \/>/, "完整记录里的输出也要走 Markdown（否则路径还是路径）");
  assert.match(rd, /from "@\/components\/Markdown"/, "完整记录要引 Markdown 组件");
});

test("工作表（work-paths）是唯一判定源：组件里不得再各写一份产物匹配正则", () => {
  for (const f of ["components/Markdown.tsx", "components/ui/run-timeline.tsx", "components/RunDetailDialog.tsx"]) {
    const src = read(f);
    // 手写产物的特征：内联的图片后缀表 / 自建 WORK_*_RE
    assert.doesNotMatch(src, /\.\(png\|jpe\?g/, `${f} 里又手写了一份图片后缀表（应走 lib/work-paths）`);
    assert.doesNotMatch(src, /const WORK_(IMG|PATH)_RE/, `${f} 里又自建了产物正则（应走 lib/work-paths）`);
  }
});

test("输入坞：图标化发送/停止 + 自动长高 + 粘贴/拖拽投喂附件", () => {
  const src = read("components/ChatConsole.tsx");
  // 发送不再是「一个写字的按钮」，而是同一个位置的圆形箭头（执行中变方块）
  assert.doesNotMatch(src, />\s*发送\s*</, "发送键应当是图标（形状表达状态），不再占一个写「发送」的按钮");
  assert.match(src, /title=\{paused \? "运行暂停，先处理授权" : "发送（Enter）"\}/);
  assert.match(src, /title="停止这一轮"/);
  // 自动长高：不做的话长输入缩在单行里靠内部滚动条看
  assert.match(src, /const taRef = useRef<HTMLTextAreaElement \| null>\(null\)/);
  assert.match(src, /el\.style\.height = `\$\{Math\.min\(el\.scrollHeight, cap\)\}px`/);
  // 三条投喂路径统一走 addFiles
  assert.match(src, /const addFiles = async \(files: FileList \| File\[\] \| null\)/);
  assert.match(src, /onPaste=\{\(e\) => \{/, "应当支持直接粘贴截图");
  assert.match(src, /onDrop=\{\(e\) => \{/, "应当支持把文件拖进输入坞");
  assert.match(src, /void addFiles\(e\.dataTransfer\.files\)/);
});

test("输入坞：等授权时禁用；执行中可用（回车是插话，不是又起一轮）", () => {
  const src = read("components/ChatConsole.tsx");
  assert.match(src, /const paused = !!hitl;/);
  // 暂停（等授权）时禁掉 —— 避免又起一轮抢同一个会话
  assert.match(src, /disabled=\{paused\}/);
  assert.match(src, /运行暂停，先处理上面的授权…/);
  // 执行中可用，但回车走插话；send 仍然挡住"又起一轮"
  assert.match(src, /void \(busy \? steer\(\) : send\(\)\)/);
  assert.match(
    src,
    /if \(\(!text && pendingFiles\.length === 0\) \|\| busy \|\| !sessionId \|\| !agentId\) return;/,
    "send 仍然挡住执行中的新起一轮",
  );
});

test("授权条：判定走 lib/hitl，危险操作要两步，参数可展开，拒绝有出路", () => {
  const src = read("components/HitlPrompt.tsx");
  assert.match(src, /from "@\/lib\/hitl"/, "判定要走共享实现，不能各写一份");
  assert.match(
    src,
    /danger \? setConfirming\(true\) : void resume\(true, remember\)/,
    "危险操作第一下只是进入确认态；普通询问直接放行",
  );
  assert.match(src, /本会话内不再问/, "授权条要能「本会话内不再问」（否则同类操作问十遍）");
  assert.match(src, /确认要执行\{risky\.length > 1 \? "这些" : "这个"\}危险操作？/, "第二步要把后果说清楚");
  assert.match(src, /看完整参数/, "长命令要能展开看全文（不能只给截断的 200 字）");
  assert.match(src, /permissionHref/, "「总是允许」要给真链接");
  assert.match(src, /sent !== null/, "提交后要收成状态行，不能还能再点");
  assert.doesNotMatch(src, /它想执行需要你授权的操作，等你点头才继续/, "旧的整句标题应当被说人话的版本取代");
});

test("对话页把「总是允许」链接指到配置页权限段，并有滚动定位", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /permissionHref=\{/, "对话页要传 permissionHref");
  assert.match(chat, /focus=permission/);
  const detail = read("components/AgentDetail.tsx");
  assert.match(detail, /data-focus="permission"/, "配置页要有锚点");
  assert.match(detail, /get\("focus"\)/, "配置页要读 focus 参数");
});

test("试跑页的输入框与对话页同一形态（同一个人不该在两页见到两种输入框）", () => {
  const src = read("components/AgentQuickRun.tsx");
  assert.match(src, /rounded-\[18px\]/, "试跑输入框应当是同一个坞形（rounded-[18px]）");
  assert.match(src, /const taRef = useRef<HTMLTextAreaElement \| null>\(null\)/, "试跑输入框也要自动长高");
  assert.match(src, /el\.style\.height = `\$\{Math\.min\(el\.scrollHeight, cap\)\}px`/);
  assert.match(src, /Enter 试跑 · Shift \+ Enter 换行/, "要有快捷键提示（和对话页一个口径）");
});

test("会话隔离要在界面上看得见：助手配置能选目录分法、对话页按会话列文件", () => {
  // 助手配置：枚举值用选择器（不让手打），并且把"会话之间看不看得见"讲成人话
  const ad = read("components/AgentDetail.tsx");
  assert.match(ad, /workspace_isolation/, "配置页要有「文件目录怎么分」");
  assert.match(ad, /每个会话一个"|每个会话一个/, "选项要写成用户能懂的话");
  assert.match(ad, /data\/work\/sessions\//, "要显示真实落点（会话目录）");

  // 对话页：产物必须按**会话**列（再用全局清单就等于把隔离漏回去了）
  const cc = read("components/ChatConsole.tsx");
  assert.match(cc, /api\.sessionFiles\(sessionId\)/);
  assert.match(cc, /这个会话的目录/);
  assert.doesNotMatch(cc, /api\.workList\(|maintenance\/list/, "对话页不该拉全局产物清单");

  // 存储体检：会话目录体检 + 只清"没主的"
  const sp = read("components/StoragePanel.tsx");
  assert.match(sp, /api\.sessionDirs\(\)/);
  assert.match(sp, /没有主的/);
  assert.match(sp, /有会话在用的目录一个都不会动/);
});

test("手机适配的两条结构性护栏（改坏了就会在 390 宽下炸）", () => {
  // 一行一对象的动作区必须能折行/能缩：否则五颗按钮在 390 宽下顶出卡片，
  // 而卡片是 overflow-hidden —— 最后那颗「删除」会被静默裁掉
  const kit = read("components/ui/kit.tsx");
  assert.match(kit, /min-w-0 max-w-full items-center gap-1\.5/, "Row 动作区要能缩能折");
  // 手机上整块 44 高的可点区（抽屉顶上的入口常点）
  const nav = read("components/Nav.tsx");
  assert.match(nav, /min-h-\[36px\] items-center font-semibold/, "抽屉标题要做成 44 高的可点区");
});

test("尺寸/位置的三条结构性护栏（手机排版靠它们不塌）", () => {
  // ① 工具条上"本来想窄"的输入框/下拉：`.input{width:100%}` 不在 Tailwind 层里，
  //    会压过 w-auto / w-48 / sm:w-[220px]，结果每个控件各占一整行
  //    （/runs 工具条因此在桌面被撑成 5 行 168px）。必须有 .input-inline 兜住宽度。
  const css = read("app/globals.css");
  assert.match(css, /\.input-inline\s*\{[^}]*width:\s*auto/, "要有 .input-inline 覆盖 .input 的 width:100%");
  const runs = read("components/RunsPanel.tsx");
  assert.match(runs, /input input-inline h-\[36px\]/, "运行页工具条的下拉/搜索要按内容宽度排");
  // ② 页面头：手机上标题降一档、动作整行落到下面（否则头吃 127~147px）
  const kit = read("components/ui/kit.tsx");
  assert.match(kit, /max-md:text-\[20px\]/, "页面头标题手机上要降一档");
  assert.match(kit, /max-md:w-full max-md:justify-end/, "页面头动作手机上要整行落下");
  // ③ 一行一对象：手机上主体占满整行、动作落到第二行（名字/描述不再被按钮挤）
  assert.match(kit, /max-md:w-full md:flex-1/, "行主体手机上要占满整行");
});

test("手机排版的护栏（行距和次要字号别再退回 1.38）", () => {
  const css = read("app/globals.css");
  // 中文在手机上要更松的行距：main 上给 1.6，说明类文字里的 leading-snug/tight 也要放宽
  assert.match(css, /main\s*\{\s*line-height:\s*1\.6;/, "手机上正文行距要 1.6");
  assert.match(css, /\[class~="leading-snug"\][\s\S]{0,120}?line-height:\s*1\.6/, "说明类的紧凑行距手机上要放宽");
  // 次要字号 12 → 12.5（12px 的中文在手机上偏小）
  assert.match(css, /\[class~="text-\[12px\]"\]\s*\{\s*font-size:\s*12\.5px/, "次要字号手机上要抬到 12.5");
  // 页头说明：手机上 13px + 宽松行距
  const kit = read("components/ui/kit.tsx");
  assert.match(kit, /max-md:text-\[13px\] max-md:leading-relaxed/, "页头说明手机上要 13px/宽松行距");
});

/**
 * 会话文件可见性：每个会话的文档独立存放，**在会话里就要能看见路径和文件**。
 * 曾经的错法是把这块塞进 ⓘ 的 showPaths 开关里（默认关着 = 用户根本不知道文件存哪）；
 * 现在它是输入坞上方常驻的一条，没文件时也留着（告诉人"以后生成的会落在这"）。
 */
test("本会话文件是常驻的一条，不再藏在 ⓘ 开关后面", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /本会话文件/, "要有一句明确的『本会话文件』");
  assert.doesNotMatch(chat, /showPaths && sessionFiles/, "不能再被 showPaths 开关挡住");
  assert.match(chat, /还没有文件 —— 这个会话生成的文档都会存在上面的目录里/, "没有文件时也要说明文件会落在哪");
  // 点开是文件操作框（预览/下载/复制路径），不是跳新标签页：
  // 断言"这块里用了 FileRowButton"就够 —— 别盯源码里两处相距多少字符（细节一改就误报）
  const strip = chat.slice(chat.indexOf("本会话文件"), chat.indexOf("还没有文件 ——"));
  assert.match(strip, /<FileRowButton/, "清单行要能点开操作框");
  assert.match(strip, /title=\{f\.path\}|onClick=\{/, "胶囊要是可点的按钮");
});

/**
 * 发送气泡的形状口径（用户 2026-10 要求"气泡样式和尺寸激进一点"）：
 *   · 短消息（一行、无附件）＝ 胶囊；长消息 ＝ 18px 圆角块，右下一角收成 6px（"尾巴"）
 *   · 气泡自己占满外层 90%（手机）/88%（桌面），不再套一层 92% 才到 78%
 *   · 字 14px / 行距 1.6（气泡里比正文紧一点），带一点点阴影与内高光
 */
test("发送气泡：短消息胶囊、长消息圆角+尾巴，尺寸与字阶定死", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /const shortMsg = !userBody\.includes\("\\n"\) && userBody\.length <= 24 && attachments\.length === 0/, "短消息判定口径");
  assert.match(chat, /rounded-full px-4 py-2 leading-\[1\.6\]/, "短消息 ＝ 胶囊");
  assert.match(chat, /rounded-\[18px\] rounded-br-\[6px\] px-3\.5 py-2\.5 leading-\[1\.6\]/, "长消息 ＝ 18px + 右下 6px 尾巴");
  // 2026-10 对标主流对话：正文统一 15px / 行高 1.8
  assert.match(chat, /text-white w-fit max-w-full whitespace-pre-wrap ml-auto text-\[15px\]/, "气泡 15px、贴右、宽度撑到外层上限");
  assert.match(chat, /text-\[15px\] leading-\[1\.8\] text-\[var\(--color-text\)\] max-w-\[46rem\]/, "助手正文 15px/1.8 且封顶 46rem");
  assert.match(chat, /max-w-\[88%\] max-md:max-w-\[90%\]/, "外层给气泡 88%（桌面）/90%（手机）");
});

/**
 * 会话文件清单的折叠（用户 2026-10 反馈：文件一多就遮住对话区）。
 * 口径：≤3 个默认摊开（少的时候看得见才有用），多了默认收起；
 * 手动点过就记住选择（localStorage），展开时最多 6 个胶囊 + 高度上限。
 */
test("会话文件清单可折叠：默认按数量、手动选择要记住", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /const openFiles = filesOpenPref \?\? fileCount <= 3/, "默认口径：≤3 个展开");
  assert.match(chat, /localStorage\.setItem\("chat\.filesOpen"/, "手动选择要记住");
  assert.match(chat, /localStorage\.getItem\("chat\.filesOpen"\)/, "刷新后要读回来");
  assert.match(chat, /\{openFiles &&/, "胶囊行必须跟着折叠状态走");
  assert.match(chat, /max-h-\[40vh\][^"]*overflow-y-auto/, "展开时高度要有上限，别无限长");
  /* 2026-10 改口径：以前只摆 6 个、剩下写成「还有 N 个…」根本点不到 —— 等于没给。
     现在全部列出（换行 + 滚动兜高度），不许再出现截断与「还有」提示。 */
  assert.doesNotMatch(chat, /slice\(0, 6\)/, "不许再截断成 6 个");
  assert.doesNotMatch(chat, /还有 \{sessionFiles\.files\.length - 6\}/, "不许再有『还有 N 个』这种点不到的提示");
  assert.match(chat, /shownFiles\.map\(/, "全部（过滤后）文件都要列出来");
  /* 文件查询与管理：文件多时要能按名字找、能一次删几个（删除仍要两步确认） */
  assert.match(chat, /const \[fileQuery, setFileQuery\]/, "要有按文件名查询");
  assert.match(chat, /const shownFiles = useMemo/, "查询是就地过滤，不去打扰后端");
  assert.match(chat, /if \(!bulkConfirm\) \{/, "批量删除必须先确认一次（不可撤销）");
  assert.match(chat, /api\.deleteSessionFiles\(sessionId, picked\)/, "批量删除走专用接口");
  assert.match(chat, /fileCount > 6 && \(/, "文件少的时候不摆搜索框（噪音）");
});

/**
 * 删会话必须告诉用户「文件夹也一起删」（用户 2026-10 要求）。
 * 口径：弹框里点名文件夹路径（sessions/<会话号>/）+ 文件数与体积；
 * 有文件时主按钮写「连文件夹一起删」，别只写「删除」让人以为只删聊天记录。
 */
test("删会话：说清会话文件夹会一起删", () => {
  const chat = read("components/ChatConsole.tsx");
  const block = chat.slice(chat.indexOf("const removeSession"), chat.indexOf("const renameSession"));
  assert.match(block, /api\.sessionFiles\(s\.id/, "删之前先数文件夹里有什么");
  assert.match(block, /warning:/, "用红色警告块，不是埋在 details 里");
  assert.match(block, /文件夹/, "必须点名文件夹");
  assert.match(block, /个文件/, "有文件要说有几个");
  assert.match(block, /连文件夹一起删/, "有文件时主按钮不能只写『删除』");
  assert.match(block, /fmt\.bytes\(fileBytes\)/, "还要说占多少体积");
});

test("确认弹框支持红色警告块", () => {
  const fb = read("components/ui/feedback.tsx");
  assert.match(fb, /warning\?: string/, "ConfirmOptions 要有 warning");
  assert.match(fb, /\{opt\.warning && \(/, "要真的渲染出来");
  assert.match(fb, /strokeWidth=\{1\.8\}/, "警告图标按全站口径 1.8 描边、不用 emoji");
});

/**
 * 执行过程（think / 工具 / 过程）默认收起，只把结果摊开（用户 2026-10 要求）。
 * 口径：
 *   · 对话页只能用 ProcessBar（默认收起），不能把 RunTimeline 直接摊在消息流里
 *   · 过程里不含「回答」——回答是结果，出现在气泡正文；两处都给就是同一件事说两遍
 *   · 每类一个颜色（思考紫 / 工具蓝 / 工具结果青），与结果（白底正文）拉开
 *   · 执行中不同类型不同动效；动效可关（localStorage）且尊重系统偏好
 */
test("对话页：过程默认收起，只露结果", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /<ProcessBar/, "对话页必须用过程条");
  assert.doesNotMatch(
    chat,
    /<RunTimeline steps=\{eventsToSteps/,
    "不许再把完整时间线摊在消息流里（默认只给结果）",
  );
  assert.match(chat, /running\n\s*elapsedMs=\{liveElapsed\}/, "执行中要带 running + 耗时");
});

test("过程条：剔掉输入和回答，默认收起", () => {
  const tl = read("components/ui/run-timeline.tsx");
  assert.match(
    tl,
    /export function processSteps\(steps: Step\[\]\): Step\[\] \{\s*return steps\.filter\(\(s\) => s\.kind !== "input" && s\.kind !== "output"\);/,
    "过程不含输入与回答",
  );
  assert.match(tl, /defaultOpen = false/, "默认收起");
  assert.match(tl, /data-open=\{open \? "1" : "0"\}/, "收起/展开要能在样式里区分");
  assert.match(tl, /data-running=\{running \? "1" : "0"\}/, "跑没跑也要能区分");
});

test("过程与结果：颜色分得开", () => {
  const tl = read("components/ui/run-timeline.tsx");
  const css = read("app/globals.css");
  // 三类动作的色值必须互不相同（思考 / 工具 / 工具结果）
  assert.match(tl, /think: \{\s*icon: "◆",\s*color: "#6d28d9"/, "思考＝紫");
  assert.match(tl, /tool: \{\s*icon: "⚙",\s*color: "#2563eb"/, "工具＝蓝");
  assert.match(tl, /tool_response: \{\s*icon: "◀",\s*color: "#0e7490"/, "工具结果＝青");
  // 结果（回答）用正文颜色，不带过程那套底色
  assert.match(css, /\.proc \{/, "过程有自己的壳");
  assert.match(css, /\.proc-body \{\s*border-top: 1px solid var\(--proc-border\);/, "过程展开有分隔与灰底");
});

test("执行中：不同类型不同动效，且可关", () => {
  const tl = read("components/ui/run-timeline.tsx");
  const css = read("app/globals.css");
  assert.match(tl, /s\.kind === "tool" && <span className="proc-run-ring"/, "工具＝转圈");
  assert.match(tl, /s\.kind === "think" \? \(\s*<span className="proc-think-dots"/, "思考＝呼吸点");
  assert.match(css, /\.proc-row\[data-active="1"\]::after/, "跑着的那行有扫光");
  assert.match(css, /@keyframes proc-think/, "思考动效");
  assert.match(css, /@keyframes proc-sweep/, "扫光动效");
  assert.match(css, /@keyframes proc-flash/, "结果落定闪一下");
  // 可关 + 系统偏好
  assert.match(tl, /localStorage\.setItem\("chat\.procAnim"/, "开关要记住");
  assert.match(css, /\.proc\[data-anim="off"\]/, "关掉时不动");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "尊重系统减少动效");
  // 手机点得中
  assert.match(css, /\.proc-head \{[^}]*min-height: 36px/s, "收起态 36px 点击高度");
});

/**
 * 「不同动画」要落在**收起的**那一行上（用户 2026-10 澄清：指 think / tool 的动画）。
 * 收起态左侧那颗图标就是心跳：思考＝紫点波浪，工具＝蓝圈转，工具结果＝青点弹一下。
 */
test("过程条收起态：think 与 tool 各有各的动画", () => {
  const tl = read("components/ui/run-timeline.tsx");
  const css = read("app/globals.css");
  assert.match(tl, /const activeKind: StepKind \| null = running/, "当前动作类型要算出来");
  assert.match(
    tl,
    /\["--proc-active-color" as string\]: STEP_STYLE\[activeKind \?\? "think"\]\.color/,
    "收起态整行染成当前动作的颜色",
  );
  assert.match(tl, /activeKind === "tool" \? \(/, "工具走转圈那条分支");
  assert.match(tl, /className="proc-spin"/, "工具＝圆弧转圈");
  assert.match(tl, /<span className="proc-think-dots">/, "思考＝三个点波浪");
  assert.match(tl, /activeKind === "tool_response" \|\| activeKind === "artifact"/, "结果＝落定");
  // CSS 三套动效都在，且关动效/系统偏好能一次覆盖
  assert.match(css, /\.proc-act \{/, "收起态活动图标");
  assert.match(css, /\.proc-spin \{\s*animation: spin/, "转圈");
  assert.match(css, /@keyframes proc-pop/, "落定弹一下");
  assert.match(css, /\.proc\[data-anim="off"\] \.proc-spin,/, "可关：转圈");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.proc \.proc-head::before,\s*\.proc \.proc-spin,/, "可关：系统偏好");
});

/**
 * 对标主流 Agent 对话（2026-10 用户要求）的四件事，逐条钉住：
 *  1. 正文 15px/1.8、阅读列封顶；Markdown 有 chat 档（面板仍是 12px 紧凑档）
 *  2. 自动跟随只在贴底时生效 —— 往上翻历史时新内容不许把人拽回去
 *  3. 会话侧栏：搜索 + 时间分组 + 「⋯」菜单（改名/删除）
 *  4. Esc 停止这一轮
 */
test("对话正文：15px/1.8，Markdown 走 chat 档", () => {
  const chat = read("components/ChatConsole.tsx");
  const md = read("components/Markdown.tsx");
  assert.match(chat, /<Markdown text=\{content\} chat \/>/, "对话正文用 chat 档");
  assert.match(md, /chat = false \}: \{ text: string; chat\?: boolean \}/, "Markdown 要能切档");
  assert.match(md, /chat\s*\?\s*"my-2 text-\[15px\] leading-\[1\.8\] break-words"/, "chat 档段落 15px/1.8");
  assert.match(md, /: "my-1\.5 text-\[12px\] leading-\[1\.75\] break-words"/, "面板档保持 12px");
});

test("自动跟随：贴底才跟，否则给「最新」", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /const followRef = useRef\(true\)/, "跟随状态放 ref（scroll 回调要读最新值）");
  assert.match(chat, /if \(!followRef\.current\) return;/, "不贴底就不滚动");
  assert.match(chat, /el\.scrollHeight - el\.scrollTop - el\.clientHeight < 80/, "80px 以内算贴底");
  assert.match(chat, /const jumpLatest = \(\) => \{/, "要有回到最新");
  assert.match(chat, /\{!atBottom && \(/, "离开底部才露出浮标");
  // 旧的“每次都滚到底”必须消失（那就是把人拽回去的写法）
  assert.doesNotMatch(chat, /endRef\.current\?\.scrollIntoView/, "不许无条件 scrollIntoView");
});

test("会话侧栏：搜索、分组、⋯ 菜单", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /placeholder="搜索对话"/, "要有搜索框");
  assert.match(chat, /label: "今天"/, "今天分组");
  assert.match(chat, /label: "昨天"/, "昨天分组");
  assert.match(chat, /label: "过去 7 天"/, "7 天分组");
  assert.match(chat, /label: "更早"/, "更早分组");
  assert.match(chat, /title="更多"/, "每行一个 ⋯");
  assert.match(chat, /role="menu"/, "菜单本体");
  assert.match(chat, /onRename\(s\)/, "菜单里能改名");
  assert.match(chat, /onRemove\(s\)/, "菜单里能删除");
  // 行内那两个常驻文字按钮已收进菜单（原来每行三个可点目标，误删风险高）
  assert.doesNotMatch(chat, /title="重命名"/, "改名不该再常驻在每行");
  assert.doesNotMatch(chat, /title="删除这个对话"/, "删除不该再常驻在每行");
});

test("Esc 停止这一轮（且输入框里按 Esc 不算）", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /if \(e\.key !== "Escape"\) return;/, "监听 Esc");
  assert.match(chat, /el\.tagName === "TEXTAREA"/, "输入框里的 Esc 不触发停止");
  assert.match(chat, /void stop\(\);/, "Esc → stop()");
});

/**
 * 后台任务（2026-10）：助手能把长活丢后台跑，界面必须有一处常驻的地方
 * 回答"在跑什么 / 多久 / 完事没"。口径：
 *   · 没有任务时整条不渲染（空常驻条是噪声）
 *   · 有任务在跑 → 3 秒一轮；**一轮执行期间也要盯**（否则首轮起的任务不出现）
 *   · 跑完弹一次提示（只在状态变化时，不是每次刷新都弹）
 *   · 归属会话：接口必须带 session_id
 */
test("后台任务条：无任务不渲染、执行中也轮询、跑完只提示一次", () => {
  const src = read("components/BgProcsStrip.tsx");
  assert.match(src, /if \(items\.length === 0\) return null;/, "没有任务时整条不出现");
  assert.match(src, /if \(running === 0 && !busy\) return;/, "有任务或执行中才轮询");
  assert.match(src, /const t = setInterval\(\(\) => void load\(\), 3000\);/, "3 秒一拍");
  assert.match(src, /const was = prevStatus\.current\[it\.id\];/, "只在状态变化时提示");
  assert.match(src, /fb\.success\(\s*`后台任务完成/, "完成给提示");
  assert.match(src, /api\.procLog\(it\.id, sessionId, 200\)/, "日志按会话取");
  assert.match(src, /api\.procKill\(it\.id, sessionId\)/, "停止按会话发");
  // 对话页必须接上它，并且传 busy
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /<BgProcsStrip sessionId=\{sessionId\} busy=\{busy\} \/>/, "对话页接入且带执行中标记");
});

test("后台任务接口：一律按会话过滤（会话之间不互看）", () => {
  const api = read("lib/api.ts");
  assert.match(api, /procs: \(sessionId: string\)/, "列表按会话");
  assert.match(api, /api\/procs\/\$\{id\}\/log\?session_id=/, "日志带会话");
  assert.match(api, /api\/procs\/\$\{id\}\/kill\?session_id=/, "停止带会话");
});

/**
 * 跨会话检索（2026-10，对标 Hermes 的 session_search）：
 * 侧栏搜索框不只是过滤标题 —— 还要能搜到**对话内容**，并且点一条就进那个会话。
 * 口径：≥2 个字才搜、300ms 防抖、标题与内容都空才说"没有"。
 */
test("侧栏搜索：标题 + 对话内容两段，内容命中可点进会话", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /const \[hits, setHits\] = useState<SearchHit\[\]>\(\[\]\)/, "要有内容命中状态");
  assert.match(chat, /if \(kw\.length < 2\)/, "太短不搜（单字噪声大）");
  assert.match(chat, /\}, 300\);/, "300ms 防抖");
  assert.match(chat, /api\s*\.search\(kw, \{ limit: 12 \}\)/, "调检索接口");
  assert.match(chat, /对话内容\{hitBusy \? " · 搜索中…"/, "内容命中要单独一段");
  assert.match(chat, /onClick=\{\(\) => onPick\(h\.session_id\)\}/, "点一条进那个会话");
  assert.match(chat, /没有叫「\{q\.trim\(\)\}」的对话，内容里也没有。/, "标题与内容都空才说没有");
  // 接口两侧同一实现
  const api = read("lib/api.ts");
  assert.match(api, /search: \(q: string/, "前端检索方法");
});

/**
 * 定时任务（2026-10）：让这个对话在你不看着的时候也跑，结果回到对话里或推到群里。
 * 口径：
 *   · 频率是枚举（每小时/每天/每周），不让用户写 cron
 *   · 投递两选一：本对话（零配置）/ webhook（飞书/企业微信/钉钉都是 POST 一个 JSON）
 *   · 没有定时任务时不出常驻条（只在输入框下面留一个安静的「定时」）
 */
test("定时任务：枚举频率 + 两选一投递 + 空态不占位", () => {
  const src = read("components/SessionJobs.tsx");
  // 节奏从「三个分段 + 时间零件」改成整句下拉（每天 09:00 / 每周一三五 09:00），
  // 枚举值仍在源码里明写着，不让用户写 cron
  assert.match(src, /DAILY_PRESETS/, "频率是枚举好的整句");
  assert.match(src, /option value="hourly"/, "每小时仍可选");
  assert.match(src, /key: "session" as const, label: "这个对话"/, "默认投递=本对话");
  assert.match(src, /key: "feishu", label: "飞书"/, "webhook 支持飞书");
  assert.match(src, /key: "wecom", label: "企业微信"/, "webhook 支持企业微信");
  assert.match(src, /\{items\.length > 0 && \(/, "没有任务时不出常驻条");
  // 「保存后立刻跑一次」的复选框改成卡片上的「跑一次」按钮：随时能验证，
  // 也不必在创建时多做一次决定
  assert.match(src, /跑一次/, "可以立刻跑一次验证");
  assert.match(src, /api\.runJobNow/, "走的是后端 run-now 接口");
  // 开关从两个字的按钮换成 Switch（状态比动作更直观，触屏也更好点）
  assert.match(src, /<Switch[\s\S]{0,160}checked=\{j\.enabled\}/, "能开关");
  // 对话页必须接上：按钮 + 常驻条
  const chat = read("components/ChatConsole.tsx");
  // 入口在输入坞的工具排里（附件旁边），而且是"没有任务时"才摆 ——
  // 有任务时上面有常驻条，条里已有「＋ 再排一个」，同一个动作只留一个入口
  assert.match(
    chat,
    /jobCount === 0 && <JobButton onClick=\{\(\) => setJobOpen\(true\)\} \/>/,
    "没有任务时工具排里有定时入口",
  );
  assert.doesNotMatch(
    chat,
    /Enter 发送 · Shift \+ Enter 换行 · 可直接粘贴截图<\/span>\s*\{sessionId && <JobButton/,
    "定时不能混在键盘说明那一行里",
  );
  assert.match(chat, /<SessionJobs[\s\S]{0,160}onCount=\{setJobCount\}/, "常驻条与计数接上");
  // 接口
  const api = read("lib/api.ts");
  assert.match(api, /sessionJobs: \(sessionId: string\)/, "按会话取任务");
  assert.match(api, /runJobNow: \(id: string\)/, "能立刻跑一次");
});

/**
 * 备用模型（2026-10）：主模型的 key 失效 / 下线 / 持续 5xx 时，整轮换备用模型重跑一次。
 * 口径：
 *   · 配置页可以设一个备用模型，也可以不设（不设 = 行为不变）
 *   · 过程条上必须看得见"换模型"这一步 —— 否则答案是凭空出现的
 */
test("备用模型：配置页可设 + 过程条认「换模型」", () => {
  const agent = read("components/AgentDetail.tsx");
  assert.match(agent, /备用模型（可选）/, "配置页有入口");
  assert.match(agent, /不设 —— 主模型出问题就报错/, "不设 = 不兜底，行为不变");
  assert.match(agent, /patch\(\{ fallback: null \}\)/, "能取消");

  const tl = read("components/ui/run-timeline.tsx");
  assert.match(tl, /"model_fallback"/, "事件流里认这个事件");
  assert.match(tl, /kind: "fallback", label: "换模型"/, "过程条上有一行");
  assert.match(tl, /主模型 \$\{from\} 不可用/, "说清是谁换成了谁");
  const types = read("lib/types.ts");
  assert.match(types, /fallback\?: ModelSpec \| null/, "定义里带 fallback");
});

/**
 * 运行中插话（2026-10）：一轮还在跑的时候，用户要能把方向掰回来。
 * 口径：
 *   · 执行中**输入框可用**、回车即插话（不是排到这一轮后面）
 *   · 有字时给一个「插话」按钮（常驻可见，不藏进菜单）
 *   · 插过的话在历史里看得出是"打断式补充"，不是新一轮提问
 */
test("运行中插话：执行中输入框可用 + 回车即插话 + 历史里标记出来", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /api\.steerRun\(liveRunId, text\)/, "走插话接口");
  assert.match(chat, /执行中 · 回车即插话/, "提示语说清楚回车是插话");
  assert.match(chat, /void \(busy \? steer\(\) : send\(\)\)/, "执行中回车走插话");
  assert.match(chat, /disabled=\{paused\}/, "执行中输入框不能禁掉");
  assert.match(chat, /插话：塞进这一轮，不打断当前这一步/, "按钮常驻可点");
  assert.match(chat, /运行中插话/, "历史里标记出来");

  const api = read("lib/api.ts");
  assert.match(api, /steerRun: \(id: string, text: string\)/, "接口封装存在");
});

/**
 * 变更门 + 心跳（2026-10）：定时任务别每次都为"没变化"烧一遍模型；
 * 长任务别让用户反复问"跑完没"。
 */
test("定时任务：可设「有变化才跑」，并把跳过的原因说清楚", () => {
  const jobs = read("components/SessionJobs.tsx");
  assert.match(jobs, /只在有变化时才跑/, "变更门有入口（收进折叠区，不占常驻位置）");
  assert.match(jobs, /option value="command"/, "命令型检查有入口");
  assert.match(jobs, /option value="url"/, "网址型检查有入口");
  assert.match(jobs, /monitor_kind: monitorKind/, "保存时带上类型");
  // 节奏是派生值，「自定义…」必须有独立 state 记着，否则一选就被算回预设、下拉弹回去
  assert.match(jobs, /rhythmCustom\s*\?\s*"custom"/, "自定义选项有独立 state");
  assert.match(jobs, /setRhythmCustom\(true\)/, "选中自定义时置位");
  assert.match(jobs, /结果和上次一样就「整个跳过」/, "文案说清为什么没跑");
  assert.match(jobs, /有变化才跑/, "列表行上看得出来");

  const types = read("lib/types.ts");
  assert.match(types, /monitor_kind: "" \| "command" \| "url"/);
});

test("心跳：平台自己的提示在对话里有一行灰字（关掉页面回来还在）", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /m\.role === "system"/, "system 消息要保留并渲染");
  assert.match(chat, /key=\{m\.id \?\? `sys-\$\{i\}`\}/, "系统行有稳定 key");
  const tools = read("../src/agent_studio/native_tools.py");
  assert.match(tools, /heartbeat_s/, "proc_start 能开心跳");
});

/**
 * 跨轮清单（2026-10）：助手列的五步，下一轮不许装作没列过。
 */
test("跨轮清单：有清单才出现，一行给进度，点开看每一步", () => {
  const strip = read("components/TodoStrip.tsx");
  assert.match(strip, /if \(tasks\.length === 0\) return null;/, "没清单不占地方");
  assert.match(strip, /清单 \{done\}\/\{tasks\.length\}/, "一行给进度");
  assert.match(strip, /正在做：/, "正在做哪一步看得见");
  assert.match(strip, /api\.sessionTodos\(sessionId\)/, "数据来自平台（跨轮存的那份）");
  assert.match(strip, /max-md:min-h-\[38px\]/, "手机点击高度（38px）");
  assert.doesNotMatch(strip, /✅|⬜|🔲/, "不用 emoji 图标");

  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /<TodoStrip sessionId=\{sessionId\} busy=\{busy\} refreshKey=\{todoTick\} \/>/);
  assert.match(chat, /setTodoTick\(\(n\) => n \+ 1\)/, "一轮结束要刷新清单");
});


/**
 * 视频预览：编码不支持时不能只丢黑框（用户原话「mp4视频播放不了」）。
 * 口径：开视频先 probe；播不了/可能播不了 → 明说原因 + 一键转 H.264。
 */
test("视频预览：先探编码，播不了给转码入口", () => {
  const dlg = read("components/FileDialog.tsx");
  assert.match(dlg, /api\s*\.\s*probeWorkFile\(workRel\)|api\.probeWorkFile\(workRel\)/, "打开视频先问后端编码");
  assert.match(dlg, /转成能播的版本（H\.264）/, "播不了要给一键转码");
  assert.match(dlg, /const workRel = /, "probe/transcode 用相对 data/work 的路径（不是会话目录那层）");
  assert.match(dlg, /onError=\{\(\) => setVideoFailed\(true\)\}/, "浏览器自己解不开时也要切成提示态");
});


test("浏览器交互用窗口 + 动作字幕，不是一张裸图", () => {
  const stage = read("components/BrowserStage.tsx");
  const chat = read("components/ChatConsole.tsx");
  const rail = read("components/ProcessRail.tsx");

  // 窗口感：chrome 条 + 地址栏可复制
  assert.match(stage, /function ChromeBar/, "要有窗口 chrome 条（三个点 + 地址栏）");
  assert.match(stage, /navigator\.clipboard\.writeText\(frame\.url\)/, "地址栏点一下能复制网址");
  // 人话字幕：动作来自后端 browser_action
  assert.match(stage, /function ActionLine/, "要有动作字幕");
  assert.match(chat, /ev\.type === "browser_action"/, "前端要收 browser_action 事件");
  // 不抢正文：消息流里只是缩略条，点开才是面板
  assert.match(chat, /variant="inline"/, "消息流里用缩略条");
  assert.match(chat, /variant="panel"/, "点开是完整窗口");
  // 帧直达 <img>（2026-10-22 起）：限帧后不再需要双层淡入那套，
  // 每帧 setState 才是卡顿的根，这里守住"位图不进 React 状态"
  assert.match(stage, /img\.src = `data:image\/jpeg;base64,\$\{pending\}`/, "帧要直接写进 img.src");
  assert.doesNotMatch(stage, /const \[prev, setPrev\]/, "不该再有双层淡入的两份帧状态");
  // 右栏与消息流共用同一个组件（不再各写一份）
  assert.match(rail, /<BrowserStage/, "右栏也用 BrowserStage");
  assert.throws(() => read("components/BrowserLive.tsx"), "旧的 BrowserLive 应已删除");
});
