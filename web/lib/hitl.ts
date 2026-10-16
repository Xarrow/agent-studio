/**
 * 授权请求（HITL）的判定与人话翻译 —— 纯函数，可单测
 * ==================================================
 *
 * 运行中途停下来等用户点头时，事件里给的是一串工具名 + 原始 JSON 入参。
 * 直接把 `{"command": "rm -rf /tmp/x"}` 摆给用户看，等于让他自己去审代码。
 * 这里负责三件事：
 *
 *   1. **说人话**：`Bash` → 「执行命令」，参数里挑出要害那一个（command /
 *      file_path / url / query），而不是把整个 JSON 摊开。
 *   2. **分风险**：危险操作（删库、提权、覆写磁盘、`curl | sh`、强推远端…）
 *      要单独标红，并要求**二次确认** —— 用户点第一下是「我要允许」，
 *      点第二下才是「我知道它危险，执行」。
 *   3. **敏感路径**：写/改工作目录以外的文件（/etc、/root、系统目录）
 *      也算风险 —— 助手的活动范围本该在自己的工作目录里。
 *
 * 判定要基于**工具名 + 参数**，不能只看工具名：`Bash` 既能 `ls` 也能
 * `rm -rf /`，一刀切会把正常操作也标成危险（那样用户很快就会无视红色）。
 */

/** 事件里的 tool_calls[].input 可能是对象，也可能是 JSON 字符串 */
export function parseToolInput(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null; // 不是 JSON：交给调用方按原文显示
    }
  }
  return null;
}

type ToolCall = { id?: string; name?: string; input?: unknown };

/** 工具名 → 中文动作。认不出就原样显示（不硬猜） */
const TOOL_LABELS: Record<string, string> = {
  bash: "执行命令",
  shell: "执行命令",
  execute: "执行命令",
  run_command: "执行命令",
  cmd: "执行命令",
  terminal: "执行命令",
  pythonrepl: "执行代码",
  python: "执行代码",
  ipython: "执行代码",
  notebook: "执行代码",
  read: "读取文件",
  readfile: "读取文件",
  write: "写入文件",
  writefile: "写入文件",
  edit: "修改文件",
  str_replace: "修改文件",
  multiedit: "修改文件",
  glob: "查找文件",
  grep: "搜索内容",
  websearch: "联网搜索",
  webfetch: "访问网址",
  fetch: "访问网址",
  browser: "操作浏览器",
  browseruse: "操作浏览器",
  playwright: "操作浏览器",
  todowrite: "更新任务清单",
  task: "派发子任务",
};

export function toolLabel(name: string | undefined): string {
  const raw = (name ?? "").trim();
  if (!raw) return "未知工具";
  // 命名空间形式：mcp__github__create_issue / plugin/tool
  const short = raw.split(/[\/.]/).pop() ?? raw;
  const last = short.includes("__") ? (short.split("__").pop() ?? short) : short;
  const key = last.toLowerCase().replace(/[^a-z_]/g, "");
  return TOOL_LABELS[key] ?? raw;
}

/** 参数里最能说明"它要干什么"的那个键（按要命程度排序） */
const KEY_PRIORITY = [
  "command",
  "cmd",
  "script",
  "file_path",
  "path",
  "filename",
  "url",
  "query",
  "pattern",
  "text",
];

export type CallView = {
  /** 原始工具名（原样，用于排查） */
  raw: string;
  /** 中文动作：「执行命令」 */
  label: string;
  /** 要害参数：`command: rm -rf /tmp/x` */
  detail: string;
  /** 完整入参（展开看用），JSON 字符串 */
  full: string;
  /** 风险提示（null = 没看出风险） */
  risk: { level: "danger" | "caution"; reason: string } | null;
};

/** 危险命令指纹：命中即标红并二次确认 */
const DANGER_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\*|\.\.)/, reason: "递归删除文件/目录" },
  { re: /\bsudo\b|\bsu\s+-/, reason: "需要提权（sudo）" },
  { re: /\bmkfs(\.\w+)?\b|\bdd\s+if=/, reason: "会覆写磁盘" },
  { re: />\s*\/dev\/(sd|nvme|hd)/, reason: "直接写裸设备" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "会让机器关机或重启" },
  { re: /\b(kill|pkill|killall)\s+-?9?\b/, reason: "强杀进程" },
  { re: /\bchmod\s+(-R\s+)?777\b|\bchown\s+-R\b/, reason: "放宽权限或改属主（影响面大）" },
  { re: /(curl|wget)[^|]*\|\s*(ba)?sh\b/, reason: "把网上下载的脚本直接执行" },
  { re: /git\s+push[^|]*(--force|-f)\b|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f/, reason: "覆盖远端或被丢弃本地改动" },
  { re: /npm\s+publish|docker\s+rm\s+-f|docker\s+system\s+prune|kubectl\s+delete/, reason: "发布/删除线上资源" },
  { re: /drop\s+(table|database)|\btruncate\s+table|delete\s+from\s+\w+\s*;/i, reason: "清空数据库表" },
  { re: /\.hermes|\.ssh\/|\.aws\/|credentials/i, reason: "碰到凭据或配置目录" },
];

/** 工作目录以外的写入：这些前缀下的路径属于系统/平台，不该被助手改 */
const SENSITIVE_PREFIXES = ["/etc/", "/usr/", "/bin/", "/sbin/", "/boot/", "/var/", "/root/.ssh", "/root/.hermes"];

function riskOf(label: string, args: Record<string, unknown> | null, rawText: string): CallView["risk"] {
  const text = `${rawText}`;
  const isExec = /执行命令|执行代码/.test(label);
  if (isExec) {
    for (const p of DANGER_PATTERNS) {
      if (p.re.test(text)) return { level: "danger", reason: p.reason };
    }
  }
  // 写/改文件：目标在工作目录之外
  if (/写入文件|修改文件/.test(label)) {
    const fp = String(args?.file_path ?? args?.path ?? "");
    if (fp.startsWith("/") && SENSITIVE_PREFIXES.some((pre) => fp.startsWith(pre))) {
      return { level: "danger", reason: `要改工作目录外的系统路径 ${fp}` };
    }
    if (fp.includes("/.ssh/") || fp.includes("credentials")) {
      return { level: "danger", reason: "要改凭据文件" };
    }
  }
  // 轻度提示：其它写操作（让用户知道不是只读）
  if (/写入文件|修改文件/.test(label)) return { level: "caution", reason: "会改动文件内容" };
  return null;
}

/** 把待确认的 tool_calls 提炼成可读的几条 */
export function summarizeCalls(payload: Record<string, unknown> | null | undefined): CallView[] {
  const calls = (payload?.tool_calls as ToolCall[] | undefined) ?? [];
  return calls.map((tc) => {
    const raw = tc.name ?? "";
    const label = toolLabel(raw);
    const input = parseToolInput(tc.input);
    const full =
      input !== null ? JSON.stringify(input, null, 2) : typeof tc.input === "string" ? tc.input : "{}";
    let detail: string;
    if (!input) {
      detail = (typeof tc.input === "string" ? tc.input : "").slice(0, 240) || "（没有参数）";
    } else {
      const key = KEY_PRIORITY.find((k) => typeof input[k] === "string") ?? Object.keys(input)[0] ?? "";
      detail =
        key && input[key] !== undefined
          ? `${key}: ${String(input[key]).slice(0, 240)}`
          : JSON.stringify(input).slice(0, 240);
    }
    return { raw, label, detail, full, risk: riskOf(label, input, detail) };
  });
}

/** 这批调用里最高的风险等级（卡片据此决定是否要二次确认） */
export function highestRisk(calls: CallView[]): "danger" | "caution" | null {
  if (calls.some((c) => c.risk?.level === "danger")) return "danger";
  if (calls.some((c) => c.risk?.level === "caution")) return "caution";
  return null;
}
