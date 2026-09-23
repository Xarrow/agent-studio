"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Tool } from "@/lib/types";
import { SkillsPanel } from "@/components/SkillsPanel";
import { useFeedback } from "@/components/ui/feedback";

export default function ToolsPage() {
  const fb = useFeedback();
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  /** 正在编辑的工具（null = 没在编辑） */
  const [editing, setEditing] = useState<Tool | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [testOut, setTestOut] = useState<Record<string, string>>({});
  const [argsInput, setArgsInput] = useState<Record<string, string>>({});
  const [kindFilter, setKindFilter] = useState("");
  /** 这一页管三件事：工具 / Skills /（以后的）MCP —— 页签切换，不跳页 */
  const [tab, setTab] = useState<"tools" | "skills">("tools");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTools(await api.tools());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api.syncBuiltins("agentscope");
      const base = `发现 ${r.discovered} 个内置工具（新增 ${r.created}，刷新 ${r.updated ?? 0}）`;
      if (r.unsupported && r.unsupported.length > 0) {
        fb.warn(
          base,
          "以下工具在当前服务器不可用，已标记并禁用试运行：\n" +
            r.unsupported.map((u) => `· ${u.name}：${u.reason}`).join("\n"),
        );
      } else {
        fb.success(base);
      }
      await load();
    } catch (e) {
      fb.error("同步内置工具失败", e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const test = async (t: Tool) => {
    // 内置工具需要参数（file_path / pattern 等），按签名提示用户填写
    const argSpec =
      (t.impl?.args as { name: string; required: boolean; type: string }[]) ?? [];
    let args: Record<string, unknown> = {};

    if (argSpec.length > 0) {
      const hint = argSpec
        .map((a) => `${a.name}${a.required ? "（必填）" : `（${a.type}，可空）`}`)
        .join(", ");
      const raw = await fb.prompt({
        title: `${t.name} · 试跑参数`,
        description: `参数签名：${hint}`,
        multiline: true,
        placeholder: '{\n  "file_path": "demo.txt"\n}',
        defaultValue: argsInput[t.id] ?? "{}",
        hint: "只读工具会真实执行（限制在工作目录内）；写/执行类工具为避免任意代码执行会被跳过。",
        validate: (v) => {
          if (!v.trim()) return "请填写参数（至少 {} ）";
          try {
            JSON.parse(v);
            return null;
          } catch (e) {
            return `JSON 不合法：${e instanceof Error ? e.message : String(e)}`;
          }
        },
        confirmText: "试运行",
      });
      if (raw === null) return;
      setArgsInput((p) => ({ ...p, [t.id]: raw }));
      args = JSON.parse(raw || "{}");
    }

    setTestOut((p) => ({ ...p, [t.id]: "测试中…" }));
    try {
      const r = await api.testTool(t.id, args);
      if (r.skipped) {
        setTestOut((p) => ({ ...p, [t.id]: `⏸ 已跳过\n${r.reason ?? ""}` }));
      } else if (r.ok) {
        setTestOut((p) => ({
          ...p,
          [t.id]: `✓ ${r.note ?? "正常"} · ${fmt.ms(r.duration_ms)} · ${fmt.bytes(r.result_size)}\n${r.result_preview ?? ""}`,
        }));
      } else {
        setTestOut((p) => ({
          ...p,
          [t.id]: `✗ ${r.error ?? "失败"}${r.hint ? `\n${r.hint}` : ""}`,
        }));
      }
    } catch (e) {
      setTestOut((p) => ({ ...p, [t.id]: `✗ ${e instanceof Error ? e.message : e}` }));
    }
  };

  const remove = async (t: Tool) => {
    const ok = await fb.confirm({
      title: `删除工具「${t.name}」？`,
      description: "已挂载它的 Agent 会立即失去该能力。",
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await api.deleteTool(t.id);
      fb.success(`已删除工具「${t.name}」`);
      await load();
    } catch (e) {
      fb.error("删除工具失败", e instanceof Error ? e.message : String(e));
    }
  };

  const filtered = kindFilter ? tools.filter((t) => t.kind === kindFilter) : tools;
  const counts = {
    builtin: tools.filter((t) => t.kind === "builtin").length,
    http: tools.filter((t) => t.kind === "http").length,
    code: tools.filter((t) => t.kind === "code").length,
  };

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-5xl">
      {/* 页签：工具 / Skills —— 对用户本是同一件事（"这个助手能干什么"），
          分成两个菜单只会让人先猜该点哪个 */}
      <div className="mb-5 flex gap-1 border-b" style={{ borderColor: "var(--color-border)" }}>
        {(
          [
            ["tools", "工具"],
            ["skills", "Skills"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className="-mb-px border-b-2 px-3.5 py-2 text-[13.5px] transition-colors"
            style={
              tab === k
                ? {
                    borderColor: "var(--color-accent)",
                    color: "var(--color-accent)",
                    fontWeight: 600,
                  }
                : { borderColor: "transparent", color: "var(--color-muted)" }
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "skills" && <SkillsPanel embedded />}

      {tab === "tools" && (
        <>
      <header className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">工具</h1>
          <p className="text-[13px] text-[var(--color-muted)] mt-1">
            给助手加「手」：能查网页、读文件、跑命令之类。不加的话它就只能聊天。
          </p>
          <p className="text-[11.5px] text-[var(--color-muted)] mt-1">
            内置 {counts.builtin} · HTTP {counts.http} · 代码 {counts.code}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn" disabled={syncing} onClick={sync}>
            {syncing ? "同步中…" : "同步内置工具"}
          </button>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            + 自定义工具
          </button>
        </div>
      </header>

      {editing && (
        <EditToolDialog
          key={editing.id}
          tool={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      {showNew && (
        <NewToolDialog
          onClose={() => setShowNew(false)}
          onCreated={async () => {
            setShowNew(false);
            await load();
          }}
        />
      )}

      <div className="flex gap-1.5 mb-4">
        {[
          ["", "全部"],
          ["builtin", "内置"],
          ["http", "HTTP"],
          ["code", "代码"],
        ].map(([k, label]) => (
          <button
            key={k}
            className={`btn ${kindFilter === k ? "border-[var(--color-accent)]" : ""}`}
            onClick={() => setKindFilter(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card p-6 text-[13px] text-[var(--color-muted)]">加载中…</div>
      ) : filtered.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-[14px] mb-2">还没有工具</p>
          <p className="text-[12.5px] text-[var(--color-muted)] mb-4">
            点击「同步内置工具」导入运行时的内置能力，或创建自定义 HTTP 工具。
          </p>
          <button className="btn" disabled={syncing} onClick={sync}>
            同步 AgentScope 内置工具
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((t) => (
            <div key={t.id} className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="font-medium text-[14px] mono">{t.name}</span>
                    <span className="tag">{t.kind}</span>
                    {Boolean(t.flags?.read_only) && <span className="tag">只读</span>}
                    {Boolean(t.flags?.dangerous) && (
                      <span className="tag text-[var(--color-warn)]">写/执行</span>
                    )}
                    {t.flags?.platform_ok === false && (
                      <span className="tag text-[var(--color-err)]">当前平台不可用</span>
                    )}
                  </div>
                  {t.flags?.platform_ok === false &&
                    typeof t.flags?.platform_note === "string" && (
                      <p className="text-[11.5px] text-[var(--color-err)] mt-1.5">
                        ⚠ {t.flags.platform_note}
                      </p>
                    )}
                  {t.description && (
                    <p className="text-[12.5px] text-[var(--color-muted)] mt-1.5">
                      {t.description}
                    </p>
                  )}
                  {t.kind === "http" && (
                    <p className="text-[11.5px] text-[var(--color-muted)] mono mt-1">
                      {String(t.impl?.method ?? "GET")} {String(t.impl?.url ?? "")}
                    </p>
                  )}
                  {/* 内置工具：展示试跑所需参数（来自运行时签名探测） */}
                  {t.kind === "builtin" &&
                    Array.isArray(t.impl?.args) &&
                    (t.impl?.args as { name: string; required: boolean }[]).length > 0 && (
                      <p className="text-[11.5px] text-[var(--color-muted)] mt-1">
                        试跑参数：
                        {(t.impl?.args as { name: string; required: boolean }[])
                          .map((a) => `${a.name}${a.required ? "*" : ""}`)
                          .join(", ")}
                        <span className="opacity-60">（* 必填）</span>
                      </p>
                    )}
                  {Object.keys(t.input_schema?.properties ?? {}).length > 0 && (
                    <p className="text-[11.5px] text-[var(--color-muted)] mt-1">
                      参数：
                      {Object.keys(
                        (t.input_schema.properties as Record<string, unknown>) ?? {},
                      ).join(", ")}
                    </p>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button className="btn" onClick={() => setEditing(t)}>
                    编辑
                  </button>
                  <button
                    className="btn"
                    disabled={t.flags?.platform_ok === false}
                    title={
                      t.flags?.platform_ok === false
                        ? String(t.flags?.platform_note ?? "")
                        : ""
                    }
                    onClick={() => test(t)}
                  >
                    试运行
                  </button>
                  {t.kind !== "builtin" && (
                    <button
                      className="btn text-[var(--color-err)]"
                      onClick={() => remove(t)}
                    >
                      删除
                    </button>
                  )}
                </div>
              </div>
              {testOut[t.id] && (
                <pre className="mt-3 pt-3 border-t border-[var(--color-border)] text-[11.5px] whitespace-pre-wrap break-all text-[var(--color-muted)] max-h-40 overflow-auto">
                  {testOut[t.id]}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
        </>
      )}
    </div>
  );
}


// --------------------------------------------------------------------------- //
function NewToolDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [params, setParams] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(null);
    if (!name.trim() || !url.trim()) {
      setErr("名称与 URL 必填");
      return;
    }
    // 参数形如：city, date=2026-01-01
    const properties: Record<string, unknown> = {};
    for (const raw of params.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [k] = raw.split("=");
      properties[k] = { type: "string", description: raw.includes("=") ? raw : undefined };
    }

    setBusy(true);
    try {
      await api.createTool({
        kind: "http",
        name: name.trim(),
        description: description.trim(),
        input_schema: { type: "object", properties },
        impl: { method, url: url.trim(), timeout_s: 15, max_bytes: 65536 },
        flags: { read_only: readOnly, concurrency_safe: true },
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[var(--color-overlay)] flex items-center justify-center p-4 z-50">
      <div className="card w-full max-w-lg p-5">
        <h2 className="text-[16px] font-medium mb-1">自定义 HTTP 工具</h2>
        <p className="text-[12px] text-[var(--color-muted)] mb-4">
          URL 里用 <code className="mono">{"{{参数名}}"}</code> 占位，调用时替换成模型给出的实参。
        </p>

        <div className="space-y-3.5">
          <div>
            <label className="label">工具名（模型看到的函数名）</label>
            <input
              className="input mono"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="get_weather"
            />
          </div>
          <div>
            <label className="label">描述（模型据此判断何时调用）</label>
            <textarea
              className="input"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="查询指定城市当前天气"
            />
          </div>
          <div className="grid grid-cols-[100px_1fr] gap-3">
            <div>
              <label className="label">方法</label>
              <select
                className="input"
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              >
                {["GET", "POST", "PUT", "DELETE"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">URL 模板</label>
              <input
                className="input mono"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.example.com/weather?city={{city}}"
              />
            </div>
          </div>
          <div>
            <label className="label">参数（逗号分隔，如 city, date）</label>
            <input
              className="input mono"
              value={params}
              onChange={(e) => setParams(e.target.value)}
              placeholder="city"
            />
          </div>
          <label className="flex items-center gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            只读工具（不产生副作用，可并发）
          </label>
          {err && <div className="text-[12.5px] text-[var(--color-err)]">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
/**
 * 编辑已有工具。
 *
 * 按类别给出不同的可编辑范围（这是刻意的，不是偷懒）：
 *   · builtin —— **只能改描述**。实现由运行时提供，"同步内置工具"会把它刷回
 *     来；名字也是模型看到的函数名，改了会让已配好的助手对不上。
 *   · http    —— 名称/描述/方法/URL/参数/只读，全都能改。
 *   · code    —— 名称/描述 + impl 源码（JSON）。
 * 另外给一个「高级」区，直接编辑 impl JSON —— 覆盖上面表单没暴露的字段
 * （比如超时、字节上限），不用为了改一个值去找后端。
 */
function EditToolDialog({
  tool,
  onClose,
  onSaved,
}: {
  tool: Tool | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // tool 为 null 时整个弹窗不渲染，这里只是给 hooks 一个稳定的初始值
  const t = tool;

  const [name, setName] = useState(t?.name ?? "");
  const [description, setDescription] = useState(t?.description ?? "");
  const [method, setMethod] = useState(String(t?.impl?.method ?? "GET"));
  const [url, setUrl] = useState(String(t?.impl?.url ?? ""));
  const [params, setParams] = useState(
    Object.keys((t?.input_schema?.properties as Record<string, unknown>) ?? {}).join(", "),
  );
  const [readOnly, setReadOnly] = useState(Boolean(t?.flags?.read_only));
  const [implText, setImplText] = useState(JSON.stringify(t?.impl ?? {}, null, 2));
  const [showImpl, setShowImpl] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!t) return null;

  const isBuiltin = t.kind === "builtin";
  const isHttp = t.kind === "http";

  const buildParams = () => {
    const props: Record<string, unknown> = {};
    for (const raw of params.split(",").map((x) => x.trim()).filter(Boolean)) {
      const [k] = raw.split("=");
      props[k] = { type: "string" };
    }
    return props;
  };

  const submit = async () => {
    setErr(null);
    if (!name.trim()) {
      setErr("请填写工具名");
      return;
    }
    if (isHttp && !url.trim()) {
      setErr("HTTP 工具必须有 URL");
      return;
    }

    setBusy(true);
    try {
      const body: Parameters<typeof api.updateTool>[1] = {};

      // 内置工具：只提交描述
      if (isBuiltin) {
        body.description = description;
      } else {
        body.name = name.trim();
        body.description = description;

        if (showImpl) {
          // 高级模式：以 impl JSON 为准
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(implText || "{}");
          } catch (e) {
            setErr(`impl JSON 格式错误：${e instanceof Error ? e.message : String(e)}`);
            setBusy(false);
            return;
          }
          body.impl = parsed;
        } else if (isHttp) {
          body.impl = {
            ...(t.impl ?? {}),
            method,
            url: url.trim(),
          };
          body.input_schema = { type: "object", properties: buildParams() };
          body.flags = { ...(t.flags ?? {}), read_only: readOnly };
        }
      }

      await api.updateTool(t.id, body);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[var(--color-overlay)] flex items-center justify-center p-4 z-50 overflow-y-auto">
      <div className="card w-full max-w-lg p-5 my-8">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-[16px] font-medium">编辑工具</h2>
          <span className="tag mono">{t.kind}</span>
        </div>
        <p className="text-[12px] text-[var(--color-muted)] mb-4">
          {isBuiltin
            ? "内置工具只能修改描述 —— 它的实现由运行时提供，「同步内置工具」会把改动覆盖回去。"
            : "改完保存即生效，引用它的助手下次运行就会用新定义。"}
        </p>

        <div className="space-y-3.5">
          <div>
            <label className="label">
              工具名（模型看到的函数名）
              {isBuiltin && "（内置，不可改）"}
            </label>
            <input
              className="input mono"
              value={name}
              disabled={isBuiltin}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="label">描述（模型据此判断何时调用）</label>
            <textarea
              className="input"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="这个工具是做什么的、什么时候该用"
            />
          </div>

          {isHttp && !showImpl && (
            <>
              <div className="grid grid-cols-[100px_1fr] gap-3">
                <div>
                  <label className="label">方法</label>
                  <select
                    className="input"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                  >
                    {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">URL 模板</label>
                  <input
                    className="input mono"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://api.example.com/x?q={{q}}"
                  />
                </div>
              </div>

              <div>
                <label className="label">参数（逗号分隔，如 city, date）</label>
                <input
                  className="input mono"
                  value={params}
                  onChange={(e) => setParams(e.target.value)}
                />
              </div>

              <label className="flex items-center gap-2 text-[12.5px]">
                <input
                  type="checkbox"
                  checked={readOnly}
                  onChange={(e) => setReadOnly(e.target.checked)}
                  className="accent-[var(--color-accent)]"
                />
                只读工具（不产生副作用，可并发）
              </label>
            </>
          )}

          {/* 高级：直接改 impl */}
          <div className="pt-1 border-t border-[var(--color-border)]">
            <button
              className="text-[12.5px] text-[var(--color-muted)] mt-3"
              onClick={() => {
                setShowImpl(!showImpl);
                if (!showImpl) setImplText(JSON.stringify(t.impl ?? {}, null, 2));
              }}
            >
              {showImpl ? "▾" : "▸"} 高级：直接编辑实现（impl JSON）
            </button>
            {showImpl && (
              <>
                <textarea
                  className="input mono mt-2"
                  rows={9}
                  value={implText}
                  onChange={(e) => setImplText(e.target.value)}
                  spellCheck={false}
                />
                <p className="text-[11.5px] text-[var(--color-muted)] mt-1">
                  这里改的是原始定义（含超时、字节上限等表单未暴露的字段）。格式必须是合法 JSON。
                </p>
              </>
            )}
          </div>

          {err && <div className="text-[12.5px] text-[var(--color-err)]">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
