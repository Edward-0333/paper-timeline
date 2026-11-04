# AI 接口指南

精简笔记通过 `papers.setBriefNote {id,text}` 保存，最多 1000 字符的纯文本，空白文字清除；`papers.list/get` 返回 `briefNote`。保存在库索引中，独立于 Markdown 附件。详情和 PDF 阅读页可编辑，时间线底部可切换展示，显示偏好在本机按库记忆。

新文献的 `unread=true` 表示绿色「未打开」圆点。桌面主动选择详情或打开 PDF/MD 时清除，API 查询和自动选中不清除；只有需要明确标记时调用 `papers.markOpened {id}`。旧条目无此字段时视作已打开，重复导入/重新检索不会重置。两项操作离线、原子保存并备份，失败保留原状态；不修改论文文件或书目元数据。

「配置大模型」弹窗可手动测试连通性：只发送固定简短消息，可能产生少量 API 费用，不发送论文、不保存未提交配置。只在用户点击时执行，显示本次模型响应状态和耗时。此功能仅提供桌面交互，不开放 AI HTTP 操作；自动验证使用隔离假服务。

个人首页「配置大模型」支持添加和切换本机模型配置。论文阅读 Agent 在发送消息时使用当前模型。每套配置分别管理密钥，设置文件由本机系统加密保存。见 [配置说明](../docs/model-api-guide.md)。

详情页「AI 可读全文」现支持本机 MinerU 4.x 全文转换，输出 Markdown、结构化 JSON 和图片，不覆盖阅读笔记或 PDF 标注。首次使用需准备本机环境和下载模型，不上传 PDF。使用 `documents.environment` 检测环境，`documents.convert {id,tier?}` 提交单篇，`documents.get {id}` 查询状态及结果路径，`documents.cancel {id}` 取消。默认 basic，也可明确选择 standard 或仅文字层 flash；accepted 只表示已接收，须等待 succeeded。失败/取消保留旧结果，不能把旧 result 当成本次成功。迁移需包含每篇资料文件夹中的完整 `parsed/`；见 [MinerU 全文转换说明](../docs/mineru-guide.md)。

PDF 阅读器现支持离线高亮、下划线、颜色、评论与删除/撤销，标注和最近页码/缩放保存到 `library/papers/<资料文件夹>/annotations.json`，原 PDF 不变。此功能由桌面交互提供，尚无 AI 标注写操作；不要直接修改文件。复制完整文献库时携带每篇资料文件夹的 `annotations.json`（桌面复制已包含），详见 [阅读器说明](../docs/pdf-reader-guide.md)。默认软件打开的原文不包含软件中的新增标注，尚未实现带标注 PDF 导出或标注云同步。

阅读器支持多标签页，打开不同论文新增固定宽度的标题标签，长标题省略、悬停可看全名；同篇复用，可切换和单独关闭，标注、页码及缩放按论文独立保存。标签页管理仅提供桌面交互。

阅读器「AI」侧栏提供基于 AI SDK 的当前论文阅读 Agent。仅发送/重试时联网，主进程按论文 ID 绑定目录与工具，不接受模型提供其他论文 ID、任意路径或命令。工具可启动并等待 MinerU、读取当前论文全文/笔记/标注、关键词查找、列图、查看图和渲染原始 PDF 页面；相关文字和图片会发送至已配置模型，图像能力取决于模型。可停止，提供安全错误与资料引用。成功对话保存在当前论文 `chat.json`（上一版 `.bak`），可恢复并随库复制；草稿仍仅在本次运行内存中。打开面板和恢复记录不调用模型。聊天与这些工具仅用于桌面 IPC，不向本机 AI HTTP 接口公开；不修改原文、笔记、标注或其他论文。见 [模型配置与论文 Agent](../docs/model-api-guide.md)。

当前索引为版本 2，每篇论文以 `storageFolder` 关联 `papers/<资料文件夹>/`，文件夹创建后保持稳定，不随标题修改。`papers.get {id}` 增加 `directory` 返回当前资料文件夹的绝对路径，原 `pdfPath` 含义和操作参数不变；不要拼接标题猜测路径。详情「更多操作 → 打开资料文件夹」可直接查看。无 PDF 条目也有资料文件夹。

旧库在启动时自动复制升级：先备份原索引、暂存并 SHA-256 校验资料，最后原子提交新版索引，保留 ID、元数据、标签、评分、时间线及文件关联。原五类资料目录和 `library.pre-paper-folders-v1.json` 保留用于恢复，不自动删除；失败保留旧索引，可解决原因后重试。新版桌面复制只带当前索引及普通备份、完整 `papers/`（含额外普通文件）和 `sync/`，不再携带旧布局历史目录、升级备份或暂存。详见 [文献库布局与迁移](../docs/library-layout-guide.md)。

监控对账：先调用 `cloud.review {offset?}` 查看当前库差异及每页 20 条的旧网页订阅。
仅按用户明确范围调用 `cloud.reconcile {}`（以本库开关对齐，含暂停本库孤立订阅）、
`cloud.importLegacy {id,revision}`（转入所选旧订阅）或 `cloud.stopLegacy {id,revision}`。
id/revision 来自对账结果；不自动批量处理旧列表，不修改其他库或账户。
两端都需新版；转入请求持久化重试，停止旧订阅需联网。完整说明见 `docs/cloud-monitoring-guide.md`。

## 云端引用监控与个人首页

启动默认显示个人首页，统计当前整个文献库的论文、PDF、Markdown 笔记和监控数量。首页显示服务器最近成功抓取、本地最近完整同步、当轮去重后的新增引用、待同步开关和云端异常数量。未连接时明确显示缓存状态。

「同步概况」使用水平柱状图展示本库云端已确认、账户全部监控，以及分别展示待抓取和未完整更新；不把这些计数当作每日进度，也不通过减法推算成功数。新增引用、待同步开关和旧网页待处理用数字卡，抓取与同步时间单独显示。监控论文按去重数量计篇，旧网页订阅按条目计项，未知数据与零值分开显示，离线仍显示缓存。本次只调整桌面展示，`cloud.status` 等公开操作的字段和语义保持不变。

个人首页「云端引用监控」为紧凑卡片，显示连接状态及账户摘要；点击连接管理入口，在弹窗中填写 Paper Monitoring 的 HTTPS 地址、用户名或邮箱、密码，或管理已登录连接。登录表单不再常驻首页；立即同步、退出登录及旧本地监控迁移仍需明确操作。关闭弹窗不退出账户，不停止同步或云端任务。登录后本库绑定服务器和账户，换账户请使用另一个文献库。密码不保存；桌面会话由操作系统加密，放在本机用户目录，不能随 library 拷贝。换电脑后重新登录同一账户。退出登录只断开桌面同步，不停止服务器任务；网页服务概览可撤销设备会话。

详情中的引用监控开关保存个人订阅。服务器按所有用户的有效订阅合并总表，每天北京时间 08:00 开始依次拉取，论文之间默认间隔 10 秒；桌面运行且登录后约每分钟同步。离线开关保存在本库，显示待同步；关闭请求成功到达服务器后才生效。其他用户或文献库仍开启的订阅继续监控。旧版本已开启的本地监控不会自动上传，需在首页明确点击迁移到当前账户。

本地 OpenAlex / Semantic Scholar 抓取及定时器已移除。arXiv / Crossref 单篇元数据检索仍可使用。引用结果保存到 library/papers/<资料文件夹>/citations/citations.json，失败不会清空历史数据，不自动下载 PDF，也不自动运行 AI 分析或加入主列表。

桌面点击「被引数」可在独立标签中分页查看本地引用详情。每行「加入文献库」先显示含论文标题的确认框，点击「确认加入」后才将已有书目信息保存为未分类、待核对的无 PDF 文献；默认聚焦「取消」，取消或关闭不添加。操作离线可用，不自动检索或开启监控；已存在的论文显示标记并避免重复添加，保留原有文献资料。此功能不新增 AI HTTP 操作，`citations.get` 仍为只读查询。

AI 可用 cloud.status 查询无凭据的状态、cloud.sync 触发一次同步、citations.setMonitoring {id,enabled} 管理单篇开关，以及 citations.get {id,offset?,limit?} 分页读取本地记录。首次登录、退出和旧监控批量迁移由桌面界面提供。不要默认开启全部文献。开关保存成功不等于服务器已确认，须检查 pending / error。

复制文献库必须包含 library.json、完整 papers/ 和 sync/。sync/cloud.json 保存账户绑定、库编号和同步进度，不含凭据。复制同一库用于换电脑应停止旧电脑写入；不要在两台电脑同时修改同一个库的独立副本。界面复制会等待同步结束并校验文件。

测试使用隔离测试库，执行 node scripts/run.cjs test；云端连接流程见 docs/cloud-monitoring-guide.md。

Paper Timeline 提供版本 1 的本机接口。AI 可以发现可用操作、读取文献、提交任务并检查结果。接口与桌面界面使用同一份文献库和任务队列，修改会同步反映到窗口中。此接口不提供模型密钥管理、聊天或自然语言解析，也不是 MCP 服务。

## 入口

先打开软件，再在软件文件夹执行以下命令。`capabilities` 和 `help` 不要求软件运行；其他操作需要新版软件处于运行状态。

```powershell
./PaperAI.cmd help
./PaperAI.cmd capabilities
./PaperAI.cmd call app.status
./PaperAI.cmd call papers.list
./PaperAI.cmd call folders.list
```

`PaperAI.cmd` 优先使用随软件提供的运行环境，不需要另装 Node.js。如果只有源码而尚未打包，可使用已安装的 Node.js 执行 `node ai/cli.cjs ...`。不要把命令入口文件与 `ai/` 文件夹、EXE 分离。

`capabilities.json` 列出全部可用操作及 JSON Schema 参数规范。没有出现在清单中的命令不能调用。清单可离线读取，实际连接是否可用请查 `app.status`。

## 查找与重新检索

推荐将参数放入 UTF-8 JSON 文件，避免 Windows 终端对引号、中文和反斜杠的处理差异。带 BOM 的 UTF-8 也受支持。以下文件是模板，先复制到自己的请求文件并替换示例值。

```powershell
./PaperAI.cmd call papers.list --file ai/examples/find-papers.json
./PaperAI.cmd call metadata.refresh --file refresh-request.json
./PaperAI.cmd call papers.get --file paper-request.json
```

查询参数示例：

```json
{ "query": "Driving on Registers", "limit": 20 }
```

按标签查询示例：

```json
{ "tag": "视觉-动作", "status": "matched", "limit": 20 }
```

`tag` 按完整标签文字精确匹配，去除首尾空格且不区分大小写；相同文字的标签即使 ID 或贴边位置不同，也视为同一标签，颜色在全库统一。多个标签改用 `tags` 数组，可选 `tagMode: "all"`（默认，交集，须具有全部标签）或 `tagMode: "any"`（并集，具有任一标签）。例如 `{ "tags": ["视觉-动作", "单一网络"], "tagMode": "any" }`。重复名称只计算一次，空数组取消标签筛选。最多传 100 个标签，每个文字须为 1–80 字符，不允许全空白或控制字符。`tag` 和 `tags` 不能同时提供，`tagMode` 只能配合 `tags` 使用。

标签筛选结果再与 `query`、`status`、`folderId` 的条件取交集，然后分页；`total` 是筛选后的论文总数。省略 `tag` 和 `tags` 表示不按标签筛选。该查询不修改文献或标签。

检索与查询详情参数都需要从列表中获得真实 `id`：

```json
{ "id": "替换为列表返回的64位论文ID" }
```

检索返回示意：

```json
{
  "ok": true,
  "apiVersion": "1",
  "operation": "metadata.refresh",
  "result": {
    "id": "论文ID",
    "accepted": true,
    "alreadyProcessing": false,
    "status": "extracting",
    "poll": "papers.get"
  }
}
```

`status` 随处理进度变化，不能依赖提交时一定为 `extracting`。每隔约 1–2 秒查询这篇文献即可，长任务逐渐加大间隔。

| 状态 | 含义 |
| --- | --- |
| queued / extracting / searching | 等待、解析或检索中，尚未完成 |
| matched | 已匹配或已保存手动元数据；结合 source、matchMethod 解释结果 |
| review | 处理结束，但没有可靠匹配，需要核对 |
| error | 处理失败，查看 message |

本版本使用论文 ID 查询任务状态，没有独立的任务历史或任务 ID。重新检索会读取原 PDF 并可能替换当前元数据；手动元数据默认受保护。确实需要替换时使用 `{ "id": "...", "replaceManual": true }`。批量操作由调用方先明确范围、取得 ID，然后逐篇提交；目前没有默认操作全部文献的命令。

## 导入与修改

```powershell
./PaperAI.cmd call papers.import --file import-request.json
./PaperAI.cmd call metadata.update --file update-request.json
./PaperAI.cmd call folders.create --file folder-request.json
./PaperAI.cmd call papers.move --file move-request.json
```

导入参数使用绝对路径，可选 `folderId`；重复导入会跳过，保留原分类：

```json
{ "paths": ["D:/论文/example.pdf"] }
```

返回 `imported`、`duplicates`、`errors`、`paperIds`。`paperIds` 按成功/重复输入的顺序返回，失败文件不在其中，重复输入可能产生重复 ID。导入接受与后台识别完成是两件事，仍需查询状态。接口 `ok: true` 不代表所有文件均导入成功，必须检查 `errors`。

更新参数采用部分字段，不需要把整篇元数据写回：

```json
{
  "id": "替换为真实论文ID",
  "fields": { "publicationDate": "2025-04", "venue": "已核实的期刊名称" }
}
```

日期接受 `YYYY`、`YYYY-MM`、`YYYY-MM-DD` 或空字符串，年份自动计算。未列出的字段保留原值；修改标记为“手动”，摘要来源沿用现有手动保存行为。检索期间不能修改。文件夹均为平级，每篇文献只属于一个文件夹；`papers.move` 的 `folderId: null` 表示未分类。`folders.delete` 保留论文和 PDF。

## 彩色标签

时间线中右键点击论文卡片可选择「添加标签」，输入文字并选择背景色；右键点击已有标签可编辑文字、修改颜色或删除。按住标签沿论文框四周拖动，可调整贴边位置，标签始终与边框接触，松开后自动保存。标签文字、颜色和位置会保存在文献库中，重启后保留，元数据重新检索也会保留标签。

同一文献库内，同名标签统一使用一种颜色，名称去除首尾空格且不区分大小写。新增已有名称时沿用全库颜色，界面会显示并固定该颜色；只在名称不变时修改颜色，会同步更新全库同名标签，界面会提示此范围。改名只修改当前标签，改成已有名称时沿用目标名称的颜色，其他原同名标签保留。删除和移动仍仅针对指定论文上的指定标签。

旧库启动时会统一历史颜色冲突：同名标签采用出现次数最多的原有颜色，次数相同则按大写 HEX 字符串字典序选择，颜色统一存为大写。一次原子保存并保留上一版索引备份，失败不提交；标签 ID、文字、贴边位置及其他论文资料不变。没有需调整的颜色时不重写索引。

在文献详情（包括首页分类列表的详情）点击标签的删除按钮，或在时间线右键菜单选择「删除标签」，均先弹出确认框，显示标签文字与所属论文。默认聚焦「取消」；取消或按 Esc 不删除，确认后仅移除该论文的这一个标签，不影响论文、附件或其他标签。删除失败会保留确认框及错误提示，可重试；处理期间不重复提交。PDF/MD 文件标签不可删除。此确认仅用于桌面交互，下面的 `tags.delete` 接口仍按已授权的用户任务直接执行。

时间轴最左侧可以多选标签，标题右侧的开关向左为交集（默认，须同时具有全部所选标签），向右为并集（具有任一所选标签）。可拖动开关、点击两侧文字或用左右方向键切换。勾选即时生效，选择框保持打开，底部显示匹配论文数。标签列表支持名称搜索，搜索不会清除已选项；每项数量表示当前搜索、核对状态和文件夹范围内带该标签的论文数，零匹配的标签仍保留以便切换。取消全部勾选或选择「全部论文」取消标签筛选。该界面选择只影响时间线，不改变列表视图的范围或文献数据。

`papers.list` 与 `papers.get` 会返回论文的 `tags` 数组，每个标签为 `{id,text,color,position?}`；`position` 为 `{side,offset}`。没有位置的标签默认排在下边框；旧文献没有标签时可能省略 `tags` 字段。论文 ID 与标签 ID 不同，调用前先从查询结果取得真实值。

```powershell
./PaperAI.cmd call tags.add --file add-tag-request.json
./PaperAI.cmd call tags.update --file update-tag-request.json
./PaperAI.cmd call tags.move --file move-tag-request.json
./PaperAI.cmd call tags.delete --file delete-tag-request.json
```

新增参数示例：

```json
{ "id": "替换为真实论文ID", "text": "视觉-动作", "color": "#9AD4D6" }
```

`tags.add` 返回新标签 `{id,text,color}`；已有同名标签时，返回的 `color` 沿用全库已有颜色，可能与请求颜色不同。更新时传 `{id,tagId,text,color}`，返回保存后的论文（不含缩略图）并保留原位置：名称不变时请求颜色同步到全库同名标签，调用前须确保用户任务授权此修改范围；改名时只改当前标签，目标名称已存在则沿用目标颜色。删除时传 `{id,tagId}`，返回 `{id,tagId,deleted:true}`。这些操作均不联网，不改变核对状态、元数据来源或 PDF。

移动标签参数示例：

```json
{ "id": "替换为真实论文ID", "tagId": "替换为真实标签ID", "position": { "side": "top", "offset": 0.5 } }
```

`tags.move` 返回保存后的论文（不含缩略图），保留标签文字和颜色。`side` 只能是 `top`、`right`、`bottom`、`left`；`offset` 是 0–1 的有限数，横边从左到右、竖边从上到下，`0.5` 表示居中。位置使用边上的相对比例，论文框随标题调整大小后仍保持贴边。只接受这两个位置字段，不能传任意画布坐标。

每篇论文最多 32 个标签，文字去除首尾空格后为 1–80 字符，不允许控制字符，同篇不允许同名（不区分大小写）。接口文本参数本身也限制为最多 80 字符。背景色必须为六位 HEX，例如 `#7BC58C`；不能传 CSS 表达式或颜色名称。更新与删除使用标签的稳定 ID；添加请求若遇连接中断，先查 `papers.get`，避免重复添加。

## 多条独立时间线

界面底部的「新增时间线」先增加一个空白标签筛选方框。选择标签或点击「全部论文」后，这条线才显示对应论文；交集/并集条件与其他线相互独立。同一篇论文可显示在多条线上。拖动方框或上方的移动手柄会移动该线及其全部论文，垃圾桶仅删除该线，不删除论文、PDF 或标签。位置与筛选条件保存在文献库中，重启后恢复。全局搜索、核对状态和文件夹筛选仍作用于每条线。

- `timelines.list` 无参数，返回 `{timelines: [{id,tags,tagMode,configured,position}]}`。
- `timelines.create` 接受可选 `position: {x,y}`，省略时放在已有线下方，返回新时间线。新建时 `configured=false`，尚不显示论文；最多 100 条。
- `timelines.update` 传 `{id,changes}`，只修改 `changes` 中的 `tags`、`tagMode` 或 `position`，返回该时间线。提供 `tags` 会使 `configured=true`；空数组明确表示全部论文。标签最多 100 项，完整名称去除首尾空格、不分大小写、重复去重；每项 1–80 字符且不含控制符。
- `timelines.delete` 传 `{id}`，返回 `{id,deleted:true}`；允许删除最后一条线，下次启动不会重新补回。

位置是「标签筛选」方框左上角的画布坐标，与当前缩放无关。x/y 均为 -100000 到 100000 的有限数，支持向左、上方移动。筛选导致论文数量或框尺寸改变时，方框仍固定在该位置。新旧文献库兼容：没有时间线字段的旧库默认显示一条全部论文时间线，读取时不改写文件。

更新示例（先从 `timelines.list` 取得真实 ID）：

```json
{ "id": "替换为真实时间线ID", "changes": { "tags": ["视觉-动作", "单一网络"], "tagMode": "any", "position": { "x": 40, "y": 900 } } }
```

查看某条线匹配的文献时，先查其 `configured`，再把 `tags`、`tagMode` 传给 `papers.list`（未配置的线应视为空）。这些操作均不联网；新增请求遇到连接中断时先查询，避免重复创建。

## 返回、错误与环境

所有命令向标准输出返回一个 JSON 对象，成功为 `ok: true`，失败为 `ok: false` 并带 `error.code`、`error.message`；退出码分别为 0、1。发现错误后不要直接修改底层文件来绕过接口。

常见错误：`APP_NOT_RUNNING`（软件未启动或接口关闭）、`CONNECTION_FAILED`（会话失效或连接中断）、`INVALID_ARGUMENT`、`INVALID_JSON`、`UNKNOWN_OPERATION`、`NOT_FOUND`、`BUSY`、`MANUAL_METADATA`、`REQUEST_TOO_LARGE`、`OPERATION_FAILED`。网络断开/超时可能发生在写操作已提交之后；先查结果，再决定是否重试。文件夹创建不是幂等操作，重试前通过 `folders.list` 检查是否已创建。

```powershell
./PaperAI.cmd call app.status --library "D:/文献库/library"
```

`--library` 指向文献库本身，不改变软件使用的文献库。软件仍需在该库上运行。未指定时先定位源码/发布目录，再读取 `library-location.json` 跟随界面选择的位置；没有设置时使用默认库。`PAPER_TIMELINE_DATA` 指定独立的数据与设置根目录，默认库在其下的 `library/`，该根目录中的位置设置可指定其他库。

位置修改使用桌面顶部「文献库设置」：可选择已有库、复制当前库到空文件夹或新建空库，确认后自动重启。换电脑时复制完整文献库，再在新电脑选择它。现有 AI 操作不包含位置修改；`app.status` 始终返回实际使用路径。不要直接修改设置文件来绕过复制校验、任务等待和重启流程。

## 供程序直接调用

命令行是推荐入口，也可读取目标库的 `.ai-session.json`，向其中 `127.0.0.1` 与随机端口发送请求。请求头使用 `Authorization: Bearer <token>`；不要打印令牌。服务不支持跨域浏览器请求，带 `Origin` 的请求会被拒绝。

- `GET /v1/capabilities`：运行版本的能力清单。
- `POST /v1/call`，`Content-Type: application/json`，请求体为 `{ "operation": "papers.list", "params": {} }`。
- 参数格式和限制见能力清单；禁止未知字段。请求体上限 1 MB。
- 令牌每次启动更新，退出后清理会话文件。异常退出可能残留失效文件，重启会更新。
- 本接口信任能访问文献库会话文件的本机进程，不提供远程访问、账号体系或细分用户权限。`PAPER_TIMELINE_AI=0` 可在启动时关闭服务。

## 扩展接口

### 逐层定位文献资料

`app.status` 的 `aiIndex` 返回 `ready`、`entryPath`、`catalogPath` 和可能的 `error`。从文献库的 `AI-INDEX.md` 读取说明，再读取 `ai-index/catalog.json` 按真实 ID/标题/DOI/标签查找，最后读取对应 `index` 指向的单篇 `paper-index.json`。`papers.get {id}` 也返回该文件的绝对路径 `indexPath`。索引内部路径统一相对于文献库根目录；只把 `status=available` 的登记资料当作可读文件。个人 Markdown 笔记、精简笔记、MinerU 全文分别在不同字段，避免混淆。

索引自动维护，外部修改文件后可调用 `PaperAI.cmd call library.refreshIndex`；它只重建导航文件，不修改论文资料、不联网。即使接口返回成功，也应检查 `ready` 和 `error`。索引失败不撤销已经成功的主资料保存，不覆盖冲突文件；不能用索引授权读取、修改或上传用户未要求的内容。详见 [AI 资料导航](../docs/library-ai-index-guide.md)。

增加功能时把业务逻辑放在共享服务层，同时登记 `capabilities.json` 和公开处理函数，并补充参数/状态/数据保护测试。服务启动时会校验清单与处理函数是否对应。内置论文 Agent 已直接复用 Library 的解析能力，文件读取和聊天记录保持为桌面专用功能；未来接入 MCP 可继续复用服务，无需模拟点击。

### Markdown 笔记与表格阅读记录

通过 `notes.attach` 传论文 `id` 和本地 `.md` 文件绝对 `path`，文件会独立复制入库（UTF-8，最大 10 MB）。每篇一份，重复来源内容不会覆盖用户对库中副本的修改。通过 `notes.get` 查询库内路径；`papers.list/get` 中的 `markdownNote` 可判断有无笔记。详情支持选择文件添加，列表、详情及时间线中的 MD 入口在软件内打开「MD：论文标题」标签，与 PDF、引用详情及分类标签共存，同篇复用。

内置笔记可阅读、编辑和分屏预览。点击「保存」或 Ctrl/Command+S 写回该论文的 `notes.md`，切换/关闭、退出及复制库前先保存；失败保留当前草稿。上一版为 `notes.md.bak`，外部修改触发版本冲突保护，必须先保留草稿再明确重新读取核对，不强制覆盖。编辑不改变原始导入哈希、书目数据、PDF 或标注；缺失、链接或无效文件不会被空白笔记替代。界面保留「默认软件打开」。图片附件和 Obsidian 引用暂不加载，HTML 不执行，资源随软件分发；网页链接仅在点击时使用浏览器打开。该读写功能仅提供桌面 IPC，`notes.get/attach` 的公开参数及行为不变，没有增加 AI HTTP 笔记编辑操作。见 [内置 Markdown 笔记](../docs/markdown-note-guide.md)。迁移整个库时包含完整 `papers/`（含笔记及备份）、`sync/` 和 `library.json`。

`papers.setReadingRecord` 接收 `{id,record:{source,fields:[{label,value}]}}`，最多 32 个字段，每个值最多 30000 字符，保存外部 Excel 等来源的原始阅读记录。该操作替换阅读记录，保留论文检索元数据、标签、核对状态和 Markdown 内容。标签仍通过 `tags.add/update` 导入。

### 文件标签

列表的 PDF 列以红色图标打开原文，MD 列打开笔记。时间线自动生成 PDF/MD 文件标签，与论文边框保持接触，可拖动、点击打开，不提供编辑或删除，不计入分类标签和标签数量限制，也不参与标签筛选。

`files.moveTag {id,kind,position}` 保存文件标签位置，kind 为 `pdf` 或 `md`，position 为 `{side,offset}`（同 `tags.move`）。`fileTagPositions` 随论文保存，重新检索或复制文献库后保留；缺少文件时禁止移动。`papers.list/get` 的 `availableFiles` 是本次查询时检查的文件存在状态，不写入文献库。界面打开或刷新文献库数据时更新文件图标。

## 无 PDF 文献

顶部「添加文献」可凭标题创建条目，默认在线检索，原文与笔记可稍后添加。列表与时间线按实际附件显示文件图标；无附件的条目仍可筛选和排列。

- `papers.create {fields:{title,authors?,publicationDate?,venue?,doi?,arxivId?,abstract?},folderId?,retrieve?}`：title 必填；retrieve 默认 true，false 只保存为待核对。返回稳定 id、created、accepted。重复标题或编号返回已有条目，不覆盖原信息；请轮询至 matched/review/error。
- `papers.attachPdf {id,path}`：为无 PDF 的条目复制原文，保留元数据、标签、笔记及 ID，不覆盖已有附件；检索中请先等待。
- `papers.get` 对无 PDF 条目返回 pdfPath:null。存储中 pdfHash:null 表示无附件；省略表示旧版 PDF 哈希即文献 ID；补加原文后 pdfHash 保存内容哈希。始终通过接口操作。
- 在线未匹配成功时保留已导入信息，不把阅读概述当作原文摘要、不用导入时间替代发表日期。复制文献库仍需携带完整 library 文件夹。

## 论文评分

在文献详情的「评分」中点击第 1–5 颗星设置评分，点击「清除评分」恢复未评分。列表在「标签」后显示「评分」列，时间线在论文框内作者右侧显示黄色星星。同一篇论文在多条时间线上共享评分，评分随文献库保存、复制，重新检索元数据也会保留。

`papers.setRating {id,rating}` 设置评分，`rating` 只能是 1–5 的整数或 `null`（清除）。返回保存后的论文；`papers.list` / `papers.get` 的 `rating` 字段表示星级，未评分时省略。操作不联网、不修改元数据来源和核对状态，不要通过 `metadata.update` 修改评分。
