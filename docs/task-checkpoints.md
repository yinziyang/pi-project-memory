# 私有任务检查点与上下文恢复

## 启用与边界

任务功能复用自动私有采集的可信 HOME 配置、项目与 worktree 绑定及同一个 writer owner，默认随采集配置关闭。
没有显式配置或已 pause 时，不为任务或状态命令新建第二个 owner。
`assistant-local` 是自动 owner 的内部窄角色，只增加固定任务 IPC 和只读持久状态，不获得批准、生成、审核或发布权限。
原 `archive-only` 角色仍拒绝 task IPC，仅增加可信宿主可查询的只读 status。

检查点属于私有、未审核的任务声明，不是公开知识，不会创建提炼 job、attempt、response 或批准记录。
检查点表与归档复用同一 `writer.db`，不在 namespace 中增加文件，不关闭借用数据库。
手动 authoring 接管前仍必须通过 `/memory-capture pause` 确认自动 owner 实际退出。

## 可信命令

可信用户通过固定命令选择任务，模型不能选择项目、路径、task 或公开版本。

- `/memory-task new` 创建并选择一个新任务，revision 为 0，尚无检查点正文。
- `/memory-task select <UUID> <revision>` 显式关联固定版本，revision 为非负安全整数，0 只表示空任务选择。
- `/memory-task resume <UUID> <revision>` 与 select 同样要求显式任务和固定版本，不按 latest 猜测“继续”。
- `/memory-task status` 返回当前可见关联、版本和 SQL 总量，不返回检查点正文。
- `/memory-task unlink` 在当前分支追加低敏解除关联标记，不删除私有历史。

跨 session、fork 和 new session 不自动继承旧关联，即使 SDK 复制了祖先 marker，也必须由可信用户重新关联。
只能在同一个项目和 worktree 的私有命名空间内关联任务。
没有显式 task 或存在多个 task 时，不自动选择其他会话的任务。

## 模型保存工具

`memory_checkpoint` 只作用于可信命令已经选中的当前任务。
工具参数严格限定为 `revision`、`goal`、`constraints`、`done`、`next`、`blockers`。

| 字段 | 类型与上限 |
|---|---|
| revision | 非负安全整数，必须匹配当前可见版本与数据库 head，冲突时拒绝覆盖 |
| goal | 非空字符串，最多 1024 UTF-8 字节 |
| constraints、done、next、blockers | 字符串，各最多 2048 UTF-8 字节 |
| 完整输入 | JSON 序列化后最多 8192 UTF-8 字节 |

不接受数组或任意附加字段，不截断、规范化或静默改写 BOM 和非 BMP 字符。
`done` 只是来源自述，未经独立核验，不能据此批准或公开任何事实。
已知凭据及敏感路径模式会拒绝私有写入，但不承诺识别所有未知秘密。
禁止提交凭据，因为 SDK 可能已经把工具参数记录到 Pi 原始会话，本工具不能抹除这些参数，也不能宣称完全不留 transcript。
插件不会再把完整检查点复制到 `appendEntry`、工具额外 details、公开 SQLite 或 Markdown。

## 分支锚点与崩溃恢复

每次保存先在私有事务中提交不可变版本及不透明关联 ID，再调用 `pi.appendEntry` 追加仅含 `version` 和 `associationId` 的本扩展 marker，最后确认实际 marker entry ID。
自己的新 marker 才是实际时间锚点，保存前已有的 leaf 不能充当事后保存的锚点。
恢复只沿当前 leaf 的祖先链查找最近的本扩展 marker，不扫描全 entries 或未来节点。

- 私有 prepare 后崩溃但没有 marker 的版本是孤立历史，不会自动恢复。
- marker 已持久但 confirmation 丢失时，可以凭实际祖先 opaque ID 幂等补确认。
- confirmation 已持久后重放同一 marker 不新增版本，冲突 marker 拒绝覆盖。
- marker 对应记录缺失、跨会话或校验失败时，不回退到其他版本或全库 latest。

默认最多保留 10000 个任务身份、10000 个检查点版本和 20000 个关联，达到各自容量后拒绝写入。
当前没有自动删除或驱逐历史的策略，需要扩容时应先核实私有存储容量和历史保留要求。

## 每次模型调用恢复

每次 SDK context 回调均重新检查当前会话、祖先关联、项目/worktree 生命周期和当前 checkout。
SDK 公开 manager 没有原子 snapshot，祖先复制在无 await 的短窗口内执行，默认最多 2048 entries 或 8ms，并在末尾复核 session 和 leaf。
超预算、超时、不稳定、缺记录或不可取消操作尚未真正结束时，不注入旧状态。

每次只移除本扩展 `local-memory-task-context-v1` 类型的旧临时消息，不按正文删除其他 extension 的消息。
恢复消息最多一份，明确标记为未受信任的私有任务数据，正文不持久追加到原始会话。
usage 未知或 tokens 为 null 时，完整序列化消息最多 2KiB，可靠 usage 时最多 4KiB，余量不足则整份省略并报告固定状态。
字节不是精确 tokens，不把截断后的数据说成完整检查点。

插件不调用 `sendMessage` 触发检查点恢复，不修改 SDK compaction，不返回 continue，也不自行启动额外模型循环。
SDK 会记录 context handler 异常后继续请求，因此安全降级是撤下本扩展旧注入，不代表阻断模型请求。
取消会交给同一 owner 并等待实际操作结束，SQL 的同步阻塞由已有进程隔离及有界关闭负责，不用 Promise.race 遗留后台 SQL。

## 读取撤销与状态

公开工具及每次 context 会在读取前同步撤下旧候选周期，再有界观察 checkout、公开文件身份和暂停标记。
未变化的已核验周期可以恢复原候选表，checkout、generation 或同代文件替换变化时重新安装投影并清除旧 UUID。
异步读取返回前再次核对 ticket 和身份，晚到结果不得恢复旧范围的读取权限。
Git 观察不是跨命令原子快照，dirtyDigest 只是状态摘要，不是文件内容 hash，也不证明代码事实已自动核验。

状态只借用已经附着的 owner，不为 `/memory-status` 启动 owner。
状态栏只使用 `local-project-memory.status.v1`，不 setFooter 或覆盖其他 extension 的状态。
无 UI 时 `/memory-status` 使用 SDK 自定义消息输出安全状态，并明确 `triggerTurn=false`，不依赖可能被忽略的 command handler 返回值。
公开及索引总量在可信接线方核实前保持未知，不用分页长度或回执数量代替 SQL 总量。

## 验证边界

受管测试入口为 `validation/project-cm/run.py --task-context-unit`、`--task-store` 和 `--task-sdk`。
真实 SDK 测试使用内存认证、合成 provider、临时 HOME/cwd/Git/SQLite，不使用真实模型或服务。
SDK 阈值压缩本身不会自动增加模型回合，测试用显式合成宿主 custom message 验证压缩后的下一调用，无新用户 prompt，但不将此说成 SDK 自动续调。
真实 overflow 和 retry 则直接验证同一次 prompt 内的 SDK 内部继续调用。
实际验收证据、首次失败和未覆盖项见 `validation/project-cm/task-handoff.md`，独立测试通过不等于整个 N03 或全部剩余任务验收完成。
