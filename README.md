# 小记 · xiaoji

一个简洁、以本地 Markdown 为基础的 Obsidian 小记插件。当前版本：**0.16.0**。

![](https://github.com/cimuyang/xiaoji/blob/main/%E5%AE%A3%E4%BC%A0/01-%E5%B0%8F%E8%AE%B0%E5%AE%A3%E4%BC%A0%E6%80%BB%E8%A7%88.png)

![](https://github.com/cimuyang/xiaoji/blob/main/%E5%AE%A3%E4%BC%A0/02-%E8%AE%B0%E5%BD%95%E4%B8%8E%E6%B5%8F%E8%A7%88%E6%93%8D%E4%BD%9C.png)

![](https://github.com/cimuyang/xiaoji/blob/main/%E5%AE%A3%E4%BC%A0/03-AI%E4%B8%8E%E6%96%87%E4%BB%B6%E7%AE%A1%E7%90%86.png)

## 功能

- 顶部记录框与源码编辑，支持标签补全、待办、附件及自定义提交快捷键。
- 列表与瀑布流、置顶、归档、层级标签、搜索与批量操作。
- 顶部和侧栏独立配置显示与拖动排序。
- 桌面快速记录小窗，支持窗口置顶及转入主页面继续编辑。
- 月／季／年文件分卷，可自定义文件名和日／周／月日期标题，也可不分组。
- 单文件 Markdown 回收站；格式整理提供预览与备份。
- 可选兼容 Chat Completions 的 AI 对话，支持自定义对话目录与临时会话。

## 安装与升级

将 `main.js`、`manifest.json`、`styles.css` 放到仓库的 `.obsidian/plugins/xiaoji/`，然后在 Obsidian 第三方插件设置中启用。

源码仓库不包含生成的 `main.js`，请自行构建，或从发布者提供的运行包安装。升级时只替换上述三个文件，保留现有 `data.json`、笔记与附件。

## 开发

需要 Node.js 和 npm。在项目根目录运行：

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run package
```

构建输出 `main.js`；运行包输出到 `dist/`。测试包含 Markdown 读写、存储冲突、设置、对话和交互回归。桌面、手机及第三方主题的实际效果仍应在目标环境中确认。

## 数据格式

```markdown
### 261023

- 20261023110727000
  记下一个想法。 #生活

  - [ ] 接下来要做的事
```

记录使用本地日期时间戳，正文逐行额外缩进两个空格。`×` 表示归档，`↑` 表示置顶。支持读取有效的 14 位和 17 位时间戳。

删除的记录集中保存在小记目录的 `回收站.md`，恢复信息使用 HTML 注释保存。格式整理备份直接保存在 `_格式备份/`，不会进入正常小记索引；已有旧格式备份保留。整理不会自动移动或重新分卷历史文件。

## AI 与隐私

AI 默认关闭。启用后，需要自行配置服务地址、模型与密钥。普通记录、浏览和搜索无需网络。

使用 AI 时，问题及按模式检索的小记内容会发送到所配置的服务商；临时会话不等于服务商不保留请求。密钥通过 Obsidian 密钥存储保存；不可用时仅在当前会话中保留，不写入小记或插件配置。

“复制迁移提示词”只复制格式说明，不会自动上传旧笔记。请检查 AI 整理结果后再导入。

## 第三方许可

打包依赖的许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
