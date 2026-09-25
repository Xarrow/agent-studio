"use client";

/**
 * 「管理」页 —— **全部流程 + 全部运行记录合并在一处**（用户要求：
 * "管理全部流程和 runs 页面功能合并"）。
 *
 * 为什么合并
 * ----------
 * 原来这是两个入口：Runs 页看执行记录，Playground 顶栏「流程」浮层管理流程 ——
 * 而"这条流程跑过几次、那次是怎么走的"本来就是一回事，分成两处就得来回跳 ✗。
 *
 * 现在：左边一处选择
 *   · 「全部运行记录」（置顶）→ 右侧是原来 Runs 页那张表（类型筛选/搜索/批量删除/清理/清空 + 详情弹框）
 *   · 某条流程              → 右侧是它的骨架 + 每次执行一张卡（含「就地回放」）
 * 头部动作（新建/重命名/复制/删除/打开到画布）作用于"当前选中的那条流程"。
 *
 * 同一份组件（WorkflowManager）在 Playground 顶栏「流程」里以浮层形态复用 ——
 * 一处能力、两个入口，不写两遍。
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import type { Agent, Workflow } from "@/lib/types";
import { WorkflowManager } from "@/components/WorkflowManager";

export default function ManagePage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  /** 变更后让面板重挂载一次 = 重新拉列表（面板内部自己加载，不暴露 reload） */
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    void (async () => {
      try {
        setAgents(await api.agents());
      } catch {
        /* 拉不到就用空列表，面板里显示"助手"占位 */
      }
    })();
  }, []);

  return (
    <div className="p-4 md:p-6 lg:p-7">
      <WorkflowManager
        key={tick}
        open
        variant="page"
        agents={agents}
        onClose={() => {}}
        onOpenWorkflow={(w: Workflow) => router.push(`/playground?wf=${w.id}`)}
        onNew={() => router.push("/playground")}
        onDuplicate={(w: Workflow) =>
          void (async () => {
            try {
              await api.createWorkflow({
                name: `${w.name || "未命名编排"} 副本`,
                description: w.description ?? "",
                graph: w.graph,
              });
              reload();
            } catch {
              /* 失败就留在原页，列表不刷新 */
            }
          })()
        }
        onDeleted={reload}
        onRenamed={reload}
        onReplay={(orcId: string) => router.push(`/playground?history=${orcId}`)}
      />
    </div>
  );
}
