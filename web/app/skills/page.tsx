/**
 * /skills —— 历史路径，重定向到「工具」页。
 *
 * Skills、工具、MCP 现在是同一页里的三个页签：它们对用户是同一件事
 * （"这个助手能干什么"），分成三个菜单只会让人先猜该点哪个。
 */

import { redirect } from "next/navigation";

export default function SkillsPage() {
  redirect("/tools");
}
