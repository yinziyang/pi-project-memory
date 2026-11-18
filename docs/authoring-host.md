# 可信写宿主最窄更新链

本页的完整 authoring 入口由人或受控宿主调用，不是模型工具，也不自动采集真实会话或授予事实审核权。
独立 archive-only 角色使用同一 LocalWriter，只允许 archive、receipt、固定只读累计计数 status 与 close，不提供 transport、不启动 consumer、不恢复 apply。
正式 Pi 自动 owner 使用 assistant-local 角色，额外开放固定任务 IPC，但模型仅能更新宿主已选任务的检查点，仍无批准、生成或发布权限，配置与暂停接管见 [自动私有归档](automatic-capture.md)。
原始来源的唯一权威库是私有 SQLite，批准、job、attempt、完整响应、候选及审核历史均不进入公开包或模型上下文。
当前生产入口为 Bun 隔离进程，Pi 插件及其 SDK 宿主仍运行于 Node，不能用 Node 直接运行需要 `bun:sqlite` 的写入口。
平台验收限定 Linux amd64 的可信独占本地目录，不承诺 NFS、macOS、掉电持久性或同 UID 恶意并发防御。

## 构建与运行

使用已有 Bun、Python 3、Node 26.13.1 及已安装的 Pi SDK 1.5.2，不下载模型、不安装全局工具，也不需要 PG、Redis 或 Docker。
本轮未验证其他 SDK 版本。
SDK 生产适配器通过公开 `ModelRuntime.create`、`getModel`、`completeSimple` 与 `settleCredentialWrites` 接口工作，不手读 auth、models 或会话文件。
SDK 初始化延后到最终批准加载及 attempt 持久登记之后，未批准任务不会初始化认证或发起提炼。
默认生产选择 `openai-codex/gpt-6-luna`，要求 `openai-codex-responses` 与 `https://chatgpt.com` origin，重试固定为零。
此前核心闭环验收期间未运行下面生产 SDK 命令，当时仅使用内存认证、真实 SDK 合成 provider 与 loopback 假 HTTP，不是新增真实 Luna 请求成功证据。
后续 N06 两批十条真实合成调用已按独立授权、账本和产物对账执行，保留分类错配与自然 facts 未定，零候选、审核和发布，当前记录见 [剩余能力](remaining-work.md)。

```sh
npm run build
# 只有当前精确输入获得实施核验、生成批准与额度授权后，可信宿主才可以启动这个入口。
python3 dist/authoring/supervise.py /安装的/bun sdk /规范绝对路径/private-dir '原样项目标识' /规范绝对路径/project /安装的/pi-coding-agent
# 已有可信本机 provider 时可使用独立 loopback 入口，不允许公网 URL、认证 URL 或重定向。
python3 dist/authoring/supervise.py /安装的/bun http /规范绝对路径/private-dir '原样项目标识' /规范绝对路径/project http://127.0.0.1:PORT
```

私有目录父目录必须由调用方信任并独占，根目录应为当前 UID 的 `0700`，既存链接、未知文件、错误 owner 或开放权限均拒绝，不通过修改全局 umask 获取权限。
创建任何宿主资源前按真实路径校验私有与项目目录物理分离，私有目录不能等于或位于项目、公开树、stage、retained 内，项目也不能位于私有根内而污染严格私有文件集合。
不存在的私有目录只解析已有祖先，不为校验创建目录，BOM、非 BMP 字符及相似前缀不会被改写或当成祖先关系。
standalone 发布与恢复从 SQLite 主库的实际路径重新校验同一边界，不依赖 CLI 已经做过检查。
当前库及已知 SQLite sidecar 为 `0600`，不收编无绑定旧库、错项目库或损坏元数据库。
项目标识原样保留 UTF-8，最多 256 字节，不接受空值、纯空白、未配对代理项或 NUL，不能通过 trim、解析路径或 Unicode 归一化改变身份。
标准输入和输出都是可信私有通道，输出候选完整投影不能转发进 Pi 模型上下文、共享日志或公开目录。
每行一个 JSON 请求，使用安全整数 `id`，成功返回 `{id,result}`，输入拒绝仅返回固定安全错误，进入数据库后的失败保守停止进程并统一收尾。
stdio 输入单帧最多 3MiB，所有输出单帧含结尾换行最多 1MiB，原文、批准输入及最终私有 JSON 响应分别限 1MiB，SDK 原始传输实际字节另限 4MiB，先有限收齐后交 SDK，不依赖事后响应大小限制 SDK 累积。
输出先按 JSON 转义后的实际字节数计量再构造序列化字符串，过大返回固定 HOST_RESPONSE_TOO_LARGE 而不截断 JSON，status 在 SQL 边界限制各集合行数，分类 metadata 只从 SQL 投影出已校验的有限枚举，不把全部原文载入 JS。
公开单文件校验限 32MiB，公开 manifest 限 1MiB，七类目录及全部文件以完整清单校验。
默认请求预算为 10000ms，库调用方可设 1–60000ms，默认宿主总运行预算为 3600000ms，库调用方可设 1–3600000ms。
入口在控制权可执行时立即启动统一清理预算 2000ms，超时报告 `HOST_SHUTDOWN_UNCONFIRMED` 并终止本隔离进程，启动它的宿主必须实际等待进程回收，TERM 或 KILL 均不表示远端停止或停止计费。
正式入口 supervise.py 在 Linux 启用 subreaper，以 pidfd 只管理自己的 Bun 与被领养后代，不创建 detached 进程组、不杀共享组，所有启动、运行、失败与正常退出都受 3600 秒总预算及 3 秒停止收尾预算约束。
停止时先 TERM，200ms 后必要时 KILL，并实际 waitpid 回收，SQLite 或 Python 同步阻塞不能阻塞独立 owner 的预算，回收未确认时报告非零退出。
底层 Bun cli.mjs/sdk-cli.mjs 是受管内部入口，单独运行不能把 2000ms JavaScript watchdog 宣称为可抢占同步 I/O，实际使用应走上面的独立监督入口。
`runAuthoringHost` 只用于受控独占的隔离进程，会拥有该进程的 stdio 和信号，不能在 Pi 主事件循环内直接调用。

## 命令与批准责任

- `capture` 接受 `round:{sourceSessionId,sourceEntryId,capturedAt,rawBase64}`，时间为合法 UTC 毫秒 ISO 字符串，Base64 必须规范编码原始 UTF-8 字节，持久回执只等本地归档，不等待批准或生成。
- `approve-input` 接受 `jobId` 与完整 `approval`，字段为 `project,approvalId,sourceId,reviewer,reviewedAt,snapshot,method,coverage,observed,expected,comparison,expectationSource,evidenceRefs,evidenceInputDigest,approvedBytes`，其中 `approvedBytes` 是规范 Base64，digest 是对应解码字节的 SHA-256。
- `snapshot` 精确包含 `object,scope,version,contentDigest`，独立期望、实际实施及证据覆盖必须由可信宿主核验，模型的 verified、自评或原始正文不能授予资格。
- `set-current` 接受 `jobId,snapshot`，宿主必须在实际对象变更时更新当前快照，发送前在同一 worker 最终重新读取并匹配批准对象，缺失、撤销或不匹配均零请求、零 attempt。
- `revoke-input` 接受 `approvalId`，撤销永久生效，不复活旧批准。
- `wake` 立即回执并唤醒唯一串行 consumer，单次 wake 固定当前任务高水位、每批最多查询 100 项且每项只消费一次，未批准任务不 busy-loop，新增任务由后续显式 wake 消费。
- `status` 返回持久 job、attempt、响应大小、候选 observation ID 与发布阶段，不返回原文，默认每个集合最多 100 行，`limit` 是 1–1000 的安全整数。
- `cursor` 可包含 jobs、candidates、responses、attempts 四个非负安全整数游标，省略项默认为 0，响应以 `next` 返回各集合下一游标，以 `hasMore` 表示是否还有结果，不能把单页当成全部数据。
- 调用方应将整份 `next` 带入后续请求，直到四个 hasMore 都为 false，顺序按各集合持久键递增，同一静态集合无遗漏或重复，跨命令发生新增或状态变化时不承诺数据库快照，需重新从 0 扫描确认当前全量。
- 私有兼容命令 `receipt` 现在是同一分页 status 的别名，旧数组消费者须改读 result.jobs 并处理 next／hasMore，不再提供无界数组。
- 完整响应先落私有库，再由同库事务 apply 为未审核候选，unknown 永不自动重试，重启会继续 apply 已持久的 response_ready，不自动唤醒 queued。
- SDK 的 sdkResponse 与 sdkOutput 表示完整 SDK 逻辑结果及模型原始输出，不声称逐字节保存原始 SSE wire，完整 length/error 结果先存档再标 invalid_response，未取得完整结果的取消或网络故障保留 unknown。
- SDK 提示要求自动建议七类分类，模型将建议存入 observation.metadata 的 JSON 字符串 categorySuggestion，status.candidates 只暴露校验后的枚举建议和 suggested/missing/invalid 状态，缺失或非法不猜默认类，review 仍必须显式指定最终 category，建议不能授予公开批准。
- 枚举合法不代表分类正确，可信宿主仍须核对条目主主题与最终 category，不能把建议或模型自评作为审批依据。
- files_read/files_modified 是模型对源工作流程的文件标签，不是远端模型实际读写的审计凭证，涉及文件动作时须有独立来源映射。
- 公开投影不复制原始文件标签，但 title/narrative/facts 中的路径和行为主张仍须审核，字段被排除不代表其他正文自动真实。
- `candidate` 接受 `proposal:{project,knowledgeId,observationId,category,scope,source}`，返回待审核完整投影，不返回审核权。
- `review` 接受 `submission:{proposal,expectedRevision,review}`，review 包含 `approvalId,reviewer,reviewedAt,projection,evidence`，必须绑定完整投影。
- 每条 evidence 包含 `implementation,object,method,coverage,source,publicSummary,result:{observed,expected,comparison}`，事实真实性、证据与结论匹配及公开去敏仍是可信宿主或人的责任，不能把模型 payload 当作该 review。
- category 必须是 `项目概况、领域规则、代码导航、开发操作、设计决策、排障经验、项目约定` 之一，发布只保留 current SQLite、七类 MD、descriptor 与完整自有清单，不复制工作库。
- `invalidate` 接受 `invalidation:{project,knowledgeId,expectedRevision,reason,invalidatedAt,reviewer}`，必须在实际插件暂停与持久暂停标记之后调用，失效后无新核验的条目退出默认结果和 MD，全部失效允许合法空代。
- `close` 停止接收、取消在途生成、等待 consumer、结算 SDK 认证写入、关闭 SQLite 与 owner，重复停止安全。

示例原始提交只归档，不会自动批准。

```json
{"id":1,"command":"capture","round":{"sourceSessionId":"trusted-round","sourceEntryId":"round-1","capturedAt":"2026-07-01T00:00:00.000Z","rawBase64":"cHJpdmF0ZQ=="}}
{"id":2,"command":"status"}
{"id":3,"command":"wake"}
```

## 发布与真实插件刷新

1. 可信 SDK 宿主或人实际执行 `/memory-refresh pause`，等待命令完成并确认无 SDK 安全错误及旧 worker 已 close，必须暂停所有共享该目录的 reader，不以任意布尔字段代替实际停止。
2. 通过私有 stdio 发送 `{"id":4,"command":"pause-confirmed","confirmation":"all-readers-stopped"}`，宿主在项目根持久建立 `.project-memory-paused`，插件重启或新 session 也拒绝重装旧代。
3. 如旧实现已变，先 `invalidate`，再登记已完成真实独立核验及人工公开审核的 review，不能用未核验新候选覆盖旧知识。
4. 发送 `{"id":5,"command":"publish"}`，在 `.project-memory-next` 生成当前精选 SQLite、MD、descriptor 与 manifest，校验既有完整 snapshot 后一次 Linux renameat2 交换整套目录。
5. 只有已确认 committed、旧树清理完成及已知 marker 归属时才解除持久暂停，随后实际执行 `/memory-refresh`，search/read 才使用新 generation。

旧 UUID、旧 generation 及旧 revision 不跨代读取，重新 search 获取当前稳定 kid 的新引用。
构建、交换或收尾失败时保留暂停标记，不自动回到 last-good，也不在 restart 自动删除 staging、未知公开文件或手改 marker。
失败状态可通过重开同项目宿主的 `status.publication` 查询，`building` 为构建未完成，`commit-unconfirmed` 不能推定未提交，`committed` 表示整套目录已知提交。
未知或手改公开内容会阻止替换，未确认关闭的 SQLite 或交换后的旧树保留待可信宿主确认进程已停止后处理，不提供任意递归清理命令。
显式恢复流程为等待旧 host 实际回收、启动同私有目录与项目的新 host、实际暂停 reader、再次 pause-confirmed，然后发送 {"id":6,"command":"recover"}，私有 owner 锁与发布归属 ledger 共同防止活库接管。
完整已封存快照会验证项目、整树清单与 generation，若新代已当前则确认 committed 并清理已验证旧 stage，若新代尚在 stage 则继续整套交换，绝不盲回滚。
部分构建只在归属、UID、无链接和固定文件族校验通过后移动到 .project-memory-retained-UUID 保留目录，不删除、不发布且不解除暂停，随后可重新 publish 并实际 memory-refresh，保留目录不充当 last-good。
未知 stage 文件、错误 token、手改完整 manifest 或未知 marker 会拒绝恢复，部分构建中已知文件的内容不宣称完整验证，即使需要保留也绝不删除或作为当前结果。
公开文件被人改动时，须由可信人员明确修复该改动，再由 recover 重新验证完整 snapshot，host 不静默删除人的文件。
公开 marker 只含固定协议字串，没有来源、审核人或私有路径，未知 marker 不覆盖、不删除。

## 本轮检查入口

```sh
bash validation/project-cm/check-authoring-slice.sh
```

闭环测试从不含 validation 的离线 consumer 产物启动真实写 CLI，以本机假 HTTP、真实私有 SQLite 与真实 Pi extension loader 验证发布、刷新、重启、跨项目、失效为空、unknown 不重发、手改拒绝和持久 fail-closed。
SDK 专项在 Bun 中使用真实 Pi ModelRuntime、内存 credentials 与合成注册 provider，另外验证传输预算与初始化失败后资源所有权，不连接真实模型。
review 回归另验证原生 SQLite／聚合清理故障及 request_started 可信 hook 故障原样传播，数据库读取失败不伪装 invalid_response，传输失败仍 unknown 且不重试，完整坏 JSON 仍按原语义拒绝。
构造或发布关闭未确认时保留原错、cleanupErrors 与 retainedResources，不二次关闭伪报成功，私有主库未确认关闭时 owner 强持有到隔离进程结束。
以下属于此前核心闭环的验收记录，不代表当前 N01–N06 最终组合已全部验收，当前状态见 [剩余能力](remaining-work.md)。
此前主代理从当时最终源码独立执行五套检查全部退出 0，review 20 项、writer 5 项、SDK 6 项、publication 4 项及真实闭环集成 1 通过，23 个外层 runner 确认回收，154 个代码文件摘要前后无变化。
证据为 `../validation/project-cm/authoring-review-main-final-checks.log` 与对应源码摘要，原 reviewer 串行只读复核已关闭本轮 P1／P2，在限定核心闭环内无剩余确认阻碍。
最终实现、使用方式、真实模型证据与未覆盖边界统一见 [`docs/1.md`](1.md)，不将本轮离线适配测试扩大为新增真实模型语义验证。
