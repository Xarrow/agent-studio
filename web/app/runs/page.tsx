"use client";

/**
 * 「管理」页 —— **全部流程 + 全部运行记录在同一页**
 *（用户原话："管理全部流程和 runs 页面功能合并"；后来补一句"我们管理的菜单栏没有了"→ 导航项保留）
 *
 * 两种形态、同一份组件（WorkflowManager），不写两遍：
 *   · 从导航「管理」进来  → 整页（variant="page"）：你是来管理的，给足空间、能看全；
 *   · 从画布顶栏「流程」进来 → 浮层（variant="overlay"）：你正在编排，就地打开、不跳页。
 *
 * 页面模式下"需要在画布上做的事"（新建 / 复制后打开 / 就地回放）统一跳到 Playground，
 * 通过深链把意图带过去（?new=1 / ?wf=<id> / ?history=<id>）—— 不在管理页里再长一个画布。
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { WorkflowManager } from "@/components/WorkflowManager";
import { api } from "@/lib/api";
import type { Agent } from "@/lib/types";

export default function ManagePage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  /** 组件自己拉流程列表 —— 改名/复制/删除之后靠这个把列表重挂一次，避免"操作完列表不动" */
  const [ver, setVer] = useState(0);
  const reload = useCallback(() => setVer((v) => v + 1), []);

  useEffect(() => {
    void api.agents().then(setAgents);
  }, []);

  return (
    <div className="h-full">
      <WorkflowManager
        key={ver}
        open
        variant="page"
        currentId={null}
        agents={agents}
        onClose={() => router.push("/playground")}
        onOpenWorkflow={(w) => router.push(`/playground?wf=${w.id}`)}
        onNew={() => router.push("/playground?new=1")}
        onDuplicate={() => reload()}
        onDeleted={() => reload()}
        onRenamed={() => reload()}
        onReplay={(orcId) => router.push(`/playground?history=${orcId}`)}
      />
    </div>
  );
}
