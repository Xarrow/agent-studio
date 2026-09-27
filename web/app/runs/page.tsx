"use client";

/**
 * 「管理」页 —— 全部流程 + 全部运行记录在同一页。
 * 画布已退役（Playground → Agent 执行）：这里不再跳画布，
 * 流程数据与执行记录仅作历史查看；新建编排走「Agent 执行」对话。
 */

import { useCallback, useEffect, useState } from "react";
import { WorkflowManager } from "@/components/WorkflowManager";
import { api } from "@/lib/api";
import type { Agent } from "@/lib/types";

export default function ManagePage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  /** 组件自己拉流程列表 —— 改名/复制/删除之后靠这个把列表重挂一次，避免"操作完列表不动" */
  const [ver, setVer] = useState(0);
  const reload = useCallback(() => setVer((v) => v + 1), []);

  useEffect(() => {
    void api.agents().then(setAgents);
  }, []);

  return (
    <div className="p-4 md:p-6 lg:p-7">
      <WorkflowManager
        key={ver}
        open
        variant="page"
        currentId={null}
        agents={agents}
        onClose={() => {}}
        onDuplicate={() => reload()}
        onDeleted={() => reload()}
        onRenamed={() => reload()}
      />
    </div>
  );
}
