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

/* ── 文件类型图标（会话文件胶囊 / 文件弹框标题用）──────────────────────
   同一套 24 网格、1.8 线宽；用"文档 + 里面的符号"表达类型，
   不做彩色 emoji —— 一屏十几个胶囊时颜色会盖过文件名本身。 */
function Doc({ size = 14, className, children }: P & { children?: React.ReactNode }) {
  return (
    <svg {...base(size ?? 14, className)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      {children}
    </svg>
  );
}

/** 图片：山 + 太阳 */
export function IconFileImage({ size = 14, className }: P) {
  return (
    <Doc size={size} className={className}>
      <path d="M8 13l2.5 2.5L13 13" />
      <circle cx="10.5" cy="10.5" r="0.6" />
    </Doc>
  );
}

/** JSON：一对花括号 */
export function IconFileJson({ size = 14, className }: P) {
  return (
    <Doc size={size} className={className}>
      <path d="M10.5 10.5c-1 0-1.2.6-1.2 1.5s-.4 1.5-1.3 1.5c.9 0 1.3.6 1.3 1.5s.2 1.5 1.2 1.5" />
      <path d="M13.5 10.5c1 0 1.2.6 1.2 1.5s.4 1.5 1.3 1.5c-.9 0-1.3.6-1.3 1.5s-.2 1.5-1.2 1.5" />
    </Doc>
  );
}

/** XML / HTML：尖括号 */
export function IconFileXml({ size = 14, className }: P) {
  return (
    <Doc size={size} className={className}>
      <path d="M10.5 10.5L8.8 13l1.7 2.5" />
      <path d="M13.5 10.5L15.2 13l-1.7 2.5" />
    </Doc>
  );
}

/** 文本 / Markdown：三行横线 */
export function IconFileText({ size = 14, className }: P) {
  return (
    <Doc size={size} className={className}>
      <path d="M9 12h6M9 15h4" />
    </Doc>
  );
}

/** 表格：格子 */
export function IconFileSheet({ size = 14, className }: P) {
  return (
    <Doc size={size} className={className}>
      <path d="M9 12h6M9 15h6M12 12v5" />
    </Doc>
  );
}

/** 代码：斜杠 */
export function IconFileCode({ size = 14, className }: P) {
  return (
    <Doc size={size} className={className}>
      <path d="M11 11.5l-1.6 3M13.6 11.5L12 14.5" />
    </Doc>
  );
}

/** 压缩包：中缝拉链 */
export function IconFileArchive({ size = 14, className }: P) {
  return (
    <Doc size={size} className={className}>
      <path d="M12 11v1.2M12 14v1.2" />
    </Doc>
  );
}

/** 其它/PDF：纯文档 */
export function IconFile({ size = 14, className }: P) {
  return <Doc size={size} className={className} />;
}

/** 按 lib/files 的 fileTypeKey 选图标 */
export function FileTypeIcon({ kind, size = 14, className }: P & { kind: string }) {
  switch (kind) {
    case "image":
      return <IconFileImage size={size} className={className} />;
    case "json":
      return <IconFileJson size={size} className={className} />;
    case "xml":
      return <IconFileXml size={size} className={className} />;
    case "text":
      return <IconFileText size={size} className={className} />;
    case "sheet":
      return <IconFileSheet size={size} className={className} />;
    case "code":
      return <IconFileCode size={size} className={className} />;
    case "archive":
      return <IconFileArchive size={size} className={className} />;
    default:
      return <IconFile size={size} className={className} />;
  }
}
