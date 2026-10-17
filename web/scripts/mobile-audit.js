/**
 * 手机适配自检脚本（在浏览器控制台 / CDP 里执行，返回一份体检结果）。
 *
 * 为什么要有它：移动端的问题（横向溢出、手指点不准的小控件、只在 hover 出现的控件）
 * 肉眼在桌面上看不出来，靠"我觉得没问题"必然漏。这个脚本量三件事 + 控制台报错：
 *   ① 横向溢出（只报真正的元凶层：父元素没溢出的那一层；
 *      父元素是 truncate（overflow:hidden / 省略号）时不算 —— 那是故意裁的）
 *   ② 触屏目标过小（<32px；勾选框按它的 label 算可点区）
 *   ③ 只在 hover 才出现的控件（手机上不存在）
 *   ④ 控制台报错
 * 用法：先用 CDP 把视口设成 390x844（mobile=true），逐个路由执行本脚本，
 *      顶部量一次、滚到底再量一次。全 0 才算过。
 */
(() => {
  const W = window.innerWidth, H = window.innerHeight;
  const doc = document.documentElement;
  const hidden = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return true;
    if (s.position !== "fixed" && el.offsetParent === null) return true; // 祖先里有人 display:none
    return false;
  };
  const path = (el) => {
    const p = [];
    let n = el;
    for (let i = 0; i < 4 && n && n.tagName; i++) {
      let c = "";
      if (typeof n.className === "string" && n.className) c = "." + n.className.trim().split(/\s+/).slice(0, 2).join(".");
      p.unshift(n.tagName.toLowerCase() + c);
      n = n.parentElement;
    }
    return p.join(">");
  };
  const txt = (el) => (el.textContent || el.getAttribute("title") || el.getAttribute("placeholder") || "").trim().slice(0, 34);
  const res = {
    W, H, docScrollW: doc.scrollWidth, bodyScrollW: document.body.scrollWidth,
    overflow: [], small: [], hoverOnly: [], errs: (window.__errs || []).slice(0, 4),
  };

  // ① 横向溢出（只记真正的元凶层）
  document.querySelectorAll("*").forEach((el) => {
    if (hidden(el)) return;
    const r = el.getBoundingClientRect();
    const over = Math.round(r.right - W), left = Math.round(r.left);
    if (over <= 2 && left >= -2) return;
    const p = el.parentElement;
    if (p && !hidden(p)) {
      const pr = p.getBoundingClientRect();
      if (Math.max(pr.right - W, -pr.left) > 2) return;
      // 父元素自己"故意裁掉"（truncate = overflow:hidden + 省略号）→ 不算溢出
      const ps = getComputedStyle(p);
      if ((ps.overflowX === "hidden" || ps.textOverflow === "ellipsis") && pr.right <= W + 1 && pr.left >= -1) return;
    }
    res.overflow.push({ p: path(el), left, right: Math.round(r.right), over, w: Math.round(r.width), t: txt(el) });
  });

  // ② 触屏目标过小 —— 勾选框/单选框算**它外层 label** 的可点区
  document.querySelectorAll("button, a, select, textarea, input:not([type=hidden]), [data-tap], [role=button], summary").forEach((el) => {
    if (hidden(el)) return;
    let target = el;
    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
      target = el.closest("label") || el.parentElement || el;
      if (hidden(target)) target = el;
    }
    const r = target.getBoundingClientRect();
    if (r.width < 32 || r.height < 32) {
      res.small.push({ p: path(target), w: Math.round(r.width), h: Math.round(r.height), t: txt(el) || txt(target) });
    }
  });

  // ③ 只在 hover 才出现的控件 = 手机上不存在（隐藏容器里的不算）
  document.querySelectorAll("*").forEach((el) => {
    const cls = typeof el.className === "string" ? el.className : "";
    if (!cls || hidden(el)) return;
    const hoverOnlyOpacity = /opacity-0/.test(cls) && /(group-hover|hover):opacity-100/.test(cls);
    const noTouchFallback = /(^|\s)(hidden|opacity-0)(\s|$)/.test(cls) && /(^|\s)(group-hover|hover):/.test(cls) && !/(lg:|sm:|max-)/.test(cls);
    if (hoverOnlyOpacity || noTouchFallback) res.hoverOnly.push({ p: path(el), cls: cls.slice(0, 80) });
  });
  return res;
})()
