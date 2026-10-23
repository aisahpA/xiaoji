# 更新记录

## 0.16.1

- 保留原有功能、布局、操作方式和 Markdown 格式，兼容旧版宿主的可选密钥存储。
- 使用 Obsidian 提供的日期库和所属文档的 DOM 辅助方法，规范浏览器定时器。
- 校验 AI 响应结构，补齐引用点击失败时的错误处理。
- 添加 MIT 许可、英文使用说明、官方代码检查和只读构建验证工作流。
- 行为兼容所需的审核告警保留并记录在 REVIEW_NOTES.md，不关闭规则隐藏告警。

Compatibility maintenance: preserve UI and data format, validate provider responses,
support optional host secret storage and add release verification.

## 0.16.0

- 设置按存储、界面、AI、通用排列；保留导航配置切换时的滚动位置。
- 格式备份改为平铺 Markdown 文件，使用原文件名、时间和冲突序号。
- 快速记录支持“在小记中继续”，承接到主页面草稿，不自动提交。
- 支持自定义 AI 对话子目录，当前及历史对话目录排除正常小记索引。

## 0.15.0

- 回收站合并为单一 Markdown 文件，兼容迁入旧记录。
- 格式备份使用普通 Markdown 文件。
- 精简设置分区和重复菜单。
