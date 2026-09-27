"use client";

/**
 * 「Agent 执行」—— 对话式干活入口（对齐 Claude Code 的产品范式）。
 *
 * 架构对齐 AG-UI 语义（零依赖，不引 CopilotKit）：
 *   前端会话流 ⇄ SSE 事件流 ⇄ /api/runs/stream/{id} ⇄ runner 内核 ⇄ Ark
 *   think / tool_call / tool_result / text 事件与 AG-UI 的
 *   Thinking* / ToolCall* / TextMessage* 一一对应 —— 将来任何
 *   AG-UI 客户端都能直接消费这套事件流。
 *
 * 复用 ChatConsole（原 /chat 页主体）：sessions 多轮、实时事件分色、
 * HITL 就地确认、失败重试 —— 它们与 exec 是同一份数据的两个视图。
 */

import { useEffect, useState } from "react";
import { ChatConsole } from "@/components/ChatConsole";

export default function ExecPage() {
  /** 支持从别处「用这个助手跑一次」直接带过来：/exec?agent=<id>。
   *
   *  读 window.location 而不是 useSearchParams()：后者会把 /exec 从静态页
   *  改成动态渲染（还要额外套 Suspense 边界），为了一个查询参数不值得。
   *  放在 effect 里读也避免了服务端/客户端渲染不一致。 */
  const [agent, setAgent] = useState<string | undefined>(undefined);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("agent");
    if (id) setAgent(id);
  }, []);
  return <ChatConsole agentId={agent} />;
}
