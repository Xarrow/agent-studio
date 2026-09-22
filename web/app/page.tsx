import Link from "next/link";
import { api, fmt, STATUS_STYLE } from "@/lib/api";
import { Hint, HINTS } from "@/components/ui/hint";

export const dynamic = "force-dynamic";

/**
 * 首页 —— **任务导向，不是数据导向**。
 *
 * 设计原则（"小孩子也能学会"）：
 *  1. 没配置好时：直接给「三步开始」，每步一个大按钮 —— 不让人对着数据发呆
 *  2. 配置好后：先给「继续上次对话」（最高频动作），再给「我的助手」
 *  3. 监控类数据（运行时能力、TTFT、tokens）**降到次要位置**，且都挂通俗提示
 */
export default async function HomePage() {
  const [health, agents, runs, runtimes, credentials, sessions] = await Promise.all([
    api.health().catch(() => null),
    api.agents().catch(() => []),
    api.runs(undefined, 5).catch(() => []),
    api.runtimes().catch(() => []),
    api.credentials().catch(() => []),
    api.sessions().catch(() => []),
  ]);

  const hasCred = credentials.length > 0;
  const hasAgent = agents.length > 0;
  const ready = hasCred && hasAgent;

  // 最近聊过的那个对话（按更新时间）
  const recentSession = [...sessions].sort(
    (a, b) => Number(b.last_active_at || 0) - Number(a.last_active_at || 0),
  )[0];

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-5xl">
      <header className="mb-6">
        <h1 className="text-[22px] font-semibold tracking-tight">
          {ready ? "概览" : "欢迎使用 Agent Studio"}
        </h1>
        <p className="text-[13px] text-[var(--color-muted)] mt-1">
          {ready
            ? "接着上次继续，或者建一个新的助手。"
            : "三步就能让 AI 开始帮你干活。"}
        </p>
      </header>

      {!ready ? (
        <Onboarding hasCred={hasCred} hasAgent={hasAgent} />
      ) : (
        <>
          {/* ① 最高频动作放最上：继续上次对话 */}
          {recentSession && (
            <section className="mb-6">
              <Link
                href="/chat"
                className="card p-4 flex items-center gap-4 hover:border-[var(--color-accent-dim)] transition-colors"
              >
                <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-[15px]"
                     style={{ background: "color-mix(in srgb, var(--color-accent) 12%, transparent)", color: "var(--color-accent)" }}>
                  ✦
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-[var(--color-muted)] mb-0.5">
                    继续上次的对话
                  </div>
                  <div className="text-[14px] font-medium truncate">
                    {recentSession.title || "未命名对话"}
                  </div>
                  <div className="text-[11.5px] text-[var(--color-muted)] mt-0.5">
                    {recentSession.agent_name ?? "助手"} ·{" "}
                    {recentSession.message_count ?? 0} 条消息 ·{" "}
                    {fmt.relative(recentSession.last_active_at)}
                  </div>
                </div>
                <span className="text-[var(--color-accent)] text-[13px] shrink-0">
                  继续 →
                </span>
              </Link>
            </section>
          )}

          {/* ② 我的助手 */}
          <section className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[15px] font-medium">我的助手</h2>
              <Link href="/agents" className="text-[12px] text-[var(--color-accent)]">
                管理 →
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {agents.map((a) => (
                <div key={a.id} className="card p-4 flex flex-col">
                  <div className="font-medium text-[14px] truncate">{a.name}</div>
                  <p className="text-[12px] text-[var(--color-muted)] mt-1 line-clamp-2 flex-1">
                    {a.description || "还没有写说明"}
                  </p>
                  <div className="flex gap-2 mt-3">
                    <Link
                      href="/chat"
                      className="btn btn-primary flex-1 text-center text-[12.5px]"
                    >
                      聊天
                    </Link>
                    <Link
                      href={`/agents/${a.id}`}
                      className="btn flex-1 text-center text-[12.5px]"
                    >
                      设置
                    </Link>
                  </div>
                </div>
              ))}
              <Link
                href="/agents"
                className="card p-4 flex flex-col items-center justify-center gap-1.5 text-[13px] text-[var(--color-muted)] hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)] transition-colors min-h-[128px]"
              >
                <span className="text-[20px] leading-none">+</span>
                <span>新建助手</span>
              </Link>
            </div>
          </section>

          {/* ③ 最近的对话（用户视角，不是 Run ID） */}
          <section className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[15px] font-medium">最近的对话</h2>
              <Link href="/chat" className="text-[12px] text-[var(--color-accent)]">
                全部 →
              </Link>
            </div>
            <div className="card divide-y divide-[var(--color-border)]">
              {sessions.length === 0 ? (
                <div className="p-5 text-[13px] text-[var(--color-muted)]">
                  还没聊过。点 <Link href="/chat" className="text-[var(--color-accent)]">对话</Link> 开始。
                </div>
              ) : (
                [...sessions]
                  .sort((a, b) => Number(b.last_active_at || 0) - Number(a.last_active_at || 0))
                  .slice(0, 5)
                  .map((s) => {
                    return (
                      <Link
                        key={s.id}
                        href="/chat"
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors"
                      >
                        <span className="text-[13.5px] truncate flex-1">
                          {s.title || "未命名对话"}
                        </span>
                        <span className="text-[11.5px] text-[var(--color-muted)] shrink-0">
                          {s.agent_name ?? "—"}
                        </span>
                        <span className="text-[11.5px] text-[var(--color-muted)] shrink-0 w-16 text-right">
                          {fmt.relative(s.last_active_at)}
                        </span>
                      </Link>
                    );
                  })
              )}
            </div>
          </section>
        </>
      )}

      {/* ④ 技术信息折叠起来 —— 需要时再展开，每个术语都挂通俗解释 */}
      <details className="card mb-6">
        <summary className="px-4 py-3 cursor-pointer text-[13.5px] font-medium select-none">
          系统状态与技术细节
        </summary>
        <div className="px-4 pb-4 space-y-4 border-t border-[var(--color-border)] pt-4">
          <div className="text-[12.5px] text-[var(--color-muted)]">
            {health
              ? `后端连接正常 · 版本 v${health.version}`
              : "后端未连接（请确认 8848 端口服务已启动）"}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="助手" value={String(agents.length)} href="/agents" hint={HINTS.agent} />
            <Stat label="模型密钥" value={String(credentials.length)} href="/credentials" hint={HINTS.credential} />
            <Stat label="最近调用" value={String(runs.reduce((s, r) => s + (Number(r.usage?.llm_calls) || 0), 0))} href="/runs" hint="最近几次里，AI 一共被问了多少次。" />
            <Stat
              label="累计成本"
              value={
                runs.reduce((s, r) => s + (Number(r.usage?.cost_usd) || 0), 0) > 0
                  ? `$${runs.reduce((s, r) => s + (Number(r.usage?.cost_usd) || 0), 0).toFixed(4)}`
                  : "$0"
              }
              href="/runs"
              hint="按服务商的价格估算的花费。显示 $0 通常是还没配置价格。"
            />
          </div>

          <div>
            <h3 className="text-[13px] font-medium mb-2 flex items-center gap-1">
              <Hint text={HINTS.runtime}>运行时</Hint>
            </h3>
            <div className="space-y-2">
              {runtimes.map((rt) => (
                <div key={rt.name} className="text-[12.5px] flex flex-wrap items-center gap-2">
                  <span className="font-medium">{rt.display_name}</span>
                  <span className="tag mono">{rt.name}</span>
                  {rt.supports_hitl && <Hint text={HINTS.hitl}><span className="tag">HITL</span></Hint>}
                  {rt.supports_thinking && <Hint text={HINTS.thinking}><span className="tag">思考过程</span></Hint>}
                  {rt.supports_skills && <Hint text={HINTS.skill}><span className="tag">Skill</span></Hint>}
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-[13px] font-medium mb-2">
              最近执行（
              <Hint text={HINTS.run}>Run</Hint>
              ）
            </h3>
            <div className="overflow-x-auto">
              {runs.length === 0 ? (
                <p className="text-[12.5px] text-[var(--color-muted)]">还没有执行记录。</p>
              ) : (
                <table className="w-full min-w-[600px] text-[12px]">
                  <thead className="text-[var(--color-muted)]">
                    <tr>
                      <th className="text-left py-1.5 font-medium">记录</th>
                      <th className="text-left font-medium">状态</th>
                      <th className="text-right font-medium">
                        <Hint text="这次执行里，AI 被问了几次。" />
                      </th>
                      <th className="text-right font-medium">耗时</th>
                      <th className="text-right font-medium">
                        <Hint text={HINTS.ttft}>TTFT</Hint>
                      </th>
                      <th className="text-right font-medium">
                        <Hint text={HINTS.token}>tokens</Hint>
                      </th>
                      <th className="text-left font-medium">时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} className="border-t border-[var(--color-border)]">
                        <td className="py-1.5">
                          <Link href={`/runs/${r.id}`} className="mono text-[var(--color-accent)]">
                            {r.id.slice(4, 12)}
                          </Link>
                        </td>
                        <td className={`${STATUS_STYLE[r.status] ?? ""}`}>{r.status}</td>
                        <td className="text-right mono">{r.usage?.llm_calls ?? 0}</td>
                        <td className="text-right mono">{fmt.ms(r.usage?.llm_ms as number)}</td>
                        <td className="text-right mono">{fmt.ms(r.usage?.ttft_ms_avg as number)}</td>
                        <td className="text-right mono">
                          {r.usage?.tokens_in ?? 0}/{r.usage?.tokens_out ?? 0}
                        </td>
                        <td className="text-[var(--color-muted)]">
                          {fmt.relative(r.started_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}

/** 三步开始 —— 未配置好时显示的引导 */
function Onboarding({ hasCred, hasAgent }: { hasCred: boolean; hasAgent: boolean }) {
  const steps = [
    {
      n: "①",
      done: hasCred,
      title: "填一个模型密钥",
      desc: "AI 要工作，得先有一把钥匙。去服务商网站申请，粘进来就行。",
      action: "去填写",
      href: "/credentials",
      hint: HINTS.credential,
    },
    {
      n: "②",
      done: hasAgent,
      title: "创建一个助手",
      desc: "告诉它你希望它帮你做什么（写代码、答疑、查资料…）。",
      action: "去创建",
      href: "/agents",
      hint: HINTS.agent,
    },
    {
      n: "③",
      done: false,
      title: "开始聊天",
      desc: "像发消息一样说出你要什么，它自己想办法完成。",
      action: "开始聊天",
      href: "/chat",
      hint: HINTS.multiTurn,
    },
  ];
  const firstUndone = steps.findIndex((s) => !s.done);

  return (
    <div className="space-y-3">
      {steps.map((s, i) => {
        const active = i === firstUndone;
        return (
          <Link
            key={s.n}
            href={s.href}
            className={`card p-4 flex items-center gap-4 transition-colors ${
              active
                ? "border-[var(--color-accent)] hover:border-[var(--color-accent-dim)]"
                : s.done
                  ? "opacity-70"
                  : "opacity-60"
            }`}
          >
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-[16px] font-semibold"
              style={{
                background: s.done
                  ? "color-mix(in srgb, var(--color-ok, #16a34a) 16%, transparent)"
                  : active
                    ? "color-mix(in srgb, var(--color-accent) 14%, transparent)"
                    : "var(--color-surface-2)",
                color: s.done
                  ? "var(--color-ok, #16a34a)"
                  : active
                    ? "var(--color-accent)"
                    : "var(--color-muted)",
              }}
            >
              {s.done ? "✓" : s.n}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[14.5px] font-medium flex items-center gap-1.5">
                {s.title}
                <span onClick={(e) => e.stopPropagation()}>
                  <Hint text={s.hint} />
                </span>
              </div>
              <p className="text-[12.5px] text-[var(--color-muted)] mt-0.5 leading-relaxed">
                {s.desc}
              </p>
            </div>
            <span
              className={`text-[13px] shrink-0 ${
                active ? "text-[var(--color-accent)] font-medium" : "text-[var(--color-muted)]"
              }`}
            >
              {s.done ? "已完成" : `${s.action} →`}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: string;
  href: string;
  hint?: string;
}) {
  return (
    <Link href={href} className="card p-4 hover:border-[var(--color-accent-dim)]">
      <div className="text-[11px] text-[var(--color-muted)] flex items-center gap-1">
        {hint ? <Hint text={hint}>{label}</Hint> : label}
      </div>
      <div className="text-[19px] font-semibold mt-1">{value}</div>
    </Link>
  );
}
