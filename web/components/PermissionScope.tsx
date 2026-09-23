"use client";

/**
 * 权限 scope 编辑器 —— 「工具执行前要不要先问一句」。
 *
 * 为什么需要它
 * ----------
 * AgentScope 的权限引擎默认**每个操作都要人确认**，而"确认"需要有人在运行中途
 * 点同意。平台目前没有中途审批的界面 —— 于是运行会停在等待确认上，模型只能输出
 * "我在等你的许可"。用户看到的是"卡住了"。
 *
 * 所以这里让用户**事先划定范围**：范围内直接放行，范围外用规则单独处理。
 *
 * 设计取舍
 * ------
 * · 模式用**下拉选**，并把每个模式的后果直接写在下面（尤其「每个都问」会卡住、
 *   「全部放行」危险）—— 这是让用户在**知情**的前提下选，而不是靠猜。
 * · 例外规则用**一张表**（工具 / 匹配 / 行为），而不是拆成"允许""拒绝""询问"三个
 *   列表 —— 用户想的是"这条规则怎么处理"，而不是"它属于哪个类别"。保存时才分流。
 * · 工具名用平台自己的叫法（bash/read/write），**翻译由后端做**（AgentScope 内部
 *   叫 Bash/Read/Write）—— 不让用户去记大小写。
 */

import { Hint } from "@/components/ui/hint";

export type PermRule = { tool: string; pattern?: string; behavior: "allow" | "deny" | "ask" };
export type PermConf = { mode?: string; allow?: Omit<PermRule, "behavior">[]; deny?: Omit<PermRule, "behavior">[]; ask?: Omit<PermRule, "behavior">[] };

/** 模式：值 / 名字 / 一句话说清后果 */
const MODES: { value: string; label: string; desc: string; warn?: string }[] = [
  {
    value: "accept_edits",
    label: "允许改工作目录内的文件（推荐）",
    desc: "工作目录内的读写直接执行；越出工作目录才需要确认。",
  },
  {
    value: "explore",
    label: "只读：能看不能改",
    desc: "允许 Read / Grep / Glob 等只读操作；任何修改一律拒绝。",
  },
  {
    value: "dont_ask",
    label: "需要确认的一律拒绝（不卡住）",
    desc: "把「要问一句」的操作直接判为拒绝。适合无人值守。",
    warn: "助手会因权限不足而放弃某些操作，表现为「做不了」，而不是卡住。",
  },
  {
    value: "default",
    label: "严格：每个操作都要确认",
    desc: "AgentScope 的原生默认，最保守。",
    warn: "平台目前没有「运行中途点同意」的界面 —— 选这个，助手一遇到需要确认的操作就会停在那里等，你会看到它在说「我在等你的许可」。",
  },
  {
    value: "bypass",
    label: "全部放行（危险）",
    desc: "跳过所有权限检查，只保留你显式写的拒绝规则。",
    warn: "连删除文件、改 ~/.bashrc 这类危险操作也不再拦。只在沙箱/容器里用。",
  },
];

const BEHAVIORS: { value: PermRule["behavior"]; label: string }[] = [
  { value: "allow", label: "允许" },
  { value: "deny", label: "拒绝" },
  { value: "ask", label: "先问" },
];

/** 数据库里存的是三段（allow/deny/ask），界面上是一张表 —— 这里来回转 */
function toRows(conf: PermConf): PermRule[] {
  const out: PermRule[] = [];
  for (const b of ["allow", "deny", "ask"] as const) {
    for (const r of conf[b] ?? []) out.push({ tool: r.tool, pattern: r.pattern, behavior: b });
  }
  return out;
}

function fromRows(mode: string, rows: PermRule[]): PermConf {
  const conf: PermConf = { mode };
  for (const b of ["allow", "deny", "ask"] as const) {
    const picked = rows
      .filter((r) => r.behavior === b && r.tool.trim())
      .map((r) => (r.pattern?.trim() ? { tool: r.tool.trim(), pattern: r.pattern.trim() } : { tool: r.tool.trim() }));
    if (picked.length) conf[b] = picked;
  }
  return conf;
}

export function PermissionScope({
  conf,
  onChange,
  toolNames,
}: {
  conf: PermConf | undefined;
  onChange: (next: PermConf) => void;
  /** 这个助手挂了哪些工具（平台侧名字）—— 规则只能针对它有的工具，才有意义 */
  toolNames: string[];
}) {
  const cur = conf ?? {};
  const mode = cur.mode || "accept_edits";
  const rows = toRows(cur);
  const meta = MODES.find((m) => m.value === mode);

  const setMode = (v: string) => onChange(fromRows(v, rows));
  const setRows = (next: PermRule[]) => onChange(fromRows(mode, next));

  return (
    <div className="mt-4 pt-4 border-t border-[var(--color-border)]">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[12.5px] font-medium">权限</span>
        <Hint text="工具执行前的许可范围。范围内的操作直接执行，不用每次都问你。">
          <span className="text-[11.5px] text-[var(--color-muted)]">工具执行前的许可范围</span>
        </Hint>
      </div>

      <select className="input w-full" value={mode} onChange={(e) => setMode(e.target.value)}>
        {MODES.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>

      {meta && (
        <p className="text-[11.5px] text-[var(--color-muted)] mt-1.5">{meta.desc}</p>
      )}
      {meta?.warn && (
        <p
          className="text-[11.5px] mt-1.5 rounded-md px-2 py-1.5"
          style={{
            background: "color-mix(in srgb, var(--color-warn) 10%, transparent)",
            color: "var(--color-warn)",
          }}
        >
          ⚠ {meta.warn}
        </p>
      )}

      {/* 例外规则 */}
      <div className="flex items-center justify-between mt-3 mb-1.5">
        <span className="text-[11.5px] text-[var(--color-muted)]">例外规则（可选）</span>
        <button
          className="text-[11.5px] text-[var(--color-accent)] hover:underline"
          onClick={() =>
            setRows([...rows, { tool: toolNames[0] ?? "", pattern: "", behavior: "deny" }])
          }
          disabled={toolNames.length === 0}
          title={toolNames.length === 0 ? "先在上面勾选工具" : "加一条例外规则"}
        >
          + 加一条
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-[11.5px] text-[var(--color-muted)]">
          {toolNames.length === 0
            ? "这个助手还没挂工具 —— 先在上面勾选工具，再来划权限。"
            : "没有例外规则：按上面的模式统一处理。"}
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-1.5 flex-wrap">
              <select
                className="input flex-1 min-w-[110px] text-[12px]"
                value={r.tool}
                onChange={(e) =>
                  setRows(rows.map((x, j) => (j === i ? { ...x, tool: e.target.value } : x)))
                }
              >
                {toolNames.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
                {r.tool && !toolNames.includes(r.tool) && <option value={r.tool}>{r.tool}</option>}
              </select>
              <input
                className="input flex-1 min-w-[110px] text-[12px]"
                value={r.pattern ?? ""}
                placeholder="匹配（可留空）"
                title="Bash 填命令片段（如 npm install）；Read/Write 填路径（如 src/**）"
                onChange={(e) =>
                  setRows(rows.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))
                }
              />
              <select
                className="input w-[84px] text-[12px]"
                value={r.behavior}
                onChange={(e) =>
                  setRows(
                    rows.map((x, j) =>
                      j === i ? { ...x, behavior: e.target.value as PermRule["behavior"] } : x,
                    ),
                  )
                }
              >
                {BEHAVIORS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
              <button
                className="text-[13px] px-1 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
                title="删掉这条"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
