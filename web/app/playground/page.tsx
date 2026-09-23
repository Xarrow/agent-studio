/**
 * Playground —— 编排工作台。
 *
 * 这里是**唯一**干活的入口：一个节点是跟一个助手聊，多个节点就是编排。
 * 原来的「对话」菜单已经并进来（/chat 会重定向到这里），所以侧边栏不再有
 * 「对话 / Playground」两道门 —— 否则又变成"先选页面、再选摆几个助手"。
 *
 * 实现与设计理由写在 components/PlaygroundConsole.tsx。
 */

import { PlaygroundConsole } from "@/components/PlaygroundConsole";

export const metadata = { title: "Playground · Agent Studio" };

export default function PlaygroundPage() {
  return <PlaygroundConsole />;
}
