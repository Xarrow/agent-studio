/**
 * 工具配置的「签名即参数表」纯函数 —— 与 AgentScope Toolkit 同一思想：
 * 签名（URL 占位符 / input_schema / 探测到的 args）就是唯一真相，
 * 绝不让用户手抄第二份。
 *
 * 全部纯函数、零依赖 —— 前端护栏测试可直接覆盖。
 */

/** 从 URL 模板里解析出参数名，如 `https://x.com/w?city={{city}}&d={{date}}` → ["city","date"] */
export function urlParams(url: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(url)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 表单字段描述：一个参数在表单里长什么样 */
export interface FieldSpec {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
  /** 枚举候选（input_schema 里有 enum 就给选择器，不让手打） */
  enumValues?: string[];
}

/**
 * 把 JSON Schema（工具的 input_schema）压平成表单字段清单。
 * 只处理顶层 properties（工具参数没有更深的需求）；认不出的类型按 string。
 */
export function schemaToFields(schema: unknown): FieldSpec[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  const props = s.properties ?? {};
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  return Object.entries(props).map(([name, raw]) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const t = typeof p.type === "string" ? p.type : "string";
    const en = Array.isArray(p.enum) ? (p.enum as unknown[]).map(String) : undefined;
    return {
      name,
      type: t === "number" || t === "integer" ? "number" : t === "boolean" ? "boolean" : "string",
      required: required.has(name),
      description: typeof p.description === "string" ? p.description : "",
      enumValues: en && en.length > 0 ? en : undefined,
    };
  });
}

/** 把探测签名的类型注解（"str" / "int | None" / "bool" / "Literal" / "Any"…）压成表单类型。
 *  AgentScope 给的是 Python 注解字符串，联合/泛型按第一个成员认。 */
function pyTypeToForm(t: string | undefined): FieldSpec["type"] {
  if (!t) return "string";
  const head = t.split("|")[0].trim();
  if (head === "int" || head === "float" || head === "number") return "number";
  if (head === "bool" || head === "boolean") return "boolean";
  return "string";
}

/**
 * 把「探测到的参数签名」（builtin 工具 impl.args：[{name, required, type}]）
 * 压平成表单字段清单 —— 与 schemaToFields 同一输出形状，试运行表单只认 FieldSpec。
 */
export function argsToFields(
  args: { name: string; required?: boolean; type?: string; description?: string }[] | null | undefined,
): FieldSpec[] {
  if (!Array.isArray(args)) return [];
  return args.map((a) => ({
    name: a.name,
    type: pyTypeToForm(a.type),
    required: Boolean(a.required),
    description: a.description ?? "",
  }));
}

/** 表单里的字符串值 → 按 schema 类型转换成要提交的值（number/boolean 不做字符串提交） */
export function fieldToValue(f: FieldSpec, raw: string): unknown {
  if (f.type === "number") {
    if (!raw.trim()) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (f.type === "boolean") return raw === "true";
  return raw;
}

/** 字段值 → 预填表单的字符串（boolean 用 "true"/"false"） */
export function valueToField(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
