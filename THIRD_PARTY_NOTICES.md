# 内置阅读器第三方组件

本次集成固定使用 npm 发布的 `@embedpdf/react-pdf-viewer@2.15.1` 及同版 EmbedPDF 组件。所安装的该版本组件附带 MIT License；此说明仅针对锁定版本，升级时需重新检查分发内容与许可。

- EmbedPDF React 包、snippet 及插件：MIT License，项目来源 https://github.com/embedpdf/embed-pdf-viewer 。
- EmbedPDF PDFium 包装代码：MIT License。PDFium 引擎的声明见包内 `LICENSE.pdfium`，随阅读引擎保留分发。
- Noto Sans Hans 中文后备字体：SIL Open Font License 1.1，保留 Adobe、Google 的版权声明和 Reserved Font Name，不修改或单独售卖字体。

构建脚本将已安装 EmbedPDF 依赖的许可原文复制到 `dist/reader-assets/licenses/`，随 `resources/app.asar` 分发；发布目录也附带可直接查看的 `reader-licenses/`。原始 npm 依赖许可保留在各包目录中。

此阅读功能使用本地开源组件，不连接 EmbedPDF Cloud 或 CloudPDF 服务。

## Markdown 笔记阅读与编辑

`vditor@4.0.1`（MIT License，https://github.com/Vanessa219/vditor）用于笔记源码编辑及格式工具栏，`diff-match-patch@1.0.5`（Apache License 2.0）用于编辑历史。Vditor 随附的 Lute JavaScript 解析器按 Mulan PSL v2 分发，其编译包含 Go 与 GopherJS 的 BSD 运行时代码。相关许可原文保留在 `dist/vendor/vditor/licenses/`，发布目录附带 `note-licenses/`。

编辑器、中文界面和图标在本地打包，不使用 CDN。笔记阅读及编辑时的预览复用下述 Streamdown、KaTeX、Shiki 组件；不运行笔记中的 HTML，不自动加载图片附件。

## 全文转换

MinerU 作为单独安装的本机程序调用，目前已验证 4.0.12，不随本应用程序包分发。来源：https://github.com/opendatalab/MinerU 。其许可和解析模型的许可保留于相应安装与模型目录，使用者需按所安装版本的条款使用。转换界面明确显示 MinerU。

解析 MinerU 结果包使用 `fflate@0.8.2`，MIT License，Copyright (c) 2023 Arjun Barrett。许可原文随应用依赖分发，并附于 `mineru-licenses/fflate-MIT.txt`。

## 论文阅读 Agent

- `ai@7.0.150`、`@ai-sdk/openai-compatible@3.0.77` 和 `@ai-sdk/openai@4.0.101` 使用 Apache License 2.0，来源 https://github.com/vercel/ai 。用于模型适配和工具调用循环，直接连接配置的模型服务。
- `zod@4.6.7`：MIT License，用于工具与对话存储参数校验。
- `@napi-rs/canvas@1.0.9`：MIT License，用于本地图像处理及 PDF 页面渲染；PDF 解析沿用 `pdfjs-dist`。

以上组件许可原文保留于分发的依赖目录，并在发布目录附带 `agent-licenses/`。PaperQA 仅为证据收集设计参考，本软件未引入或分发 PaperQA 代码和运行时。

## 聊天 Markdown 显示

- `streamdown@2.7.1`、`@streamdown/code@2.0.0`、`@streamdown/math@1.0.3`、`@streamdown/cjk@1.0.4`：Apache License 2.0，Copyright 2023 Vercel, Inc.，来源 https://github.com/vercel/streamdown 。
- `katex@0.18.2`：MIT License，来源 https://github.com/KaTeX/KaTeX ，用于本地数学排版，字体资源随应用分发。
- `shiki@4.5.0`：MIT License，来源 https://github.com/shikijs/shiki ，用于代码高亮，本地打包语言与主题资源。
- `remark-gfm@4.0.1`：MIT License，Copyright (c) Titus Wormer，来源 https://github.com/remarkjs/remark-gfm 。

用于本地渲染模型回答，不执行回复中的 HTML，不自动加载图片。许可原文随发布目录 `chat-licenses/` 分发。构建使用 Tailwind CSS 4.3.3（MIT License），仅生成带 ptmd 前缀的聊天样式；不加载全局 preflight。
