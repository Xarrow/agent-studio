/**
 * Playground —— 保留的入口，直接进「多 Agent 编排」模式。
 *
 * 功能已合并进 components/ConversationWorkbench.tsx（和 /chat 是同一个工作台）。
 * 这个路径保留下来只为**老书签不失效**：它和 /chat 点一下「多 Agent 编排」
 * 是完全一样的界面。侧边栏已不再单独列它。
 */

import { ConversationWorkbench } from "@/components/ConversationWorkbench";

export const metadata = { title: "编排 · Agent Studio" };

export default function PlaygroundPage() {
  return <ConversationWorkbench initialMode="orchestration" />;
}
