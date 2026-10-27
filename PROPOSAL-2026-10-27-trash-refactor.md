# 提案：回收站存储重构与发布剪枝（0.17.0）

- 状态：草案，待拍板
- 日期：2026-10-27
- 影响版本：建议 0.17.0
- 关联记录：`CHANGELOG.md` 0.15.0（回收站合并为单一 Markdown 文件）、性能分析（本地实测，脚本见「附录 A」）
- 一句话：线上从 0.16.0 首发、无旧数据，`TrashFiles` 这层「虚拟文件」装饰器没有任何用户会用到，却让打开回收站变成 O(n²)、每次 scan 白付一次 store 解析、并使 scan 增量缓存失效；建议在 0.17.0 删掉兼容层，回收站改成显式的 `TrashStore`，同时剪掉首发前内部迭代留下的数据迁移代码。

---

## 1. 背景

- 插件 0.16.0 才首次发布（当前 0.16.2，下载量约 20 次），线上不存在 0.16.0 之前的数据。
- 代码里仍保留为内部迭代服务的兼容结构：
  - `_回收站/` 下「每条回收站记录一个真实 md 文件」的旧布局及其自动迁入逻辑；
  - 设置加载器里对旧键（如 `pinnedTools`、`sidebarOrder` 等）的兜底；
  - `migrateQuickHotkeys()`：把已退役的 `xiaoji:quick-window` 快捷键并入 `capture`；
  - 会话回收站里旧格式副本的识别与清理（`conversations.ts`）；
  - `tests/v7`、`v8`、`v9`、`v10`、`v13` 等针对旧 schema 的迁移测试。
- 这些代码为「从未发布过的版本」服务，属于死路径；其中回收站这一层还连带制造了两处真实性能损失（见第 2 节）。

当前组合方式（`src/main.ts:131-132`、`src/core/repository.ts:36-38`）：

```
main.ts: this.files = new VaultFiles(app)
         this.repo  = new Repository(this.files, ...)
repository.ts:38:  this.files = new TrashFiles(files, () => this.settings().folder)
```

`TrashFiles` 让 `小记/_回收站/<id>.md` 看起来像普通文件，读写实际落到聚合文件 `小记/回收站.md`。

## 2. 问题（均实测）

### 2.1 打开回收站是 O(n²)

`Repository.listTrash()`（`src/core/repository.ts:263-272`）对回收站里**每个条目**调用一次 `files.read`；而 `TrashFiles.read`（`src/core/trash-files.ts:76`）每次都执行 `entries()`（`:52`），即「读整份 store → `parse()` 全量解析」。`parse()` 内每条条目还要 `decode()`（`:7-15`，含一次 `parseMemos`）和一次 `legacy()` 往返，最后对整个 store 做两次 `serialize()` 校验（`:33`）。

实测（`/tmp/xj-perf/bench8.mjs`，真实 `Repository` + `TrashFiles` + 内存 FilePort，12 个文件/84 条 memo）：

| 回收站条数 | `listTrash()` |
|---|---|
| 10 | 83 ms |
| 50 | 1.33 s |
| 100 | 4.93 s |

且 `ui/trash.ts` 的 `refresh()`（`:35-38`）直接调用 `listTrash()`，而回收站视图在 `notify` 后也会刷新——回收站开着时，每保存一条小记就重跑一次秒级操作。

### 2.2 每次 scan 白付一次 store 解析

`TrashFiles.listMarkdown()`（`src/core/trash-files.ts:61-75`）在返回路径列表前：

1. 触发一次全 vault `listMarkdown`（`:62`）；
2. 对 `_回收站/` 下每个真实文件做迁移尝试（`:63-72`，生产环境该目录为空，循环空转）；
3. 再触发一次全 vault `listMarkdown`（`:73`）。

解析整份 store 的成本随回收站条数线性增长，而 `Repository.scan()` 拿到列表后第一件事就是把 `_回收站/` 路径**全部过滤掉**（`src/core/repository.ts:61`）——这份成本对 scan 是纯浪费。实测：100 条回收站时，12 文件小库的 warm scan 从约 0 ms 增加到 48 ms。

### 2.3 单次删除/恢复对 store 重复解析

- `delete()`（`src/core/repository.ts:237-261`）：`files.create` 写备份（store 解析）、`files.process` 删源文件、`files.process` 改状态（解析），`parseTrash` 返回结果——一次删除约 3-4 次整份 store 解析；84 条 memo 文件 + 100 条回收站实测删除 394 ms。
- `restore()`（`:284-301`）：读回收站条目（解析）→ 写回源文件（再解析）→ 删除备份（解析）；实测 349 ms。

### 2.4 缓存被这层包装吞掉（已临时修复，重构后可撤回）

`Repository.scan` 的增量缓存依赖 `this.files.revision(path)`（`repository.ts:68-72`），但 `TrashFiles` 原先没实现 `revision`，`revision?.()` 恒为 `undefined` → 缓存永不命中，每次 scan 全量重读重解析。已通过给 `TrashFiles` 转发 `revision` 做临时修复（工作区未提交，见第 7 节）。重构删掉 `TrashFiles` 后，`Repository` 直接持有 `VaultFiles`，这个问题从根上消失。

### 2.5 测试在模拟不存在的数据

`tests/trash-store.test.ts:13-16` 专门测试「把 `_回收站/` 里的旧文件迁入聚合 store」——生产环境永远不会出现这种文件；而生产实际走的「包装器 + 缓存」路径没有任何覆盖（这也是 2.4 逃逸的原因）。

## 3. 目标 / 非目标

**目标**

1. 回收站操作成本降为 O(n)：`listTrash` 一次解析；`delete/restore/purge` 一次写入。
2. `scan()` 完全不解析回收站 store。
3. 删除 `TrashFiles` 及 `_回收站/` 虚拟文件语义，删掉两项死迁移代码。
4. **store 文件格式与用户数据 100% 不变**（`小记/回收站.md` 字节级一致），因此零数据迁移风险。
5. 顺带剪掉首发前遗留的其他兼容代码（分批，先列清单）。

**非目标（另立提案）**

- 数据索引层重构：`parseMemos` 的单遍解析、写路径重复解析、冷启动持久化索引（见性能分析报告）。
- UI 渲染层重构：`renderFeed` 全量、卡片生命周期、搜索索引。
- 会话存储（conversations state）与 `persist` 深拷贝。
- AI/搜索查询链路的性能。

## 4. 方案

### 4.1 目标结构

```
src/core/
  repository.ts    ← 构造：files: FilePort（裸 VaultFiles）+ trash: TrashStore
  trash-store.ts   ← 新增：回收站聚合存储（内存快照 + 写穿 + 串行队列）
  trash-files.ts   ← 删除
  types.ts         ← FilePort 保留；TrashEntry 复用
src/ui/trash.ts    ← 不改公开 API，只依赖 repo.listTrash()
src/main.ts        ← 组合根显式构造 TrashStore 并注入 Repository
```

职责划分：

- `FilePort`：只描述真实文件的读写（`VaultFiles` 唯一实现）。
- `TrashStore`：只管 `小记/回收站.md` 的编解码、内存条目、串行写入、冲突检测；**不实现 FilePort**。
- `Repository`：区分「源文件」与「回收站条目」两类对象，不再假设回收站条目是文件。

### 4.2 `TrashStore` 接口草案

```ts
// src/core/trash-store.ts
import { parseMarkdown, parseMemos } from './markdown';
import { MemoError, type FilePort } from './types';

interface Entry {
  name: string;          // <id>-<timestamp>.md
  source: string;
  deletedAt: string;
  state: 'backup' | 'deleted';
  raw: string;           // 原始 memo markdown
}

export class TrashStore {
  private tail: Promise<unknown> = Promise.resolve();
  private entries: Entry[] | null = null;   // 内存快照，首次 load 后复用
  constructor(private files: FilePort, private folder: () => string) {}

  /** 首次读 store；之后直接返回内存快照。 */
  list(): Promise<Entry[]>;
  /** 写穿：追加条目并更新快照；保留当前 write() 的 before 校验（冲突检测）。 */
  append(entry: Entry): Promise<void>;
  update(name: string, mutate: (entry: Entry) => Entry): Promise<void>;
  remove(name: string): Promise<boolean>;
  /** 外部改动（vault modify 事件）后丢弃快照，下次 list() 重读。 */
  invalidate(): void;
}
```

要点：

- 编解码复用现有 `marker`/`entryMarker`/`decode`/`serialize`（`trash-files.ts:4-37`），**store 文件字节不变**。
- `parse()` 的往返校验（`:33`）保留，但从「每次 `entries()` 都校验」变成「每次 load 校验一次」，成本从 O(操作数 × n) 降为 O(1 × n)。
- 内存快照 + 串行队列替代「函数式装饰器」：读写不再经过文件路径抽象，`listTrash` 天然 O(n)。

### 4.3 Repository 改动

| 方法 | 现状 | 改后 |
|---|---|---|
| `scan()` (`:58-87`) | 经 `TrashFiles`；被 `_回收站/` 过滤 | 裸 `VaultFiles`；仍过滤 `_回收站/` 与 `回收站.md`；`revision` 直达 |
| `delete()` (`:237-261`) | 写虚拟路径 + 3-4 次 store 解析 | 读源文件快照一次 → `trash.append(...)` → 删源文件 |
| `listTrash()` (`:263-272`) | 逐条目 `read` | `trash.list()` 一次；`parseTrash` 在内存条目上做 |
| `purgeTrash()` (`:274-279`) | 读文件 + 解析 | `trash.remove(name)`；冲突比较用快照 |
| `restore()` (`:284-301`) | 读文件 + 解析 + 写回 | `trash.get(name)` + `trash.remove(name)` + 写回源文件 |

注意：`restore()` 写回源文件时仍会经过 `appendMemo`（`markdown.ts` 内部多次解析），这是数据层问题（P0-2/P1-3），不在本提案内解决，但重构会给它留出干净的入口。

### 4.4 `_回收站/` 旧文件处理

- 删除 `trash-files.ts:63-72` 的迁移循环与 `:73` 的第二次 `listMarkdown`；`listMarkdown` 不再需要存在。
- 线上不存在该目录（首发 0.16.0 + 生产写入只落聚合文件）；因此**不提供自动迁移**。
- 给开发者本机数据提供一个可选脚本 `scripts/migrate-legacy-trash.mjs`（一次性把 `_回收站/*.md` 追加进 `小记/回收站.md`），不随插件运行。是否保留由维护者决定。

### 4.5 发布剪枝清单（分批）

**A. 本提案内确认删除**

- `src/core/trash-files.ts` 整个文件（兼容层）。
- `tests/trash-store.test.ts` 中「迁移旧文件」用例，改为 `TrashStore` 行为测试。
- `repository.ts:2` 的 import 与 `:38` 的构造。

**B. 执行时逐项核对后删除（用 CHANGELOG 时间线确认属于首发前内部迭代）**

| 位置 | 内容 | 关联测试 |
|---|---|---|
| `src/core/settings.ts` 加载器 | 旧键兜底（`pinnedTools` 等，约 `:121-160`） | `tests/v9.test.ts`、`v10.test.ts` 等 |
| `src/main.ts:302-320` | `migrateQuickHotkeys()` | `tests/v7.test.ts:105` 附近 |
| `src/core/conversations.ts` | 旧格式回收站副本清理（`delete()` 内 `parseTrash` 的 legacy 分支） | `tests/conversations.test.ts`、`tests/chat-v5.test.ts` |
| `tests/v7`–`v13` 等迁移测试 | 首发前 schema 的迁移断言 | — |

核对方法：`git log --follow` 不可用（历史被压成单个 commit），以 `CHANGELOG.md` 版本条目 + `tests/v*.test.ts` 的断言内容为准；凡迁移目标格式在 0.16.0 已存在的，删。

## 5. 测试计划

1. **保留并改造**
   - `tests/scan-cache.test.ts`：改为裸 `FilePort`（不经过 `TrashFiles`），断言零变更二次 scan 0 read。
   - `tests/trash-store.test.ts`：保留 store 读写/冲突/损坏恢复用例；删除「虚拟文件迁移」用例。
2. **新增**
   - `TrashStore` 单测：list 一次 load、append/update/remove 写穿、外部改动 invalidate。
   - `Repository` 回收站集成测试：delete → listTrash → purge / restore 全链路（现有 fixture，改断言路径语义）。
   - 性能断言（可选，标记 slow）：100 条回收站 `listTrash` ≤ 100 ms（本机基准）；scan 不调用 store 解析（spy `parseMemos` 计数为 0）。
3. **回归**：`npm run verify`（lint + tsc + vitest + build）。

## 6. 验收标准

- `listTrash` 100 条：本机 ≤ 100 ms（现 4.93 s）。
- warm scan（零变更）不解析 store；`repository.revision` 直接来自 `VaultFiles`。
- `delete/restore/purge` 单次操作 store 解析 ≤ 1 次（load 后为 0）。
- `grep -R "_回收站" src/` 只剩常量或删除后的必要残留；不再有虚拟文件路径构造。
- store 文件字节与 0.16.2 生成的完全一致（用真实 `回收站.md` fixture 做 round-trip）。
- `npm run verify` 全绿；`main.js` 重新构建。

## 7. 与工作区未提交改动的关系

工作区已有 P0-1 临时修复（`main.js`、`src/core/trash-files.ts`、`src/core/types.ts`、`tests/scan-cache.test.ts`）。本提案落地后：

- 删除 `TrashFiles.revision` 转发（随文件一起删）；
- `types.ts` 的 `revision?: string | number | undefined` 保留（若决定转必选则同步改，见开放问题 1）；
- `tests/scan-cache.test.ts` 改为裸端口版本后保留；
- `main.js` 随最终代码重建。

## 8. 风险与回滚

- **数据风险：低**。store 格式不变，只是读写路径重写；用真实 fixture 做 round-trip 校验。
- **行为风险：低**。若用户手工把文件放进 `_回收站/`，删除迁移后该文件不再出现在插件回收站（0.16.x 用户几乎不会；CHANGELOG 说明即可）。
- **冲突检测**：保留 `write()` 现有的 before 校验；外部改动通过 vault `modify` 事件 invalidate 后重读。
- **回滚**：数据格式未变，单 commit 回退安全；`main.js` 重新构建即可。

## 9. 分期与工作量

| 阶段 | 内容 | 预计 |
|---|---|---|
| Step 0 | 只删迁移循环 + 第二次 `listMarkdown`（零风险，可先合） | 30 分钟 |
| Step 1 | 新增 `trash-store.ts`；Repository 4 个入口迁移；删 `trash-files.ts`；测试改造 | 0.5 天 |
| Step 2 | 发布剪枝清单 B（逐项核对后删）+ 测试清理 | 0.5 天 |
| Step 3 | 基准脚本迁入 `scripts/bench/`、性能断言、CHANGELOG/版本号 | 0.5 天 |

合计约 2 人日。

## 10. 开放问题（需拍板）

1. `FilePort.revision` 是否改为必选？建议必选（`Repository` 依赖它；`VaultFiles` 已实现；测试假端口补 3 行）。
2. 发布剪枝清单 B 是否在 0.17.0 一起做？建议一起（首发窗口期，改动风险最低）。
3. `_回收站/` 旧文件：彻底删（推荐）还是保留开发者脚本？建议保留脚本、插件内不迁移。
4. `TrashEntry.path` 字段（现为虚拟路径）是否保留？建议内部改用 `name`，UI 展示时拼 `_回收站/<name>` 保持文案不变。

## 附录 A：复核命令

```
cd /tmp/xj-perf && node bench8.mjs        # listTrash O(n²) 实测
cd /tmp/xj-perf && node bench4.mjs        # scan 缓存/冷扫规模实测
cd /Users/chenxg/Documents/code/Github/xiaoji && npm run verify
```

（脚本目前在 `/tmp`，Step 3 时迁入仓库 `scripts/bench/`，并去掉对内网常量的依赖。）

---

# 附录 B：10k 规模务实性能路线（2026-10-27 增补；供排期用，不属于 0.17 回收站范围）

目标：**10k 条小记下"过得去"**，不追求完美，不做架构级重写。原则是**按操作频率排序投入**：
高频（每天几十次）必须无感；中频（每天十几次）做到可接受；低频（启动、回收站、重排）用"延后/分批/进度"或明确接受，不重写。

## B.1 前提修正与 10k 的真实形态

存储周期只有三种（`src/core/types.ts:2`：`Period = 'month' | 'quarter' | 'year'`），**不存在"日文件型"**。按 10 条/天、2.7 年 ≈ 10,000 条估算：

| 周期 | 文件数 | 每文件条数 / 体积 | 单次保存现状（估算） |
|---|---|---|---|
| `month`（默认） | ~33 | ~300 条 / ~30 KB | **0.3–0.5 s**（3–4 次整文件解析 + 事件再解析一次） |
| `quarter` | ~11 | ~900 条 / ~90 KB | **1–1.2 s** |
| `year` | ~3 | ~3,300 条 / ~330 KB | **3.5–4.5 s**（不可用） |

- 依据：`parseMemos` 约 **0.1–0.3 ms/条**（实测：300 条/30 KB = 79.5 ms；1000 条/167 KB = 1320 ms）；`create` 对同一文件解析 3–4 次（`repository.ts:163/165/166` + `markdown.ts:106/112`），外加 vault 事件 180 ms 后 scan 再整文件解析一次。
- **冷启动与周期无关**：10k 全量解析 ≈ **7.7 s**（10k/120 文件实测），发生在每次 Obsidian 启动（`main.ts:173`）。
- 结论：**先治"每次保存"，再治"启动"**；周期只影响保存成本，季度/年文件会放大 3–10 倍，必须在路线里单列。

## B.2 高频操作（每天 20–50 次）

### 保存一条小记（最高优先）

| 档位 | 做法 | 目标（10k） | 工期 |
|---|---|---|---|
| Tier A（简单，先做） | ① `create/mutate` 解析 3–4 次 → **1 次**：`appendMemo` 接收已解析的 memos，删掉校验用的 `parseMemos(next)`；② `view.save` 的 `await p.refresh()` → `refreshSoon()`；③ 写后用新 revision **回填 scan 缓存**，让 180 ms 后的 refresh 不再整文件解析 | month 0.3–0.5 s → **≤ 120 ms**；quarter 1–1.2 s → ≤ 400 ms；year 3.5–4.5 s → ~1 s | 1 天 |
| Tier B（季度/年文件必需，仍不算复杂） | ④ 写路径改为**偏移量直改**：`records` 里已有每条 memo 的 `start/end/raw`，`text.slice(start,end) === raw` 校验通过后直接替换/删除（乐观并发），不通过再回退全解析；⑤ 新建时"当天第一条"回退全解析（每天一次），同日追加走偏移量；⑥ 保留 Tier A 的缓存回填 | 所有周期 **≤ 100 ms**（每天首次新建多一次解析：month 80 ms / quarter 250 ms / year 0.9 s） | 1 天 |

> 说明：Tier B 的关键不是"更聪明的解析"，而是**根本不解析整文件**——offset 已在 `records` 里，校验用一次字符串比较。这是最简单能覆盖季度/年文件的方案。

### 其余高频

| 操作 | 现状 | 最小改法 | 目标 | 工期 |
|---|---|---|---|---|
| 每次 notify 的 UI 更新 | 40 卡 × 数百次同步布局读；隐藏宿主全量建卡（`view.ts:692-694`，REVIEW_NOTES 439–503 ms 疑似来源） | 版本 gate（状态没变直接 return）；`measureCards` 只量内容变化的卡；`clientHeight===0` 只占位不建卡 | 保存后 UI 更新 **< 50 ms** | 0.5–1 天 |
| 搜索输入 | 每键全量 filter+sort（1 万条 3–7 ms）+ 冷缓存折叠 13.2 ms + 逐 grapheme 高亮 | 150 ms 去抖 + 复用 `queryCache` | 每键 **< 5 ms** | 2 小时 |

## B.3 中频操作（每天 5–20 次）

| 操作 | 现状 | 最小改法 | 目标 | 工期 |
|---|---|---|---|---|
| 点 @引用 / 深链 | 先全量 `refresh()` 再查 id（`main.ts:613-624`、`:668-679`） | 先查内存 `records`，未命中再单文件读 | **< 10 ms** | 1 小时 |
| 打开回收站 | 100 条 4.93 s，且开着时每次保存重跑 | 执行本提案正文的 `TrashStore` | **< 100 ms** | 约 1 天（含剪枝） |
| 切标签 / 导航 / 布局 | 每次 scan 全量重建标签树 27.5 ms | `recordsRevision` 只在条目数/标签集合变化时递增 | 仅变化时重建 | 2 小时 |

## B.4 低频操作（启动 1–3 次/天；回收站、重排周/月级）

| 操作 | 现状 | 做法 | 目标 | 工期 |
|---|---|---|---|---|
| Obsidian 启动 | 启动后立刻全量 scan 7.7 s | 首轮 scan 从 `onLayoutReady` 挪到**首次打开小记视图**；每 20–30 个文件一批、批间让出主线程；视图显示进度 | 启动无感；首次开视图骨架 < 0.5 s，2–4 s 补齐 | 1–1.5 天 |
| 冷启动解析本身 | 10k = 1+N 次解析/文件 | **单遍解析**：`features` 消费整文件 AST 的 listItem 子树，不再对每条 body 二次 `parseMarkdown`（`markdown.ts:30/37/62`） | 全路径 ×1.4–2 提速，冷扫 7.7 s → 4–5 s | 1 天 |
| 格式重排 | 每文件 5N+7 次解析，10k 约 5 万次 | 确认弹窗 + 分批 + 进度条；不改解析架构 | 可用不冻结（分钟级可接受） | 0.5 天（或只加确认） |
| 外部直接编辑源文件 | 每 180 ms 防抖后整文件重解析：month 80 ms / quarter 250 ms / year 0.9 s | 大文件把重解析延到编辑停止 1–2 s 后；年文件在设置页提示 | 可接受并文档化 | 2 小时 |
| AI 会话 / `persist` 深拷贝 | 每轮写 1.8 MB state，list 读 29 MB | **本轮不做**（低频、可选功能） | — | — |
| 瀑布流 CSS / bundle 体积 / 许可注释 | 对 CPU 无影响 | 顺手清理，不排期 | — | 半天 |

## B.5 明确不做（为了"不复杂"）

- 磁盘持久索引（跨重启索引文件、失效校验）。
- 卡片池 / 虚拟列表重写、瀑布流布局换方案。
- 会话 state 分片、Web Worker 解析。

理由：10k 规模下"启动慢"用**延后 + 分批**就能接受；"保存慢"用 **Tier A/B** 就能到 100 ms 级；渲染层只做门控和短路，够用即止。

## B.6 批次与验收

| 批次 | 内容 | 工期 |
|---|---|---|
| Batch 0 | 提交已完成的 P0-1 修复；回收站提案 Step 0（删迁移循环+第二次全盘 list） | 0.5 小时 |
| Batch 1（高频） | Tier A + 渲染门控/隐藏短路 + 搜索去抖 | 1.5–2 天 |
| Batch 2（中频 + 启动） | Tier B + 单遍解析 + 首轮 scan 延后分批 + @引用先查 + tag 重建条件 | 2–2.5 天 |
| Batch 3（回收站） | 本提案正文（`TrashStore` + 剪枝） | 约 2 天（可提前穿插） |

验收（10k，三种周期都要过）：

| 场景 | month | quarter | year |
|---|---|---|---|
| 保存一条（Tier A+B） | < 120 ms | < 150 ms | < 200 ms（每天首次新建另计时） |
| 保存后 UI 更新 | < 50 ms | < 50 ms | < 50 ms |
| 启动 Obsidian | 无感（不做全量 scan） | 同左 | 同左 |
| 首次打开视图可交互 | < 0.5 s（骨架），后台 2–4 s 补齐 | 同左 | 同左 |
| 搜索每键 | < 5 ms | < 5 ms | < 5 ms |
| 点 @引用 | < 10 ms | < 10 ms | < 10 ms |
| 回收站 100 条 | < 100 ms | 同左 | 同左 |

## B.7 需拍板

1. **Tier B 是否做**：月文件可能只用 Tier A 就够（≤120 ms），但季度/年文件不做 Tier B 仍会 0.4–1 s；建议做（1 天）。
2. **冷启动策略**：首次打开视图时扫描（推荐，启动零成本）vs `onLayoutReady` 后 idle 后台扫描（启动后台有 stutter）。
3. 是否在设置页对"季度/年 + 大文件"给出规模提示（"记录较多时建议月周期"）。
4. "外部直接编辑源文件仍会在大文件时卡一下"是否接受并写进文档（建议接受，本轮不做增量解析）。
