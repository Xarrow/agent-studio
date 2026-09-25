"use client";

/**
 * /runs 旧路径 → 直接进 Playground 的「流程管理」。
 *
 * 为什么改（用户问："管理功能为什么和其他类型分割？"）
 * ------------------------------------------------
 * 流程管理 + 运行记录本来是**画布这件事的一部分** —— 它被做成了一个独立的导航"类型"，
 * 于是同一件事有了两个入口（Playground 顶栏「流程」+ 导航「管理」）✗。
 * 按"能合并的入口就合并、能就地就不跳页"的准则：只保留 **Playground 内的那一处**
 * （顶栏「流程」→ 全部流程 + 每次执行 + 点步骤看这一步的执行详情 + 全部运行记录），
 * 这个旧 URL 保留为重定向，老链接不失效 ✓。
 * 需要整页形态时把 WorkflowManager 的 variant 传 "page" 即可（组件仍支持，一行的事）。
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function RunsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/playground?manage=1");
  }, [router]);
  return (
    <div className="p-6 text-[13px]" style={{ color: "var(--color-muted)" }}>
      正在打开流程管理…
    </div>
  );
}
