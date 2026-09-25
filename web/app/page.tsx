import { redirect } from "next/navigation";

/**
 * 首页 —— **概览页已移除**（用户要求）。
 *
 * 这里保留一个**重定向**而不是留空页：
 *   · 老书签、外站引用、logo 上的 "/" 链接都不会变成 404
 *   · 产品收敛到"进来就干活"：直接去 Playground（唯一的编排 + 执行入口）
 */
export default function HomePage() {
  redirect("/playground");
}
