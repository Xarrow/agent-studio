/**
 * 行内描边图标（stroke 1.8，跟随 currentColor）。
 *
 * 为什么集中放这里：手机上"一行一对象"的动作区如果用文字按钮，三颗就要占一整行
 * （36px 高 + 换行），19 行的列表因此多出 600px 滚动。手机上改成图标按钮、桌面仍是
 * 文字按钮 —— 图标必须统一（同一套线宽、同样的 24 网格），否则大小和粗细参差不齐。
 *
 * 用法：只做"看得懂的动作"（编辑 / 运行 / 复制 / 查看 / 对话 / 删除），
 * 按钮上仍然给 title 和 aria-label（图标不是无字天书，长按/悬停有说明）。
 */
type P = { size?: number; className?: string };

const base = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className,
  "aria-hidden": true,
});

export function IconPencil({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export function IconPlay({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M6 4l13 8-13 8Z" />
    </svg>
  );
}

export function IconTrash({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

export function IconCopy({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

export function IconEye({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

export function IconChat({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.6-4.4A8 8 0 1 1 21 12Z" />
    </svg>
  );
}

export function IconLink({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}
