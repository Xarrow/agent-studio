/**
 * 给用户的文字净化 —— 框架的「内部话术」不能原样甩到聊天窗口里。
 *
 * 现场：AgentScope 被取消时会把这一轮的回答替换成一句英文
 *   "I notice the interruption. How can I help you?"
 * 这句话是**给模型的**（它自己用来确认"我被中断了"），不是给人看的。
 * 老数据里已经落了 9 条，翻译/改库之外，前端再兜一层：看到就换成能看懂的中文。
 */

/** 框架补的那句「我注意到中断了」（大小写/多余空白都容错） */
const FRAMEWORK_INTERRUPTION = /^i notice the interruption[\s\S]*$/i;

/** 中文替代：说清发生了什么 + 下一步能做什么（不出现第二个术语） */
export const INTERRUPTED_NOTICE =
  "这一轮被中断，没有产出。可以让我接着做。";

/**
 * 助手消息出厂前过一道：把框架内部话术换成中文说明。
 * 只动「整条就是那句话」的情况 —— 正文里偶尔引用这个英文短语不去改它。
 */
export function humanizeAssistantText(text: string): string {
  const t = (text || "").trim();
  if (!t) return text;
  if (FRAMEWORK_INTERRUPTION.test(t) && t.length < 200) return INTERRUPTED_NOTICE;
  return text;
}
