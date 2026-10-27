import { describe, expect, it, vi } from 'vitest';
import { Conversations, parseConversation } from '../src/core/conversations';
import { FixtureFiles } from './fixture';
import { parseMemos, serializeMemo } from '../src/core/markdown';

const setup = () => {
  const files = new FixtureFiles(), store = new Conversations(files, () => '小记对话', () => '小记');
  return { files, store };
};
describe('local conversation storage', () => {
  it('writes readable Markdown and a validated, round-trippable payload', async () => {
    const { files, store } = setup(), chat = await store.create('课堂对话');
    chat.turns.push({ id: '20261021110000001', question: '怎样提问？', answer: '留出思考时间。[1]', createdAt: new Date().toISOString(), status: 'complete',
      sources: [{ number: 1, content: '留出思考时间。', memo: parseMemos(serializeMemo('20261021110000002', '完整原文\n\n#教学'), '小记/2610.md')[0]! }] });
    await store.save(chat);
    const raw = await files.read('小记对话/' + chat.id + '.md');
    expect(raw).toContain('### Question\n\n怎样提问？'); expect(raw).toContain('完整原文');
    expect((await store.load(chat.id)).turns[0]!.sources[0]!.memo.body).toBe('完整原文\n\n#教学');
    expect(parseConversation(raw.replace(/\n/g, '\r\n'), await store.load(chat.id)).id).toBe(chat.id);
    expect(raw.startsWith('# ')).toBe(true); expect(raw).not.toContain('xiaoji-json'); expect(raw).not.toContain('xiaoji-conversation:');
  });
  it('never mixes chat Markdown into the memo directory', async () => {
    const { files, store } = setup(); await store.create('独立对话');
    expect([...files.data.keys()].every(path => path.startsWith('小记对话/'))).toBe(true);
    const invalid = new Conversations(files, () => '小记/对话', () => '小记');
    await expect(invalid.create('支持子目录')).resolves.toMatchObject({title:'支持子目录'});
  });
  it('refuses stale writes without overwriting external changes', async () => {
    const { files, store } = setup(), chat = await store.create('外部编辑');
    const path = '小记对话/' + chat.id + '.md'; files.data.set(path, (await files.read(path)) + '\n外部修改');
    chat.title = '不能覆盖'; await expect(store.save(chat)).rejects.toThrow('chatConflict');
    expect(await files.read(path)).toContain('外部修改');
  });
  it('detects human edits to readable content instead of silently ignoring them', async () => {
    const { files, store } = setup(), chat = await store.create('原始标题');
    files.data.set('小记对话/' + chat.id + '.md', chat.raw!.replace('# 原始标题', '# 手动修改'));
    await expect(store.load(chat.id)).rejects.toThrow('chatInvalid');
    expect((await store.list()).damaged).toHaveLength(1);
  });
  it('permanently deletes a saved conversation and all machine state without creating recycle files', async () => {
    const { files, store } = setup(), chat = await store.create('直接删除');
    chat.turns.push({ id: '20261021110000001', question: 'Q', answer: 'A', status: 'complete', createdAt: new Date().toISOString(), sources: [] });
    await store.save(chat); await store.delete(chat);
    expect([...files.data.keys()]).toEqual([]); expect((await store.list()).chats).toHaveLength(0); expect([...files.data.keys()].some(path => path.includes('_回收站'))).toBe(false);
  });
  it('protects externally changed conversations from permanent deletion', async () => {
    const { files, store } = setup(), chat = await store.create('冲突保护'); const path = '小记对话/' + chat.id + '.md';
    files.data.set(path, chat.raw + '\n外部改动');
    await expect(store.delete(chat)).rejects.toThrow('chatConflict'); expect(await files.read(path)).toContain('外部改动');
  });
  it('reads legacy frontmatter snapshots, and upgrades to clean Markdown on the next save', async () => {
    const { files, store } = setup();
    const chat = { id: '20261021120000000', title: '旧对话', createdAt: '2026-10-21', updatedAt: '2026-10-21', turns: [] };
    const raw = '---\nxiaoji-conversation: 1\n---\n\n# 旧对话\n\n' + '\n<!-- xiaoji-conversation-data -->\n~~~xiaoji-json\n' + JSON.stringify(chat, null, 2) + '\n~~~\n<!-- /xiaoji-conversation-data -->\n';
    files.data.set('小记对话/' + chat.id + '.md', raw);
    const loaded = await store.load(chat.id); await store.save(loaded);
    const clean = await files.read('小记对话/' + chat.id + '.md'); expect(clean.startsWith('# ')).toBe(true); expect(clean).not.toContain('xiaoji-json');
    expect((await store.load(chat.id)).id).toBe(chat.id);
  });
  it('recovers when journal cleanup fails after a successful Markdown save', async () => {
    const { files, store } = setup(), chat = await store.create('journal');
    const write = files.process.bind(files); let calls = 0;
    vi.spyOn(files, 'process').mockImplementation(async (path, update) => { if (path.endsWith('.json') && ++calls === 2) throw Error('cleanup'); return write(path, update); });
    chat.title = 'saved'; await store.save(chat); expect((await store.load(chat.id)).title).toBe('saved');
  });
  it('protects existing Markdown when the machine-state write fails', async () => {
    const { files, store } = setup(), chat = await store.create('original');
    const before = chat.raw, process = files.process.bind(files);
    vi.spyOn(files, 'process').mockImplementation(async (path, update) => { if (path.endsWith('.json')) throw Error('state failed'); return process(path, update); });
    chat.title = 'unsaved'; await expect(store.save(chat)).rejects.toThrow('state failed');
    expect(await files.read('小记对话/' + chat.id + '.md')).toBe(before);
  });
  it('serializes rapid writes and retains the last local state', async () => {
    const { store } = setup(), chat = await store.create('快速保存');
    chat.title = '第一版'; const first = store.save(chat);
    chat.title = '第二版'; const second = store.save(chat);
    await Promise.all([first, second]); expect((await store.load(chat.id)).title).toBe('第二版');
  });
});
