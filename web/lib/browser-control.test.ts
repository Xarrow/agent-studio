/**
 * 浏览器控制权的护栏 —— node --test，零依赖
 * ==================================================
 *
 * 守的是这一版修掉的两个实证病根（界面上一眼看不出来的那种）：
 *
 *   ① 浏览器挂在 run 上：run 一结束就 kill，画面还在、点击静默失效；
 *   ② 只有协作式暂停闸、没有控制权归属：暂停期间双方都能发动作，谁后发谁赢。
 *
 * 这些都是"跑起来才看得见"的不变量，靠自觉守不住：谁把徽章改回自己判 busy、
 * 谁把 run 结束又接回 close_all，用户就会再次遇到"点不动也没解释"。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(WEB, p), "utf8");
const py = (p: string) => readFileSync(join(WEB, "..", "src/agent_studio", p), "utf8");

test("徽章/按钮文案来自后端状态，不再自己判 busy", () => {
  const stage = read("components/BrowserStage.tsx");
  assert.match(stage, /control[!?]?\.badge/, "徽章文字必须直接渲染后端给的 badge");
  assert.match(stage, /control[!?]?\.button/, "按钮文案必须直接渲染后端给的 button");
  assert.match(stage, /control[!?]?\.button_action/, "按钮动作也由后端指定（take / release）");
  assert.match(stage, /\{control\.footer\}/, "底部文案来自后端（本轮结束/已过期都是它）");
  assert.match(stage, /notice\?: string/, "被拒绝的原因要有位置显示");
  assert.doesNotMatch(stage, /onPauseChange/, "旧的协作式暂停闸应当彻底消失（那是抢控的来源）");
});

test("运行中任何形态都有可点的接管，点到就当场解释", () => {
  const stage = read("components/BrowserStage.tsx");
  // 状态还没同步到时（第一轮刚起来）也要有兜底的「接管」—— 实测这一瞬面板里
  // 只有一条红色横幅、没有按钮，用户点不动也停不下来。
  assert.match(stage, /live \? "接管" : ""/, "状态未到时要有兜底按钮文案");
  assert.match(stage, /data-browser-take/, "接管按钮要有稳定的可点标记（三种形态同一处）");
  assert.doesNotMatch(stage, /onWheel=\{shown \? undefined : handleWheel\}/, "回看态也不能吞掉滚动");
  assert.match(stage, /denied_hint/, "非 user 态的人话原因来自后端");
  assert.match(stage, /browser-inline-feedback/, "点击处就地反馈要有一个可见落点");
  assert.match(stage, /browser-take-pulse/, "被拒时接管按钮要高亮");
  assert.match(stage, /onControl\?\.\("take"\)/, "横幅里提到「接管」时整条横幅可点");
});

test("状态文案单一来源：运行条/主底部/面板都读 public_state", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /statusText=\{browserCtl\?\.run_bar \|\| undefined\}/, "顶部运行条读后端的 run_bar");
  assert.match(chat, /browserCtl\?\.chat_status \|\| "助手正在执行…"/, "对话主底部读后端的 chat_status");
  // 圆点的状态词按 phase 派生，**四个入口（桌面侧栏×2 / mini / 顶栏）共用同一句** ——
  // 以前只有顶栏那一处读浏览器状态，桌面侧栏同一页面仍写「执行中」。
  assert.match(chat, /browserCtl\?\.phase === "waiting_user"[\s\S]{0,40}"等你处理"/, "等用户时芯片不许再写执行中");
  assert.equal((chat.match(/<AgentSwitcher/g) || []).length, 4, "对话页有四个助手切换入口");
  assert.equal(
    (chat.match(/statusText=\{agentDotText\}/g) || []).length,
    4,
    "四个入口必须用同一句状态词（各写一份必然漂移）",
  );
  assert.match(chat, /browserCtl\?\.phase_text \|\| "等你处理"/, "等登录卡片标题也来自 public_state");
  assert.match(chat, /setBrowserNotice\(""\);\s*\n\s*return;/, "状态一变就清掉旧的 409 横幅");
});

test("步数口径：胶片条跟 public_state 的同一轮，不跟上一轮", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(
    chat,
    /const runId = browserCtlRef\.current\?\.run_id \|\| liveRunId \|\| lastBrowserRun\.current/,
    "步骤留档优先取控制器记的那一轮（否则标签说本轮、图是上一轮）",
  );
  assert.match(chat, /\[browserCtl\?\.run_id, browserCtl\?\.step_count\]/, "本轮每走一步就同步胶片条");
  const stage = read("components/BrowserStage.tsx");
  assert.match(stage, /control\?\.step_count \?\? steps\?\.length/, "缩略条用后端的本轮数，不数内存动作");
  assert.match(stage, /control\?\.step_label \|\| `过程 \$\{steps\.length\} 步`/, "面板胶片条同一口径");
});

test("状态类动作不参与当前行（「等你登录」不许残留在底部）", () => {
  const stage = read("components/BrowserStage.tsx");
  assert.match(
    stage,
    /actions\.filter\(\(a\) => a\.action !== "wait_login"\)/,
    "wait_login 是状态不是动作：交还后它不能继续当「当前这一行」",
  );
  assert.match(stage, /\(running && last\?\.summary\) \|\|[\s\S]{0,40}control\?\.action_line/, "当前行优先用后端状态，其次才是实时动作");
});

test("会话级浏览器直播：run 结束也不断", () => {
  const chat = read("components/ChatConsole.tsx");
  assert.match(chat, /api\.browserStreamUrl\(sessionId\)/, "要订阅会话级的浏览器流");
  assert.match(chat, /ev\.type === "browser_state"/, "控制权状态从这条流同步");
  assert.match(chat, /busy \|\| !!browserCtl\?\.alive/, "本轮结束后浏览器卡还要在（否则用户以为画面没了）");
  assert.match(chat, /notice=\{browserNotice\}/, "409 的人话原因要交给画面显示");
  assert.match(chat, /browserCtl\?\.status === "waiting_user"/, "wait_login 的卡片由状态驱动，不靠动作流猜");
});

test("后端：控制权是会话级单一状态源", () => {
  const ctl = py("browser_control.py");
  assert.match(ctl, /def key_of/, "归属键要区分会话与 run");
  assert.match(ctl, /f"ses:\{session_id\}"/, "有会话就跟会话（run 只是这一次在用）");
  assert.match(ctl, /IDLE_TTL_S = 30 \* 60/, "浏览器保活 30 分钟");
  assert.match(ctl, /def user_gate/, "用户输入要过持有者闸");
  assert.match(ctl, /async def gate_agent/, "助手的动作要过同一道闸");
  assert.match(ctl, /def public_state/, "所有文案由后端一处给出");

  const session = py("browser_session.py");
  assert.match(session, /def get_session\(\s*run_id: str,[\s\S]{0,200}session_id: str = ""/, "get_session 要能按会话复用浏览器");
  assert.match(session, /def close_key/, "过期/删会话要能收掉整个浏览器");
});

test("run 结束不关浏览器（改回 close_all 就退回 v1 的病根）", () => {
  const svc = py("runner/service.py");
  assert.match(svc, /browser_control import on_run_end/, "run 收尾要交给控制权状态机");
  assert.doesNotMatch(svc, /browser_session import close_all/, "run 结束不该再杀浏览器");
});
