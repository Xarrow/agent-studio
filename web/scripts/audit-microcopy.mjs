#!/usr/bin/env node
/**
 * 小字审计：列出「解释型辅助文案」并给出建议（删 / 改布局 / 留）。
 *
 * 用法：
 *   node scripts/audit-microcopy.mjs            # 表格
 *   node scripts/audit-microcopy.mjs --json     # 机器可读
 *
 * 判定口径（见 docs/specs/microcopy-budget.md）：
 *   留 —— 危险/不可逆/凭据/费用/失败原因/空态/加载态
 *   删 —— 复述交互（点击X就Y、勾选=Z）、实现内幕（同一份数据、经导入管线）、
 *         架构科普（适合本地、不需要额外服务）、跨页引用
 *   改 —— 字段规则（可换成占位示例 / 单位后缀 / 选择器）
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());
const FILES = globSync(["app/**/*.tsx", "components/**/*.tsx"], { cwd: ROOT });

const SMALL = /text-\[(?:10|11|12)px\]|text-xs/;
const CJK = /[\u4e00-\u9fa5]{2,}/;

const KEEP = [
  /危险|不可逆|不可|删除|覆盖|清空|冻结|清掉/,
  /密码|口令|密钥|凭据|token|Token|API ?key/i,
  /费用|价格|单价|额度|上限|超时|轮数/,
  /失败|错误|异常|不支持|不兼容|超限|冲突/,
  /还没有|暂无|没有任何|空/,
  /读取中|加载中|运行中|处理中|同步中/,
];

const DELETE = [
  /点击|点右|点上|点一下|勾选 ?=|去掉勾|就会|会自动|即可|照抄|抄一条/,
  /同一份数据|经导入管线|原子安装|内容哈希|两级判断|入库后|留存|快照|落库/,
  /适合本地|不需要额外服务|一个文件就是|通用|兼容|标准 ?格式/,
  /和.*页.*(一样|同一)|跟.*一样/,
];

const FIELD_RULE = /默认|留空|必填|格式|示例|例如|范围|至少|最多|不超过|超过就|按.*算/;

function classify(text) {
  const t = text.trim();
  if (!t || !CJK.test(t)) return null;
  if (KEEP.some((r) => r.test(t))) return { verdict: "留", why: "风险/状态信息" };
  if (DELETE.some((r) => r.test(t))) return { verdict: "删", why: "复述交互或实现内幕" };
  if (FIELD_RULE.test(t)) return { verdict: "改", why: "字段规则 → 占位示例/单位后缀" };
  if (t.length >= 24) return { verdict: "改", why: "长句，多半能交给布局" };
  return { verdict: "留", why: "短标签" };
}

/** 找出 className 含小字体的元素，取其文本子节点（支持跨行）。 */
function extract(src) {
  const out = [];
  const open = /<([A-Za-z][\w.]*)\b[^>]*?className=(?:"([^"]*)"|\{`([^`]*)`\})[^>]*?>/g;
  let m;
  while ((m = open.exec(src))) {
    const cls = m[2] ?? m[3] ?? "";
    if (!SMALL.test(cls)) continue;
    const start = open.lastIndex;
    // 取到对应的闭合标签（同名的最近一个）
    const closeRe = new RegExp(`</${m[1]}>`, "g");
    closeRe.lastIndex = start;
    const close = closeRe.exec(src);
    if (!close) continue;
    const inner = src.slice(start, close.index);
    if (inner.includes("<") && !/^[^<]*$/.test(inner)) continue; // 只取纯文本子节点
    const text = inner.replace(/\{[^}]*\}/g, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ line, text });
  }
  return out;
}

const rows = [];
for (const f of FILES) {
  const src = readFileSync(resolve(ROOT, f), "utf8");
  for (const it of extract(src)) {
    const c = classify(it.text);
    if (!c) continue;
    rows.push({ file: f, line: it.line, text: it.text, ...c });
  }
}

/**
 * --check：门禁模式。当前"该删/该改"的条目冻结在 scripts/microcopy-allow.json，
 * 新出现的（没在允许名单里）就失败 —— 只拦新增，不逼人一次清干净。
 */
if (process.argv.includes("--check")) {
  const allowPath = resolve(ROOT, "scripts/microcopy-allow.json");
  let allow = [];
  try {
    allow = JSON.parse(readFileSync(allowPath, "utf8"));
  } catch {
    console.error("缺少 scripts/microcopy-allow.json；先跑 node scripts/audit-microcopy.mjs --write-allow");
    process.exit(2);
  }
  const set = new Set(allow);
  const bad = rows.filter((r) => (r.verdict === "删" || r.verdict === "改") && !set.has(`${r.file}::${r.text}`));
  if (bad.length) {
    console.error(`新增待清理的辅助说明 ${bad.length} 条：`);
    for (const b of bad.slice(0, 30)) console.error(`  ${b.file}:${b.line}  ${b.text.slice(0, 60)}`);
    console.error("要么改布局/删掉，要么确认必要后加进 scripts/microcopy-allow.json");
    process.exit(1);
  }
  console.log("microcopy: ok");
  process.exit(0);
}

if (process.argv.includes("--write-allow")) {
  const items = rows.filter((r) => r.verdict === "删" || r.verdict === "改").map((r) => `${r.file}::${r.text}`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(resolve(ROOT, "scripts/microcopy-allow.json"), JSON.stringify([...new Set(items)], null, 2) + "\n");
  console.log(`已写入 ${new Set(items).size} 条`);
  process.exit(0);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const byFile = new Map();
for (const r of rows) {
  const k = r.file;
  if (!byFile.has(k)) byFile.set(k, { 删: 0, 改: 0, 留: 0 });
  byFile.get(k)[r.verdict] += 1;
}
const sorted = [...byFile.entries()].sort(
  (a, b) => b[1].删 + b[1].改 - (a[1].删 + a[1].改),
);
console.log("file".padEnd(42), "删", "改", "留");
for (const [f, c] of sorted) {
  console.log(f.padEnd(42), String(c.删).padStart(2), String(c.改).padStart(2), String(c.留).padStart(2));
}
const t = rows.reduce((a, r) => ((a[r.verdict] += 1), a), { 删: 0, 改: 0, 留: 0 });
console.log(`\n合计 删 ${t.删} / 改 ${t.改} / 留 ${t.留}  （共 ${rows.length} 条，${sorted.length} 个文件）`);
