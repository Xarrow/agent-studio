/**
 * 对话 —— 单助手对话与多助手编排，同一个界面。
 *
 * 早期这两件事是两个页面（/chat 和 /playground），后来合到一页但留着模式切换，
 * 现在连那道切换也去掉：**参与者本身决定它是对话还是编排**。
 * 实现与理由写在 components/ConversationConsole.tsx。
 */

import { ConversationConsole } from "@/components/ConversationConsole";

export const metadata = { title: "对话 · Agent Studio" };

export default function ChatPage() {
  return <ConversationConsole />;
}
