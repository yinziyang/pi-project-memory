# pi-project-memory

给 [Pi Coding Agent](https://pi.dev/) 用的本地项目记忆插件。帮 AI 查到项目规则、设计决策、开发步骤和排障经验，也让你把已验证的新结论整理成草稿，确认后留下。

精选 SQLite 是唯一真源，七类 Markdown 从当前知识生成，SQLite 关键词检索可直接使用，E5 + Chroma 语义检索按需初始化。
聊天归档默认关闭，不把会话原文、凭据或私库写入项目的公开知识。

## 安装

```sh
pi install git:https://github.com/yinziyang/pi-project-memory.git
```

安装后重启 Pi 或执行 `/reload`。从旧的本地安装迁移时，可用 `pi list` 查看旧安装来源，并用 `pi remove <旧来源>` 移除；如果原来靠 `-e` 加载本地文件，去掉该参数。不要同时加载两份。

本版在 Linux amd64 和 Pi 1.5.2 上验证。需要 Node 26.13.1 或更高版本、提供 `bun:sqlite` 的 Bun，以及可信 PATH 中的 `bun`、`python3` 和 `git`；Python 验收版本为 3.13.2。
语义搜索初始化另需已有 `uv` 和 Python 3.13。macOS 尚未验收。
Git 安装使用仓库自带的运行时产物，用户无需手动构建。公开分发走 GitHub，不发布到 npm。

## 项目如何启用

打开项目根目录并在 Pi 中信任该项目。插件只检查当前目录下已发布的 `.project-memory`，不会向上搜索；没有发布时可从 `/memory-draft` 的人工确认开始创建。
插件以会话 `ctx.cwd` 为项目根，不向上搜索，默认不读取会话历史，也不读取认证、模型配置或私有工作数据库。
可信 HOME 配置显式启用后，可有界采集当前会话分支的过滤文本并归档到独占私有 writer，配置、暂停接管与预算见 [自动私有归档](docs/automatic-capture.md)。
该 cwd 必须已由 Pi 判为可信项目，宿主公开目录及文件必须可信独占且不是符号链接。

读取需要固定的 `.project-memory/curated.json` 和同目录的 `knowledge.sqlite`，首次保存会生成这两项，不会把旧原型 `config.json` 或任意 SQLite 库自动转换成公开知识。
描述文件为至多 8192 字节的 UTF-8 JSON，只允许以下三个字段，其中 generation 必须替换为审核发布给出的 64 位小写十六进制内容代，而不是 SQLite 文件哈希。

```json
{"version":1,"project":"合成示例项目","generation":"审核发布生成的64位小写十六进制内容代"}
```

project 必须为非空有效 Unicode 字符串，不含 NUL，UTF-8 最多 256 字节。首次保存使用当前目录名，后续沿用已有发布的项目标识。
缺少文件、非法描述、未审核库、旧库、损坏或身份／内容代不匹配时工具明确不可用，不返回伪装为空知识的成功结果，也不回退旧代。
模型读取工具为 `memory_search` 和 `memory_read`，另注册默认不可用的 `memory_checkpoint`，仅显式启用私有采集并由可信宿主关联当前任务后才可提交五字段检查点与 revision CAS。
检查点只是未审核的私有来源自述，SDK 可能将工具参数写入原会话，不得提交秘密，关联与恢复契约见 [任务检查点](docs/task-checkpoints.md)。
默认不自动 capture，正式自动 owner 使用 assistant-local 角色归档及处理受限任务 IPC，不提炼、审核或发布，独立 archive-only 角色也不具有这些权限，不将全部知识塞入 system context。
只有当前项目可信且发布已通过校验时，模型请求才会看到 `memory_search` 和 `memory_read` 的工具声明，宿主显式停用的工具不会被重新启用。
搜索结果是不可信候选，读取只接受当前周期搜索返回的 UUID，保留 scope、分类、公开来源、公开证据和 v2 稳定引用。

## 初始化本地语义搜索

在可信项目中显式执行 `/memory-init`，它使用本机已有的 `uv` 和 Python 3.13，在专用目录 `~/.pi-project-memory/` 下载并校验固定版本的 E5，并安装锁定的 Chroma 虚拟环境。
该目录必须由当前用户所有，权限为 `0700`，且不能是符号链接。
如果此前因 `~/.local` 是符号链接或其下目录可被同组用户写入而报 `INDEX_INSTALL_UNSAFE_PATH`，更新插件后再执行 `/memory-init` 即可跳过这条旧路径，无需修改 `~/.local`。
旧安装目录不会被迁移或删除，旧目录里的模型也不会被自动复用。
执行后 Pi 会立即提示已开始初始化。首次安装需下载约 470 MB 的 E5 权重并安装 Chroma，请等到完成或错误提示再查看状态。
再次执行会验证并复用已完整安装的健康资产，不覆盖损坏的现有资产。未下载完整的单个文件会重新下载，不从临时文件断点续传。
初始化成功后，本用户打开任何可信且已有有效 `.project-memory` 发布的项目时都默认启用向量检索，各项目索引独立，不预扫项目。
`/memory-status` 分别显示用户级安装和当前项目索引状态，`not-initialized` 表示尚无成功安装回执，即使部分文件已经下载也不算完成。
没有连接私库时会显示「私有库未连接」（`PRIVATE_NOT_ATTACHED`），不影响使用已有的公开知识。
普通目录没有发布时，插件不会弹出启动警告，也不会向模型提供项目检索工具。
如果已有发布但无法读取，插件仍会提示错误。
未初始化语义搜索仍可使用 SQLite 关键词检索，但当前项目需要已有有效的知识发布。
显式索引配置仍优先，`enabled: false` 可关闭本用户默认启用，详见 [当前读取运行时](docs/current-reader-runtime.md)。

## 日常使用与场景

| 场景 | 用法 | 结果 |
|---|---|---|
| 接手项目、查询约定或排障 | 在有有效发布的可信项目内提问 | AI 可用 `memory_search` 找候选，再用 `memory_read` 核对正文、范围和证据。建议对照前三条，不把排名当作事实。 |
| 某个结论已验证，值得留下 | 在可信项目空闲时输入 `/memory-draft` 或单独说「开始提炼」 | 当前会话模型给出草稿，列证据、必要代码、拟存放路径和新增／更新／失效建议。没价值或证据不足就说明原因。 |
| 检查语义搜索 | 执行 `/memory-status` | 分开查看安装状态、当前发布和索引状态。 |
| 恢复一项未完的私有任务 | 显式启用私有采集后使用 `/memory-task` | 恢复可信命令选中的检查点，不把进度当作公开知识。 |
| 暂停私有归档并手动接管 | `/memory-capture pause` | 实际关闭自动写入进程后才允许手动接管。 |
| 维护当前公开版本或索引 | `/memory-refresh`、`/memory-refresh pause` 或 `/memory-refresh index` | 分别用于重载发布、停读或显式修复索引。 |

草稿入口不调用额外模型、不启动子代理、不读取或另存历史。
本轮回复仍受 Pi 自身会话保存和工具权限约束，不是文件系统沙箱。

在可信项目的交互界面输入 `/memory-draft` 或单独说「开始提炼」，当前模型返回可提交草稿后，Pi 用 Markdown 展示定稿并请你确认，无需审核或复制 JSON，也无需另输保存命令。
提炼后的知识及其证据不应保存源码或测试文件名、路径、行号，也不应以链接替代这些定位信息。
只有能帮助下次做判断、采取行动或避免错误且有证据的内容才值得提炼，不复述 README、一次性修复过程或测试流水账。
证据应说明验证场景、操作、预期和实际结果，必要时可保留不依赖文件位置的短代码示例。
导出的 Markdown 先展示结论和要点，再展示适用范围与验证方法，不逐项展开 SQLite 字段。
插件会拒绝草稿中常见的源码定位写法，其余内容仍需人工核对。
使用旧知识时，若需定位实现，应重新检查当前工作区，核实冲突后更新同一条知识。
确认后，插件将选中的条目整批保存到当前项目的 `.project-memory/knowledge.sqlite`，并从同一份 SQLite 生成 `.project-memory/md/`。
首次保存会创建发布，不需要私库绑定，不开启聊天归档，也不提交或推送 Git。
新增使用 `expectedRevision: 0`，更新沿用已有知识 ID 和当前修订号，未选中的知识保留原样。
发布代或条目修订发生变化时拒绝覆盖，结果未确认时先核对实际发布，不重复提交或删除暂存文件。
直接保存限可信的 Linux 本地项目目录，能否写入由当前用户实际执行文件操作的结果决定，不按项目根目录的属主或权限数字预先拒绝。
协作锁不能约束其他账号或外部程序直接修改目录，请不要在不受信任的共享目录中使用直接保存。
同一个项目的 Pi 窗口需安装新版并退出重开，才能参与协作停读，旧版本或外部非协作读取程序须先关闭。
有其他协作窗口正在读取时，先在这些窗口执行 `/memory-refresh pause`，再重新提炼并确认保存。
私有归档与 [独立可信写宿主](docs/authoring-host.md) 是另外的工作流，不需要为直接保存配置。

无需手动开启或登记验证提醒。
可信 Pi 验证扩展可在一轮实际核验完成后发送 `local-project-memory.verification-receipt.v1`，字段为当前 `cwd`、`sessionId` 和稳定证据的 64 位小写十六进制 `digest`。
插件在本轮正常结束时最多提醒一次，同一会话的重复凭据不重复提示。
普通测试命令、退出码或模型自评不会自动产生凭据；没有可信凭据的项目不提醒。
提醒不调用模型、不采集或落库，也不代替证据核验。

## 显式更新与恢复

1. 宿主执行 `/memory-refresh pause`，等待命令完成并确认没有安全错误，此时旧工具周期已停服并回收。
2. 可信写宿主执行 `pause-confirmed` 持久停用，再按完整协议失效旧状态、审核并发布 SQLite／七类 Markdown／描述整套快照，不手工散件替换，也不允许模型替代审核。
3. 宿主执行无参数的 `/memory-refresh` 安装当前发布，失败保持不可用。

命令仅接受空参数、固定的 `pause` 或 `index`，不接受项目、路径或内容代参数，模型工具不能获得事实审核或发布权限。
`index` 仅供可信宿主显式修复派生索引，坏 matching 索引不会因普通查询而回退放行，配置与取消契约见 [当前读取运行时](docs/current-reader-runtime.md)。
SDK 会记录部分命令处理器错误后继续，脚本宿主必须检查 SDK 错误回执，不能仅凭 prompt 正常返回认定暂停或刷新成功。
Pi 的 reload、new、resume、fork 和 shutdown 生命周期负责先清理旧实例，新的 session_start 重新校验发布，旧候选 UUID 不跨周期或项目恢复。
桥启动／安装共享 5000 毫秒预算，请求为 10000 毫秒，停止先 TERM、200 毫秒后 KILL、再最多等待 1000 毫秒实际 close。
5000 毫秒不包含生命周期排队、旧桥回收、前置描述文件 I/O 或故障诊断 I/O，不是整个 session_start 的总时间保证。
进程回收未知时保留所有权并阻止替代 worker，不以 Promise.race 提前返回冒充资源停止。
完整描述、分发取舍及验证边界见 [只读插件切片](docs/curated-plugin.md)。

## 宿主私有诊断

故障安全快照写到宿主 HOME 下固定的 `.local-project-memory-diagnostics/curated.json`，独立目录权限必须为 0700，文件权限必须为 0600，现存符号链接、不符权限、非本人文件或非普通文件均拒绝。
最多保留最近 32 条且整个 JSON 不超过 32768 字节，只保存白名单机器码、阶段及 bridge 的 PID、exit、shutdown、cleanupErrors、retainedResources，不保存原始异常、stack、私有路径、知识正文或密钥。
目录与文件不参与公开 descriptor、SQLite 或 Markdown 导出，也不写入 session，模型工具不能选择诊断路径或读取此出口。
confirmed-close 但关库／退出存在异常时仍记录诊断，不伪报活资源或阻止宿主发布。
落盘失败通过固定安全码 `PRIVATE_DIAGNOSTIC_WRITE_FAILED` 明确反馈，工具停用，原安全故障及写失败记录在有界内存中保留，后续生命周期重试，不假称诊断写入成功。
诊断等待固定最多 1000 毫秒，超时或取消返回 `STOP_UNCONFIRMED`，不表示底层 I/O 已停止。
快照通过原子替换交付，多个 Pi 进程同时使用时以最后成功写入者为准，不是完整跨进程审计历史，也不承诺掉电持久性。
控制停服及进程回收先于诊断落盘，未确认的实际任务、句柄及临时文件跨 reload 保留，同一时间最多一项在途写入，实际完成前拒绝新写。
底层文件系统操作仍可能无法抢占，晚回执仅继续自有清理，不恢复已取消的正文写入或安装，也不把有界等待失败说成已关闭。

## 命令速查

| 命令 | 作用 |
|---|---|
| `/memory-draft` 或单独输入「开始提炼」 | 使用当前模型起草，选条目、预览并经人工确认后保存到项目的 `.project-memory/`。 |
| `/memory-status` | 查看项目发布、私库和本机语义索引状态。 |
| `/memory-init` | 安装或复用本机的 E5 和 Chroma。 |
| `/memory-refresh`、`/memory-refresh pause`、`/memory-refresh index` | 分别重载发布、停读和显式修复向量索引。 |
| `/memory-capture status`、`/memory-capture pause` | 查看或暂停显式启用的私有归档。 |
| `/memory-task new`、`status`、`unlink`、`select <ID> <revision>`、`resume <ID> <revision>` | 管理私有任务关联，须显式配置私有采集。 |

`memory_search`、`memory_read` 和 `memory_checkpoint` 是模型工具，不是斜杠命令。

## 开发与源码

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Git 安装入口为 `dist/curated/pi-extension.mjs`。`dist` 由 `scripts/build-curated.mjs` 从 `src/` 生成，不依赖开发机的验证目录。
Claude-Mem 衍生产物的来源和许可证见 [搜索模块](src/curated/vendor/NOTICE.md)和[写入模块](src/authoring/vendor/NOTICE.md)。
完整验证夹具、模型资产和本地证据日志不随公开仓库分发。

## 当前验证范围

下列五套与13项记录属于此前核心闭环验收，不代表当前 N01–N06 最终组合已经全部通过，当前状态见 [剩余能力](docs/remaining-work.md)。
正式入口已通过真实 DefaultResourceLoader、extension runner、AgentSessionRuntime 和纯本地机械合成 provider 的 13 项检查，包括干净离线 consumer 的构建／导入及实际 Bun 查询、跨代刷新、reload、新 session、跨项目 switch、实际 signal 取消、启动失败、安全不可用及私有诊断。
测试只在隔离 HOME/cwd 中生成合成项目，不访问真实模型或网络，不代表远端模型实际调用或通用事实审核能力。
当前验证平台为 Linux amd64，未验收 macOS、真实 OS kill/wait 故障或多进程发布广播。
可信写宿主提供手动批准输入、后台生成、私有候选审核和整套发布入口，使用方式与责任边界见 [写宿主说明](docs/authoring-host.md)。
此前核心闭环的生产 SDK 适配仅用真实 SDK 合成 provider 与内存认证离线验证，后续 N06 两批十条真实合成调用已独立执行与对账，保留分类错配及自然 facts 未定，不冒称语义全面通过。
此前核心闭环的主代理独立五套检查、23 个外层 runner 及串行只读复核已通过，完整结果和有意保留的边界见 [最终方案与验收记录](docs/1.md)。
