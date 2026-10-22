"use client";

import { useEffect } from "react";

/**
 * 首页 —— 直接去「Agent 执行」（唯一的干活入口）。
 * 保留跳转而不是留空页：老书签、外站引用、logo 上的 "/" 链接都不会 404。
 *
 * 这里**不能**用 next/navigation 的 redirect()：前端是 output:"export" 的静态
 * 导出，redirect 在构建期生成不了真正的跳转，只会落下一个 __next_error__ 页 ——
 * 从根路径进来看到的就是一张错误页。静态导出下用客户端跳转最稳。
 */
export default function HomePage() {
  useEffect(() => {
    window.location.replace("/exec");
  }, []);
  return (
    <div style={{ padding: 24, fontSize: 13, color: "var(--color-muted)" }}>
      正在打开…
    </div>
  );
}
