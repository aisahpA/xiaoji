# 小记 · xiaoji

简洁、本地优先的 Obsidian 小记插件，让灵感、日常与待办留在自己的 Markdown 里。

A quiet, local-first memo plugin for Obsidian. Keep ideas, everyday moments and tasks in your own Markdown files.

![](宣传/宣传1.PNG)

![](宣传/宣传2.PNG)

## 功能 · Features

| 中文 | English |
| --- | --- |
| 原生 Markdown，支持标签、待办、附件、代码、表格与公式 | Native Markdown with tags, tasks, attachments, code, tables and math |
| 列表与瀑布流、置顶、归档、层级标签、搜索与批量整理 | List and waterfall layouts, pins, archives, nested tags, search and batch actions |
| 顶部与侧栏独立配置，拖动排序 | Configure top and sidebar navigation separately; drag to reorder |
| 桌面快速记录小窗，全局快捷键、置顶与转回主页面继续编辑 | Desktop quick capture with a global shortcut, always-on-top and transfer to the main composer |
| 自定义存储、日期分组，Markdown 回收站与格式备份 | Flexible storage and date headings, Markdown Trash and formatting backups |
| 可选 AI：接入 API 或本机 Codex，检索小记、来源引用与临时对话 | Optional AI through API or local Codex, with memo retrieval, source citations and temporary chats |

## 安装与升级 · Installation & updates

需要 **Obsidian 1.8.7+**；独立快速记录小窗仅限桌面端。

Requires **Obsidian 1.8.7+**. The standalone quick-capture window is desktop-only.

1. 从[同一版本的 Release](https://github.com/cimuyang/xiaoji/releases) 下载 `main.js`、`manifest.json`、`styles.css`；本仓库根目录也保留这三个文件。
   Download these three files from the [same release](https://github.com/cimuyang/xiaoji/releases). They are also included in the repository root.
2. 放入笔记库的 `.obsidian/plugins/xiaoji/`，重新加载 Obsidian，在「第三方插件」中启用。
   Place them in `<vault>/.obsidian/plugins/xiaoji/`, reload Obsidian and enable xiaoji under Community plugins.
3. 升级时只替换上述文件，保留 `data.json`、笔记与附件。
   When updating, replace only these files. Keep `data.json`, notes and attachments.

## 记录与整理 · Capture & organize

- 点击侧栏小记图标或从命令面板打开。**Enter 换行，Shift+Enter 记录**；快捷键可在「通用」中修改。
  Open from the ribbon icon or command palette. **Enter inserts a newline; Shift+Enter saves.** Customize both keys in General.
- 输入 `#` 或点击标签按钮选择标签；双击卡片回到顶部编辑，右键或 `⋯` 管理小记。
  Type `#` or click the tag button for suggestions. Double-click a card to edit at the top; right-click or use `⋯` for actions.
- 点击标签筛选；进入多选后，可点选或拖动框选，按住 Shift 追加选择。
  Filter by tags. In selection mode, click or drag a rectangle; hold Shift to add to the selection.
- 点击 `@ID` 引用定位，Ctrl／⌘ 悬停预览；删除的小记可在插件回收站恢复。
  Click an `@ID` reference to locate its memo; Ctrl/⌘ + hover previews it. Restore deleted memos from the plugin Trash.

![](宣传/宣传.svg)

## AI 与文件 · AI & files

- 「通用 → 快速记录」录制组合键，同一行的「全局生效」默认开启。开启时 Obsidian 最小化也能创建或恢复小窗；关闭后相同按键仅在 Obsidian 内响应。冲突会提示，完全退出 Obsidian 后不响应。不同笔记库应使用不同组合键。
  Record one shortcut in General → Quick capture. Global scope is enabled by default; disable it to use the same key only within Obsidian. It works while minimized when global scope is on. Conflicts are reported; Obsidian must still be running. Use different shortcuts for different vaults.
- 「AI → 接入方式」可选择本机 Codex。安装并登录 [Codex CLI](https://learn.chatgpt.com/docs/cli) 或 Codex 桌面端后，点击「检测连接」读取模型列表。默认跟随本机配置；路径留空时比较已发现 CLI 的版本，选择较新的可用版本，手动路径优先。「连接详情与选项」显示实际路径、版本、配置目录及服务，可手动填写模型并发送不含小记的简短验证。检测连接本身不发送推理请求。
  Choose Local Codex in AI → Connection after installing and signing in to [Codex CLI](https://learn.chatgpt.com/docs/cli) or Codex desktop. Check the connection to discover models. The default follows local Codex configuration. Automatic discovery selects the newest verified installed CLI; an explicit path takes priority. Connection details show the executable, version, configuration home and provider. A separate model test sends a short synthetic prompt without memos; checking the connection does not run inference.
- Codex 仅用于桌面端，沿用插件的检索范围与引用；每次请求使用临时只读会话，工具关闭，取消会结束本次进程。插件不读取或复制 Codex 凭据，也不改动其全局配置；服务端的数据保留由服务方决定。
  Codex is desktop-only and uses the plugin's retrieval scope and citations. Requests use ephemeral read-only threads with tools disabled; cancellation ends the owned process. The plugin does not read or copy Codex credentials or modify its global configuration. Provider retention still applies.
- 「跟随本机 Codex」沿用所选 CLI 的默认模型配置，不同步桌面端某个聊天临时选择的模型，也不为小记文件夹创建 Codex 项目。模型目录不保证调用权限，错误不会触发静默降级；本机接入仍需要模型服务联网。
  Following local Codex uses the selected CLI's configured default, not a desktop chat's temporary model choice. It does not create a Codex project for the memo folder. Catalog entries do not guarantee model access; failures never silently select another model. Inference still requires a network connection.
- 历史对话被外部编辑后，可从历史菜单恢复到新对话。原文件保持不变，来源编号不会从外部文本自动重建。
  Recover externally edited conversations from the history menu into a new chat. Originals stay unchanged; source numbers are not reconstructed from imported text.

- AI 默认关闭。选择 API 后配置兼容 Chat Completions 的服务地址、模型和密钥；选择「自动」「仅小记」或「不使用小记」，有来源的回答可展开相关小记。
  AI is off by default. Configure a Chat Completions-compatible endpoint, model and key. Choose Auto, Memos only or No memos; expand related sources when available.
- 可自定义对话目录、提示词，或使用临时会话。问题及按模式选择的小记内容会发送给服务商；临时模式不控制服务商的数据保留。
  Customize the chat folder and prompts, or use temporary sessions. Questions and context selected by the mode go to your provider; temporary mode does not control provider retention.
- 普通记录与搜索无需联网。密钥使用 Obsidian 密钥存储；不支持时仅保留在当前会话，不写入笔记或插件配置。
  Capture and search work offline. Keys use Obsidian secret storage; unsupported hosts keep them in memory only, outside notes and plugin settings.
- 可按月／季／年分卷，自定义文件名与日期标题。整理历史格式会先预览并备份，不自动重命名或重新分卷；迁移提示词只复制，不自动上传旧笔记。
  Choose monthly, quarterly or yearly files and custom names/headings. Reformatting previews and backs up existing notes without renaming or repartitioning them. Migration prompts are copied; old notes are not uploaded automatically.


## 0.16.4 更新 · What's new

- **一键随手记**：快捷键与全局开关合并，默认支持 Obsidian 最小化时唤起记录小窗。
  **Capture anywhere:** one shortcut with a global toggle; open quick capture while Obsidian is minimized.
- **续写更自然**：从小窗返回小记，光标自动停在草稿末尾。
  **Continue smoothly:** returning to the main composer places the cursor at the end of your draft.
- **本机 Codex 更省心**：自动识别较新运行时，跟随本机默认模型，支持连接详情与模型验证。
  **Better local Codex:** discover newer installed runtimes, follow your configured model, and inspect or test the connection.
- **深色模式更清晰**：修复光标不可见，切换主题保留输入和撤销记录。
  **Clearer dark mode:** visible cursors, with text and undo history preserved across theme changes.

## 开发 · Development

使用 Node.js 22.13+ 与 npm；验证包含代码检查、类型检查、回归测试和生产构建。

Use Node.js 22.13+ and npm. Verification runs lint, type checks, regression tests and a production build.

```sh
npm ci
npm run verify
npm run package
```

安装包输出到 `dist/`。更新记录见 [CHANGELOG.md](CHANGELOG.md)，兼容性说明见 [REVIEW_NOTES.md](REVIEW_NOTES.md)。

Packages are written to `dist/`. See [CHANGELOG.md](CHANGELOG.md) for changes and [REVIEW_NOTES.md](REVIEW_NOTES.md) for compatibility notes.

## 许可 · License

[MIT](LICENSE) · [第三方许可 / Third-party notices](THIRD_PARTY_NOTICES.md)
