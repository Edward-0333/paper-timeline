# AI 资料导航

文献库自动维护三层导航，供能够访问本地文件的 AI 按需读取，不需要一次加载整个 `library.json` 或猜测文件夹名称。

```text
library/AI-INDEX.md
  → ai-index/catalog.json
    → papers/<稳定资料文件夹>/paper-index.json
      → original.pdf、notes.md、annotations.json、chat.json、chat-context.json
      → citations/citations.json
      → parsed/<最新成功版本>/Markdown、JSON、图片
```

第一层说明读取顺序和字段含义。第二层包含论文 ID、标题、DOI、arXiv 编号、标签、实际资料目录和单篇索引位置。第三层提供该论文元数据、个人精简笔记、评分、分类、阅读记录及资料清单。

所有 JSON 内的 `path`、`directory`、`index` 都相对于 **library 根目录**，统一使用 `/` 分隔；搬动文献库后仍可解析。不要把它们相对于单篇 JSON 所在目录拼接。软件 API 的 `app.status.aiIndex.entryPath/catalogPath` 与 `papers.get.indexPath` 则返回当前电脑的绝对路径。

个人 Markdown 笔记是 `files.markdownNote`，精简笔记是 `paper.briefNote`，MinerU 提取的论文全文是 `parsed.markdown`。`parsed.artifacts` 列出最近成功版本中的 Markdown、JSON 和图片，图片无需提前加载。旧转换版本保留在磁盘上，但不列为当前全文。没有原文的条目同样拥有索引。

文件状态 `available` 表示检查时为库内普通文件，`missing` 表示已登记的位置缺失，`unavailable` 表示无法安全访问，`not_attached` 表示尚未添加附件。解析状态还可能是 `incomplete`、`stale`（登记 PDF 哈希不同）或 `source_unavailable`（原文缺失或不可访问）。`registeredPdfMatches` 仅比较登记哈希，不等于重新计算磁盘原文哈希；文件状态也不等于内容已经被模型读取或验证。解析目录遍历最多 10,000 项、16 层，达到边界标记 `truncated=true`，不跟随链接。

启动软件、修改文献信息、保存附件/笔记/阅读记录/聊天/解析结果后会维护索引；云端同步结束后更新引用文件状态。内容无变化不重写，`generatedAt` 为该索引内容最后更新的时间。外部修改文件后，重新打开软件或调用：

```text
PaperAI.cmd call library.refreshIndex
```

检查返回的 `ready` 和 `error`。索引是可再生成的缓存，失败不会撤销已经成功的主资料保存。各文件以临时文件原子发布；不同论文之间不提供全库事务快照，正在修改时先等待更新完成。路径被占用、索引损坏或存在非软件生成文件时不覆盖，处理冲突后再刷新。不要修改导航文件来修改论文，应使用软件或已公开接口。

桌面复制会携带各篇的 `paper-index.json`；目标库启动后重建根入口和目录。手工复制完整文献库则携带全部三层索引。原文和笔记正文不复制到索引，密钥、登录信息、临时会话和无关文件不列入；额外手放的补充材料仍随库复制，但不自动登记进此清单。此功能不联网、不自动运行 MinerU、不自动发送资料给模型，也不扩大内置论文 Agent 的当前论文权限。
