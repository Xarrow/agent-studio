/**
 * /chat —— 历史路径，重定向到 Playground。
 *
 * 「对话」不再是一个独立入口：它只是"画布上只有一个助手"的那种情况。
 * 留着这条路径只为老书签、老链接不失效。
 */

import { redirect } from "next/navigation";

export default function ChatPage() {
  redirect("/playground");
}
