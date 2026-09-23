"use client";

/**
 * 助手详情（独立页面形态）。
 *
 * 实体在 components/AgentDetail.tsx —— 对话页里点「配置」弹出的浮层用的是
 * **同一份实现**（只是 inDialog=true）。改配置逻辑只需要改一处。
 */

import { useParams } from "next/navigation";
import { AgentDetail } from "@/components/AgentDetail";

export default function AgentEditorPage() {
  const params = useParams<{ id: string }>();
  return <AgentDetail agentId={params.id} />;
}
