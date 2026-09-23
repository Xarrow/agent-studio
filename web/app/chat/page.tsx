/**
 * 对话 —— 单 Agent 对话 / 多 Agent 编排，同一个工作台。
 *
 * 两个模式原来分别是 /chat 和 /playground 两个页面，现已合并到
 * components/ConversationWorkbench.tsx（合并理由写在那里）。
 *
 * /playground 也保留着（预设为编排模式），老书签不失效。
 */

import { ConversationWorkbench } from "@/components/ConversationWorkbench";

export const metadata = { title: "对话 · Agent Studio" };

export default function ChatPage() {
  return <ConversationWorkbench initialMode="chat" />;
}
