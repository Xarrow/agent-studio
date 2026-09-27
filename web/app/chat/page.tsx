/**
 * /chat —— 历史路径，重定向到 Agent 执行。
 * 留着这条路径只为老书签、老链接不失效。
 */

import { redirect } from "next/navigation";

export default function ChatPage() {
  redirect("/exec");
}
