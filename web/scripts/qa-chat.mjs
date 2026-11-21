#!/usr/bin/env node
/**
 * 对话页的接口契约回归（零依赖，node 直接跑）
 *
 *   node scripts/qa-chat.mjs [--base http://127.0.0.1:8848]
 *
 * 守的是这轮 QA 里真出过的问题，靠自觉会再犯：
 *   ① 会话清单必须按助手过滤 —— 混进别人的会话，前端就会"切了助手内容还是旧的"
 *   ② ETag 命中（304）时，仍必须能拿到**这个助手**的清单（不是当前渲染那份）
 *   ③ 删掉的会话再取要明确不存在（前端据此提示并切走，而不是停在空白页）
 *   ④ 会话详情里的 agent_id 必须与清单一致（前后端对同一条会话的判断同源）
 *
 * 不测 UI 动效/布局 —— 那些要人眼看，放真机点验。
 */
const argBase = process.argv.indexOf("--base");
const BASE = argBase > -1 ? process.argv[argBase + 1] : "http://127.0.0.1:8848";

let failed = 0;
const ok = (name, extra = "") => console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`);
const bad = (name, detail) => {
  failed += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail) => (cond ? ok(name, detail) : bad(name, detail));

async function get(path) {
  const r = await fetch(BASE + path);
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, headers: r.headers, body };
}

async function post(path, data) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  console.log(`QA: 对话页接口契约 @ ${BASE}`);

  // 清场会话（本轮自建、结束时删掉）
  const created = [];

  try {
    const agents = (await get("/api/agents")).body;
    const list = Array.isArray(agents) ? agents : (agents?.items ?? []);
    check("能取到助手清单", list.length > 0, `${list.length} 个`);
    if (!list.length) throw new Error("没有助手，无法继续");

    // ① 会话清单按助手过滤
    const a = list[0].id;
    const b = list[1]?.id ?? a;
    const sa = (await get(`/api/sessions?agent_id=${a}`)).body;
    const wrong = sa.filter((s) => s.agent_id !== a);
    check(`① /sessions?agent_id=${a.slice(-6)} 不含别的助手`, wrong.length === 0, wrong.length ? `${wrong.length} 条串了` : `${sa.length} 条`);

    if (a !== b) {
      const sb = (await get(`/api/sessions?agent_id=${b}`)).body;
      const overlap = sa.filter((s) => sb.some((x) => x.id === s.id));
      check("① 两个助手的会话集合不重叠", overlap.length === 0, overlap.length ? overlap[0].id : "ok");
    }

    // ② ETag 304 仍能拿到本助手的清单
    const first = await get(`/api/sessions?agent_id=${a}`);
    const etag = first.headers.get("etag");
    if (etag) {
      const again = await fetch(BASE + `/api/sessions?agent_id=${a}`, { headers: { "If-None-Match": etag } });
      if (again.status === 304) {
        const other = await fetch(BASE + `/api/sessions?agent_id=${b}`, {
          headers: { "If-None-Match": etag },
        });
        check(
          `② 304 之后换成 ${b.slice(-6)} 仍返回该助手清单（不能回 304）`,
          other.status !== 304 || a === b,
          `status=${other.status}`,
        );
      } else {
        ok("② 服务端未启用 304（跳过）", `status=${again.status}`);
      }
    } else {
      ok("② 无 ETag 头（跳过）");
    }

    // ③ 删除 → 再取必须不存在
    const mk = await post("/api/sessions", { agent_id: a, title: "qa-chat 临时会话" });
    const sid = mk.body?.id ?? mk.body?.session?.id;
    check("③ 新建临时会话", Boolean(sid), sid || JSON.stringify(mk.body).slice(0, 80));
    if (sid) {
      created.push(sid);
      const detail = await get(`/api/sessions/${sid}?turns=1`);
      check("③ 新会话可读", detail.status === 200, `status=${detail.status}`);
      const del = await fetch(BASE + `/api/sessions/${sid}`, { method: "DELETE" });
      check("③ 删除返回成功", del.status < 300, `status=${del.status}`);
      const after = await get(`/api/sessions/${sid}?turns=1`);
      check("③ 删掉后再取 → 404/410（前端据此提示并切走）", [404, 410].includes(after.status), `status=${after.status}`);
      const listed = (await get(`/api/sessions?agent_id=${a}`)).body.filter((s) => s.id === sid);
      check("③ 清单里不再出现", listed.length === 0, listed.length ? "仍在" : "ok");
      created.pop();
    }

    // ④ 详情与清单的 agent_id 同源
    const sample = (await get(`/api/sessions?agent_id=${a}`)).body[0];
    if (sample) {
      const d = (await get(`/api/sessions/${sample.id}?turns=1`)).body;
      check("④ 详情 agent_id 与清单一致", d?.session?.agent_id === sample.agent_id, `${d?.session?.agent_id} vs ${sample.agent_id}`);
      check("④ 详情带 messages 数组", Array.isArray(d?.messages), typeof d?.messages);
    } else {
      ok("④ 该助手没有会话（跳过）");
    }
  } catch (e) {
    bad("执行异常", e instanceof Error ? e.message : String(e));
  } finally {
    for (const sid of created) {
      await fetch(BASE + `/api/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
    }
  }

  /* ── --slow：真的起一轮，验证"切走不掐现场 / 切回能接上"的契约 ──────────
     前端回挂依赖三件后端事实，这三件错了就会串台或白屏：
       ⑤ 切走期间服务端仍在跑（in_flight 仍能查到这条 run）
       ⑥ 别的助手的会话清单里不会冒出这条会话
       ⑦ stream 端点能给回放（首帧 event，前端靠它把现场接回来）
     跑一次约 10-20 秒（真调模型），所以只在 --slow 时执行。 */
  if (process.argv.includes("--slow")) {
    console.log("\n--slow：起一轮真实执行，验证切换契约");
    let sid = "";
    let rid = "";
    try {
      const agents = (await get("/api/agents")).body;
      const list = Array.isArray(agents) ? agents : (agents?.items ?? []);
      const mine = list[0];
      const other = list[1] ?? list[0];
      const mk = await post("/api/sessions", { agent_id: mine.id, title: "qa-chat slow" });
      sid = mk.body?.id ?? mk.body?.session?.id;
      check("⑤ 建会话", Boolean(sid), sid || "无 id");

      const r = await post("/api/runs", {
        agent_id: mine.id,
        session_id: sid,
        input: "请用 500 字说明 BM25 与向量检索的区别，不要调用任何工具。",
        origin: "chat",
      });
      rid = r.body?.id ?? "";
      check("⑤ 起一轮执行", Boolean(rid), `status=${r.status} ${rid}`);

      // 切走的那一拍：服务端必须还在跑
      await new Promise((ok2) => setTimeout(ok2, 1200));
      const inflight = (await get(`/api/runs?session_id=${sid}&in_flight=true&limit=5`)).body;
      const running = (Array.isArray(inflight) ? inflight : []).find((x) => x.id === rid);
      check("⑤ 切走后这条 run 仍在跑（现场没被掐）", Boolean(running), running ? running.status : "查不到");

      // 别的助手的清单里不能有它
      const others = (await get(`/api/sessions?agent_id=${other.id}`)).body;
      check("⑥ 别的助手清单里没有这条会话", !others.some((x) => x.id === sid), `${others.length} 条`);

      // stream 能给回放（前端 attachStream 的输入）
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      let firstChunk = "";
      try {
        const resp = await fetch(BASE + `/api/sessions/${sid}/stream`, { signal: ctrl.signal });
        const reader = resp.body.getReader();
        const { value } = await reader.read();
        firstChunk = new TextDecoder().decode(value ?? new Uint8Array());
        reader.cancel().catch(() => {});
      } catch {
        /* 超时也当没拿到 */
      } finally {
        clearTimeout(t);
      }
      check("⑦ stream 首帧可达（回放现场）", firstChunk.length > 0, `${firstChunk.slice(0, 40).replace(/\n/g, " ")}`);

      // 收尾：中止，别白烧 token
      if (rid) await post(`/api/runs/abort/${rid}`, {});
      await new Promise((ok2) => setTimeout(ok2, 800));
      const last = (await get(`/api/runs/${rid}`)).body;
      check("⑤ 中止后不再 running", !["running", "pending"].includes(last?.status), `status=${last?.status}`);
    } catch (e) {
      bad("--slow 执行异常", e instanceof Error ? e.message : String(e));
    } finally {
      if (sid) await fetch(BASE + `/api/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
    }
  }

  console.log(failed ? `\n失败 ${failed} 项` : "\n全部通过");
  process.exit(failed ? 1 : 0);
})();
