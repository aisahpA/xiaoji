import { expect, it } from 'vitest';
import { makeFixture } from './fixture';
it('stores multiple deleted memos in one Markdown file without YAML and restores independently',async()=>{
 const {plugin,files}=await makeFixture();const originals=plugin.repo.records.slice(0,2);
 for(const m of originals)await plugin.repo.delete(m);
 expect([...files.data.keys()].filter(p=>p.includes('_回收站/'))).toEqual([]);
 const raw=await files.read('小记/回收站.md');expect(raw.startsWith('---')).toBe(false);expect(raw).toContain(originals[0]!.raw);
 const entries=await plugin.repo.listTrash();expect(entries).toHaveLength(2);
 await plugin.repo.restore(entries[0]!);expect(await plugin.repo.listTrash()).toHaveLength(1);
 await plugin.repo.scan();expect(plugin.repo.records).toHaveLength(3);
});
it('refuses to overwrite an existing ordinary recycle note',async()=>{const {plugin,files}=await makeFixture();await files.create('小记/回收站.md','用户自己的笔记');await expect(plugin.repo.delete(plugin.repo.records[0]!)).rejects.toThrow();expect(await files.read('小记/回收站.md')).toBe('用户自己的笔记');});

it('preserves trailing spaces',async()=>{const {plugin}=await makeFixture();const m=await plugin.repo.create('hard break  ');await plugin.repo.delete(m);expect((await plugin.repo.listTrash())[0]!.memo.raw).toBe(m.raw);});

it('keeps earlier entry bodies byte-identical when the store is rewritten for a later delete',async()=>{
 const {plugin,files}=await makeFixture();
 const originals=plugin.repo.records.slice(0,2);
 for(const memo of originals)await plugin.repo.delete(memo);
 const before=await files.read('小记/回收站.md');
 const body=originals[0]!.raw;
 expect(before).toContain(body);
 await plugin.repo.delete(plugin.repo.records[0]!);
 const after=await files.read('小记/回收站.md');
 expect(after.indexOf(body)).toBe(after.lastIndexOf(body)); // exactly once, unchanged
});

it('keeps reading a hand-edited store after dropping an entry and adding blank lines',async()=>{
 const {plugin,files}=await makeFixture();
 for(const memo of plugin.repo.records.slice(0,2))await plugin.repo.delete(memo);
 const store=await files.read('小记/回收站.md');
 const first=store.indexOf('<!-- xiaoji-trash-entry ');
 const blocks=store.slice(first).split('<!-- xiaoji-trash-entry ').filter(Boolean);
 await files.process('小记/回收站.md',()=>store.slice(0,first)+'<!-- xiaoji-trash-entry '+blocks[1]+'\n\n\n');
 plugin.repo.invalidateTrash();
 expect(await plugin.repo.listTrash()).toHaveLength(1);
});
