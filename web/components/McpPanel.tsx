"use client";

/**
 * MCP 服务器管理面板 —— 嵌在「工具」页的第三个页签里。
 *
 * 设计要点（都是从"用户不该被为难"推出来的）
 * ------------------------------------------------
 * ① **工具清单不让手填**：MCP 服务器的能力在服务器那边，随时会变。手填一定漂移，
 *    最后表现成"配了却调不到"。所以只让用户填**怎么连**，清单一律"探测"回来。
 * ② **保存前先试连**：连不上、命令写错、包没装 —— 这些错误应该在按保存之前就暴露，
 *    而不是等到某个助手跑起来才报。
 * ③ 名字会变成工具名前缀（mcp__<名字>__<工具>），只能 ASCII —— 中文名由后端
 *    自动转成稳定短名，界面上说明一句，不让人自己猜为什么被改。
 *
 * 2026-10-29 重写：对齐全站 kit 范式（PageHead/Toolbar/Segmented/RowList/Row/
 * RowDetail/Chip/Switch/Empty/KV）——整张表一圈边框的行式列表，一行一个服务器，
 * 点行就地展开（工具清单/连接目标/失败原因全在展开区），动作常驻可见。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { McpProbeResult, McpServer, McpServerInput } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { Hint } from "@/components/ui/hint";
import {
  PageHead,
  Toolbar,
  Segmented,
  Chip,
  RowList,
  Row,
  RowDetail,
  Empty,
  KV,
  Switch,
  DLG_BACKDROP,
  DLG_CARD,
} from "@/components/ui/kit";

const EMPTY: McpServerInput = {
  name: "",
  transport: "stdio",
  command: "",
  args: [],
  url: "",
  env: {},
  headers: {},
  enabled: true,
};

type StatusFilter = "all" | "ok" | "fail" | "off";

export function McpPanel({ embedded = false }: { embedded?: boolean }) {
  const fb = useFeedback();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setServers(await api.mcpServers());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const probe = async (s: McpServer) => {
    setBusyId(s.id);
    try {
      const got = await api.probeMcpServer(s.id);
      if (got.last_probe_ok) {
        fb.success(`「${s.name}」连上了，${got.tools.length} 个工具`);
      } else {
        fb.error(`「${s.name}」连不上`, got.last_probe_error || "（没给原因）");
      }
      await load();
    } catch (e) {
      fb.error("探测失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (s: McpServer) => {
    try {
      await api.updateMcpServer(s.id, { enabled: !s.enabled });
      await load();
    } catch (e) {
      fb.error("改启用状态失败", e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (s: McpServer) => {
    const ok = await fb.confirm({
      title: `删除 MCP 服务器「${s.name}」？`,
      description: "助手会少掉这些工具，重新注册可恢复",
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await api.deleteMcpServer(s.id);
      fb.success(`已删除「${s.name}」`);
      await load();
    } catch (e) {
      fb.error("删除失败", e instanceof Error ? e.message : String(e));
    }
  };

  /* ── 粘贴 mcpServers JSON 直接注册 ──────────────────────────────
     用户从 Claude Desktop / Cursor / 内部平台拿到的那份配置原样粘进来，
     不用把字段拆成表单手填一遍。有 command 走 stdio、有 url 走 http，
     后端判；这里只做**本地预览**（名字/形态/连到哪）让人确认，注册和
     工具清单一律走后端。同名再粘一次是更新不是新增。 */
  const [pasted, setPasted] = useState("");
  const [importing, setImporting] = useState(false);
  const [showPaste, setShowPaste] = useState(false);

  const pastePreview = useMemo(() => {
    const t = pasted.trim();
    if (!t) return null;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const inner = (obj.mcpServers ?? obj) as Record<string, unknown>;
      if (typeof inner !== "object" || inner === null || Array.isArray(inner))
        return { error: "没找到 mcpServers 配置：应为 {\"mcpServers\": {\"名字\": {...}}}" };
      const items = Object.entries(inner).map(([name, cfg]) => {
        const c = (cfg ?? {}) as Record<string, unknown>;
        const cmd = String(c.command ?? "").trim();
        const url = String(c.url ?? "").trim();
        const kind = cmd ? "stdio" : url ? "http" : "缺 command 和 url";
        return { name, kind, target: cmd ? `命令 ${cmd}` : url || "—" };
      });
      if (!items.length) return { error: "mcpServers 里是空的" };
      return { items };
    } catch {
      return { error: "不是合法的 JSON（先粘到别处校验一下？）" };
    }
  }, [pasted]);

  const doImport = async () => {
    setImporting(true);
    try {
      const got = await api.importMcpServers(JSON.parse(pasted));
      fb.success(
        `已导入 ${got.length} 个 MCP 服务器`,
        got.map((s) => `${s.name}（${s.transport}）`).join("、"),
      );
      setPasted("");
      setShowPaste(false);
      await load();
    } catch (e) {
      fb.error("导入失败", e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  // 状态分桶：连不上/没探测都算「异常」（用户最该先看的），停用单列
  const statusOf = (s: McpServer): StatusFilter =>
    !s.enabled ? "off" : s.last_probe_at > 0 && s.last_probe_ok ? "ok" : "fail";
  const counts = useMemo(() => {
    const c = { all: servers.length, ok: 0, fail: 0, off: 0 };
    for (const s of servers) c[statusOf(s)] += 1;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers]);
  const shown = servers.filter((s) => {
    if (filter !== "all" && statusOf(s) !== filter) return false;
    const kw = q.trim().toLowerCase();
    if (!kw) return true;
    return (
      s.name.toLowerCase().includes(kw) ||
      (s.command || "").toLowerCase().includes(kw) ||
      (s.url || "").toLowerCase().includes(kw) ||
      s.tools.some((t) => t.name.toLowerCase().includes(kw))
    );
  });

  return (
    <div className={embedded ? "" : "p-4 md:p-6 lg:p-7 max-w-5xl"}>
      {!embedded && (
        <PageHead
          title={<Hint text="标准协议：把别人写的工具服务接进来">MCP 服务器</Hint>}
          desc="把外部的工具服务接进来。注册一次，多个助手都能挂。"
        />
      )}

      <Toolbar>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          + 注册
        </button>
        <button
          className="btn"
          onClick={() => setShowPaste(!showPaste)}
          title="从 Claude Desktop / Cursor 的配置直接导入"
        >
          粘贴 JSON 导入
        </button>
        <input
          className="input input-inline !w-[180px]"
          placeholder="搜名字 / 命令 / 工具"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Segmented<StatusFilter>
          options={[
            { key: "all", label: "全部", count: counts.all },
            { key: "ok", label: "正常", count: counts.ok },
            { key: "fail", label: "异常", count: counts.fail },
            { key: "off", label: "停用", count: counts.off },
          ]}
          value={filter}
          onChange={setFilter}
        />
        <span className="ml-auto text-[12px] text-[var(--color-muted)]">
          {loading ? "加载中…" : `${servers.length} 个`}
        </span>
      </Toolbar>

      {/* ── 粘贴 mcpServers JSON（收起，点「粘贴 JSON 导入」展开） ── */}
      {showPaste && (
        <div className="mb-3 rounded-[10px] border p-3 md:p-4" style={{ borderColor: "var(--color-border)" }}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">粘贴 mcpServers 配置</span>
            <span className="text-[12px] text-[var(--color-muted)]">
              原样粘进来，不用拆字段手填；同名再导是更新
            </span>
          </div>
          <textarea
            className="input min-h-[64px] w-full font-mono text-[12px]"
            placeholder={'{\n  "mcpServers": {\n    "名字": { "command": "npx", "args": ["-y", "包名"] }\n  }\n}'}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            spellCheck={false}
          />
          {pastePreview && (
            <div className="mt-2 text-[12px]">
              {pastePreview.error ? (
                <p style={{ color: "var(--color-err, #dc2626)" }}>{pastePreview.error}</p>
              ) : (
                <>
                  <p className="mb-1 text-[var(--color-muted)]">
                    解析出 {pastePreview.items?.length ?? 0} 个服务器（导入后同名是更新）：
                  </p>
                  {(pastePreview.items ?? []).map((it) => (
                    <p key={it.name} className="truncate">
                      · <b>{it.name}</b> — {it.kind} · {it.target}
                    </p>
                  ))}
                </>
              )}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              className="btn btn-primary"
              disabled={importing || !pastePreview || !!pastePreview.error}
              onClick={() => void doImport()}
            >
              {importing ? "导入中…" : "导入"}
            </button>
            {pasted && (
              <button className="btn" onClick={() => setPasted("")} disabled={importing}>
                清空
              </button>
            )}
          </div>
        </div>
      )}

      {servers.length === 0 && !loading ? (
        <RowList>
          <Empty
            title="还没有 MCP 服务器"
            hint="常见两种：本地起一个进程（stdio，例如 npx -y @modelcontextprotocol/server-filesystem /data），或者接一个远端地址（http）。注册后到「Agents → 某个助手 → 能力」里挂上，助手才有这些工具。"
            action={
              <button className="btn btn-primary" onClick={() => setShowNew(true)}>
                + 注册第一个
              </button>
            }
          />
        </RowList>
      ) : shown.length === 0 && !loading ? (
        <RowList>
          <Empty title="没有符合条件的服务器" hint="换个关键词或状态筛选。" />
        </RowList>
      ) : (
        <RowList>
          {shown.map((s) => {
            const st = statusOf(s);
            const isOpen = expanded === s.id;
            const target =
              s.transport === "stdio"
                ? [s.command, ...(s.args || [])].filter(Boolean).join(" ")
                : s.url;
            return (
              <div key={s.id}>
                <Row
                  expanded={isOpen}
                  onToggle={() => setExpanded(isOpen ? null : s.id)}
                  wrapActions={false}
                  actions={
                    <>
                      <Switch
                        checked={s.enabled}
                        onChange={() => void toggle(s)}
                        ariaLabel={`${s.enabled ? "停用" : "启用"} ${s.name}`}
                        title={s.enabled ? "停用（助手暂不可用这些工具）" : "启用"}
                      />
                      <button
                        className="btn !min-h-0 !px-2 !py-1 text-[12px]"
                        disabled={busyId === s.id}
                        title="连上去要一次工具清单"
                        onClick={(e) => {
                          e.stopPropagation();
                          void probe(s);
                        }}
                      >
                        {busyId === s.id ? "连接中…" : "探测"}
                      </button>
                      <button
                        className="btn !min-h-0 !px-2 !py-1 text-[12px]"
                        title="编辑连接配置"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(s);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        className="btn !min-h-0 !px-2 !py-1 text-[12px] text-[var(--color-err)]"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(s);
                        }}
                      >
                        删除
                      </button>
                    </>
                  }
                >
                  <span className="truncate text-[13.5px] font-semibold">{s.name}</span>
                  <Chip tone="muted">{s.transport === "stdio" ? "本地进程" : "远端 http"}</Chip>
                  {s.last_probe_at === 0 ? (
                    <Chip tone="warn">还没探测</Chip>
                  ) : st === "ok" ? (
                    <Chip tone="ok">{s.tools.length} 个工具</Chip>
                  ) : (
                    <Chip tone="err">连不上</Chip>
                  )}
                  {!s.enabled && <Chip tone="muted">已停用</Chip>}
                  <code className="mono hidden min-w-0 flex-1 truncate text-[12px] text-[var(--color-muted)] md:inline">
                    {target}
                  </code>
                </Row>

                {isOpen && (
                  <RowDetail>
                    <div className="flex flex-col gap-1.5">
                      <KV k="连接目标">
                        <code className="mono break-all">{target || "—"}</code>
                      </KV>
                      {s.last_probe_at > 0 && (
                        <KV k="最近探测">
                          {fmt.time(s.last_probe_at)}
                          {s.last_probe_ok ? "" : " · 失败"}
                        </KV>
                      )}
                      {!s.last_probe_ok && s.last_probe_error && (
                        <KV k="失败原因">
                          <span style={{ color: "var(--color-err)" }}>{s.last_probe_error}</span>
                        </KV>
                      )}
                      <KV k="挂到助手">到「Agents → 某个助手 → 能力」里勾上它</KV>
                      {s.tools.length > 0 && (
                        <div className="mt-1">
                          <p className="mb-1 text-[12px] text-[var(--color-muted)]">
                            工具清单（探测所得，{s.tools.length} 个）：
                          </p>
                          <ul className="flex flex-col gap-1">
                            {s.tools.map((t) => (
                              <li key={t.name} className="text-[12px]">
                                <code className="mono">{t.name}</code>
                                <span className="ml-2 text-[var(--color-muted)]">{t.description}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </RowDetail>
                )}
              </div>
            );
          })}
        </RowList>
      )}

      {(showNew || editing) && (
        <McpDialog
          key={editing?.id ?? "new"}
          server={editing}
          onClose={() => {
            setShowNew(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setShowNew(false);
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */

function McpDialog({
  server,
  onClose,
  onSaved,
}: {
  server: McpServer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const fb = useFeedback();
  const [form, setForm] = useState<McpServerInput>(() =>
    server
      ? {
          name: server.name,
          transport: server.transport,
          command: server.command,
          args: server.args || [],
          url: server.url,
          env: server.env || {},
          headers: server.headers || {},
          enabled: server.enabled,
        }
      : EMPTY,
  );
  const [argsText, setArgsText] = useState((server?.args || []).join(" "));
  const [busy, setBusy] = useState(false);
  const [probed, setProbed] = useState<McpProbeResult | null>(null);

  const payload = (): McpServerInput => ({
    ...form,
    // 参数按空格切 —— 大多数 MCP 命令就是这么写的；要带空格的用引号包起来
    args: argsText.split(/\s+/).filter(Boolean),
  });

  const test = async () => {
    setBusy(true);
    setProbed(null);
    try {
      const r = await api.probeMcpDraft(payload());
      setProbed(r);
      if (r.ok) fb.success(`连上了，${r.tools.length} 个工具`);
      else fb.warn("没连上", r.error);
    } catch (e) {
      fb.error("试连失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!form.name.trim()) {
      fb.warn("先给它起个名字");
      return;
    }
    if (form.transport === "stdio" && !form.command.trim()) {
      fb.warn("stdio 要填启动命令");
      return;
    }
    if (form.transport === "http" && !form.url.trim()) {
      fb.warn("http 要填地址");
      return;
    }
    setBusy(true);
    try {
      if (server) await api.updateMcpServer(server.id, payload());
      else await api.createMcpServer(payload());
      fb.success(server ? "已保存" : "已注册");
      onSaved();
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={DLG_BACKDROP} onClick={onClose}>
      <div
        className={`${DLG_CARD} max-w-[560px] p-4`}
        style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold">{server ? "编辑 MCP 服务器" : "注册 MCP 服务器"}</h2>
        <p className="mt-1 text-[12px] text-[var(--color-muted)]">
          只填"怎么连"。工具清单保存后点「探测」自动取回来。
        </p>

        <div className="mt-3 flex flex-col gap-3">
          <label className="block">
            <span className="label">名字</span>
            <input
              className="input w-full"
              value={form.name}
              placeholder="例如 filesystem"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <span className="mt-1 block text-[12px] text-[var(--color-muted)]">
              它会成为工具名前缀（<code className="mono">mcp__&lt;名字&gt;__&lt;工具&gt;</code>）。
              用英文字母/数字/下划线/连字符 —— 填中文会自动换成一个稳定的短名。
            </span>
          </label>

          <label className="block">
            <span className="label">怎么连</span>
            <select
              className="input w-full"
              value={form.transport}
              onChange={(e) => setForm({ ...form, transport: e.target.value as "stdio" | "http" })}
            >
              <option value="stdio">本地起一个进程（stdio）</option>
              <option value="http">连远端地址（http）</option>
            </select>
          </label>

          {form.transport === "stdio" ? (
            <>
              <label className="block">
                <span className="label">启动命令</span>
                <input
                  className="input mono w-full"
                  value={form.command}
                  placeholder="npx"
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="label">参数（空格分隔）</span>
                <input
                  className="input mono w-full"
                  value={argsText}
                  placeholder="-y @modelcontextprotocol/server-filesystem /data"
                  onChange={(e) => setArgsText(e.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <label className="block">
                <span className="label">地址</span>
                <input
                  className="input mono w-full"
                  value={form.url}
                  placeholder="https://example.com/mcp"
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="label">请求头（每行一个 key: value，可留空）</span>
                <textarea
                  className="input mono w-full"
                  rows={2}
                  value={Object.entries(form.headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n")}
                  onChange={(e) => {
                    const h: Record<string, string> = {};
                    e.target.value.split("\n").forEach((line) => {
                      const i = line.indexOf(":");
                      if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                    });
                    setForm({ ...form, headers: h });
                  }}
                />
              </label>
            </>
          )}

          {probed && (
            <div
              className="rounded-[8px] border p-2.5 text-[12px]"
              style={{
                borderColor: probed.ok
                  ? "color-mix(in srgb, var(--color-ok) 35%, var(--color-border))"
                  : "color-mix(in srgb, var(--color-err) 35%, var(--color-border))",
              }}
            >
              {probed.ok ? (
                <>
                  <b style={{ color: "var(--color-ok)" }}>连上了</b>，{probed.tools.length} 个工具：
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {probed.tools.map((t) => (
                      <li key={t.name}>
                        <code className="mono">{t.name}</code>
                        <span className="ml-2 text-[var(--color-muted)]">{t.description}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <b style={{ color: "var(--color-err)" }}>没连上</b>
                  <p className="mt-0.5 break-all text-[12px] text-[var(--color-muted)]">{probed.error}</p>
                </>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" disabled={busy} onClick={() => void test()}>
            {busy ? "测试中…" : "测试连接"}
          </button>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
