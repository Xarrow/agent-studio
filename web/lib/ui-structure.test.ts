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
  assert.match(src, /max-w-3xl mx-auto px-4 sm:px-5 py-5/, "消息流缺 max-w-3xl 阅读列");
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

test("输入坞：运行暂停（等授权）时禁用，避免又起一轮抢同一个会话", () => {
  const src = read("components/ChatConsole.tsx");
  assert.match(src, /const paused = !!hitl;/);
  assert.match(src, /disabled=\{busy \|\| paused\}/);
  assert.match(src, /运行暂停，先处理上面的授权…/);
});

test("授权条：判定走 lib/hitl，危险操作要两步，参数可展开，拒绝有出路", () => {
  const src = read("components/HitlPrompt.tsx");
  assert.match(src, /from "@\/lib\/hitl"/, "判定要走共享实现，不能各写一份");
  assert.match(src, /danger \? setConfirming\(true\) : void resume\(true\)/, "危险操作第一下只是进入确认态");
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
  // 点开是文件操作框（预览/下载/复制路径），不是跳新标签页
  assert.match(chat, /<FileRowButton[\s\S]{0,200}本会话文件|本会话文件[\s\S]{0,2400}<FileRowButton/, "清单行要能点开操作框");
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
  assert.match(chat, /text-white w-fit max-w-full whitespace-pre-wrap ml-auto text-\[14px\]/, "气泡 14px、贴右、宽度撑到外层上限");
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
  assert.match(chat, /max-h-\[96px\][^"]*overflow-y-auto/, "展开时高度要有上限，别无限长");
  assert.match(chat, /slice\(0, 6\)/, "最多列 6 个胶囊，其余用『还有 N 个』");
});
