import type XiaojiPlugin from '../src/main';
import { Repository } from '../src/core/repository';
import { TrashStore } from '../src/core/trash-store';
import { Conversations } from '../src/core/conversations';
import { serializeMemo } from '../src/core/markdown';
import { loadSettings } from '../src/core/settings';
import { displayDate } from '../src/core/dates';
import { resolveLanguage, translate, type MessageKey } from '../src/i18n';
import { TFile } from './obsidian-mock';
import type { Draft, FilePort, Settings } from '../src/core/types';

export class FixtureFiles implements FilePort {
  data = new Map<string, string>();
  async listMarkdown(): Promise<string[]> { return [...this.data.keys()]; }
  async read(path: string): Promise<string> { if (!this.data.has(path)) throw Error('Missing file'); return this.data.get(path)!; }
  async exists(path: string): Promise<boolean> { return this.data.has(path); }
  async create(path: string, text: string): Promise<void> { if (this.data.has(path)) throw Error('Exists'); this.data.set(path, text); }
  async process(path: string, change: (text: string) => string): Promise<void> { this.data.set(path, change(await this.read(path))); }
  async remove(path: string): Promise<void> { this.data.delete(path); }
  async move(from: string, to: string): Promise<void> {
    if (this.data.has(to)) throw Error('Destination exists'); const text = await this.read(from); this.data.set(to, text); this.data.delete(from);
  }
}

export async function makeFixture(overrides: Partial<Settings> = {}): Promise<{ plugin: XiaojiPlugin; files: FixtureFiles; errors: unknown[] }> {
  const files = new FixtureFiles();
  files.data.set('小记/2610小记.md', [
    serializeMemo('20261021120000001', '好的课堂提问，要给学生留出思考的时间。\n\n#教学/反思'),
    serializeMemo('20261021110000002', '教学反馈应具体。\n\n- [ ] 准备课件\n- [x] 阅读教材\n\n#备课'),
    serializeMemo('20261021100000003', '| 方式 | 效果 |\n| --- | --- |\n| 小组讨论 | 激发思考 |\n\n#备课'),
    serializeMemo('20261020180000004', '旧记录内容。\n\n#生活', { archived: true }),
  ].join('\n\n'));
  const data = { schema: 1, settings: loadSettings(overrides), drafts: {} as Record<string, Draft> };
  const repo = new Repository(files, new TrashStore(files, () => data.settings.folder), () => data.settings);
  const chats = new Conversations(files, () => data.settings.chatFolder, () => data.settings.folder);
  await repo.scan();
  const errors: unknown[] = [];
  const subscribers = new Set<() => void>();
  const fileObject = (path: string): TFile | null => files.data.has(path) ? new TFile(path) : null;
  const app: any = {
    vault: {
      getMarkdownFiles: () => [...files.data.keys()].map(path => new TFile(path)),
      getAbstractFileByPath: fileObject,
      getName: () => 'xiaoji-test',
    },
    metadataCache: { getFileCache: () => null, getFirstLinkpathDest: (path: string) => fileObject(path) },
    fileManager: { generateMarkdownLink: (file: TFile, _source: string, subpath = '', alias?: string) => '[[' + file.path.replace(/\.md$/, '') + subpath + (alias ? '|' + alias : '') + ']]' },
    workspace: {
      getLeaf: () => ({ openFile: async () => undefined }),
      openLinkText: async () => undefined,
    },
    loadLocalStorage: () => null,
    saveLocalStorage: () => undefined,
  };
  const plugin: any = {
    app, data, repo, files, chats, manifest: { id: 'xiaoji', version: '0.1.0' }, loading: false,
    get prefs() { return data.settings; },
    get locale() { return resolveLanguage(data.settings.language, 'zh'); },
    t: (key: MessageKey, values = {}) => translate(resolveLanguage(data.settings.language, 'zh'), key, values),
    navLabel: (item: any) => item.title || plugin.t(item.kind),
    date: (memo: any) => displayDate(memo.createdAt, data.settings.dateFormat, plugin.locale),
    sourcePath: () => '小记/2610小记.md',
    tags: () => [...new Set(repo.records.flatMap(memo => memo.tags))],
    subscribe: (callback: () => void) => { subscribers.add(callback); return () => subscribers.delete(callback); },
    notify: () => { for (const subscriber of subscribers) subscriber(); },
    updateSettings: async (update: Partial<Settings> | ((current: Settings) => Partial<Settings>)) => { data.settings = loadSettings({ ...data.settings, ...(typeof update === 'function' ? update(data.settings) : update) }); plugin.notify(); },
    setDraft: (key: string, text: string, memo?: any, metadata = {}) => {
      if (text) data.drafts[key] = { ...metadata, text, updatedAt: Date.now(), memoKey: memo?.key, originalRaw: memo?.raw };
      else delete data.drafts[key];
    },
    clearDraft: async (key: string) => { delete data.drafts[key]; },
    refresh: async () => { await repo.scan(); plugin.notify(); },
    report: (error: unknown) => { errors.push(error); },
    createMemo: (body: string) => repo.create(body),
    showEdit: () => undefined, showTrash: () => undefined, showAi: () => undefined,
    showReview: () => undefined,
    rebase: (body: string) => body,
    renderReferences: () => undefined,
    bindReferences: () => undefined,
    openMemo: async () => undefined,
    sourceLink: (memo: any) => '[[' + memo.path + ']]',
    memoLink: (memo: any) => 'obsidian://xiaoji?id=' + memo.id,
    quote: (memo: any) => '> ' + memo.body,
    clipboard: async () => undefined,
    openSource: async () => undefined,
    openQuick: async () => undefined, openHotkeys: () => undefined,
    watchQuickBounds: () => () => undefined,
    quickWindowControls: () => false, quickWindowMaximized: () => false, quickWindowAction: () => undefined,
    windowPinState: () => false, toggleWindowPin: () => false,
    recoverAttachment: () => undefined,
    apiKey: () => '',
    setApiKey: () => undefined,
    persist: async () => undefined,
    addAttachment: async () => '![[附件.png]]',
  };
  return { plugin, files, errors };
}
