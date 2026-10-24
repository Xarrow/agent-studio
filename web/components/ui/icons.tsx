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

// ── 能力库（Skills）用的一组 ──────────────────────────────────────────
/** 技能本体：一本书。来源不同再叠不同的小标志 */
export function IconSkill({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
    </svg>
  );
}

/** 仓库装的 */
export function IconBox({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M21 8v8a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8Z" />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
    </svg>
  );
}

/** 助手自己沉淀出来的 */
export function IconSpark({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconCheck({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** 固定（图钉） */
export function IconPin({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 17v5M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6Z" />
    </svg>
  );
}

/** 归档（盒子里的向下箭头） */
export function IconArchive({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
    </svg>
  );
}

/** 更新 / 重新拉取 */
export function IconRefresh({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />
    </svg>
  );
}

export function IconSearch({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function IconChevronRight({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** 工具（扳手） */
export function IconWrench({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3l9.4-9.4Z" />
      <path d="M14.7 6.3 17 4l3 3-2.3 2.3" />
    </svg>
  );
}

/** MCP / 插头 */
export function IconPlug({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5" />
    </svg>
  );
}

/** 时间（相对时间前面用） */
export function IconClock({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** 目录 / 服务器本地 */
export function IconFolder({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

/** 整理 / 自动清理（魔棒） */
export function IconWand({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="m15 4 5 5M13.5 5.5 4 15l1.5 1.5L15 7l-1.5-1.5ZM19 13v3M17.5 14.5h3M6 3v3M4.5 4.5h3" />
    </svg>
  );
}

/** 加号（新建/导入） */
export function IconPlus({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** 多个助手 / 共用 */
export function IconUsers({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" />
      <circle cx="10" cy="7.5" r="3" />
      <path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.6a3 3 0 0 1 0 5.8" />
    </svg>
  );
}

/** 分叉 / 血缘 */
export function IconGitBranch({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M6 7.5v9M8.5 12h7" />
    </svg>
  );
}

/** 密钥 */
export function IconKey({ size = 16, className }: P) {
  return (
    <svg {...base(size, className)}>
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8.2-8.2M17 6l2 2M14 9l2 2" />
    </svg>
  );
}
