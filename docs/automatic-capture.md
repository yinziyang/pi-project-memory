# 显式启用的自动私有归档基础切片

本切片增加 N01 与 N02 的基础接线，不代替核心知识审核闭环，也不表示全部剩余能力已完成。
自动归档不请求模型，不加载 SDK 认证，不批准提炼输入，不产生公开候选，不发布知识。
默认没有配置时保持原只读行为，不读取会话历史、不启动 writer、不创建采集目录。

## 可信配置

由用户或可信宿主在固定的 `$HOME/.local-project-memory-capture/config.json` 写入配置，模型工具与公开 descriptor 不能启用它。
目录必须属于当前 UID 且为 0700，文件必须为单链接普通文件、0600、至多 16384 字节，禁止链接、重复键、未知字段、BOM 和非法 UTF-8。
宿主应独占可信 HOME 及配置祖先，当前不防御同 UID 恶意并发替换祖先目录。
插件只读取该配置，不会替用户修改真实配置。

```json
{
  "version": 1,
  "enabled": true,
  "projects": [
    {
      "cwd": "/absolute/canonical-project",
      "project": "explicit-project-id",
      "privateRoot": "/absolute/private-parent",
      "bunPath": "bun"
    }
  ]
}
```

- `version` 固定为 1，`enabled` 必须显式为 true 才启用，false 为关闭。
- `projects` 最多 32 项，按 canonical cwd 精确匹配，不向上搜索，cwd 不能重复。
- `project` 是原样保留的非空 UTF-8 标识，至多 256 字节，禁止 NUL，并须与已有私有绑定及存在的公开 descriptor 一致。
- `privateRoot` 是项目之外的绝对规范路径，项目与它不得互为祖先，已有目录必须当前 UID 所有且为 0700。
- `bunPath` 是可信宿主选择的现有 Bun 绝对路径或固定字符串 `bun`，后者使用可信 PATH，不自动安装或升级。

同一项目多个 worktree 可在 projects 中分别列出 canonical cwd，并共用 project 与 privateRoot。
实际数据库位于 `privateRoot/<worktree-identity>/private.sqlite`，身份包含 canonical cwd 与实际 Git 目录，不用分支名区分。
每个数据库子目录仍只允许既有 SQLite 文件白名单，不把配置、spool 或缓存混入其中。
配置根尚不存在时只在显式启用且确有待归档轮次后创建，父目录须已存在。

公开库缺失时仍可归档，观察绑定中的 generation 为 null。
公开 descriptor 已存在但 project 不匹配时停止该关联，不能因 knowledge.sqlite 缺失而绕过绑定，也不自动迁移私有库。

## 生命周期与接管

`session_start` 补采当前祖先路径，`agent_settled` 扫描完成轮，`session_tree` 重选当前路径。
不使用尚未持久化的 message_end leaf 推测 entry ID，也不把 agent_end 或 turn_end 当作最终完成凭据。
读取只通过公开 ReadonlySessionManager 的 getSessionId、getLeafId 与 getEntry，不读取任意 JSONL 文件，不假设存在原子 snapshot 方法。
必要字段在无 await 的短段中复制为自有过滤快照，后台不保留 SDK entry 或 message 对象引用。

`before_agent_start` 在已启用时观察 checkout，变化后先实际关闭旧 reader、清除旧候选，再按当前 worktree 的公开文件安装新周期。
此检查不授予任何内容批准权，也不把 dirty 状态摘要当作 currentSnapshot.contentDigest。

`/memory-capture status` 显示当前周期的固定状态，不包含正文、路径、原始错误或凭据。
`/memory-capture pause` 停止接收并实际关闭自动 owner，成功返回后才可由可信手动 writer 接管同一数据库。
暂停不改持久配置，重新加载仍会重新检查配置，因此持久停用还须用户将 enabled 改为 false。
固定状态同时接入综合 TUI 与非 UI 展示，持久计数及未知值规则见 `memory-status.md`，最终验收范围仍以剩余清单为准。

shutdown 先停止接收、清空未发队列并标 gap，再取消 Git 读取、等待在途归档并实际关闭专用 subreaper。
关闭不明时保留 PID owner 引用并阻止替代进程，不把发送 TERM、父进程退出或收到协议 ACK 当作整个子树已经回收。
在途只读 status 因 pause、close 或调用方 signal 主动取消时，只有确认 owner 实际回收后才返回 null，取消原值按 SameValue 比较，包含 NaN，不能按错误码一律吞掉取消后的故障。
既存协议故障、ACK 未知及真实关闭未确认仍传播并保留资源，请求开始前取消则不会新增工作，也不表示既有 owner 已关闭。
未发队列、不可用 owner 或崩溃可能造成 gap，公开 SDK 不能保证恢复已经放弃的分支，当前不通过读取真实 session 文件补洞。

## 采集与隐私

策略版本为 `visible-text-meta-v1`，只复制 user/assistant 可见文本和顶层工具配对所需标识。
工具名、参数、结果正文、details、provider payload、system、thinking、图片及 custom data 默认不复制，bash、MCP 和自定义工具没有正文 allowlist。
多个 user、steering 和并行工具保留为同一完成轮的有序消息，工具标识必须唯一且配对完整。
只有最终 stop、没有未完成工具的轮可以归档，length、error、aborted、工具错误及不完整轮均保守拒绝。
嵌套工具数据不伪造额外 entry，摘要不冒称原始对话。

已知 token、认证头、cookie、password、私钥、敏感路径与大写环境赋值模式会拒绝整轮，普通小写代码赋值不会因此被当作环境秘密。
该策略同样检查 session、entry 与 tool 标识，合法 BOM、非 BMP 和 opaque 标识原样保留，已知敏感标识不进入回执或秘密摘要。
诊断只有固定原因码，不能用原文 hash 或秘密片段代替泄漏正文。
未知秘密无法保证自动识别，过滤成功不是安全批准，也不是事实审核。

context_edit omission 或 replacement 影响的轮保守拒绝，压缩前已完成轮仍可从祖先路径补采，compaction 与 branch summary 自身不作为 transcript。
此前合法观察时已经归档的历史不会被后来 context_edit 静默删除，也不能据此将其自动选作当前可见上下文。
检查点恢复必须重新应用当前路径和可见选择，不得把私有历史当当前公开内容，已接入的关联与恢复契约见 `task-checkpoints.md`。

每个已归档 envelope 明确标记 structuralComplete=true、contentComplete=false、filtered=true、policy 与完整 entryIds。
这只是过滤后的来源，不是原 JSONL 字节备份。
archive IPC 再次逐字段白名单校验，不能靠伪造 filtered=true 保存额外正文或私有路径字段。

## 有界历史、回执与事务

- 同步复制每次最多 2048 个 entry、4MiB 文本和 25ms，具体 getEntry 的单次执行时间仍由 SDK 实现负责。
- 超预算标记 HISTORY_SUFFIX_ONLY gap，只处理最近后缀中首个已结束助手之后的独立轮，舍弃前导不完整轮，不让古老历史永久阻断新短轮。
- 不宣称后缀模式补齐全部历史，重载也可重新扫描当前有界后缀，缺失的更早轮保持 gap。
- 每整轮序列化最多 1MiB，超限拒绝，不截断后冒称完整轮。
- 后台最多排队 8 个快照且合计 4MiB，每周期最多保留 64 项安全状态回执。
- observed 与 queued 不是 saved，只有同事务回执成功才为 committed，其他状态包括 rejected、writerbusy、gap 与 unknown。
- source、checkout observation 与 cursor 在同一 SQLite 事务内提交，cursor 只证明该 entry 集合已归档，不证明整条分支完整。
- source 以 session 与策略版本下的完整 entry 集合幂等定位，只对过滤后 envelope 计算 digest，相同 entry 集合不同内容拒绝覆盖。
- ACK 丢失后不自动重试未知写入，但重载按相同来源重放可幂等确认，事务失败不推进 cursor。

独立 archive-only 模式复用同一个 LocalWriter 和数据库 owner，协议仅允许 archive、receipt、固定 v1 只读累计计数 status 与 close。
正式 Pi 自动 owner 使用 assistant-local 角色，另允许固定任务 IPC，模型只能更新可信命令已经选择的任务检查点，不能指定任意任务、项目、路径或批准字段。
status 不支持分页、正文查询或额外参数，连接可用和本实例回执数不能冒充持久累计存量。
approve-input、set-current、review、wake、consume、publish 等其他命令全部拒绝，不导入模型 SDK，不建立 transport，不启动 consumer，也不恢复 apply 旧响应。
手动可信宿主的批准、attempt、完整响应及公开审核门槛没有被弱化。

## Git 与进程预算

Git 使用固定 argv、无 shell、无交互、无 pager、关闭 fsmonitor 与全局配置，并带 `--no-optional-locks`，不 fetch、stash 或写 index。
状态使用 porcelain -z 字节摘要，支持非 ASCII 和换行路径，canonical cwd/root/gitDir/commonDir 只在观察进程内使用，持久观察只保留工作树身份摘要。
保存 commit、tree、detached、unborn、dirty、dirtyDigest、stable 与 generation，两次 HEAD/status 不一致时标 gap。
双次观察不是跨命令原子快照，dirtyDigest 也不是文件内容 SHA，不能检测所有内容变化或替代人工批准的精确快照。
旧轮绑定自己的 leaf、checkout 与 ticket，晚到结果不能改变新周期状态，排队后 checkout 已变化的来源拒绝错误绑定。

Git 总预算 2000ms，每条命令 stdout 与 stderr 合计最多 1MiB，取消或超限后 TERM、100ms 后 KILL，并等待实际 close。
archive 启动与每帧各限 2000ms，输入帧最多 1500000 字节，archive-only 输出最多 8192 字节，assistant-local 输出最多 16384 字节，stderr 总量最多 65536 字节。
archive close 先请求协议关闭，1000ms 后向专用 subreaper 发 TERM，总等待最多 4000ms，子树由现有 Linux pidfd/subreaper 回收。
单个 owner 继承既有 3600000ms 运行期限，不因为长期存活而无限等待退出。
本页只说明 Linux 自动采集契约，macOS 暂缓，独立真实生成、dense、综合 UI 和检查点的实现与验证分别见 `remaining-work.md`，不把本页低层测试推广为全部能力完成。

## 源码验证入口

源码工作区通过 `bash validation/project-cm/check-capture-slice.sh` 执行新增检查，再串行执行既有五组安全检查。
validation 下的脚本、报告、故障日志和固定上游检出仅在源码环境存在，不属于分发包，文档链接不得解释为包内测试资源。
当前切片结果与待补验收以源码环境的 `docs/remaining-work.md` 和交付报告为准，不用本页契约文字代替实际验证。
