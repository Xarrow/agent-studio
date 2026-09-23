/**
 * Playground —— 历史路径，只为老书签不失效。
 *
 * 功能和 /chat 完全一样（同一个 ConversationConsole）：现在"编排"不是一个模式，
 * 而是"参与者多于一个"的自然结果，所以这个路径没有自己的界面了。
 * 侧边栏早已不再单独列它。
 */

import { ConversationConsole } from "@/components/ConversationConsole";

export const metadata = { title: "对话 · Agent Studio" };

export default function PlaygroundPage() {
  return <ConversationConsole />;
}
