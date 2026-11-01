/**
 * 「浮层 ⇄ 浏览器历史」的一层薄封装。
 *
 * 背景：手机上从左缘滑动、Android 手势返回、浏览器「后退」，触发的都是
 * `history.back()`。单路由页面里切换会话、开抽屉、开文件面板全是 React state，
 * 历史栈一条都不增 → 用户一滑，浏览器发现站内没有上一页，**直接退出网页**
 * （Android 关标签回到桌面，iOS 退回上一个站点）。
 *
 * 这里把「页面上打开着的每一层」映射成一条历史记录：
 *   打开 → pushState；用户返回 → 关掉这一层；程序内关闭 → 撤回自己那条记录。
 * 于是左滑 = 关闭浮层 / 回到上一个会话；在最底层滑 = 正常退出（不劫持返回键）。
 *
 * 逻辑抽成纯函数以便 node --test（仓库前端测试不带 DOM）。
 */

export type LayerEntry = {
  /** 唯一 id，同时写进 history.state.__hl */
  id: string;
  kind: "layer" | "session";
  /** 用户按返回把它「退掉」时该做的事（关浮层 / 回到上一个会话） */
  onClose: () => void;
};

export type HistoryEnv = {
  push: (state: Record<string, unknown>) => void;
  replace: (state: Record<string, unknown>) => void;
  back: () => void;
  /** 订阅 popstate */
  onChange: (handler: () => void) => () => void;
};

export function createLayerStack(env: HistoryEnv) {
  const stack: LayerEntry[] = [];
  /** 我们自己调 back() 撤回记录时，要吃掉随之而来的那次 popstate */
  let ownBacks = 0;
  const listeners = new Set<() => void>();
  const sync = () => listeners.forEach((fn) => fn());

  env.onChange(() => {
    if (ownBacks > 0) {
      ownBacks -= 1;
      return;
    }
    // 用户返回：栈顶那一层就是我们刚离开的那条记录
    const top = stack.pop();
    if (!top) return; // 站内最底层 → 不拦截，让浏览器正常退出去
    try {
      top.onClose();
    } finally {
      sync();
    }
  });

  return {
    /**
     * 压一层。
     *
     * `takeOver`：接管当前栈顶那条记录（用 replaceState），而不是再压一条。
     * 用在「抽屉里点会话」这种连续动作上 —— 点完抽屉就关了，如果还留着它的
     * 那条历史，用户要多滑一次才见面「什么都没发生」的空退。
     */
    open(entry: LayerEntry, takeOver = false): string {
      const top = stack[stack.length - 1];
      if (takeOver && top) {
        stack[stack.length - 1] = entry;
        env.replace({ __hl: entry.id });
      } else {
        stack.push(entry);
        env.push({ __hl: entry.id });
      }
      sync();
      return entry.id;
    },

    /**
     * 程序内关闭（点 ✕ / 点遮罩 / 打开下一层）。
     *
     * - 不在栈里 = 已经被返回消费掉了 → 幂等忽略（否则会多退一级，
     *   表现成「左滑一次退两页」）。
     * - 不在栈顶 = 只摘记录、不回退（否则会连带把上面那层也退掉）。
     */
    close(id: string): void {
      const i = stack.findIndex((e) => e.id === id);
      if (i === -1) return;
      const wasTop = i === stack.length - 1;
      stack.splice(i, 1);
      if (wasTop) {
        ownBacks += 1;
        env.back();
      }
      sync();
    },

    depth(): number {
      return stack.length;
    },

    /** 仅供测试断言 */
    ids(): string[] {
      return stack.map((e) => e.id);
    },
  };
}

export type LayerStack = ReturnType<typeof createLayerStack>;
