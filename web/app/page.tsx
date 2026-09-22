import Link from "next/link";
import { api, fmt, STATUS_STYLE } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [health, agents, runs, runtimes, credentials] = await Promise.all([
    api.health().catch(() => null),
    api.agents().catch(() => []),
    api.runs(undefined, 8).catch(() => []),
    api.runtimes().catch(() => []),
    api.credentials().catch(() => []),
  ]);

  const totalLlm = runs.reduce(
    (s, r) => s + (Number(r.usage?.llm_calls) || 0),
    0,
  );
  const totalCost = runs.reduce(
    (s, r) => s + (Number(r.usage?.cost_usd) || 0),
    0,
  );

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-6xl">
      <header className="mb-7">
        <h1 className="text-[22px] font-semibold tracking-tight">概览</h1>
        <p className="text-[13px] text-[var(--color-muted)] mt-1">
          {health
            ? `后端连接正常 · v${health.version} · 运行时 ${health.runtimes.join(", ")}`
            : "后端未连接（请确认 8848 端口服务已启动）"}
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-7">
        <Stat label="Agents" value={String(agents.length)} href="/agents" />
        <Stat label="LLM 配置" value={String(credentials.length)} href="/credentials" />
        <Stat label="最近 LLM 调用" value={String(totalLlm)} href="/runs" />
        <Stat
          label="累计成本"
          value={totalCost > 0 ? `$${totalCost.toFixed(4)}` : "$0"}
          href="/runs"
        />
      </div>

      <section className="mb-7">
        <h2 className="text-[15px] font-medium mb-3">运行时</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {runtimes.map((rt) => (
            <div key={rt.name} className="card p-4">
              <div className="flex items-center justify-between">
                <span className="font-medium text-[14px]">{rt.display_name}</span>
                <span className="tag mono">{rt.name}</span>
              </div>
              <p className="text-[12px] text-[var(--color-muted)] mt-2 leading-relaxed">
                {rt.notes}
              </p>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {rt.supports_hitl && <span className="tag">HITL</span>}
                {rt.supports_thinking && <span className="tag">思考过程</span>}
                {rt.supports_skills && <span className="tag">Skill</span>}
                {rt.supports_middlewares && <span className="tag">中间件</span>}
              </div>
            </div>
          ))}
          {runtimes.length === 0 && (
            <div className="card p-4 text-[13px] text-[var(--color-muted)]">
              未检测到运行时
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[15px] font-medium">最近执行</h2>
          <Link href="/runs" className="text-[12px] text-[var(--color-accent)]">
            全部 Runs →
          </Link>
        </div>
        <div className="card overflow-hidden">
          {runs.length === 0 ? (
            <div className="p-5 text-[13px] text-[var(--color-muted)]">
              还没有执行记录。去 <Link href="/agents" className="text-[var(--color-accent)]">Agents</Link> 创建一个并试跑。
            </div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead className="bg-[var(--color-surface-2)] text-[var(--color-muted)]">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Run</th>
                  <th className="text-left px-3 py-2 font-medium">状态</th>
                  <th className="text-right px-3 py-2 font-medium">LLM</th>
                  <th className="text-right px-3 py-2 font-medium">耗时</th>
                  <th className="text-right px-3 py-2 font-medium">TTFT</th>
                  <th className="text-right px-3 py-2 font-medium">tokens</th>
                  <th className="text-left px-4 py-2 font-medium">时间</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
                  >
                    <td className="px-4 py-2">
                      <Link
                        href={`/runs/${r.id}`}
                        className="mono text-[var(--color-accent)]"
                      >
                        {r.id}
                      </Link>
                    </td>
                    <td className={`px-3 py-2 ${STATUS_STYLE[r.status] ?? ""}`}>
                      {r.status}
                    </td>
                    <td className="px-3 py-2 text-right mono">
                      {r.usage?.llm_calls ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right mono">
                      {fmt.ms(r.usage?.llm_ms as number)}
                    </td>
                    <td className="px-3 py-2 text-right mono">
                      {fmt.ms(r.usage?.ttft_ms_avg as number)}
                    </td>
                    <td className="px-3 py-2 text-right mono">
                      {r.usage?.tokens_in ?? 0}/{r.usage?.tokens_out ?? 0}
                    </td>
                    <td className="px-4 py-2 text-[var(--color-muted)]">
                      {fmt.relative(r.started_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href: string;
}) {
  return (
    <Link href={href} className="card p-4 hover:border-[var(--color-accent-dim)]">
      <div className="text-[11px] text-[var(--color-muted)] uppercase tracking-wide">
        {label}
      </div>
      <div className="text-[19px] font-semibold mt-1">{value}</div>
    </Link>
  );
}
