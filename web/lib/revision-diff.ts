/**
 * 版本差异的可读化（纯函数，可单测）
 * =================================
 *
 * 后端给的是字段路径（`definition.model.name`）与两份原始值。直接把这两样
 * 摆出来，用户要自己做三件事：知道这个路径是什么意思、把 JSON 在脑子里比、
 * 猜哪边是新的。这里把它压成"一句人话 + 一行一个字段"，界面上才能一眼看懂。
 *
 * 刻意不做文本 diff：快照是结构化的，字段级差异信息量更高；
 * 提示词那种长文本用等宽块并排显示旧/新，比行级 +/- 更利于逐字核对。
 */

/** 后端差异项 */
export type RevChange = {
  path: string;
  before?: unknown;
  after?: unknown;
  added?: string[];
  removed?: string[];
};

/** 字段路径 → 界面上的中文名（认不出的保留路径，至少能定位） */
const LABELS: Array<[RegExp, string]> = [
  [/^name$/, "名字"],
  [/^description$/, "一句话职责"],
  [/^runtime$/, "运行时"],
  [/^definition\.system_prompt$/, "系统提示词"],
  [/^definition\.role$/, "流程里的角色"],
  [/^definition\.orchestrator_brief$/, "编排者职责"],
  [/^definition\.model\.name$/, "模型"],
  [/^definition\.model\.provider$/, "服务商"],
  [/^definition\.model\.base_url$/, "接口地址"],
  [/^definition\.model\.params\./, "模型参数"],
  [/^definition\.limits\./, "上限"],
  [/^definition\.runtime_options\./, "运行时选项"],
  [/^tool_names$/, "工具"],
  [/^skill_names$/, "Skill"],
  [/^graph\.nodes$/, "步骤"],
  [/^graph\.edges$/, "连线"],
  [/^mode_override$/, "执行方式"],
];

export function fieldLabel(path: string): string {
  for (const [re, label] of LABELS) {
    if (re.test(path)) return label;
  }
  // 认得前缀的，用"前缀名 · 尾巴"（例如 definition.params.foo → 其它参数 · foo）
  const tail = path.split(".").pop() || path;
  return tail;
}

/** 值 → 界面文本：字符串原样（保留换行），数组逗号连，对象紧凑 JSON */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "（空）";
  if (typeof v === "string") return v === "" ? "（空）" : v;
  if (typeof v === "boolean") return v ? "开" : "关";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "（无）";
    return v
      .map((x) => {
        if (typeof x === "string") return x;
        // 工具/Skill 引用形如 {ref: "t_fetch"} —— 只显示 ref，别糊 JSON 给用户
        if (x && typeof x === "object" && typeof (x as { ref?: unknown }).ref === "string") {
          return (x as { ref: string }).ref;
        }
        return JSON.stringify(x);
      })
      .join("、");
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 0) return "（无）";
    // {ref: "t_x", enabled: true} 这种只想要 ref
    if (keys.length <= 2 && typeof o.ref === "string") return o.ref;
    return JSON.stringify(o);
  }
  return String(v);
}

/** 一行差异：字段名 + 旧值 + 新值（关系字段额外给出增删） */
export type RevRow = {
  label: string;
  before: string;
  after: string;
  added?: string[];
  removed?: string[];
};

export function diffRows(changes: RevChange[]): RevRow[] {
  return (changes || []).map((c) => ({
    label: fieldLabel(c.path),
    before: formatValue(c.before),
    after: formatValue(c.after),
    added: c.added,
    removed: c.removed,
  }));
}

/** 太长的值先给个摘要，展开再看全文（提示词动辄几千字） */
export function clip(s: string, n = 240): string {
  const t = s.replace(/\s+$/, "");
  return t.length <= n ? t : `${t.slice(0, n)}…（共 ${t.length} 字，点开看全文）`;
}
