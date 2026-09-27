/**
 * /playground —— 画布已退役，重定向到 Agent 执行。
 * 老书签 / 老深链（?wf= / ?history= / ?new=）统一落到对话式执行。
 */

import { redirect } from "next/navigation";

export default function PlaygroundPage() {
  redirect("/exec");
}
