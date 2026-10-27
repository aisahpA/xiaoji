import { describe, expect, it } from 'vitest';
import { Repository } from '../src/core/repository';
import { TrashStore } from '../src/core/trash-store';
import { serializeMemo } from '../src/core/markdown';
import { loadSettings } from '../src/core/settings';
import { FixtureFiles } from './fixture';

/** FixtureFiles plus content revisions and a read counter, to observe the scan read cache. */
class RevisableFiles extends FixtureFiles {
  reads = 0;
  revisions = new Map<string, string | number>();
  revision(path: string): string | number | undefined { return this.revisions.get(path); }
  override async read(path: string): Promise<string> { this.reads++; return super.read(path); }
}

const settings = loadSettings(undefined);
const clock = (): Date => new Date(2026, 9, 21, 12, 0, 0);
const memoPath = '小记/2610小记.md';
const memoFile = (...ids: string[]): string => ids.map(id => serializeMemo(id, '记录 ' + id + ' #测试')).join('\n\n') + '\n';

async function setup(): Promise<{ files: RevisableFiles; repo: Repository }> {
  const files = new RevisableFiles();
  files.data.set(memoPath, memoFile('20261021120000001', '20261021110000002'));
  files.revisions.set(memoPath, 1);
  return { files, repo: new Repository(files, new TrashStore(files, () => settings.folder), () => settings, clock) };
}

describe('Repository scan cache', () => {
  it('零变更的第二次 scan 复用缓存，不再读取文件（TrashFiles 透传 revision）', async () => {
    const { files, repo } = await setup();

    expect((await repo.scan()).length).toBe(2);
    expect(files.reads).toBe(1);
    const ids = repo.records.map(memo => memo.id);

    expect((await repo.scan()).length).toBe(2);
    expect(files.reads).toBe(1);
    expect(repo.records.map(memo => memo.id)).toEqual(ids);
  });

  it('revision 变化后重新读取并刷新 records', async () => {
    const { files, repo } = await setup();
    await repo.scan();
    expect(files.reads).toBe(1);

    files.data.set(memoPath, memoFile('20261021120000001', '20261021110000002', '20261021100000003'));
    files.revisions.set(memoPath, 2);

    expect((await repo.scan()).length).toBe(3);
    expect(files.reads).toBe(2);
    expect(repo.records.map(memo => memo.id)).toContain('20261021100000003');
  });

  it('本地写入触发 invalidate，下一次 scan 重新读取后再命中缓存', async () => {
    const { files, repo } = await setup();
    await repo.scan();
    expect(files.reads).toBe(1);

    const created = await repo.create('新增一条 #测试');
    const beforeScan = files.reads;
    await repo.scan();
    expect(files.reads).toBe(beforeScan + 1);
    expect(repo.records.map(memo => memo.id)).toContain(created.id);

    await repo.scan();
    expect(files.reads).toBe(beforeScan + 1);
  });
});
