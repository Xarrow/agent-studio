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
 */

import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { McpProbeResult, McpServer, McpServerInput } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { Hint } from "@/components/ui/hint";

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

export function McpPanel({ embedded = false }: { embedded?: boolean }) {
  const fb = useFeedback();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openTools, setOpenTools] = useState<string | null>(null);

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
      description: "挂在它上面的助手会少掉这些工具。重新注册可以恢复。",
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

  return (
    <div className={embedded ? "" : "p-4 md:p-6 lg:p-7 max-w-5xl"}>
      {!embedded && (
        <>
          <header className="flex items-start justify-between mb-6">
            <div>
              <h1 className="text-[22px] font-semibold tracking-tight flex items-center gap-1.5">
                <Hint text="MCP 是一套标准协议：别人写好的工具服务，用这个协议接进来就能给助手用。">
                  MCP 服务器
                </Hint>
              </h1>
              <p className="text-[13px] text-[var(--color-muted)] mt-1">
                把外部的工具服务接进来。注册一次，多个助手都能挂。
              </p>
            </div>
          </header>
        </>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          + 注册 MCP 服务器
        </button>
        <span className="text-[12px] text-[var(--color-muted)]">
          {loading ? "加载中…" : `${servers.length} 个`}
        </span>
        <p className="w-full text-[11.5px] text-[var(--color-muted)]">
          工具清单靠<b>探测</b>得到（连上去问服务器要），不用手填 —— 手填的一定会和实际漂移。
          注册后到「Agents → 某个助手 → 能力」里勾上它，助手才有这些工具。
        </p>
      </div>

      {servers.length === 0 && !loading && (
        <div className="rounded-[10px] border p-4 text-[13px] text-[var(--color-muted)]" style={{ borderColor: "var(--color-border)" }}>
          还没有 MCP 服务器。常见的两种：本地起一个进程（stdio，例如
          <code className="mono"> npx -y @modelcontextprotocol/server-filesystem /data</code>），
          或者接一个远端地址（http）。
        </div>
      )}

      <div className="flex flex-col gap-2">
        {servers.map((s) => (
          <div
            key={s.id}
            className="rounded-[10px] border p-3"
            style={{ borderColor: "var(--color-border)", opacity: s.enabled ? 1 : 0.6 }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-semibold">{s.name}</span>
              <span className="tag">{s.transport === "stdio" ? "本地进程" : "远端 http"}</span>
              <span
                className="tag"
                style={
                  s.last_probe_ok
                    ? { color: "var(--color-ok)", borderColor: "color-mix(in srgb, var(--color-ok) 35%, var(--color-border))" }
                    : { color: "var(--color-warn)", borderColor: "color-mix(in srgb, var(--color-warn) 35%, var(--color-border))" }
                }
              >
                {s.last_probe_at === 0
                  ? "还没探测"
                  : s.last_probe_ok
                    ? `${s.tools.length} 个工具`
                    : "连不上"}
              </span>
              {!s.enabled && <span className="tag">已停用</span>}
              <div className="ml-auto flex flex-wrap gap-1.5">
                <button className="btn text-[12px]" disabled={busyId === s.id} onClick={() => void probe(s)}>
                  {busyId === s.id ? "连接中…" : "重新探测"}
                </button>
                {s.tools.length > 0 && (
                  <button className="btn text-[12px]" onClick={() => setOpenTools(openTools === s.id ? null : s.id)}>
                    {openTools === s.id ? "收起工具" : "看工具"}
                  </button>
                )}
                <button className="btn text-[12px]" onClick={() => setEditing(s)}>
                  编辑
                </button>
                <button className="btn text-[12px]" onClick={() => void toggle(s)}>
                  {s.enabled ? "停用" : "启用"}
                </button>
                <button className="btn text-[12px] text-[var(--color-err)]" onClick={() => void remove(s)}>
                  删除
                </button>
              </div>
            </div>

            <div className="mt-1.5 text-[11.5px] text-[var(--color-muted)] break-all">
              {s.transport === "stdio" ? (
                <code className="mono">{[s.command, ...(s.args || [])].filter(Boolean).join(" ")}</code>
              ) : (
                <code className="mono">{s.url}</code>
              )}
              {s.last_probe_at > 0 && (
                <span className="ml-2">· 最近探测 {fmt.time(s.last_probe_at)}</span>
              )}
            </div>
            {!s.last_probe_ok && s.last_probe_error && (
              <p className="mt-1 text-[11.5px]" style={{ color: "var(--color-err)" }}>
                {s.last_probe_error}
              </p>
            )}

            {openTools === s.id && s.tools.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 border-t pt-2" style={{ borderColor: "var(--color-border)" }}>
                {s.tools.map((t) => (
                  <li key={t.name} className="text-[12px]">
                    <code className="mono">{t.name}</code>
                    <span className="ml-2 text-[var(--color-muted)]">{t.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="max-h-[86vh] w-full max-w-[560px] overflow-auto rounded-[12px] border p-4"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold">{server ? "编辑 MCP 服务器" : "注册 MCP 服务器"}</h2>
        <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">
          只填"怎么连"。工具清单保存后点「重新探测」自动取回来。
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
            <span className="mt-1 block text-[11px] text-[var(--color-muted)]">
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
                  <p className="mt-0.5 break-all text-[11.5px] text-[var(--color-muted)]">{probed.error}</p>
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
