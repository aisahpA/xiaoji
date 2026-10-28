export type Language = 'auto' | 'zh' | 'en';
export type Period = 'month' | 'quarter' | 'year';
export type Grouping = 'none' | 'day' | 'week' | 'month';
export type ViewKind = 'all' | 'archive' | 'pinned' | 'week' | 'tasks' | 'tag' | 'trash' | 'ask' | 'review';

export interface Memo {
  id: string;
  path: string;
  body: string;
  raw: string;
  header: string;
  /**
   * Offset into `path` at the revision this record was parsed from. It is a
   * transient parse artifact, not a durable coordinate: unrelated edits shift it
   * and cached records are never re-aligned. Read it only from a record that was
   * just parsed from the same text; otherwise re-derive it with `text.indexOf(raw)`
   * (see `findUnchanged`) before slicing or jumping.
   */
  start: number;
  createdAt: number;
  archived: boolean;
  pinned: boolean;
  blockId: string | null;
  tags: string[];
  tasks: { total: number; incomplete: number };
}

export interface NavItem {
  id: string;
  kind: ViewKind;
  title?: string;
  favorite: boolean;
  sidebarVisible?: boolean;
  tag?: string;
  includeArchived?: boolean;
}

export interface Settings {
  submitKey: string;
  newlineKey: string;
  quickPin: boolean;
  /** 快速记录组合键（如 `Mod-Shift-J`）；空字符串表示未设置。 */
  captureKey: string;
  /** 组合键是否全局生效（Obsidian 最小化后也能唤起）；关闭时只在 Obsidian 内响应。 */
  captureGlobal: boolean;
  chatFolder: string;
  chatFolders?: string[];
  language: Language;
  folder: string;
  period: Period;
  fileFormats: Record<Period, string>;
  grouping: Grouping;
  headingLevel: number;
  headingFormats: Record<Exclude<Grouping, 'none'>, string>;
  dateFormat: string;
  layout: 'list' | 'waterfall';
  topOrder: string[];
  sidebarOrder: string[];
  density: 'compact' | 'comfortable' | 'spacious' | 'custom';
  gap: number;
  padding: number;
  cardWidth: number;
  listWidth: number;
  foldHeight: number;
  tasksIncludeCompleted: boolean;
  nav: NavItem[];
  tagOrder: string[];
  reviewEnabled: boolean;
  aiEnabled: boolean;
  aiBaseUrl: string;
  aiModel: string;
  aiInstructions: string;
  aiSystemPrompt: string;
  aiMemoMode: 'auto' | 'strict' | 'off';
  saveConversations: boolean;
  aiSecretName: string;
  aiMaxMemos: number;
  aiMaxCharacters: number;
}

export interface Draft {
  autoTag?: string;
  text: string;
  updatedAt: number;
  memoId?: string;
  originalRaw?: string;
  sourcePath?: string;
  kind?: 'memo';
  title?: string;
  folder?: string;
}

export interface PluginData {
  lastChatId?: string;
  chatInputs?: Record<string, string>;
  schema: 1;
  settings: Settings;
  drafts: Record<string, Draft>;
}

export interface FilePort {
  erase?(path: string, expected: string): Promise<void>;
  move?(from: string, to: string): Promise<void>;
  revision(path: string): string | number | undefined;
  listMarkdown(): Promise<string[]>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  create(path: string, text: string): Promise<void>;
  process(path: string, update: (current: string) => string): Promise<void>;
  remove(path: string): Promise<void>;
}

export class MemoError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'MemoError';
  }
}
