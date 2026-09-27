"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Tool } from "@/lib/types";
import { Chip, Empty, KV, PageHead, Row, RowDetail, RowList, Segmented, Toolbar } from "@/components/ui/kit";
import { SkillsPanel } from "@/components/SkillsPanel";
import { McpPanel } from "@/components/McpPanel";
import { ToolTestForm } from "@/components/ToolTestForm";
import { urlParams } from "@/lib/tool-params";
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
  const [kindFilter, setKindFilter] = useState("");
  /** 这一页管三件事：工具 / Skills /（以后的）MCP —— 页签切换，不跳页 */
  const [tab, setTab] = useState<"tools" | "skills" | "mcp">("tools");
  /** 就地展开的那一个工具（展开里放参数详情 + 试运行表单 + 上次试跑结果） */
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 每个页签自己的说法 —— 标题跟着页签走，不再"页签 + 又一个 h1"两层头 */
  const TAB_META: Record<"tools" | "skills" | "mcp", { title: string; desc: string }> = {
    tools: {
      title: "工具",
      desc: "给助手加「手」：能查网页、读文件、跑命令之类。不加的话它就只能聊天。",
    },
    skills: {
      title: "Skills",
      desc: "给助手加「说明书」：告诉它这类任务该怎么做（正文按需加载，不占上下文）。",
    },
    mcp: {
      title: "MCP",
      desc: "接外部工具服务器：把别的系统提供的能力挂给助手用。",
    },
  };

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

  /** 试运行：参数表单就地展开在卡片里（ToolTestForm 从签名自动生成），
      不再弹 fb.prompt 让用户手写 JSON */
  const [testing, setTesting] = useState<Tool | null>(null);

  const testOut2 = (t: Tool, out: string) => setTestOut((p) => ({ ...p, [t.id]: out }));

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
    // 分派是**平台原生**工具（助手因此能把自己的任务拆给多个实例并行处理）——
    // 不归进"内置/HTTP/代码"里的任何一类，否则用户按分类找会找不到它。
    fork: tools.filter((t) => t.kind === "fork").length,
  };

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-5xl">
      {/* 头部一行：标题跟页签走 + 右侧「工具 / Skills / MCP」切换。
          原来是「顶部页签条 + 页签里再来一个 h1 + 说明 + 按钮」两层头，
          占了 150px 才看到第一个工具，且字号与其它页不一致 ✗ */}
      <PageHead
        title={TAB_META[tab].title}
        desc={TAB_META[tab].desc}
        actions={
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { key: "tools", label: "工具", count: tools.length },
              { key: "skills", label: "Skills" },
              { key: "mcp", label: "MCP" },
            ]}
          />
        }
      />

      {tab === "skills" && <SkillsPanel embedded />}

      {tab === "mcp" && <McpPanel embedded />}

      {tab === "tools" && (
        <>
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

          {/* 工具条一行：类型筛选（带计数）+ 两个动作 */}
          <Toolbar>
            <Segmented
              value={kindFilter}
              onChange={setKindFilter}
              options={[
                { key: "", label: "全部", count: tools.length },
                { key: "builtin", label: "内置", count: counts.builtin },
                { key: "http", label: "HTTP", count: counts.http },
                { key: "code", label: "代码", count: counts.code },
                // 分派是平台给助手的"分身"能力（一个助手 → 多个实例并行）——
                // 单独一类，否则用户在"内置/HTTP/代码"里翻不到它
                ...(counts.fork > 0
                  ? [{ key: "fork", label: "分派", count: counts.fork }]
                  : []),
              ]}
            />
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <button className="btn" disabled={syncing} onClick={sync}>
                {syncing ? "同步中…" : "同步内置工具"}
              </button>
              <button className="btn btn-primary" onClick={() => setShowNew(true)}>
                + 自定义工具
              </button>
            </div>
          </Toolbar>

          {loading ? (
            <div className="card p-6 text-[13px] text-[var(--color-muted)]">加载中…</div>
          ) : filtered.length === 0 ? (
            <div className="card">
              <Empty
                title="这个分类下还没有工具"
                hint="点「同步内置工具」导入运行时的内置能力，或创建自定义 HTTP 工具。"
                action={
                  <>
                    <button className="btn" disabled={syncing} onClick={sync}>
                      同步内置工具
                    </button>
                    <button className="btn btn-primary" onClick={() => setShowNew(true)}>
                      + 自定义工具
                    </button>
                  </>
                }
              />
            </div>
          ) : (
            /* 一行一个工具（原来是每项一张卡片，13 个工具要滚三屏）。
               参数、请求地址、试运行表单、上次试跑结果全在**就地展开**里。 */
            <RowList>
              {filtered.map((t) => {
                const open = expanded === t.id;
                const isTesting = testing?.id === t.id;
                const unavailable = t.flags?.platform_ok === false;
                const args = Array.isArray(t.impl?.args)
                  ? (t.impl.args as { name: string; required: boolean }[])
                  : [];
                const schemaProps = Object.keys(
                  (t.input_schema?.properties as Record<string, unknown>) ?? {},
                );
                return (
                  <Fragment key={t.id}>
                    <Row
                      expanded={open}
                      onToggle={() => setExpanded(open ? null : t.id)}
                      actions={
                        <>
                          <button
                            type="button"
                            className="btn text-[12.5px]"
                            onClick={() => {
                              setExpanded(t.id);
                              setTesting(null);
                              setEditing(t);
                            }}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="btn text-[12.5px]"
                            disabled={unavailable}
                            title={
                              unavailable
                                ? String(t.flags?.platform_note ?? "")
                                : "参数表单按签名自动生成，不用手写 JSON"
                            }
                            onClick={() => {
                              setTesting(isTesting ? null : t);
                              setExpanded(t.id);
                            }}
                          >
                            {isTesting ? "收起" : "试运行"}
                          </button>
                          {t.kind !== "builtin" && (
                            <button
                              type="button"
                              className="btn text-[12.5px]"
                              style={{ color: "var(--color-err)" }}
                              onClick={() => void remove(t)}
                            >
                              删除
                            </button>
                          )}
                        </>
                      }
                    >
                      <span className="min-w-0 flex-1 basis-[240px]">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="mono truncate text-[14px] font-medium">{t.name}</span>
                          <Chip tone="muted">{t.kind}</Chip>
                          {Boolean(t.flags?.read_only) && <Chip tone="ok">只读</Chip>}
                          {Boolean(t.flags?.dangerous) && <Chip tone="warn">写/执行</Chip>}
                          {unavailable && <Chip tone="err">当前平台不可用</Chip>}
                        </span>
                        <span
                          className="mt-0.5 block truncate text-[11.5px]"
                          style={{ color: "var(--color-muted)" }}
                        >
                          {t.description || "没有说明"}
                          {t.kind === "http" ? (
                            <>
                              {" · "}
                              <span className="mono">
                                {String(t.impl?.method ?? "GET")} {String(t.impl?.url ?? "")}
                              </span>
                            </>
                          ) : null}
                          {args.length > 0 ? <> · 参数 {args.map((a) => a.name).join(", ")}</> : null}
                          {args.length === 0 && schemaProps.length > 0 ? (
                            <> · 参数 {schemaProps.join(", ")}</>
                          ) : null}
                        </span>
                      </span>
                      {testOut[t.id] ? (
                        <Chip tone="ok" title="这条工具试跑过，展开能看到结果">
                          已试跑
                        </Chip>
                      ) : null}
                      <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
                        {open ? "▾" : "▸"}
                      </span>
                    </Row>

                    {open && (
                      <RowDetail>
                        {unavailable && typeof t.flags?.platform_note === "string" ? (
                          <div className="mb-2 text-[12.5px]" style={{ color: "var(--color-err)" }}>
                            ⚠ {t.flags.platform_note}
                          </div>
                        ) : null}
                        <div className="grid gap-1.5 md:grid-cols-2">
                          <KV k="权限">
                            {Boolean(t.flags?.read_only)
                              ? "只读（不会改动任何东西）"
                              : Boolean(t.flags?.dangerous)
                                ? "会写数据 / 会执行命令"
                                : "没说"}
                          </KV>
                          {t.kind === "http" ? (
                            <KV k="请求">
                              <span className="mono">
                                {String(t.impl?.method ?? "GET")} {String(t.impl?.url ?? "")}
                              </span>
                            </KV>
                          ) : null}
                          {args.length > 0 ? (
                            <KV k="试跑参数">
                              <span className="mono">
                                {args.map((a) => `${a.name}${a.required ? "*" : ""}`).join(", ")}{" "}
                                <span style={{ color: "var(--color-muted)" }}>（* 必填）</span>
                              </span>
                            </KV>
                          ) : null}
                          {args.length === 0 && schemaProps.length > 0 ? (
                            <KV k="参数">
                              <span className="mono">{schemaProps.join(", ")}</span>
                            </KV>
                          ) : null}
                          {t.description ? <KV k="说明">{t.description}</KV> : null}
                        </div>
                        {isTesting ? (
                          <div className="mt-2.5">
                            <ToolTestForm tool={t} onDone={(out) => testOut2(t, out)} />
                          </div>
                        ) : (
                          <div className="mt-2.5 text-[12px]" style={{ color: "var(--color-muted)" }}>
                            点右侧「试运行」就在这里出参数表单（按签名自动生成，不用手写 JSON）。
                          </div>
                        )}
                        {testOut[t.id] ? (
                          <pre
                            className="mt-2.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[8px] border p-2.5 text-[11.5px]"
                            style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
                          >
                            {testOut[t.id]}
                          </pre>
                        ) : null}
                      </RowDetail>
                    )}
                  </Fragment>
                );
              })}
            </RowList>
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
            <label className="label">参数（从 URL 占位符自动解析，可补充）</label>
            <input
              className="input mono"
              value={params}
              onChange={(e) => setParams(e.target.value)}
              placeholder="（写了 {{city}} 之类占位符会自动出现在这里）"
            />
            {urlParams(url).length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
                  URL 里的占位符：
                </span>
                {urlParams(url).map((p) => (
                  <span key={p} className="tag mono">
                    {p}
                    {params.split(",").map((s) => s.trim()).includes(p) ? "" : " ·未在参数里"}
                  </span>
                ))}
                {!urlParams(url).every((p) => params.split(",").map((s) => s.trim()).includes(p)) && (
                  <button
                    type="button"
                    className="text-[11.5px] underline"
                    style={{ color: "var(--color-accent)" }}
                    onClick={() => {
                      const cur = params.split(",").map((s) => s.trim()).filter(Boolean);
                      const merged = [...cur];
                      for (const p of urlParams(url)) if (!merged.includes(p)) merged.push(p);
                      setParams(merged.join(", "));
                    }}
                  >
                    补齐
                  </button>
                )}
              </div>
            )}
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
