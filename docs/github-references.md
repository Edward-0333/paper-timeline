# GitHub 参考仓库与采用记录

2026-11-05 采用范围补充：下表 Vercel AI SDK 的工具循环、取消和通用摘要执行器也用于首页「文献库助手」。新增的全库查询、具体变更确认、分类/元数据/监控管理、已有模型配置编辑确认和密钥隔离流程由本项目实现，没有从其他 Agent 仓库复制管理代码，也没有引入 PaperQA 运行时。实现见 `electron/library-agent-tools.ts`、`electron/library-chat-service.ts` 和 [文献库助手说明](library-assistant-guide.md)。

整理日期：2026-10-23。

本表依据当前对话中能够确认的项目、功能说明、第三方声明以及本地依赖补录。记录用途和采用情况，避免把讨论过的项目误认为已经集成。此前没有统一登记选型过程，因此不把无法确认的历史浏览项目补写为已参考。

## 主要参考项目

| 项目 / GitHub 仓库 | 参考的具体功能或思路 | 当前采用情况 | 项目内记录 |
| --- | --- | --- | --- |
| [Paper Monitoring](https://github.com/Edward-0333/Paper_monitoring) | 用户自己的论文引用抓取项目；与 Paper Timeline 整合引用监控、账号、任务及结果同步 | 配套服务端，客户端已经实现登录、订阅和本地同步。服务端独立运行，不作为桌面 npm 组件打包 | [整合方案](remote-citation-monitoring-plan.md)、[云端引用监控指南](cloud-monitoring-guide.md) |
| [AIHOT](https://github.com/KKKKhazix/AIHOT) | 讨论论文信息过多时的自动搜集、筛选、分析和摘要流程 | 设计讨论参考；目前未确认引入其代码或运行时，不表示已经实现自动精选日报 | 本表补录；来自此前用户指定的参考项目 |
| [EmbedPDF](https://github.com/embedpdf/embed-pdf-viewer) | 内置 PDF 阅读、高亮、下划线、评论及阅读位置保存 | 已集成；直接依赖 `@embedpdf/react-pdf-viewer@2.15.1`，阅读资源随软件提供 | [PDF 阅读器说明](pdf-reader-guide.md)、[第三方声明](../THIRD_PARTY_NOTICES.md) |
| [MinerU](https://github.com/opendatalab/MinerU) | 将论文 PDF 转为 Markdown、结构化数据和图片，供阅读 Agent 查阅 | 已接入本机调用；已验证版本 4.0.12。环境及模型独立安装，不随桌面程序打包 | [MinerU 说明](mineru-guide.md) |
| [Vercel AI SDK](https://github.com/vercel/ai) | 模型适配、工具调用循环、停止和执行进度；2026-11-05 参考 `prepareStep` 与 `pruneMessages` 的上下文管理设计 | 已集成 `ai@7.0.150`、`@ai-sdk/openai-compatible@3.0.77` 和 `@ai-sdk/openai@4.0.101`。GPT-6 论文工具经过 Responses 适配器执行；2026-11-05 另外采用 openai.tools.webSearch() 和 maxToolCalls，为文献库助手提供可选的 OpenAI 内置搜索，复用当前模型配置；行内引用、来源归档和次数控制由本项目实现。已用 SDK 的 `generateText` 实现软件管理的分批摘要，并在 `prepareStep` 按预算精简较早工具结果、保留来源及调用配对；裁剪规则由本项目实现，未直接调用 `pruneMessages`。完整聊天与 `chat-context.json` 摘要分开保存，支持跨模型复用 | [模型配置与论文 Agent](model-api-guide.md)、[第三方声明](../THIRD_PARTY_NOTICES.md)、[上游上下文管理](https://ai-sdk.dev/docs/agents/loop-control#context-management)、[上游消息裁剪](https://ai-sdk.dev/docs/reference/ai-sdk-ui/prune-messages) |
| [PaperQA](https://github.com/Future-House/paper-qa) | 论文问答中的资料检索、证据收集和来源引用思路 | 仅作设计参考；未引入其代码或运行时。不能把当前论文 Agent 描述为基于 PaperQA 运行 | [模型配置与论文 Agent](model-api-guide.md)、[第三方声明](../THIRD_PARTY_NOTICES.md) |
| [Tavily JavaScript SDK](https://github.com/tavily-ai/tavily-js) | 2026-11-05 查阅官方搜索接口、结果标题/链接/正文摘要格式与搜索和正文提取的区分 | 已接入 Tavily Search HTTP API，未安装此 SDK，也未采用其无密钥模式；查询参数、加密配置、网页读取、限额和来源展示由本项目实现 | [文献库助手联网搜索](library-assistant-guide.md)、`electron/web-search-settings.ts`、`electron/library-web-tools.ts`、[官方 Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) |
| [Tavily MCP](https://github.com/tavily-ai/tavily-mcp)、[Tavily Power](https://github.com/tavily-ai/tavily-power) | 2026-11-05 调研搜索结果中的官方工具参数与鉴权示例 | 仅接口资料调研；未引入 MCP 服务、插件或仓库代码，实际采用上述直接 HTTP 接口 | 本表；最终接口依据官方 API 文档 |
| [Streamdown](https://github.com/vercel/streamdown) | AI 回复和笔记的 Markdown 渲染、表格、公式与代码显示 | 已集成；`streamdown@2.7.1`，同时使用 CJK、代码及数学插件。AI 回复、笔记阅读和编辑预览均使用它 | [模型配置与论文 Agent](model-api-guide.md)、[Markdown 笔记说明](markdown-note-guide.md) |
| [Vditor](https://github.com/Vanessa219/vditor) | 软件内的 Markdown 笔记编辑器选型 | 已集成 `vditor@4.0.1`；当前采用源码编辑和格式工具栏，配合 Streamdown 安全预览；并未启用它的全部编辑模式和在线功能 | [Markdown 笔记说明](markdown-note-guide.md)、[第三方声明](../THIRD_PARTY_NOTICES.md) |
| [Milkdown](https://github.com/Milkdown/milkdown) | 所见即所得 Markdown 编辑框架，与 Vditor 比较 | 已讨论的候选方案，当前未采用；笔记编辑选择 Vditor | 本表补录；来自 Markdown 编辑器选型讨论 |
| [react-markdown](https://github.com/remarkjs/react-markdown) | React 中的 Markdown 阅读与渲染选型 | 已讨论的渲染器候选；本项目没有单独接入其显示入口，当前显示使用 Streamdown | 本表补录；来自 Markdown 渲染器选型讨论 |

`Paper_monitoring` 与此前写作 `paper_monitoring` 的链接指同一 GitHub 仓库，合并记录，不计为两个项目。

2026-11-05 上下文核查补充：已安装的 AI SDK OpenAI Responses 适配器提供 `contextManagement` / `compactionTrigger` 服务端压缩选项，具体依赖模型与接口支持；本次仅将其作为方案比较参考，Paper Timeline 未配置这些选项，也不保存服务商专属压缩状态，实际采用上述通用文字摘要。参见 [AI SDK Compaction](https://ai-sdk.dev/providers/ai-sdk-providers/openai#compaction) 与 [OpenAI 官方压缩说明](https://developers.openai.com/api/docs/guides/compaction#server-side-compaction)。

## 已使用组件的补充来源

这些是实现和分发中用到的组件来源，单独列出，不将它们混同为产品方案的选型参考。

| 仓库 | 在本项目中的用途 | 当前本地版本 / 记录依据 |
| --- | --- | --- |
| [KaTeX](https://github.com/KaTeX/KaTeX) | AI 回复与笔记中的公式排版 | `katex@0.18.2`；依赖及第三方声明 |
| [Shiki](https://github.com/shikijs/shiki) | Markdown 代码高亮 | 本地安装 `shiki@4.5.0`；第三方声明 |
| [remark-gfm](https://github.com/remarkjs/remark-gfm) | GFM 表格、任务列表等语法支持 | 本地安装 `remark-gfm@4.0.1`；第三方声明；不是根目录的直接依赖 |
| [diff-match-patch（npm 包维护仓库）](https://github.com/JackuB/diff-match-patch) | Vditor 编辑历史所用差异处理 | `diff-match-patch@1.0.5`；已安装 npm 包的仓库字段 |
| [Lute](https://github.com/88250/lute) | Vditor 随附的 Markdown 解析资源 | 随 `vditor@4.0.1` 分发；未另行锁定独立 Lute npm 版本 |
| [Go](https://github.com/golang/go) | Lute 已编译脚本中的运行时代码与许可来源 | 该脚本标记 `go1.21.13`；不要求用户另装 Go 来编辑笔记 |
| [GopherJS](https://github.com/gopherjs/gopherjs) | Lute 已编译脚本的运行时与许可来源 | 随附运行时代码；不是另行运行的应用服务 |
| [PDF.js](https://github.com/mozilla/pdf.js) | PDF 元数据提取和原始页面处理 | `pdfjs-dist@6.3.289`；与交互式 EmbedPDF 阅读器用途不同 |
| [fflate](https://github.com/101arrowz/fflate) | 处理 MinerU 结果包 | `fflate@0.8.2`；依赖及第三方声明 |
| [Zod](https://github.com/colinhacks/zod) | Agent 工具和存储参数校验 | `zod@4.6.7`；依赖及第三方声明 |
| [napi-rs/canvas](https://github.com/Brooooooklyn/canvas) | 本地图像及 PDF 页面渲染 | `@napi-rs/canvas@1.0.9`；依赖及第三方声明 |

应用基础框架及开发工具的完整直接依赖以 [package.json](../package.json) 为准；精确依赖树以 [package-lock.json](../package-lock.json) 为准。它们不等于历史参考仓库清单。

## 与其他记录的关系

- 本文件记录「看过哪些明确项目、为什么参考、是否采用」。
- [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 记录已分发组件的版权和许可说明；本表不替代许可原文。
- [笔记编辑器附带许可来源](../third_party/note-licenses/README.md) 记录 Vditor、Lute 及运行时许可的来源。
- 各功能指南记录当前实现；历史方案中的设想不自动等于已实现能力。

## 后续维护

根据用户要求，每次参考新的 GitHub 仓库，都必须在当次任务结束前同步更新本文，无论最终是否采用。每条记录应注明：

- 仓库名称和链接。
- 参考的具体功能、模块或设计思路，不能只写“参考了该项目”。
- 是否实际采用：区分已集成、外部工具调用、仅借鉴设计、候选但未采用和仍在评估。
- 实际采用的部分、对应功能或代码/说明位置；能确认时补充版本和本次更新日期。

已有仓库新增参考功能或采用状态变化时更新原条目，不重复登记。仅调研、比较或借鉴设计的项目也要记录，但不能写成已经集成。升级已采用组件时同步核对锁定版本和第三方许可记录。
