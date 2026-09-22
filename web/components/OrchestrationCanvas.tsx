"use client";

/**
 * 编排区 —— 选模式、把助手拖进槽位、勾选数据传递。
 *
 * 交互设计（两条通道，桌面和手机各取所需）
 * ----------------------------------------
 *  ・**桌面**：从下面的助手栏把卡片**拖**进槽位（原生 HTML5 拖放，零依赖）
 *  ・**手机**：拖放在触摸屏上不可靠，所以卡片也能**点一下**直接填进第一个空槽
 * 两条通道等价，不强迫任何一侧的用户改变习惯。
 *
 * 为什么是"槽位"而不是自由画布
 * ---------------------------
 * 自由连线（LangFlow 那种）要先理解「节点 / 边 / 变量传递」三个概念才能动手。
 * 而这里的协作只有四种固定形态，用槽位表达更直接：选一个模式，槽位自己就长好了。
 */

import type { Agent, OrchestrationMode, OrchStep } from "@/lib/types";

/** 四种执行方式（顺序即推荐顺序：从最简单到最复杂） */
const MODES: { key: OrchestrationMode; label: string; desc: string; icon: string }[] = [
  { key: "single", label: "单个助手", desc: "一个助手干完这件事", icon: "▲" },
  { key: "serial", label: "串行", desc: "按顺序接力，可决定要不要把上一步的结果带下去", icon: "→" },
  { key: "parallel", label: "并行", desc: "几个助手同时开工，各自给一版", icon: "⇉" },
  { key: "master_worker", label: "主从", desc: "主控拆任务 → 干活的做 → 主控汇总出最终结果", icon: "★" },
];

/** 一个空槽位：虚线框，提示"拖到这里" */
function Slot({
  index,
  agent,
  carryPrev,
  showCarry,
  onDropAgent,
  onClear,
  onToggleCarry,
  label,
  role,
}: {
  index: number;
  agent: Agent | null;
  carryPrev: boolean;
  showCarry: boolean;
  onDropAgent: (agentId: string, slot: number) => void;
  onClear: () => void;
  onToggleCarry: () => void;
  label?: string;
  role?: "master" | "worker";
}) {
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.currentTarget.dataset.over = "1";
      }}
      onDragLeave={(e) => {
        delete e.currentTarget.dataset.over;
      }}
      onDrop={(e) => {
        e.preventDefault();
        delete e.currentTarget.dataset.over;
        const id = e.dataTransfer.getData("text/agent-id");
        if (id) onDropAgent(id, index);
      }}
      className="rounded-lg p-3 min-w-[150px] flex-1 transition-colors"
      style={{
        background: agent ? "var(--color-surface)" : "transparent",
        border: agent
          ? `1px solid ${role === "master" ? "var(--color-accent)" : "var(--color-border)"}`
          : "1.5px dashed var(--color-border)",
      }}
    >
      {/* 角色/序号标题 */}
      <div className="flex items-center gap-1.5 mb-1.5">
        {role === "master" && (
          <span
            className="text-[10.5px] px-1.5 py-0.5 rounded"
            style={{
              background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
              color: "var(--color-accent)",
            }}
          >
            主控
          </span>
        )}
        <span className="text-[11px] text-[var(--color-muted)]">
          {label ?? `第 ${index + 1} 步`}
        </span>
      </div>

      {agent ? (
        <>
          <div className="text-[13.5px] font-medium truncate" title={agent.name}>
            {agent.name}
          </div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <button
              className="text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-err)]"
              onClick={onClear}
            >
              移出
            </button>
          </div>
          {/* 串行模式：这一步要不要接收上一步的产出（用户逐项选择） */}
          {showCarry && (
            <label className="flex items-start gap-1.5 mt-2 pt-2 border-t border-[var(--color-border)] cursor-pointer">
              <input
                type="checkbox"
                className="mt-[3px] shrink-0"
                checked={carryPrev}
                onChange={onToggleCarry}
              />
              <span className="text-[11.5px] leading-snug text-[var(--color-muted)]">
                把上一步的结果一并交给它
              </span>
            </label>
          )}
        </>
      ) : (
        <div className="text-[12.5px] text-[var(--color-muted)] py-1.5 leading-snug">
          拖助手到这里
          <br />
          <span className="text-[11px]">（或点下面的助手）</span>
        </div>
      )}
    </div>
  );
}

export function OrchestrationCanvas({
  mode,
  onModeChange,
  workerMode,
  onWorkerModeChange,
  agents,
  masterId,
  onMasterChange,
  slots,
  onSlotsChange,
}: {
  mode: OrchestrationMode;
  onModeChange: (m: OrchestrationMode) => void;
  workerMode: "serial" | "parallel";
  onWorkerModeChange: (m: "serial" | "parallel") => void;
  agents: Agent[];
  masterId: string | null;
  onMasterChange: (id: string | null) => void;
  slots: (OrchStep | null)[];
  onSlotsChange: (s: (OrchStep | null)[]) => void;
}) {
  const byId = new Map(agents.map((a) => [a.id, a]));

  const fillSlot = (agentId: string, idx: number) => {
    const next = [...slots];
    // 同一个助手不能占两个槽（否则"两个助手同时跑"其实是同一个跑两次）
    const dup = next.findIndex((s) => s?.agent_id === agentId);
    if (dup >= 0) next[dup] = null;
    next[idx] = { agent_id: agentId, carry_prev: next[idx]?.carry_prev ?? false };
    onSlotsChange(next);
  };

  const isMasterMode = mode === "master_worker";
  const isSerial = mode === "serial" || (isMasterMode && workerMode === "serial");

  /** 主从模式：主控槽位 + 干活槽位分别渲染 */
  return (
    <div className="space-y-4">
      {/* ── ① 执行方式 ─────────────────────────────────────────── */}
      <div>
        <div className="label mb-2">执行方式</div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {MODES.map((m) => {
            const on = mode === m.key;
            return (
              <button
                key={m.key}
                onClick={() => onModeChange(m.key)}
                className="text-left rounded-lg p-2.5 transition-colors"
                style={{
                  background: on
                    ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
                    : "var(--color-surface)",
                  border: `1px solid ${on ? "var(--color-accent)" : "var(--color-border)"}`,
                }}
              >
                <div
                  className="text-[13px] font-medium mb-0.5"
                  style={{ color: on ? "var(--color-accent)" : "var(--color-text)" }}
                >
                  {m.icon} {m.label}
                </div>
                <div className="text-[11.5px] leading-snug text-[var(--color-muted)]">
                  {m.desc}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── ② 编排槽位 ─────────────────────────────────────────── */}
      <div>
        <div className="label mb-2">编排</div>

        {/* 主从：主控单独一行，明确它是"指挥的" */}
        {isMasterMode && (
          <div className="mb-3">
            <div className="flex items-stretch gap-2">
              <Slot
                index={-1}
                agent={masterId ? byId.get(masterId) ?? null : null}
                carryPrev={false}
                showCarry={false}
                label="指挥整场"
                role="master"
                onDropAgent={(id) => onMasterChange(id)}
                onClear={() => onMasterChange(null)}
                onToggleCarry={() => {}}
              />
            </div>
            <div className="flex items-center gap-2 mt-2 ml-3">
              <div
                className="w-px h-5"
                style={{ background: "var(--color-border)" }}
              />
              <span className="text-[11.5px] text-[var(--color-muted)]">
                拆任务 ↓ 汇总结果 ↑（主控会跑两次：先拆、最后汇总）
              </span>
            </div>
            {/* 干活的之间怎么跑 */}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="text-[11.5px] text-[var(--color-muted)]">干活的：</span>
              {(["parallel", "serial"] as const).map((wm) => (
                <button
                  key={wm}
                  onClick={() => onWorkerModeChange(wm)}
                  className="text-[11.5px] px-2 py-1 rounded"
                  style={{
                    background:
                      workerMode === wm
                        ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                        : "var(--color-surface-2)",
                    color: workerMode === wm ? "var(--color-accent)" : "var(--color-muted)",
                  }}
                >
                  {wm === "parallel" ? "⇉ 同时开工" : "→ 依次接力"}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 干活槽位 */}
        <div className="flex items-stretch gap-2 flex-wrap">
          {slots.map((s, i) => (
            <Slot
              key={i}
              index={i}
              {...(isMasterMode ? { label: `干活 ${i + 1}` } : {})}
              agent={s ? byId.get(s.agent_id) ?? null : null}
              carryPrev={s?.carry_prev ?? false}
              showCarry={isSerial && i > 0}
              onDropAgent={fillSlot}
              onClear={() => {
                const next = [...slots];
                next[i] = null;
                onSlotsChange(next);
              }}
              onToggleCarry={() => {
                const next = [...slots];
                if (next[i]) {
                  next[i] = { ...next[i]!, carry_prev: !next[i]!.carry_prev };
                  onSlotsChange(next);
                }
              }}
            />
          ))}

          {/* 加一个槽位（单个助手模式不允许加） */}
          {mode !== "single" && slots.length < 8 && (
            <button
              onClick={() => onSlotsChange([...slots, null])}
              className="rounded-lg px-3 min-w-[86px] text-[12.5px] text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors"
              style={{ border: "1.5px dashed var(--color-border)" }}
            >
              + 加一个
            </button>
          )}
        </div>

        {isSerial && slots.length > 1 && (
          <p className="text-[11.5px] text-[var(--color-muted)] mt-2 leading-relaxed">
            每个助手下方可以单独勾选「把上一步的结果一并交给它」——
            不勾就是让它独立完成原任务。
          </p>
        )}
      </div>
    </div>
  );
}

/** 助手栏：可拖（桌面）+ 可点（手机） */
export function AgentTray({
  agents,
  onPick,
  disabled,
}: {
  agents: Agent[];
  onPick: (agentId: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="label mb-2">可用的助手</div>
      <div className="flex gap-2 flex-wrap">
        {agents.map((a) => (
          <div
            key={a.id}
            draggable={!disabled}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/agent-id", a.id);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => !disabled && onPick(a.id)}
            title={disabled ? undefined : "拖到上面的槽位，或点一下自动填入"}
            className="rounded-lg px-3 py-2 cursor-grab active:cursor-grabbing select-none transition-colors hover:border-[var(--color-accent)]"
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <div className="text-[13px] font-medium">▲ {a.name}</div>
            {a.description && (
              <div className="text-[11px] text-[var(--color-muted)] mt-0.5 max-w-[190px] truncate">
                {a.description}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
