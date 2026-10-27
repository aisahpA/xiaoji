export type Language = 'auto' | 'zh' | 'en';
export type Period = 'month' | 'quarter' | 'year';
export type Grouping = 'none' | 'day' | 'week' | 'month';
export type ViewKind = 'all' | 'archive' | 'pinned' | 'week' | 'tasks' | 'tag' | 'trash' | 'ask' | 'review';

export interface Memo {
  id: string;
  key: string;
  path: string;
  body: string;
  raw: string;
  header: string;
  start: number;
  end: number;
  line: number;
  occurrence: number;
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
  /** Electron accelerator for the system-wide quick capture shortcut; empty disables it. */
  quickHotkey: string;
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
  memoKey?: string;
  originalRaw?: string;
  sourcePath?: string;
  kind?: 'memo' | 'formal';
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
  revision?(path: string): string | number | undefined;
  listMarkdown(): Promise<string[]>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  create(path: string, text: string): Promise<void>;
  process(path: string, update: (current: string) => string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface TrashEntry {
  path: string;
  source: string;
  deletedAt: string;
  state: 'backup' | 'deleted';
  memo: Memo;
}

export class MemoError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'MemoError';
  }
}
