import { normalizeInputKeys } from './shortcuts';
import { MemoError, type NavItem, type Settings } from './types';

export const BUILTINS: NavItem[] = [
  { id: 'all', kind: 'all', favorite: true },
  { id: 'archive', kind: 'archive', favorite: true },
  { id: 'pinned', kind: 'pinned', favorite: false },
  { id: 'week', kind: 'week', favorite: false },
  { id: 'tasks', kind: 'tasks', favorite: false },
  { id: 'ask', kind: 'ask', favorite: false },
  { id: 'review', kind: 'review', favorite: false },
  { id: 'trash', kind: 'trash', favorite: false },
];

export const DEFAULT_SETTINGS: Settings = {
  submitKey: 'Shift-Enter',
  newlineKey: 'Enter',
  quickPin: true,
  chatFolder: '小记对话',
  language: 'auto',
  folder: '小记',
  period: 'month',
  fileFormats: { month: 'YYMM[小记]', quarter: 'YYYY-[Q]Q[小记]', year: 'YYYY[小记]' },
  grouping: 'day',
  headingLevel: 3,
  headingFormats: { day: 'YYMMDD', week: 'GGGG-[W]WW', month: 'YYYY-MM' },
  dateFormat: 'YYYY-MM-DD HH:mm',
  layout: 'waterfall',
  topOrder: [],
  sidebarOrder: [],
  density: 'comfortable',
  gap: 12,
  padding: 16,
  cardWidth: 320,
  listWidth: 760,
  foldHeight: 280,
  tasksIncludeCompleted: false,
  nav: BUILTINS,
  tagOrder: [],
  reviewEnabled: false,
  aiEnabled: false,
  aiBaseUrl: 'https://api.deepseek.com/v1',
  aiModel: '',
  aiInstructions: '',
  aiSystemPrompt: '',
  aiMemoMode: 'auto',
  saveConversations: true,
  aiSecretName: 'xiaoji-api-key',
  aiMaxMemos: 12,
  aiMaxCharacters: 24000,
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

export const hasControlCharacters = (value: string): boolean => [...value].some(character => character.charCodeAt(0) < 32);

export function normalizeFolder(value: string): string {
  const path = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = path.split('/');
  if (!path || path.startsWith('/') || parts.some(part =>
    !part || part === '.' || part === '..' || part.startsWith('.') ||
    (/[<>:"|?*]/.test(part) || hasControlCharacters(part)) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new MemoError('invalidFolder');
  }
  return parts.join('/');
}

export function safeFileName(value: string): string {
  const name = value.trim();
  if (!name || (/[\\/:*?"<>|]/.test(name) || hasControlCharacters(name)) || /[. ]$/.test(name) ||
    name.startsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    name.length > 180) throw new MemoError('invalidFileName');
  return name;
}

export function safeSourcePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized.endsWith('.md')) throw new MemoError('invalidFolder');
  const parts = normalized.split('/');
  const file = parts.pop();
  if (!file) throw new MemoError('invalidFileName');
  safeFileName(file);
  if (parts.length) normalizeFolder(parts.join('/'));
  return normalized;
}

const oneOf = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
const text = (value: unknown, fallback: string): string => typeof value === 'string' ? value : fallback;
const bool = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;
const number = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;

const orderIds = (value: unknown, nav: NavItem[]): string[] => {
  const ids = nav.map(item => item.id);
  const order = Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && ids.includes(id)))] : [];
  return [...order, ...ids.filter(id => !order.includes(id))];
};

export function loadSettings(value: unknown): Settings {
  const data = record(value);
  const defaults = DEFAULT_SETTINGS;
  const files = record(data.fileFormats);
  const headings = record(data.headingFormats);
  const nav: NavItem[] = [];
  const seen = new Set<string>();
  if (Array.isArray(data.nav)) for (const raw of data.nav) {
    const item = record(raw);
    if (typeof item.id !== 'string' || seen.has(item.id) || item.id.length > 120) continue;
    if (item.kind === 'saved') continue;
    const kind = oneOf(item.kind, ['all', 'archive', 'pinned', 'week', 'tasks', 'tag', 'trash', 'ask', 'review'] as const, 'all');
    const builtin = BUILTINS.find(entry => entry.id === item.id);
    if (!builtin && kind !== 'tag') continue;
    seen.add(item.id);
    nav.push({
      id: item.id, kind: builtin?.kind ?? kind,
      favorite: bool(item.favorite, builtin?.favorite ?? false),
      sidebarVisible: bool(item.sidebarVisible, true),
      title: text(item.title, '').slice(0, 80),
      tag: text(item.tag, '').replace(/^#/, ''),
      includeArchived: bool(item.includeArchived, false),
    });
  }
  for (const item of BUILTINS) if (!seen.has(item.id)) nav.push({ ...item, favorite: item.kind === 'review' && Array.isArray(data.pinnedTools) && data.pinnedTools.includes('review') ? true : item.favorite });
  let folder = defaults.folder;
  try { folder = normalizeFolder(text(data.folder, folder)); } catch { /* keep safe defaults */ }
  let chatFolder = defaults.chatFolder;
  try { chatFolder = normalizeFolder(text(data.chatFolder, chatFolder)); } catch { /* safe local folder */ }
  if (chatFolder === folder || folder.startsWith(chatFolder + '/') || ['_回收站','_格式备份','格式备份'].some(n => chatFolder === folder+'/'+n || chatFolder.startsWith(folder+'/'+n+'/'))) chatFolder = folder + '-对话';
  return {
    ...normalizeInputKeys(data.submitKey, data.newlineKey),
    quickPin: bool(data.quickPin, true),
    chatFolder,
    chatFolders: [...new Set([...(Array.isArray(data.chatFolders) ? data.chatFolders.filter((v): v is string => typeof v === 'string') : []), chatFolder])],
    language: oneOf(data.language, ['auto', 'zh', 'en'] as const, defaults.language),
    folder,
    period: oneOf(data.period, ['month', 'quarter', 'year'] as const, defaults.period),
    fileFormats: {
      month: text(files.month, defaults.fileFormats.month),
      quarter: text(files.quarter, defaults.fileFormats.quarter),
      year: text(files.year, defaults.fileFormats.year),
    },
    grouping: oneOf(data.grouping, ['none', 'day', 'week', 'month'] as const, defaults.grouping),
    headingLevel: number(data.headingLevel, 1, 6, defaults.headingLevel),
    headingFormats: {
      day: text(headings.day, defaults.headingFormats.day),
      week: text(headings.week, defaults.headingFormats.week),
      month: text(headings.month, defaults.headingFormats.month),
    },
    dateFormat: text(data.dateFormat, defaults.dateFormat),
    layout: oneOf(data.layout, ['list', 'waterfall'] as const, defaults.layout),
    topOrder: orderIds(data.topOrder, nav),
    sidebarOrder: orderIds(data.sidebarOrder, nav),
    density: oneOf(data.density, ['compact', 'comfortable', 'spacious', 'custom'] as const, defaults.density),
    gap: number(data.gap, 4, 40, defaults.gap),
    padding: number(data.padding, 8, 40, defaults.padding),
    cardWidth: number(data.cardWidth, 220, 640, defaults.cardWidth),
    listWidth: number(data.listWidth, 320, 1400, defaults.listWidth),
    foldHeight: number(data.foldHeight, 100, 1000, defaults.foldHeight),
    tasksIncludeCompleted: bool(data.tasksIncludeCompleted, false),
    nav,
    tagOrder: Array.isArray(data.tagOrder) ? [...new Set(data.tagOrder.filter((value): value is string => typeof value === 'string' && value.length <= 1000 && /^[\p{L}\p{N}_/-]+$/u.test(value) && !value.includes('//')))].slice(0, 20000) : [],
    reviewEnabled: bool(data.reviewEnabled, false),
    aiEnabled: bool(data.aiEnabled, false),
    aiBaseUrl: text(data.aiBaseUrl, defaults.aiBaseUrl).trim(),
    aiModel: text(data.aiModel, defaults.aiModel).trim(),
    aiInstructions: text(data.aiInstructions, defaults.aiInstructions).slice(0, 4000),
    aiSystemPrompt: text(data.aiSystemPrompt, '').slice(0, 12000),
    aiMemoMode: oneOf(data.aiMemoMode, ['auto', 'strict', 'off'] as const, 'auto'),
    saveConversations: bool(data.saveConversations, true),
    aiSecretName: text(data.aiSecretName, defaults.aiSecretName).trim() || defaults.aiSecretName,
    aiMaxMemos: number(data.aiMaxMemos, 1, 40, defaults.aiMaxMemos),
    aiMaxCharacters: number(data.aiMaxCharacters, 2000, 80000, defaults.aiMaxCharacters),
  };
}

export function densityValues(settings: Settings): Pick<Settings, 'gap' | 'padding' | 'cardWidth' | 'foldHeight'> {
  switch (settings.density) {
    case 'compact': return { gap: 8, padding: 12, cardWidth: settings.layout === 'list' ? 680 : 280, foldHeight: 220 };
    case 'comfortable': return { gap: 12, padding: 16, cardWidth: settings.layout === 'list' ? 760 : 320, foldHeight: 280 };
    case 'spacious': return { gap: 20, padding: 22, cardWidth: settings.layout === 'list' ? 900 : 380, foldHeight: 380 };
    default: return { ...settings, cardWidth: settings.layout === 'list' ? settings.listWidth : settings.cardWidth };
  }
}

export const isChatPath = (path: string, settings: Settings): boolean => [settings.chatFolder, ...(settings.chatFolders ?? [])].some(folder => path.startsWith(folder + '/'));
