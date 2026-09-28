"use client";

/**
 * 助手详情（查询参数形态）。
 *
 * 为什么不是 /agents/[id] 动态路由：前端是**静态导出**（部署机不依赖 Node，
 * FastAPI 同进程托管 out/），动态段要么预枚举要么走 generateStaticParams ——
 * id 来自数据库、不可枚举，所以详情页用 ?id= 查询参数。
 *
 * 读 window.location 而不是 useSearchParams()：后者会把本页从静态页改成
 * 动态渲染（还要额外套 Suspense 边界），为了一个查询参数不值得。
 *
 * 实体在 components/AgentDetail.tsx —— 对话页里点「配置」弹出的浮层用的是
 * **同一份实现**（只是 inDialog=true）。改配置逻辑只需要改一处。
 */

import { useEffect, useState } from "react";
import { AgentDetail } from "@/components/AgentDetail";

export default function AgentEditorPage() {
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) setAgentId(id);
  }, []);
  if (!agentId) {
    return (
      <div className="p-4 md:p-6 lg:p-7 max-w-5xl">
        <p className="text-[13px]" style={{ color: "var(--color-muted)" }}>
          URL 里没有助手 id —— 从助手列表页的「配置」进入。
        </p>
      </div>
    );
  }
  return <AgentDetail agentId={agentId} />;
}
