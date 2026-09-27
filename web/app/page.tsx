import { redirect } from "next/navigation";

/**
 * 首页 —— 直接去「Agent 执行」（唯一的干活入口）。
 * 保留重定向而不是留空页：老书签、外站引用、logo 上的 "/" 链接都不会 404。
 */
export default function HomePage() {
  redirect("/exec");
}
