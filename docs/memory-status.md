# N04 状态投影接线契约

本文件说明已接入正式 Pi 入口的状态事实投影、呈现器及受管验证契约，不把单个模块通过当作最终分发完成。
持久计数由隔离存储层计算，Node 呈现器只接受可信快照，不在 Pi 进程执行 SQLite 或模型工作。

## 存储函数

`src/authoring/durable-status.mjs` 导出同步函数 `readDurableMemoryStatus(writer)`。
`writer` 为当前已打开且项目绑定已由宿主验证的 `LocalWriter`，函数只借用其 `db` 和 `project`。
缺少句柄返回 `missing/PRIVATE_NOT_ATTACHED`，这不表示磁盘上不存在私有库。
已关闭句柄返回 `offline/PRIVATE_OFFLINE`，读取失败返回 `offline/PRIVATE_READ_FAILED`。
可读连接返回 `available/OK`，这只表示可以读取，不表示任何内容已保存。

返回对象固定包含 `version: 1`、`state`、`code` 和下表八个事实字段。
每个事实固定为 `{state: 'known', count: 非负安全整数, code: 'OK'}` 或 `{state: 'unknown', count: null, code: 固定安全码}`。
未建表返回 `FACT_UNAVAILABLE`，畸形计数返回 `COUNT_INVALID`。
整体事务读取失败后全部私有事实返回未知，不混用不完整快照。

| 字段 | SQL 持久口径 | 不代表什么 |
|---|---|---|
| archivedSources | 当前私有库 `writer_source` 全部行数 | 不等于 capture cursor、回执数量或本次实例 committed 次数 |
| approvalRecords | `distill_approved_input` 全部行数，包含已撤销历史 | 不证明仍有效授权或可以发送 |
| attempts | `writer_attempt` 全部行数 | 不表示网络已收到或生成成功 |
| unknownAttempts | `writer_attempt.state='unknown'` 的行数 | 不自动把运行中的 dispatching 说成 unknown，重启恢复由既有 writer 负责 |
| responses | `writer_response` 完整响应记录行数 | 不表示响应已被审核或发布 |
| candidateRecords | `writer_result.kind='observation'` 的行数 | 不等于所有 observation，也不证明待审核候选已审核 |
| reviewedRevisions | 当前 `writer.project` 的 `curation_revision` 行数 | 历史审核版本不等于活跃审核条目或当前公开条目 |
| activeReviewedEntries | 当前项目 `curation_entry.status='active'` 的行数 | 不计 needs_revalidation，不证明当前已公开或索引 |

这些计数是数据库当前保留的存量，删除记录后可能减少，不是永久单调递增事件计数。
私有库以现有 writer 的项目绑定为边界，curation 额外按 `writer.project` 精确过滤。
函数不读取正文、批准元数据、公开目录或索引，也不返回 ID、路径、密钥及错误对象。
函数不开库、不建表、不启动 owner、不批准、不生成、不关闭连接，也不修改 PRAGMA 或共享连接设置。
函数以 SQLite deferred 只读事务获取同一快照，调用者必须串行调度且不得在写事务中调用。
同步 SQLite 不能提供实时取消，宿主须沿用已有有界隔离执行路径，而非在 UI 线程执行可能阻塞的磁盘读取。
archive-only 宿主可以借用既有 writer 直接调用，未初始化审核表时审核数量为未知而不是零。

## Node 呈现函数

`src/curated/memory-status.mjs` 不导入 Bun、owner、数据库或生成模块。
`projectMemoryStatus({private, publication, index})` 校验快照并返回仅含固定字段的 v1 状态。
`private` 使用上述存储函数结果，缺失或畸形内容不能冒充零。
`publication` 为可信调用者核实当前公开版本后提供的 `{state:'known', count:当前发布条目数, code:'OK'}`。
`publication` 也可为 `{state:'unknown', count:null, code:'FACT_UNAVAILABLE'}` 或 `null`。
只有明确验证当前没有公开条目时才能提供已知零，分页长度和历史发布 receipt 不可作为总数。
`index` 为可信调用者提供的 `{state:'ready'|'stale', count:索引保留条目数, code:'OK'}`。
`index` 也可为 `{state:'disabled'|'building'|'missing'|'unavailable'|'unknown', count:null, code:'FACT_UNAVAILABLE'}` 或 `null`。
关闭、构建中和缺失的数量仍未知，不能把连接可用或正在构建转换为已知零。
正式索引的 `status().count` 仅在 READY 时提供完整验证后的条目数，接线方还须将其 generation 与当前公开版本核对后才能展示为 ready。
过期索引的条目数仅表示该索引保留存量，不声称覆盖当前发布。
形状校验不验证公开内容真实性、版本绑定或索引完整性，这些责任属于提供快照的现有公开读取层与索引模块。
私有层缺失或离线不影响独立提供的公开与索引事实。

`createMemoryStatus({readStatus})` 返回 `refresh(ctx, {signal} = {})` 和 `clear(ctx)`。
`readStatus({signal})` 由可信接线方提供，返回上述三层快照或 Promise，不得为了状态查询启动 owner 或生成。
调用者负责等待上限、取消落实和资源回收，呈现器不另建后台任务或假装取消了不可取消工作。
`refresh` 返回 Promise，结果为 `{snapshot, text, code}`，TUI 和无 UI 状态命令均可使用返回文本。
`hasUI === true` 时仅调用 `ctx.ui.setStatus('local-project-memory.status.v1', text)`，无 UI 时不访问 `ctx.ui`。
`clear` 只对自身键传 `undefined`，重复清理安全，不关闭 UI、不 setFooter、不改 activeTools、不覆盖他人 status。
并发刷新采用最后发起者优先，清理后较早读取完成不得重新写回状态。
输入未知通过固定事实码呈现，读取抛错返回 `STATUS_READ_FAILED`，UI 抛错返回 `STATUS_UI_FAILED`，异常消息和对象均不返回。
正常读取的顶层 `code:'OK'` 只表示读取调用和 UI 操作没有抛错，不表示每个事实均已知，必须检查各事实的 state/code。
接线方负责命令注册、无 UI 文本输出与生命周期中调用 clear，呈现器不自行打印或通知。

## 受管测试入口

纯 Node 单元测试对应 `validation/project-cm/memory-status.node.test.mjs`，项目验收统一通过 `run.py --memory-status-node` 执行。
其范围包括正常、零、缺失、离线、畸形计数、额外字段、无 UI、他人状态保留、自身清理、并发清理和错误脱敏。

Bun SQLite 集成文件为 `validation/project-cm/memory-status.store.test.mjs`。
现有受管 `validation/project-cm/run.py --memory-status-store` 使用有界 Bun 执行与回收协议，成功 marker 为 `MEMORY_STATUS_STORE_OK`，不得绕过 runner 裸跑真实进程测试。
测试调用真实 `LocalWriter.capture` 写入 125 条来源并重放，关闭后重开验证累计存量和 dispatching 恢复为 unknown，另覆盖空库、缺表、只读、项目过滤及 SQL 失败。
审核及批准历史使用明确标注的合成持久记录验证计数口径，不把合成记录当作真实审核真实性验证。

## 当前验证与证据边界

主代理已独验 Node 单元测试14项通过、0项失败，以及真实 SQLite 状态场景1项通过，两者退出0、实际回收、无外层强杀且cleanupErrors为空。
源码证据为 `validation/project-cm/main-memory-status-node-independent-final-1.json` 和 `validation/project-cm/main-memory-status-store-1.json`，不把早期实现者13项自检当作当前主代理独验。
正式 Pi 入口已接入私有累计计数、公开 totalRows 与匹配当前 generation 的 READY 索引计数，正式本地索引与合成 SDK 组合另有独验，最终分发及旧全套回归状态以 `remaining-work.md` 为准。
语法检查不执行 SQLite、SDK 或资源回收行为，报告通过不代表自动批准事实、模型质量或 macOS 已验证。
validation 下的受管脚本和报告仅属于源码环境，不随分发包提供。
