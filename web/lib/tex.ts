/**
 * 轻量 TeX 子集**解析器**（纯函数、零依赖、无 JSX）
 * ================================================
 *
 * 为什么单独成文件：公式能不能正确认出来（分数 / 上下标 / 希腊字母 / 求和积分 /
 * 根号 / 关系符）是**逻辑**问题，不该只能靠肉眼看页面。抽成纯函数后可以用
 * node --test 直接守：认不出的命令要原样返回（宁可显示 \foo，也不要渲染错或白掉）。
 *
 * 渲染（分数用上下两行、上下标用 sup/sub）留在 components/Markdown.tsx —— 那部分是
 * 排版，不是逻辑。
 */

export const TEX_SYM: Record<string, string> = {
  // 希腊字母
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ",
  nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // 算符 / 关系
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩",
  to: "→", rightarrow: "→", Rightarrow: "⇒", leftrightarrow: "↔", mapsto: "↦",
  infty: "∞", partial: "∂", nabla: "∇", forall: "∀", exists: "∃",
  sum: "∑", prod: "∏", int: "∫", oint: "∮", sqrt: "√",
  cdotp: "·", ldots: "…", dots: "…", cdots: "⋯",
  quad: " ", qquad: "  ", ", ": " ", ";": " ", " ": " ",
  "%": "%", "#": "#", "{": "{", "}": "}", "_": "_", "&": "&", "$": "$",
};

export type MNode =
  | { k: "t"; v: string }
  | { k: "grp"; a: MNode[] }
  | { k: "frac"; a: MNode[]; b: MNode[] }
  | { k: "sqrt"; a: MNode[]; idx?: MNode[] }
  | { k: "sup"; base: MNode[]; sup: MNode[] }
  | { k: "sub"; base: MNode[]; sub: MNode[] }
  | { k: "supsub"; base: MNode[]; sup: MNode[]; sub: MNode[] };

/** 把一根 TeX 串解析成节点树。认不出的命令按字面文本（宁可显示 \foo，不要白掉）。 */
/**
 * 一行里混排的块级公式：``说明文字：$$E=mc^2$$`` 。
 *
 * 为什么单独抽出来：只认"整行以 $$ 开头"的话，模型把公式跟在解释后面时，
 * 首尾的 $$ 会**当成字面量留在页面上**（实测：页面显示成 "块级：$ … $"）。
 * 返回 null = 这行没有 $$；否则给出公式前后的文字，交给调用方分三段渲染。
 */
export function splitInlineDisplayMath(line: string): { head: string; math: string; tail: string } | null {
  const m = /^(.*?)\$\$([\s\S]+?)\$\$(.*)$/.exec(line);
  if (!m) return null;
  return { head: m[1] ?? "", math: m[2] ?? "", tail: m[3] ?? "" };
}

export function texParse(src: string): MNode[] {
  let i = 0;
  const peek = () => src[i];

  /** 读到某个收尾字符为止（\sqrt[3]{x} 里的 3）：与 seq 同一套基元+上下标规则 */
  const seqUntil = (stop: string): MNode[] => {
    const out: MNode[] = [];
    while (i < src.length && src[i] !== stop) {
      const base = atom();
      let sup: MNode[] | null = null;
      let sub: MNode[] | null = null;
      while (peek() === "^" || peek() === "_") {
        const isSup = peek() === "^";
        i++;
        const arg = group();
        if (isSup) sup = arg;
        else sub = arg;
      }
      if (sup && sub) out.push({ k: "supsub", base: [base], sup, sub });
      else if (sup) out.push({ k: "sup", base: [base], sup });
      else if (sub) out.push({ k: "sub", base: [base], sub });
      else out.push(base);
    }
    if (i < src.length) i++; // 吃掉收尾字符
    return out;
  };

  /** 取一个"组"：{...} 递归；否则取单字符（x^2 里的 2） */
  const group = (): MNode[] => {
    if (peek() === "{") {
      i++;
      const out = seq(true);
      if (peek() === "}") i++;
      return out;
    }
    if (i >= src.length) return [];
    return [{ k: "t", v: src[i++] }];
  };

  /** 取一个基元（一个 MNode） */
  const atom = (): MNode => {
    const c = peek();
    if (c === "{") return { k: "grp", a: group() };
    if (c === "\\") {
      i++;
      let name = "";
      while (i < src.length && /[a-zA-Z]/.test(src[i])) name += src[i++];
      if (!name) {
        const ch = src[i++] ?? "";
        return { k: "t", v: TEX_SYM[ch] ?? ch };
      }
      if (name === "frac") return { k: "frac", a: group(), b: group() };
      if (name === "sqrt") {
        // 方根指数：\sqrt[3]{x} —— 不认这段的话会把 "[3]" 当正文画出来（怪字符）
        let idx: MNode[] | undefined;
        if (peek() === "[") {
          i++;
          idx = seqUntil("]");
        }
        return { k: "sqrt", a: group(), idx };
      }
      if (name === "text" || name === "mathrm" || name === "operatorname") {
        return { k: "t", v: plain(group()) }; // 这些里面的字符按字面
      }
      return { k: "t", v: TEX_SYM[name] ?? "\\" + name };
    }
    i++;
    return { k: "t", v: c ?? "" };
  };

  /** 一串基元；遇到 } 就停（若在组里） */
  const seq = (inGroup: boolean): MNode[] => {
    const out: MNode[] = [];
    while (i < src.length) {
      if (inGroup && peek() === "}") break;
      const base = atom();
      // 基元后面可能挂上下标（可以同时有 ^ 和 _，顺序随意）
      let sup: MNode[] | null = null;
      let sub: MNode[] | null = null;
      while (peek() === "^" || peek() === "_") {
        const isSup = peek() === "^";
        i++;
        const arg = group();
        if (isSup) sup = arg;
        else sub = arg;
      }
      if (sup && sub) out.push({ k: "supsub", base: [base], sup, sub });
      else if (sup) out.push({ k: "sup", base: [base], sup });
      else if (sub) out.push({ k: "sub", base: [base], sub });
      else out.push(base);
    }
    return out;
  };

  /** 把节点树摊回纯文本（\text{} 用） */
  const plain = (nodes: MNode[]): string =>
    nodes
      .map((n) => {
        switch (n.k) {
          case "t": return n.v;
          case "grp": return plain(n.a);
          case "frac": return `${plain(n.a)}/${plain(n.b)}`;
          case "sqrt": return `√${plain(n.a)}`;  // 指数不参与"纯文本"形态
          case "sup": return `${plain(n.base)}^${plain(n.sup)}`;
          case "sub": return `${plain(n.base)}_${plain(n.sub)}`;
          case "supsub": return `${plain(n.base)}^${plain(n.sup)}_${plain(n.sub)}`;
        }
      })
      .join("");

  return seq(false);
}
