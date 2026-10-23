// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskPanel } from '../src/ui/chat-panel';
import { makeFixture } from './fixture';
import { Menu } from './obsidian-mock';
import { buildAssistantChat, DEFAULT_AI_PROMPT, parsePlan } from '../src/core/ai';
import type { Settings } from '../src/core/types';

const panels: AskPanel[] = [];
afterEach(() => { for (const panel of panels.splice(0)) panel.unload(); document.body.replaceChildren(); });
const response = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } });
const setup = async (settings: Partial<Settings> = {}) => {
  const fixture = await makeFixture({ aiEnabled: true, aiModel: 'configured-model', ...settings });
  fixture.plugin.apiKey = () => 'synthetic';
  const parent = document.createElement('div'); document.body.append(parent);
  const panel = new AskPanel(parent, fixture.plugin); panels.push(panel);
  return { ...fixture, panel, parent };
};
const send = async (parent: HTMLElement, question: string) => {
  const input = parent.querySelector('textarea')!; input.value = question;
  parent.querySelector<HTMLButtonElement>('button[aria-label="提问"]')!.click();
  for (let i = 0; i < 100; i++) { await new Promise(resolve => setTimeout(resolve, 5)); if (!input.disabled) return; }
  throw Error('Chat did not finish');
};
describe('normal AI and optional local persistence', () => {
  it('greets normally with one request, no memo scan and no empty-evidence warning', async () => {
    const { parent, plugin } = await setup(); const scan = vi.spyOn(plugin.repo, 'scan');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('你好，有什么想聊的？'));
    await send(parent, '你好'); expect(fetch).toHaveBeenCalledTimes(1); expect(scan).not.toHaveBeenCalled();
    expect(parent.textContent).toContain('有什么想聊'); expect(parent.textContent).not.toContain('没有找到相关小记');
    expect(parent.querySelector('[role="status"]')?.textContent).toBe('');
    expect(parent.textContent).not.toContain('对话保存在'); expect(parent.textContent).not.toContain('没有可验证');
  });
  it('uses the configured identifier for identity instead of asking a model to invent its provider', async () => {
    const { parent, plugin } = await setup(); plugin.apiKey = () => '';
    const fetch = vi.spyOn(globalThis, 'fetch'); await send(parent, '你是什么模型？');
    expect(fetch).not.toHaveBeenCalled(); expect(parent.textContent).toContain('configured-model'); expect(parent.textContent).toContain('实际模型映射');
  });
  it('routes general knowledge to normal chat without reading or uploading notes', async () => {
    const { parent, plugin } = await setup(); const scan = vi.spyOn(plugin.repo, 'scan'); const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { requests.push(JSON.parse(init!.body as string)); return response(requests.length === 1 ? '{"route":"chat","queries":[]}' : '可以先确定教学目标。'); });
    await send(parent, '怎样设计一节公开课？');
    expect(scan).not.toHaveBeenCalled(); expect(requests).toHaveLength(2); expect(requests[1].messages.at(-1).content).not.toContain('Local context');
    expect(parent.textContent).toContain('先确定教学目标');
  });
  it('off mode sends neither local counts nor memo sources, while retaining real conversation roles', async () => {
    const { parent, plugin } = await setup({ aiMemoMode: 'off', saveConversations: false }); const scan = vi.spyOn(plugin.repo, 'scan'); const requests: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { requests.push(JSON.parse(init!.body as string)); return response('我没有访问你的记录。'); });
    await send(parent, '今天记了几条小记'); await send(parent, '那我应该怎么做？');
    expect(requests).toHaveLength(2); expect(scan).not.toHaveBeenCalled();
    expect(requests[1].messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(JSON.stringify(requests)).not.toContain('好的课堂提问');
  });
  it('strict mode does not generate an unsupported answer when no personal evidence matches', async () => {
    const { parent } = await setup({ aiMemoMode: 'strict' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('{"queries":["量子引力"],"route":"memo"}'));
    await send(parent, '我记过哪些量子引力想法？'); expect(fetch).toHaveBeenCalledTimes(1); expect(parent.textContent).toContain('没有找到相关小记');
  });
  it('auto mode can answer without records rather than blocking conversation', async () => {
    const { parent } = await setup(); let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(++calls === 1 ? '{"route":"memo","queries":["量子引力"]}' : '没有找到这类记录，可以先从基础概念入手。'));
    await send(parent, '我记过哪些量子引力想法？'); expect(calls).toBe(2); expect(parent.textContent).toContain('基础概念');
  });
  it('temporary conversations and unsent questions never write files or plugin data', async () => {
    const { parent, files, plugin, panel } = await setup({ saveConversations: false });
    const before = JSON.stringify([...files.data]), beforeData = JSON.stringify(plugin.data);
    const persist = vi.spyOn(plugin, 'persist'), create = vi.spyOn(plugin.chats, 'create'), save = vi.spyOn(plugin.chats, 'save');
    await send(parent, '2026-10-21 记了几条小记');
    const input = parent.querySelector('textarea')!; input.value = '临时未发送'; input.dispatchEvent(new Event('input'));
    expect(parent.querySelector('button[aria-label="历史对话"]')).toBeNull();
    expect(JSON.stringify([...files.data])).toBe(before); expect(JSON.stringify(plugin.data)).toBe(beforeData);
    expect(persist).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    const snapshot = panel.snapshot(); panel.unload();
    const reopened = new AskPanel(parent, plugin, snapshot); panels.push(reopened); await new Promise(resolve => setTimeout(resolve, 10));
    expect(parent.querySelectorAll('.xj-chat-turn')).toHaveLength(1); expect(parent.querySelector('textarea')?.value).toBe('临时未发送');
    reopened.unload(); const fresh = new AskPanel(parent, plugin); panels.push(fresh);
    expect(parent.querySelector('.xj-chat-turn')).toBeNull(); expect(parent.querySelector('textarea')?.value).toBe('');
  });
  it('saved chats are clean Markdown and delete removes both text and state without recycling', async () => {
    const { parent, files, plugin } = await setup(); await send(parent, '2026-10-21 记了几条小记');
    const chat = (await plugin.chats.list()).chats[0]!, raw = await files.read('小记对话/' + chat.id + '.md');
    expect(raw.startsWith('# ')).toBe(true); expect(raw).not.toContain('xiaoji-json'); expect(raw).not.toContain('xiaoji-conversation:');
    parent.querySelector<HTMLButtonElement>('.xj-chat-toolbar button[aria-label="更多"]')!.click();
    Menu.last!.items.find(item => item.title === '删除对话')!.callback();
    for (let i = 0; i < 30 && parent.querySelector('.xj-chat-turn'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect((await plugin.chats.list()).chats).toHaveLength(0); expect([...files.data.keys()].some(path => path.includes('_回收站'))).toBe(false);
    expect([...files.data.keys()].some(path => path.includes(chat.id))).toBe(false);
  });
  it('switching persistence starts a new session and preserves previously saved records', async () => {
    const { parent, plugin, panel } = await setup(); await send(parent, '2026-10-21 记了几条小记'); const previous = panel.snapshot(); panel.unload();
    await plugin.updateSettings({ saveConversations: false }); const temp = new AskPanel(parent, plugin, previous); panels.push(temp);
    expect(parent.querySelector('.xj-chat-turn')).toBeNull(); await send(parent, '2026-10-21 有哪些小记');
    expect((await plugin.chats.list()).chats[0]!.turns).toHaveLength(1);
  });
  it('applies editable system instructions without changing read-only factual constraints', () => {
    const request = buildAssistantChat('问题', [], 'configured', 'auto', '用简洁中文，像一位教师。', [], '', false);
    expect(request.messages[0]!.content).toContain('像一位教师'); expect(request.messages[0]!.content).toContain('Never invent personal records');
    expect(buildAssistantChat('你好', [], 'configured', 'auto', '', []).messages[0]!.content).toContain(DEFAULT_AI_PROMPT);
    expect(parsePlan('{"route":"chat","queries":[]}').route).toBe('chat');
  });
});
