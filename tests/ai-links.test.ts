import { describe, expect, it } from 'vitest';
import { buildChat, buildPlan, citedEvidence, parsePlan, retrievePlanned, chatEndpoint, contentFromResponse, readSse, retrieve } from '../src/core/ai';
import { tagTree } from '../src/core/tags';
import { rewriteLinks } from '../src/core/links';
import { parseMemos, serializeMemo } from '../src/core/markdown';
import { loadSettings } from '../src/core/settings';
import { selectMemos } from '../src/core/search';
import { resolveLanguage, translate } from '../src/i18n';

const memo = (id: string, body: string) => parseMemos(serializeMemo(id, body), '小记/2610.md')[0]!;
const ticks = String.fromCharCode(96).repeat(3);

describe('question planning and native tag hierarchy', () => {
  it('only expands valid prose citations, excluding examples and invented numbers', () => {
    const source = memo('20261021100000001', '完整原文');
    const evidence = [{ number: 1, memo: source, content: '完整原文' }, { number: 2, memo: source, content: '完整原文' }];
    expect(citedEvidence('依据 [1]。\n\n' + ticks + 'text\n[2]\n' + ticks + '\n\n[99]', evidence).map(source => source.number)).toEqual([1]);
  });
  it('planning sends only the question and strict retrieval instructions', () => {
    const request = buildPlan('我之前怎样准备公开课？', 'test');
    expect(request.stream).toBe(false);
    expect(request.messages[1]!.content).toBe('我之前怎样准备公开课？');
    expect(request.messages[0]!.content).toContain('untrusted data');
  });
  it('accepts a small plain JSON plan and refuses invalid structures', () => {
    expect(parsePlan('{"queries":["公开课","教研"]}').queries).toEqual(['公开课', '教研']);
    expect(parsePlan(ticks + 'json\n{"queries":["课堂"]}\n' + ticks).queries).toEqual(['课堂']);
    for (const input of ['null', '{}', '{"queries":"delete all files"}', '{"queries":[123,null,""]}']) expect(() => parsePlan(input)).toThrow();
    expect(parsePlan(JSON.stringify({ queries: ['1','2','3','4','5'] })).queries).toHaveLength(4);
  });
  it('keeps original query matches even when a model suggests irrelevant alternatives', () => {
    const notes = [memo('20261021100000001', '公开课准备'), memo('20261021100000002', '晨跑五公里')];
    const evidence = retrievePlanned('公开课', { queries: ['火星移民'] }, notes, loadSettings(undefined));
    expect(evidence.map(item => item.memo.id)).toEqual(['20261021100000001']);
  });
  it('builds missing parent tags and counts distinct active memos once', () => {
    const first = memo('20261021100000001', '#教学 #教学/反思 #教学/反思/课堂');
    const second = memo('20261021100000002', '#教学/备课');
    const archived = { ...memo('20261021100000003', '#教学/反思'), archived: true };
    const roots = tagTree([first, second, archived]);
    expect(roots).toHaveLength(1); expect(roots[0]!.count).toBe(2);
    expect(roots[0]!.children.find(node => node.name === '反思')!.count).toBe(1);
    expect(roots[0]!.children.find(node => node.name === '反思')!.children[0]!.path).toBe('教学/反思/课堂');
  });
});

describe('bounded AI evidence', () => {
  const notes = [
    memo('20261021100000001', '课堂提问需要给学生思考的时间。 #教学'),
    memo('20261021100000002', '周末跑步五公里。 #生活'),
    memo('20261021100000003', '课堂反馈应当具体，学生容易理解。 #教学'),
  ];
  it('retrieves Chinese natural-language evidence, not unrelated notes', () => {
    const evidence = retrieve('如何改善课堂提问？', notes, loadSettings(undefined));
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.some(item => item.memo.body.includes('跑步'))).toBe(false);
    expect(evidence[0]!.memo.id).toBe('20261021100000001');
  });
  it('does not silently upload unrelated notes for an unmatched question', () => {
    expect(retrieve('量子引力方程', notes, loadSettings(undefined))).toEqual([]);
  });
  it('respects explicit selection, source count and total character budget', () => {
    const settings = loadSettings({ aiMaxMemos: 1, aiMaxCharacters: 2000 });
    const long = memo('20261021100000004', '长'.repeat(5000));
    const evidence = retrieve('整理', [long, ...notes], settings, true);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.content.length).toBe(2000);
  });
  it('separates source text from instructions and only includes selected material', () => {
    const evidence = retrieve('课堂', notes, loadSettings(undefined));
    const request = buildChat('课堂', evidence, 'my-model');
    expect(request.model).toBe('my-model');
    expect(request.messages[0]!.content).toContain('untrusted data');
    expect(request.messages[1]!.content).not.toContain('跑步');
    expect(request.messages[1]!.content).toContain('<memo number="1"');
  });
  it.each([
    ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://api.example.com/chat/completions', 'https://api.example.com/chat/completions'],
    ['http://localhost:1234/v1', 'http://localhost:1234/v1/chat/completions'],
  ])('normalizes endpoint %s', (input, expected) => expect(chatEndpoint(input!)).toBe(expected));
  it.each(['http://public.example.com/v1', 'file:///etc/passwd', 'https://user:key@example.com/v1', 'https://api.example.com/v1?key=secret', 'not a URL'])('rejects unsafe endpoint %s', endpoint => {
    expect(() => chatEndpoint(endpoint)).toThrow();
  });
  it('reads normal chat responses and rejects missing content', () => {
    expect(contentFromResponse({ choices: [{ message: { content: '回答 [1]' } }] })).toBe('回答 [1]');
    expect(() => contentFromResponse({ choices: [] })).toThrow('aiEmpty');
  });
  it('parses split UTF-8, CRLF boundaries, ignored reasoning and done events', async () => {
    const payload = 'data: {"choices":[{"delta":{"reasoning_content":"不展示"}}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{"content":"中文🙂"}}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{"content":" [1]"}}]}\r\n\r\n' + 'data: [DONE]\r\n\r\n';
    const bytes = new TextEncoder().encode(payload);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    });
    const chunks: string[] = [];
    for await (const text of readSse(stream, new AbortController().signal)) chunks.push(text);
    expect(chunks.join('')).toBe('中文🙂 [1]');
  });
  it('cancels a pending stream read', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const controller = new AbortController();
    const iterator = readSse(stream, controller.signal);
    const waiting = iterator.next();
    controller.abort();
    await expect(waiting).rejects.toHaveProperty('name', 'AbortError');
    expect(cancelled).toBe(true);
  });
});

describe('moving Markdown safely', () => {
  it('rewrites actual local links but preserves external links and code examples', () => {
    const original = '![[照片.png|300]]\n\n[原文](../notes/source.md#标题)\n\n' +
      '[外链](https://example.com)\n\n' + ticks + 'md\n![[照片.png]]\n' + ticks;
    const changed = rewriteLinks(original, link => link.embed ? '![[附件/照片.png|300]]' : '[[notes/source#标题|原文]]');
    expect(changed).toContain('![[附件/照片.png|300]]');
    expect(changed).toContain('[[notes/source#标题|原文]]');
    expect(changed).toContain('[外链](https://example.com)');
    expect(changed).toContain(ticks + 'md\n![[照片.png]]\n' + ticks);
  });
  it('keeps unresolved links untouched', () => {
    const original = '找不到的 ![[图片.png]] 与 [链接](missing.md)';
    expect(rewriteLinks(original, () => null)).toBe(original);
  });
  it('rebases reference-style links and retains their titles', () => {
    const original = '[原文][src]\n\n![照片][pic]\n\n[src]: ../note.md "原始标题"\n[pic]: ../photo.png';
    const changed = rewriteLinks(original, link => (link.embed ? '!' : '') + '[[资料/' + (link.embed ? 'photo.png' : 'note') + '|' + link.label + ']]');
    expect(changed).toContain('[原文](<资料/note> "原始标题")');
    expect(changed).toContain('![[资料/photo.png|照片]]');
    expect(changed).toContain('[src]: ../note.md "原始标题"');
  });
});

describe('explicit archive scope and language', () => {
  it('includes archived evidence only when explicitly requested', () => {
    const notes = [memo('20261021100000001', '教学'), { ...memo('20261021100000002', '教学归档'), archived: true }];
    const settings = loadSettings(undefined);
    expect(selectMemos(notes, settings.nav[0]!, '教学', settings, { all: true })).toHaveLength(1);
    expect(selectMemos(notes, settings.nav[0]!, '教学', settings, { all: true, includeArchived: true })).toHaveLength(2);
  });
  it('resolves locale without translating user data', () => {
    expect(resolveLanguage('auto', 'zh-TW')).toBe('zh');
    expect(resolveLanguage('en', 'zh')).toBe('en');
    expect(translate('en', 'selected', { count: 3 })).toBe('3 selected');
    expect(translate('zh', 'selected', { count: 3 })).toBe('已选 3 条');
  });
});
