import { sleep } from './timers';
import { dateFromId, timestamp } from './dates';
import { normalizeFolder } from './settings';
import { MemoError, type FilePort, type Memo } from './types';

export interface ChatSource { number: number; memo: Memo; content: string; }
export interface ChatTurn {
  id: string; question: string; answer: string; sources: ChatSource[];
  query?: { action?: 'count' | 'list' | 'answer'; total: number; shown: number; scope: string };
  status: 'pending' | 'complete' | 'interrupted' | 'failed'; createdAt: string;
}
export interface Conversation { id: string; title: string; createdAt: string; updatedAt: string; turns: ChatTurn[]; raw?: string; }
interface ChatTrash { path: string; deletedAt: string; chat: Conversation; raw: string; }
const marker = '\n<!-- xiaoji-conversation-data -->\n~~~xiaoji-json\n';
const endMarker = '\n~~~\n<!-- /xiaoji-conversation-data -->\n';
const validId = (value: unknown): value is string => typeof value === 'string' && /^\d{17}$/.test(value);
const plain = (chat: Conversation) => ({ id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, turns: chat.turns });
function serializeLegacy(chat: Conversation, deletedAt?: string): string {
  const payload = deletedAt ? { chat: plain(chat), deletedAt } : plain(chat);
  const header = deletedAt ? 'xiaoji-conversation-trash: 1' : 'xiaoji-conversation: 1';
  const readable = chat.turns.map(turn => '## ' + turn.createdAt + '\n\n### Question\n\n' + turn.question +
    '\n\n### Answer\n\n' + turn.answer + (turn.query ? '\n\n> ' + turn.query.scope : '') + '\n\n' + turn.sources.map(source =>
      '#### [' + source.number + '] @' + source.memo.id + '\n\n' + source.memo.body).join('\n\n')).join('\n\n');
  return '---\n' + header + '\n---\n\n# ' + chat.title.replace(/[\r\n]/g, ' ') + '\n\n' + readable +
    marker + JSON.stringify(payload, null, 2) + endMarker;
}
/** Human-readable Markdown only. Machine state lives outside the note. */
export function serializeConversation(chat: Conversation): string {
  const title = chat.title.replace(/[\r\n]/g, ' ');
  return '# ' + title + '\n\n' + chat.turns.map(turn => '## ' + turn.createdAt + '\n\n### Question\n\n' + turn.question +
    '\n\n### Answer\n\n' + turn.answer + (turn.query ? '\n\n> ' + turn.query.scope : '') + '\n\n' +
    turn.sources.map(source => '#### [' + source.number + '] @' + source.memo.id + '\n\n' + source.memo.body).join('\n\n')).join('\n\n') + '\n';
}
export interface ConversationStatePort { read(id: string): Promise<string | null>; write(id: string, raw: string): Promise<void>; remove(id: string): Promise<void>; }
function decode(raw: string): unknown {
  const at = raw.lastIndexOf(marker);
  if (at < 0 || !raw.endsWith(endMarker)) throw new MemoError('chatInvalid');
  try { return JSON.parse(raw.slice(at + marker.length, -endMarker.length)); } catch { throw new MemoError('chatInvalid'); }
}
function validate(value: unknown): Conversation {
  const chat = value as Conversation;
  if (!chat || !validId(chat.id) || typeof chat.title !== 'string' || typeof chat.createdAt !== 'string' ||
    typeof chat.updatedAt !== 'string' || !Array.isArray(chat.turns)) throw new MemoError('chatInvalid');
  const ids = new Set<string>();
  for (const turn of chat.turns) {
    if (!validId(turn.id) || ids.has(turn.id) || typeof turn.question !== 'string' || typeof turn.answer !== 'string' ||
      typeof turn.createdAt !== 'string' || !['pending', 'complete', 'interrupted', 'failed'].includes(turn.status) ||
      !Array.isArray(turn.sources)) throw new MemoError('chatInvalid');
    if (turn.query && ((turn.query.action !== undefined && !['count', 'list', 'answer'].includes(turn.query.action)) || !Number.isInteger(turn.query.total) || turn.query.total < 0 || !Number.isInteger(turn.query.shown) || turn.query.shown < 0 || turn.query.shown > turn.query.total || typeof turn.query.scope !== 'string')) throw new MemoError('chatInvalid');
    ids.add(turn.id);
    for (const source of turn.sources) if (!source?.memo || !/^\d{14}(?:\d{3})?$/.test(source.memo.id) ||
      typeof source.memo.body !== 'string' || typeof source.memo.path !== 'string' ||
      typeof source.content !== 'string' || !Number.isInteger(source.number) || source.number < 1) throw new MemoError('chatInvalid');
  }
  return chat;
}
export function parseConversation(raw: string, state?: Conversation): Conversation {
  if (state) {
    validate(state); if (serializeConversation(state) !== raw.replace(/\r\n/g, '\n')) throw new MemoError('chatInvalid');
    return { ...state, raw };
  }
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\nxiaoji-conversation: 1\n')) throw new MemoError('chatInvalid');
  const chat = validate(decode(normalized));
  if (serializeLegacy(chat) !== normalized) throw new MemoError('chatInvalid');
  return { ...chat, raw };
}

/** Local readable Markdown, compare-and-swap writes, and permanent conversation deletion. */
export class Conversations {
  private locations = new Map<string,string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private files: FilePort, private folder: () => string, private memoFolder: () => string, private state?: ConversationStatePort, private history: () => readonly string[] = () => []) {}
  private root(): string {
    const root = normalizeFolder(this.folder()), notes = normalizeFolder(this.memoFolder());
    if (root === notes || notes.startsWith(root + '/')) throw new MemoError('invalidFolder');
    return root + '/';
  }
  private path(id: string): string { if (!validId(id)) throw new MemoError('chatInvalid'); if (!this.locations.has(id)) this.locations.set(id, this.root() + id + '.md'); return this.locations.get(id)!; }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action); this.queue = next.catch(() => undefined); return next;
  }
  private statePath(id: string): string { if (!validId(id)) throw new MemoError('chatInvalid'); return this.root() + '_状态/' + id + '.json'; }
  private async readState(id: string): Promise<string | null> {
    if (this.state) return this.state.read(id);
    const path = this.statePath(id); return await this.files.exists(path) ? this.files.read(path) : null;
  }
  private async writeState(id: string, raw: string): Promise<void> {
    if (this.state) return this.state.write(id, raw);
    const path = this.statePath(id); if (await this.files.exists(path)) await this.files.process(path, () => raw); else await this.files.create(path, raw);
  }
  private async removeState(id: string): Promise<void> {
    if (this.state) return this.state.remove(id);
    const path = this.statePath(id); if (await this.files.exists(path)) await this.files.remove(path);
  }
  private stateText(chat: Conversation, markdown: string, previous?: string | null): string {
    let older: unknown[] = [];
    if (previous) { const parsed = JSON.parse(previous) as { versions?: unknown[] }; older = parsed.versions?.slice(0, 1) ?? []; }
    return JSON.stringify({ versions: [{ chat: plain(chat), markdown }, ...older] });
  }
  private async decodeCurrent(raw: string, id: string): Promise<Conversation> {
    if (raw.startsWith('---')) return parseConversation(raw);
    const state = await this.readState(id); if (!state) throw new MemoError('chatInvalid');
    const versions = (JSON.parse(state) as { versions?: { chat: Conversation; markdown: string }[] }).versions;
    const version = versions?.find(version => version.markdown === raw.replace(/\r\n/g, '\n'));
    if (!version || version.chat.id !== id) throw new MemoError('chatInvalid');
    return parseConversation(raw, version.chat);
  }
  async create(title: string): Promise<Conversation> {
    return this.enqueue(async () => {
      let id: string;
      id = timestamp();
      while (await this.files.exists(this.path(id)) || await this.readState(id)) { await sleep(2); id = timestamp(); }
      const date = new Date().toISOString();
      const chat: Conversation = { id, title: title.slice(0, 100), createdAt: date, updatedAt: date, turns: [] };
      chat.raw = serializeConversation(chat); await this.writeState(id, this.stateText(chat, chat.raw));
      try { await this.files.create(this.path(id), chat.raw); } catch (error) { await this.removeState(id); throw error; }
      return chat;
    });
  }
  async list(): Promise<{ chats: Conversation[]; damaged: string[] }> {
    const root = this.root(), chats: Conversation[] = [], damaged: string[] = [];
    const roots = [...new Set([root,...this.history().map(p=>normalizeFolder(p)+'/')])];
    for (const path of await this.files.listMarkdown()) {
      const base = roots.find(r=>path.startsWith(r)&&/^\d{17}\.md$/.test(path.slice(r.length))); if (!base) continue;
      try {
        const raw = await this.files.read(path);
        if (raw.startsWith('---\nxiaoji-conversation-deleted: 1\n')) continue;
        const chat = await this.decodeCurrent(raw, path.slice(base.length, -3));
        if (path !== base + chat.id + '.md' || chats.some(c=>c.id===chat.id)) throw new MemoError('chatInvalid');
        this.locations.set(chat.id, path); chats.push(chat);
      } catch { damaged.push(path); }
    }
    return { chats: chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), damaged };
  }
  async load(id: string): Promise<Conversation> {
    const chat = await this.decodeCurrent(await this.files.read(this.path(id)), id);
    if (chat.id !== id) throw new MemoError('chatInvalid'); return chat;
  }
  async save(chat: Conversation): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify({ ...chat, updatedAt: new Date().toISOString() })) as Conversation;
    validate(snapshot); const text = serializeConversation(snapshot);
    await this.enqueue(async () => {
      const previous = await this.readState(chat.id);
      await this.writeState(chat.id, this.stateText(snapshot, text, previous));
      try {
        await this.files.process(this.path(chat.id), current => { if (current !== chat.raw) throw new MemoError('chatConflict'); return text; });
      } catch (error) {
        if (previous) await this.writeState(chat.id, previous); else await this.removeState(chat.id);
        throw error;
      }
      chat.raw = text; chat.updatedAt = snapshot.updatedAt;
      // A pending two-version journal already recovers either side of the Markdown write.
      try { await this.writeState(chat.id, this.stateText(snapshot, text)); } catch { /* Keep the recoverable journal. */ }
    });
  }
  async delete(chat: Conversation): Promise<void> {
    return this.enqueue(async () => {
      const path = this.path(chat.id);
      if (await this.files.exists(path)) {
        const raw = await this.files.read(path);
        if (raw !== chat.raw) throw new MemoError('chatConflict');
        if (this.files.erase) await this.files.erase(path, raw); else await this.files.remove(path);
      }
      // Explicit permanent deletion also removes verified legacy copies of this conversation.
      for (const backup of await this.files.listMarkdown()) if (backup.startsWith(this.root() + '_回收站/' + chat.id + '-')) {
        const raw = await this.files.read(backup), entry = this.parseTrash(raw, backup);
        if (entry.chat.id !== chat.id) throw new MemoError('chatInvalid');
        await this.files.remove(backup);
      }
      await this.removeState(chat.id);
    });
  }
  private parseTrash(raw: string, path: string): ChatTrash {
    if (!path.startsWith(this.root() + '_回收站/')) throw new MemoError('chatInvalid');
    if (raw.startsWith('---\nxiaoji-conversation: 1\n')) {
      const match = /\/(\d{17})-(\d{17})\.md$/.exec(path);
      if (!match) throw new MemoError('chatInvalid');
      // Native link-safe moves may rebase the human-readable links in the recycle copy.
      // Keep the full file bytes for conflict checks; the structured snapshot remains immutable.
      const chat = { ...validate(decode(raw.replace(/\r\n/g, '\n'))), raw };
      if (chat.id !== match[1]) throw new MemoError('chatInvalid');
      const deleted = dateFromId(match[2]!); if (deleted === null) throw new MemoError('chatInvalid');
      return { path, deletedAt: new Date(deleted).toISOString(), chat, raw };
    }
    if (!raw.startsWith('---\nxiaoji-conversation-trash: 1\n')) throw new MemoError('chatInvalid');
    const value = decode(raw) as { chat?: unknown; deletedAt?: unknown };
    if (typeof value?.deletedAt !== 'string') throw new MemoError('chatInvalid');
    return { path, deletedAt: value.deletedAt, chat: validate(value.chat), raw };
  }
}
