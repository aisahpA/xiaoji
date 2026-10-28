import { describe, expect, it } from 'vitest';
import { dayString, executeMemoQuery, localMemoQuery, queryScope, validateMemoQuery } from '../src/core/query';
import { parseMemos, serializeMemo } from '../src/core/markdown';
import { buildChat, buildPlan, parsePlan } from '../src/core/ai';
import { loadSettings } from '../src/core/settings';

const now = new Date(2026, 9, 21, 15);
const memo = (id: string, body = '') => parseMemos(serializeMemo(id, body || '内容'), '小记/a.md')[0]!;
describe('full-index local queries', () => {
  it.each(['今天记了几条小记？', '我今天记了几条小记', 'How many memos did I write today?'])('counts by creation date: %s', question => {
    const q = localMemoQuery(question, now)!;
    expect(q).toMatchObject({ action: 'count', from: '2026-10-21', until: '2026-10-22' });
  });
  it('uses start-inclusive and end-exclusive local midnight, including archived records', () => {
    const notes = [memo('20261020235959999'), memo('20261021000000000'), { ...memo('20261021235959999'), archived: true }, memo('20261022000000000')];
    expect(executeMemoQuery(localMemoQuery('今天记了几条小记', now)!, notes).map(m => m.id)).toEqual(['20261021235959999', '20261021000000000']);
  });
  it('counts more than the evidence limit and counts distinct records even with duplicate timestamps', () => {
    const notes = Array.from({ length: 70 }, (_, i) => ({ ...memo('20261021100000000'), id: '202610211000' + String(i).padStart(5, '0') }));
    expect(executeMemoQuery({ action: 'count' }, notes)).toHaveLength(70);
  });
  it.each([
    ['昨天有哪些小记', '2026-10-20', '2026-10-21'],
    ['本周有哪些小记', '2026-10-19', '2026-10-26'],
    ['上周记了几条小记', '2026-10-12', '2026-10-19'],
    ['本月记了几条小记', '2026-10-01', '2026-11-01'],
    ['上月记了几条小记', '2026-09-01', '2026-10-01'],
    ['今年有哪些小记', '2026-01-01', '2027-01-01'],
    ['2026-10-21 有哪些小记', '2026-10-21', '2026-10-22'],
  ])('understands %s', (question, from, until) => expect(localMemoQuery(question, now)).toMatchObject({ from, until }));
  it('uses calendar week/month boundaries across years', () => {
    const q = localMemoQuery('本周有哪些小记', new Date(2027, 0, 3))!;
    expect(q).toMatchObject({ from: '2026-12-28', until: '2027-01-04' });
    expect(localMemoQuery('上月有哪些小记', new Date(2027, 0, 3))).toMatchObject({ from: '2026-12-01', until: '2027-01-01' });
  });
  it('applies tags and descendants, tasks, pins, literal topics and archive scope', () => {
    const notes = [memo('20261021100000001', '#Work/教学\n- [ ] 备课'), memo('20261021100000002', '#Work\n- [x] 备课'), { ...memo('20261021100000003', '#Work/教学\n- [ ] 备课'), archived: true, pinned: true }];
    expect(executeMemoQuery({ action: 'list', tags: ['Work'], tasks: 'incomplete' }, notes)).toHaveLength(2);
    expect(executeMemoQuery({ action: 'count', tags: ['Work'], pinned: true, text: '备课' }, notes)).toHaveLength(1);
    expect(executeMemoQuery({ action: 'list', archive: 'active' }, notes)).toHaveLength(2);
    expect(executeMemoQuery({ action: 'answer' }, notes)).toHaveLength(2);
    expect(executeMemoQuery({ action: 'answer' }, notes, true)).toHaveLength(3);
    expect(localMemoQuery('今天 #Work 有几条小记', now)?.tags).toEqual(['Work']);
  });
  it.each(['今天关于教学记了几条小记', '今天和昨天各记了几条小记', '今天有多少个待办任务', '今天有多少条未完成的小记，为什么', 'How many tasks today?', '2026-02-30 记了几条小记', '每天记了几条小记'])('does not broaden an ambiguous question: %s', question => expect(localMemoQuery(question, now)).toBeNull());
  it.each([{ action: 'delete' }, { action: 'count', from: '2026-02-30' }, { action: 'count', until: '2026-01-01', from: '2026-02-01' }, { action: 'count', code: 'run()' }, { action: 'list', tags: ['a b'] }, { action: 'list', archive: 'trash' }, { action: 'list', pinned: 'true' }])('rejects an invalid read-only query', query => expect(() => validateMemoQuery(query)).toThrow());
  it('accepts a model count plan without body keywords and rejects invalid filters', () => {
    expect(parsePlan('{"queries":[],"query":{"action":"count","from":"2026-10-21","until":"2026-10-22"}}').query?.action).toBe('count');
    expect(() => parsePlan('{"queries":["教学"],"query":{"action":"delete"}}')).toThrow();
    expect(buildPlan('今天几条', 'test', '', now).messages[0]!.content).toContain('2026-10-21');
  });
  it('keeps answer preferences separate from factual grounding and bounds their size', () => {
    const source = memo('20261021100000001');
    const request = buildChat('问题', [{ memo: source, number: 1, content: source.body }], 'test', '', '简洁回答', '{"totalMatching":70,"supplied":12}');
    expect(request.messages[0]!.content).toContain('Never infer a total count');
    expect(request.messages[1]!.content).toContain('简洁回答');
    expect(request.messages[2]!.content).toContain('"totalMatching":70');
    expect(loadSettings({ aiInstructions: '中'.repeat(5000) }).aiInstructions).toHaveLength(4000);
    expect(queryScope({ action: 'count' }, true)).toContain('包含归档');
    expect(dayString(now)).toBe('2026-10-21');
  });
});
