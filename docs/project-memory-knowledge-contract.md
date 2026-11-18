# 项目知识准入、更新与 Markdown 导出契约

## 状态与适用范围

本文记录用户确认的准入与更新约束，当前实现总览和完整证据见 [`docs/1.md`](1.md)。
正式只读插件、可信写宿主的批准输入、后台生成、输出审核、整套 SQLite／Markdown 发布、刷新与重启恢复已完成本轮限定核心闭环验收。
主代理从最终源码独立执行五套检查均退出 0，154 个代码文件摘要前后无变化，23 个外层 runner 实际回收，原 reviewer 串行只读复核已关闭本轮 P1／P2，在限定范围内未发现新的确认阻碍。
结构与摘要检查不能替代宿主对实施证据真实性、结论对应关系及公开去敏的审核，本轮不提供通用自动事实核验，也没有追加真实模型请求。
本文后续历史切片记录保留各阶段当时的状态，不能用其中的旧待办替代当前总览，也不能将本轮通过扩大为所有平台、真实模型质量或旧草案全部功能均已验收。
相关术语见根目录的 `GLOSSARY.md`。

## 用户确认的要求

- 必须能够导出 Markdown，供人按目录直接阅读。
- 未经实施验证的内容不能提炼为项目知识，避免错误信息进入知识库。
- 项目情况和设计决策必须能够更新，同一主题不能只按会话时间不断追加。

## 知识准入

提炼输入必须先筛选到已经实施且具有对应验证依据的内容，不能把讨论中的计划、建议或尚未验证的修改送入知识提炼流程并作为候选知识积累。
未实施方案和排障猜测可以留在私有原始会话中，但不作为项目知识入库、索引、导出或发布。
模型响应只是待检查的输出，不因 JSON 合法、分类成功或模型声称“已验证”就成为知识。
只有结论得到证据覆盖且通过准入检查，才能建立知识条目。
无法判定的结论必须拒绝准入或等待人工核验，不让同一个模型的自评替代验证。

每条准入知识必须关联以下依据。

- 实际落地的对象与适用范围，例如相关实现、配置和对应版本。
- 实际执行的验证方式和结果，以及可追溯的验证记录。
- 结论与证据的对应关系，不能把局部测试通过扩大为整个功能、平台或部署环境均已成立。
- 涉及设计理由时，理由必须来自明确的决策来源，不能由模型根据代码猜测补齐。

仅提出方案、口头同意、写完代码但尚未验证、模型总结说“测试通过”，均不满足准入条件。
实际静态核验只能证明其覆盖的事实，不能冒充行为、集成或运行验证。
仓库文档和会话中的断言本身不自动构成验证证据。
失败经验也必须有实际复现或排查依据，修复方法必须另有修复后的验证，不把猜测写成根因。

## 更新与失效

知识按稳定身份和明确主题维护，标题、分类或表述变化不应自动产生另一条重复知识。
同一主题出现新内容时，先判断它是补充事实、替代结论还是尚未解决的冲突，不能仅凭时间更晚就覆盖。
新的实施及验证结论明确取代旧结论时，更新当前条目并保留修订关联，旧版本不再参与默认检索或当前 Markdown 导出。
只有新建议而没有新实施验证时，不产生新的有效知识，也不能据此把旧结论改成建议方案。
如果旧结论的实施或适用条件已经改变，即使新结论尚未验证，也应将旧知识标为待复验并撤出默认结果，不能为了保留一个答案而继续展示已知失效内容。
影响判断依据明确关联的来源和适用范围，不声称能够自动发现所有跨模块影响。

当前正文、有效状态、验证依据和替代关联必须一致提交，失败不能留下两个互相矛盾的当前版本。
检索索引是派生数据，索引更新滞后时仍须依据当前有效状态及版本过滤候选，不能把旧索引中的已替代正文直接当作当前答案。
完整修订历史用于私有追溯，不默认导出成每日流水账，也不因更新需求而发布原始会话。

## 存储与 Markdown 目录

SQLite 继续作为精选知识的唯一数据源，Markdown 是可重新生成的阅读视图，不建立双向编辑同步。
正式发布使用固定 `curated.json` 选择当前 SQLite 发布，不使用旧 Markdown 原型的 `config.json`。
七类 Markdown 目录、首页以及 SQLite／Markdown／descriptor 整套发布和暂停后刷新已完成合成闭环验证，不表示真实 Chroma 自动重建或跨进程热发布已完成。

```text
.project-memory/
├── curated.json
├── .publication.json
├── knowledge.sqlite
└── md/
    ├── README.md
    ├── 项目概况/
    ├── 领域规则/
    ├── 代码导航/
    ├── 开发操作/
    ├── 设计决策/
    ├── 排障经验/
    └── 项目约定/
```

分类目录下使用稳定知识 ID 命名文件，在正文中提供可读标题，不把每次聊天或每次提炼生成一个新文件。
导出首页提供分类目录和知识标题链接，每条正文包含知识身份、当前修订、适用范围、验证依据及可公开的来源引用。
同一知识更新时更新对应文件，分类变化时移除旧位置的受管导出文件，不能在多个目录留下互相矛盾的当前版本。
待复验和已替代知识不留在默认当前目录中，必要的状态提示不能继续展示其旧正文为有效结论。

导出范围只能来自精选知识投影，不能顺带写出私有会话、完整模型响应、凭据或机器绝对路径。
私有来源不应伪装成其他使用者可访问的公开证据，缺少可发布依据的内容不能被标为已获独立公开验证。
导出必须记录所依据的知识快照，失败不能报告成功或把半份内容标为完整快照。
只允许管理明确归属导出器的文件，未知文件和检测到的手工改动必须报告冲突，不静默覆盖或删除。
本轮需求是供人阅读，手工修改 Markdown 回写数据库不在当前范围内。

## 持续准入要求与验收边界

- 仅讨论、仅同意、仅实施未验证和伪造“验证通过”文字的内容均不产生可检索或可导出的知识。
- 已实施并具有实际验证依据的结论能够提炼、归类、入库、导出，并通过 Pi 检索读取全文。
- 模型输出超出证据范围或捏造来源时拒绝准入，不能只通过结构校验。
- 同一知识更新后稳定身份保留，默认查询和 Markdown 只展示新修订，重复处理不增加副本。
- 旧实现失效但新实现尚未验证时，旧知识进入待复验状态，新方案不作为有效结论展示。
- 索引尚未更新时，旧的已替代记录仍被过滤，不能在检索与 Markdown 中出现不同的当前结论。
- 导出中断、源快照变化或检测到手工修改时明确失败，不破坏此前确认有效的导出内容或用户文件。
- 导出结果不包含原始会话、私有模型响应、凭据和本机私有路径。

此前模型样本只证明在合成输入上的提炼表现，不能反过来充当该输入所述项目规则已经实施验证的证据。
本轮已经通过的核心闭环及未覆盖事项见 [`docs/1.md`](1.md) 和 `../validation/project-cm/README.md`，持续要求仍依赖可信宿主实际执行，不因契约或测试存在就成为通用自动事实保证。
主代理最新独立证据为 `../validation/project-cm/authoring-review-main-final-checks.log`，下列分切片进度按历史顺序保留，其中“尚未完成”描述的是各切片当时状态。

### MD 阅读视图第一切片进度

本地验证实现位于 `validation/project-cm/markdown-export.mjs` 与 `markdown-swap.py`，尚未切换正式插件或接入模型前 gate、自动事实验证及检索全链。
发布时绑定完整公开投影及有序当前集合的 SHA-256，导出时验证既存绑定，不以临时计算摘要冒充历史审核。
七类目录和稳定 ID 文件已实现，同一快照幂等、修订覆盖、分类迁移与全部失效清空当前正文均有行为测试。
输出为固定真实目录，Linux 本地文件系统使用 `renameat2` 首次不覆盖安装和非空目录原子交换，合作式目录锁与源 `BEGIN IMMEDIATE` 覆盖交换过程。
调用方必须可信独占父目录及源路径，源库需要写权限，库入口必须置于有界进程组隔离内，本文不承诺同 UID 恶意替换防护、跨平台或掉电恢复。
归属 manifest 只证明派生树当前完整性，不能替代宿主准入审核，手改、缺失、未知内容、symlink 和特殊文件均拒绝覆盖。
已有 32 项导出测试、20 项 curation 回归及交换前后 TERM／SIGKILL 四项握手恢复验证，细节和可复跑命令见 `validation/project-cm/README.md`。
合成格式样例为 `validation/project-cm/markdown-example/README.md`，仅展示合成加法 fixture 的公开输出，绝非本项目真实规则的自动验证结果。
尚未穷举资源 I/O 故障和所有生成中断点，也未完成生产宿主取消集成。

本地串行复审另修复了源事务释放错误覆盖发布状态及测试夹具提前删除两项生命周期问题。
ROLLBACK 失败保留已知发布 outcome、快照、helper 原错和独立清理错误，借用源连接仍由调用方负责确认释放，不能据清理异常推定发布未发生。
内部中断测试夹具只在 runner 的 TMPDIR 下创建并保留，外层已有总预算和子收割器在整组停止后统一删除，不支持裸跑内部测试。
Python 验证现为四项原子交换中断恢复加两项 kill／wait 清理失败保留夹具的回归，合计六项通过，真实测试子进程均由 guard 确认回收。

### 提炼输入登记底座

`validation/project-cm/distill-input-gate.mjs` 已实现私有宿主登记、精确批准字节读取、来源及当前实施对象快照绑定、幂等冲突处理和显式永久撤销。
主代理从最终源码独立重建后通过 34 项测试，串行复审确认摘要前的来源类型及无损读取问题已关闭，可构建红记录为旧实现 24 pass、10 fail。
加载只返回批准字节及必要身份，不返回原始会话、证据引用或审核者，事实真实性、证据对应和公开去敏仍由可信宿主负责。
### 实际发送边界的 medium 切片
`loadApprovedInput` 现要求精确四字段 `{project, approvalId, sourceId, snapshot}`，其中 sourceId 必须为正安全整数并与批准元数据精确匹配，旧三字段调用明确拒绝。
LocalWriter 由同一 owner 连接初始化 gate，可信宿主通过 `selectApprovedInput(jobId, {approvalId})` 将 queued 且尚无 attempt 的任务绑定到唯一批准ID，选择不是批准，同选择幂等、异选择冲突，不支持静默覆盖。
选择表不复制原文，需变更选择时本切片要求新来源任务或后续显式CAS重绑协议。
实际 dispatch 使用 job.source_id、所选批准ID及可信宿主提供的 project/currentSnapshot 加载 gate，缺少上下文、无选择或批准拒绝均不发HTTP、不登记attempt，任务保持queued。
最终加载、状态登记与fetch调用之间无await或宿主回调，HTTP正文只来自approvedBytes，已删除raw回退。
before_send屏障发生在最终加载前且无attempt，request_started屏障发生在fetch调用后，不承诺请求已经到达或交网后仍可撤回。
只将自有GateError归为普通批准拒绝，SQLite故障和事务清理AggregateError传播给统一收尾，不继续消费未知连接。
worker默认无审批回调且无可信当前上下文，因此拒发，每轮候选最多尝试一次，只有新capture或显式wake/consume才触发新一轮，重开不自动消费queued。
固定合成测试wrapper执行sum(2,3)并核对独立常量5，只批准固定BOM和非BMP正文，不将source、模型响应或verified/review转为审核证据，也不暴露审批RPC。
生产快照生成、自动失效触发、真实事实验证及legacy SDK闭包派发入口仍未接入，本切片不代表整条生产筛选链路完成。

主代理从最终源码独立重建并通过 gate 41 项、LocalWriter 10 项、Pi source 1 项、Pi capture 3 项，以及异步 SDK 正常场景和五组故障场景，全部外层 runner 均确认回收。
原审核 20 项、Markdown 32 项、中断与回收 6 项、根 14 项及类型检查也已独立复跑通过，具体计时和日志见验证 README。
新增宿主回调数据库故障由停止接收、取消在途任务及统一关闭处理，不再仅回复错误后继续接收，串行复审已关闭该问题。
命令输入及尚未操作数据库的源读取错误仍可恢复，数据库写入、读取及宿主回调运行故障不能被降为普通命令拒绝。
apply 现在也通过 job.source_id 取得实际来源，异编号场景已验证到 applied 和原来源时间，不以派发正确替代后续归属正确。


## curated public reader 与 Pi v2 合成切片

`validation/project-cm/current-curation.mjs` 的 `readCurrentCuration(db,{project})` 共用完整 manifest、字节投影、修订、证据摘要、有序全集及唯一 observation 映射校验。
Markdown 保留自己的事务、目录锁和 Python 交换责任，reader 保留自己的只读连接责任，不把 SQLite 文件 SHA 当成 generation。

`createCuratedPublicReader({project,dense})` 从不可用状态开始，仅由 `install({publicPath,generation,signal})` 安装严格 `curated-current` 公开库。
路径及父目录必须由可信宿主独占，不防御不合作文件替换。
`search({query,topK,signal})` 返回同一 project/generation 的候选，`read({source,signal})` 只接受 `{version:2,project,generation,knowledgeId,revision}`。
任一身份不匹配均为 `STALE_REFERENCE`，要求重新搜索，即使稳定标识与 revision 未变也不跨 generation 重用引用。
相同公开内容 snapshot 重复发布可保持同一 generation。

关键词策略 `sqlite-current` 复用现有 `SessionSearch(db,{readOnly:true})`，包括其 FTS、中文 substring 与 any-term 支路，不保证每次均为纯 FTS。
构造仍执行 schema 兼容校验及临时 schema 探针，不修复公开库 FTS 表或切换 journal mode。
dense adapter 只提供稳定候选身份，不提供可信正文，匹配 generation 才可恢复 `current-dense`。
缺失或不匹配 index 在水合前丢弃全部 dense 身份并返回 `INDEX_MISSING` 或 `INDEX_GENERATION_MISMATCH`，显式使用当前 SQLite 关键词检索，不把 index 故障伪装为空库。
匹配 index 的执行故障明确失败，不隐式降级。

可信宿主必须先 `await reader.transition()` 停止旧代服务及取消并等待在途工作，再修改私有精选状态、发布新库并安装新代。
安装失败保持不可用，不回退旧代。
没有 watcher，不自动发现私有失效，宿主若绕过上述顺序，失效至下一次显式 transition 的窗口由宿主负责。
已经返回的摘要不可追回，切代之后旧引用的 read 会拒绝。
本切片不承诺多进程原子广播或 SQLite、Markdown、Chroma 多资源原子热发布。

reader 拥有 SQLite 连接，dense 引擎归调用方所有。
公开异步操作使用合作取消，transition 等待 adapter 实际 settle 后才关连接，close 可重复执行。
关闭失败汇总 cleanupErrors 与 close-unconfirmed 资源，不声称释放成功。
同步 SQLite 无法抢占，正式读取必须通过 Node bridge 的有界专用 Bun worker，不可放在 Pi 主事件循环直接承担生产查询。
验证另由 run.py 提供外层有界进程组收割，不把测试 runner 当作正式插件的运行时依赖。
不合作 adapter 的兜底是外层隔离预算，不是 Promise.race 假停止。

`pi-tools.mjs` 的默认 `createMemoryTools({reader,project,...budgets})` 为 v2 直连 adapter，仅候选 UUID 可 read，不接受任意 rowid，也不自动兼容 v1。
reader 选择当前代，Pi adapter 负责参数、scope、字节预算、deadline 和取消。
旧 HTTP v1 工具仅由 `pi-tools-legacy.mjs` 的 `createLegacyMemoryTools` 提供，旧协议探针显式导入该工厂。
本切片没有新增生产 HTTP v2 服务，旧 HTTP scope 六项仍作为 legacy 边界验证，不代表 v2 HTTP 上线。

本轮证据仅为宿主实际执行独立常量真值表的 toy canCancel 规则及两代公开发布，覆盖修订、撤销、rowid 碰撞、跨代引用、受控 dense 握手和取消。
未接触真实业务、真实会话或认证原文，没有自动真伪审核。
未运行真实 E5、Chroma 重建、模型下载及旧 domain22，q04/q10 与历史质量红门禁保持不变。


### Review 修复后的严格公开边界

Pi v2 的所有公开 execute 异常只提供固定 code 和安全 message，STALE_REFERENCE 明确要求重新搜索。
公开对象不带 cause、originalError、cleanupErrors、retainedResources、原始消息、stack 或 Bun 的 sourceURL 等路径属性。
工具边界不记录私有诊断，也不把内部异常转写为敏感日志。
reader owner 仍保留原错、cause 及清理诊断，生产宿主负责在私有受控边界接管诊断和资源处置，不得把 owner 异常直接暴露给模型或公共工具调用方。
实现没有引入新的诊断框架。
used_strategy 只允许 sqlite-current、current-dense，degradation 仅允许缺省或 INDEX_MISSING、INDEX_GENERATION_MISMATCH，其他值明确协议失败。

匹配代 dense 返回非法 candidate 格式时整次报 DENSE_PROTOCOL_ERROR，格式合法但 project、generation、knowledgeId 或 revision 不匹配时整次报 DENSE_CONTENT_MISMATCH。
不再把非法 candidate 静默过滤为正常空结果，不扩大 index 故障的 fallback 范围。
合法空数组仍是正常 current-dense 空结果，合法候选保持原顺序并去重。
当前 SQLite 分支按 SessionSearch 返回顺序水合，不以稳定标识字典顺序重新排序，原先 topK 成员选择不因此改变。

search 的 query 必须为非空且有效 Unicode 字符串，UTF-8 不超过 2048 字节，topK 默认 5，允许整数 1 至 10。
transition 的 signal 在进入及完成回收后检查，不会提前返回而遗弃仍在 settle 的 adapter，预算兜底仍是 run.py 隔离。
close 先停止服务并取消、等待在途任务，再关闭拥有的 SQLite，重复调用安全，失败保留未确认资源并允许再次 close 重试，不代关借用的 dense。
install 原失败且清理再失败时同时保留 originalError、cause、cleanupErrors 和 retainedResources，未确认资源阻止下一次 install。

合成示例现在实际执行 toyV1 与 toyV2 两份实现，在同一个 pending 输入上用独立常量期望分别验证 true 和 false。
scope、facts、narrative、publicSummary 及公开 source version 与执行点一致，只证明这些合成验证点，不宣称完整真值表或真实系统业务正确。
close 测试仅对测试独占路径对应连接的公开 close 边界注入故障，并在 finally 恢复，不代表操作系统 SQLite 故障已被真实复现。


### 公开检索语义投影补全

原三项隐私、dense 协议和排序 review 已关闭，只说明该范围通过，不代表当时已覆盖公开知识全文的语义完整性。
追加复核发现适用范围和公开依据在工具边界丢失，本轮单独建立 red 后修复，不用旧通过结果替代本项验证。

reader 的 read 同时返回 publicSource 公开来源字符串和 source v2 稳定引用，两者用途不同，不再让稳定引用覆盖唯一可读的公开来源。
reader 与 Pi search 候选均保留 scope，不在搜索响应中加入完整证据。
Pi read 白名单保留 scope、category、publicSource 和 evidence，不透传整个 row 或 reviewer 等私有字段。
scope、publicSource 必须为非空有效 Unicode 字符串，category 必须属于当前七类，evidence 必须为非空且元素均为非空有效 Unicode 字符串的数组。
校验可以检查空白，但不会 trim 重写通过校验的字段，BOM 及原始公开字符串保持不变。
工具不新增自动事实判断或敏感词过滤，已批准的 public-safe 来源内容按原值传递。

read 可读 text 同时包含适用范围、分类、公开来源和公开证据，不能只在 details 中补字段而仍输出脱离限制的正文。
bodyBytes 预算覆盖新增字段参与构造后的整个 text，responseBytes 继续限制完整后端响应，各失败仍通过固定安全错误投影公开。
纯 knowledge-categories.mjs 协议常量被发布端及工具端共用，knowledge-curation.mjs 的 CATEGORIES 导出保持兼容，Pi 工具导入不依赖 bun:sqlite。
Node 无服务检查实际导入默认工具并验证语义保真、错误边界和完整正文精确字节预算，不依赖仅在 Bun 下运行成功。

真实 curated SQLite 闭环的合成 GET 示例执行 GET/current 与 POST/current 两个输入，并与独立常量 true、false 比较，只证明该合成实现的这两个验证点。
Node fake reader 只验证协议和语义保真，不是 GET 事实审核证明，已有 toyV1/toyV2 同 pending 的执行证据保持不变。

### 本切片最终验收边界

主代理从最终源码独立构建并通过当前检索 29 项、Node 默认工具语义 3 项、legacy HTTP 6 项，以及既有派发、审核、Markdown、根测试和类型检查，记录见 `../validation/project-cm/curated-main-semantic-final-checks.log`。
串行只读最终复核关闭了公开语义投影 P2，并确认原公开异常隐私、dense 协议及 SQLite 排序三项问题保持关闭，在本合成切片内未发现新的确认阻碍。
默认工具会保留当前知识的适用条件与公开依据，失效、旧修订及跨内容代引用不能依靠旧 rowid 继续读取正文。
以上结论依赖可信宿主执行 transition、失效、发布和 install 协议，不表示自动失效已接入。
生产 HTTP v2、正式 Pi SDK 新工具注册、真实 Chroma 重建、watcher、多进程广播和多资源原子发布仍未覆盖，全文生产链路及 `docs/1.md` 的最终改写继续暂缓。

## Node 公开 reader IPC 接入边界

Node 宿主通过 `validation/project-cm/curated-reader-bridge.mjs` 异步调用一代一个 Bun worker，公开工具仍使用默认 v2，不在 Node 主事件循环执行同步 SQLite。
可信宿主先调用并等待 `transition` 实际回收旧 worker，再进行私有失效及公开发布，最后 `install({publicPath,generation})` 验证当前 manifest 后恢复服务，公开请求不得控制路径、代或安装权限。
桥独占子进程，Bun 独占只读 SQLite，工具借用桥而不关闭它，宿主负责最终 `await close()`。
取消、超时及协议失败先停服再 TERM/KILL 并等待 close，只有进程回收未确认时才保留 PID 及资源归属并拒绝安装，不能仅提前返回而宣称 SQLite 已停止。
关库异常通过固定 shutdown 状态码保留语义，可信 owner 另外获得实际退出码和信号，已确认进程 close 时 retainedResources 为空，不因关库失败误报 OS 资源仍存活或禁止宿主发布。
transition/close 在确认回收后正常返回，关库和异常退出仍在 diagnostics.cleanupErrors 中可见，重复调用保留本代诊断，transition 后显式 install 重置本代诊断并恢复服务。
close 是桥对象终态，之后不能在同一对象 install，宿主需要新生命周期时创建新桥，diagnostics.closed 仅表示子进程已确认回收，不等同于桥对象是否终态。
主动 stopping 仅免除预期的完整 stdout EOF，不吞运行中意外断流、残余半帧或坏协议，公开工具不获得可信 owner 的诊断或私有异常原文。
单请求并发返回 BUSY，不提供自动恢复、last-good、watcher 或任意后代监管，完整预算、帧上限与当前验证缺口见验证 README 的 Node/Bun 桥章节。
离线 Pi SDK 探针已用真实 SDK 注册 memory_search/memory_read，通过合成 provider 验证公开语义及安全错误，但不证明真实模型判断、正式插件接线或生产缓存生命周期。

主代理从最终源码独立构建并通过 SDK 合成集成场景、桥接 15 项和 close/input 6 项，以及既有当前检索、派发、审核、Markdown 和根检查，记录为 `../validation/project-cm/curated-ipc-main-final-checks.log`。
原 reviewer 串行只读复核关闭关库诊断丢失及正常退出误报问题，当前限定切片未发现新的确认阻碍。
底层私有异常通过桥方法故障注入进入真实 SDK，事件及合成 provider 的后续上下文均仅收到固定安全错误，正常 SQLite 查询链另行真实执行。
关库异常验证是生产 stop 路径的受控边界注入，不是 SQLite 原生 close 故障或 OS 回收失败复现。
真实 stdin 背压、不消费输出及短写组合、真实 OS kill/wait 失败仍未完整覆盖，正式插件和完整生产链路继续暂缓验收。

### reader IPC 真实背压验证边界

新增无网络的 `--curated-ipc-backpressure` 最小切片以 11 项测试验证真实管道阻塞、取消/超时/换代回收及坏协议/半帧与 EPIPE 的首错保留，原实现通过，未确认新的产品 bug。
默认 Node stdin 单个最大 8192 字节帧实测 write=true、callback 完成、无 drain，不声称默认协议自然触发真实背压。
受控测试仅把本次自有 child 的输入传输接缝改接 4096 字节独占 FIFO/fd3，实际 write=false、部分字节已写、callback 待完成、drain 为零，取消/超时/transition/坏协议/半帧均真实 KILL 并确认 close，随后 EPIPE 不覆盖首因。
输出侧仅替换生产 Bun worker 的 reader 工厂返回 120000 字符合成字段，生产 send/stop 在宿主暂停独占 FIFO 读流时，120083 字节结果阻塞后，排队在其后的 85 字节 shutdown 也真实 write=false 且 callback 未完成，桥仍升级 KILL 并等待实际 close。
85 字节 shutdown 不是独立填满管道的证据。
此证据不等同真实 SQLite 查询产生相同大结果、不等同默认 spawn stdin 的自然管道容量，也不覆盖所有短写长度、真实 OS kill/wait 失败或任意后代监管。
测试的固定预算、独立错误码及公开 stream/内核证据与限制见 `validation/project-cm/README.md` 的真实管道背压章节，三条源码 check 均已实际通过，17 个 runner 确认父进程回收与进程组消失。

### F003 的测试资源修复边界

原始 stdin 被替代后仍属于测试夹具，必须在安全收尾阶段显式 destroy 并有界确认真实 close，不能以 worker close 或测试进程退出替代父端 pipe 的释放证明。
新增断言在原实现复现 6 pass / 5 fail 的 test-only F003 red，修复后 14 项通过，八个场景的原始与替代流均 destroyed/closed 且 closeCount=1，无保留资源，fixture 只在 worker 与测试句柄确认关闭后删除。
安装失败、替换后异常及受控清理步骤报错均覆盖，单项报错不跳过后续安全阶段，原错与 cleanupErrors 独立保留，不声称模拟了真实 native destroy 或 OS 回收失败。
本轮仅改测试夹具和文档，未发现或修改生产 bridge/worker bug，修复者 SDK 检查通过记录与主代理后续独立验收分开，具体 red/green 和限制见 README 的 F003 章节。
背压加 close-unknown 组合未直接注入，既有 unknown 测试不自动扩展为该组合已验证。

主代理从最终源码独立复跑三条 check 全部退出 0，背压与资源清理 14 项及全部相关回归通过，17 个外层 runner 确认进程组已回收，记录为 `../validation/project-cm/curated-backpressure-main-final-checks.log`。
原 reviewer 串行只读复核关闭 F003，F001/F002 保持关闭，在本次限定切片内无剩余确认阻碍，生产插件及完整生产链路仍未验收。


## 正式 Pi 只读插件切片

本节更新前述历史切片中“正式插件未接线”的状态，不代表后台提炼、审核发布及重启恢复的完整生产闭环已验收。
独立正式入口为 `src/curated/pi-extension.mjs`，`npm run build` 产出 `dist/curated/pi-extension.mjs`，根包旧 API 保持原样。
Node bridge、默认 v2 tools、完整公开投影校验和专用 Bun worker 的真实运行时位于 `src/curated`，validation 的同名文件是兼容入口，不再是正式运行时真源。
固定上游 SessionSearch 查询实现随包携带来源及 Apache 许可证，通过窄 paths/logger 边界禁止默认私有库路径、全局 settings 发现及上游日志初始化，运行不依赖 validation、上游检出或开发机绝对 SDK 路径。

会话仅从可信 ctx.cwd 的 `.project-memory/curated.json` 读取固定 version/project/generation，公开库固定为同目录 `knowledge.sqlite`，无路径、项目或代的模型参数。
缺失、非法、未审核、旧库、损坏及身份不匹配均安全不可用，不回退旧代，不扫描私有工作库，不从当前真实项目自动提炼或发布知识。
`session_start` 建立新的工具候选表与桥周期，`session_shutdown` 同步撤掉工具入口后实际取消并等待 close，reload/new/resume/fork 通过真实 SDK 替换生命周期恢复当前公开代。
宿主发布前执行 `/memory-refresh pause` 并确认安全错误回执为空，回收完成后才能失效及替换公开文件，再执行无参数 `/memory-refresh` 安装。
SDK 会记录部分命令处理器错误后继续，脚本宿主不能仅凭 prompt 正常返回认定暂停或刷新成功。
进程回收未知时由自有保留集跨 reload 持有旧桥，重新确认回收之前不启动替代 worker，不释放仍可能在使用的文件。
本片不更改其他扩展合法的 active tools 更新，不关闭 Pi 借用资源，不接管宿主全局信号。

实现者从源码重建后执行真实 DefaultResourceLoader、extension runner 与 AgentSessionRuntime 的 10 项场景，使用纯机械 provider、内存认证／设置／会话及合成 SQLite，未调用真实模型或网络。
干净临时 consumer 经离线 npm tarball 安装实际依赖，再从包内重新构建、导入并加载正式插件，Bun worker 也从 consumer 包内启动，没有借用 NODE_PATH 或 validation 运行依赖。
实际覆盖 search/read 公开语义与隐私、G1→G2 显式暂停发布刷新、旧 UUID 拒绝、reload/new、A→B switch、已写入真实 search 帧后的 SDK signal 取消、Bun 启动失败及各类安全不可用。
上游全局配置发现断言使用 Bun 文件系统透明观测接缝，不读取目标原文，受控换回可加载旧 vendor 时明确捕获 FORBIDDEN_SETTINGS_DISCOVERY，独立 red 为 7 pass / 2 fail，正常实现为 10 pass / 0 fail。
最初离线 npm 物料与工具 allowlist 夹具失败、后续命令异常预期错误及未触发的旧 vendor 注入均保留记录，不计入产品行为 red 或有效变异证据。
全部相关旧三条 check 退出 0，根 14 项及 typecheck 保持通过，runner 均确认父进程回收和进程组消失，具体记录见 `curated-plugin.md`。
本节是实现者自检，不冒充主代理独立复跑、独立 AI Review 或人工审核，完整链及 `docs/1.md` 继续暂缓。

### 插件宿主诊断交付补全

原 reviewer 确认的唯一 P2 为插件闭包诊断不可达及 confirmed-close cleanup 诊断丢弃，不是既有 bridge 关库／退出协议问题。
本次增加固定 HOME 私有目录中的安全快照，目录 0700、文件 0600，最多 32 条且完整 JSON 不超过 32768 字节，仅记录白名单机器码、阶段和 bridge 资源状态，不记录原始异常、stack、路径、知识正文或密钥。
每次 close 后均采样，confirmed-close 但关库失败只报告 cleanup／exit，不伪 unknown 或阻止继续发布，诊断不进入公开描述、SQLite、Markdown 阅读导出、session、工具结果、SDK 错误或通知原文。
生命周期先停服并确认进程回收，再等待私有文件落盘，写失败明确通过固定安全码反馈，并保留原安全记录和独立写失败记录供后续生命周期重试，不假称写入成功。
桥 5000 毫秒仅覆盖启动与 install，不包含排队、旧桥回收、描述文件或诊断文件 I/O，本机文件系统冻结时没有可抢占的总时限承诺。
新增真实 loader 断言在旧插件上取得 9 pass / 4 fail 的逻辑 red，修复后总计 13 pass / 0 fail、集成 1，干净 consumer 和原 10 项未削弱，四条源码安全检查全部退出 0，18 个 runner 均确认回收，根 14 项及 typecheck 保持通过。
详细路径、权限、受控故障性质、写失败重试和未测试的 native 文件清理故障见 `curated-plugin.md`，实现者记录不代替主代理复跑和原 reviewer 复核，后台 writer／生产更新闭环未在本片扩展。
主代理随后独立执行四条源码检查均退出 0，插件 13 项与真实 loader 集成 1 通过，18 个外层 runner 均确认回收，源码摘要在测试前后无变化，记录为 `../validation/project-cm/curated-extension-diagnostic-main-checks.log`。
原 reviewer 串行只读复核关闭诊断 P2，正式只读插件完成本片限定验收，后台提炼、宿主审核发布更新闭环继续进入下一切片。
