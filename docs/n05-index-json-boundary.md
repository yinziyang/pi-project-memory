# N05 Node manifest 与缓存 JSON 读取边界收口

本轮只修 Node index 的 manifest 与缓存 JSON 读取风险，不修改 supervise、插件、observation、SDK、自有状态模块、pi-tools、package、build 或 run.py。
main 新增的 READY 存量 count 和 null/2/invalid-null/2/empty0 断言已重读并保留，没有用分页数替代当前总存量。

## 实施范围

- `src/curated/index/bounded-json.mjs` 提供固定 16 KiB 的 index JSON 读取，不引入新依赖或通用 I/O 框架。
- Node owner 的 initialize 与 E5 隔离 worker 的 manifest 读取均复用同一边界，未找到或不可读的模型仍明确降级，现有 FIFO、超量或格式错误不再被当作有效 manifest。
- cache 的 root marker、stage owner 和 ready pointer，以及 current-reader-runtime 的 cache namespace marker，全部使用同一有界读取，不经无界 readFile 或替换式 UTF-8 解码。
- index-config 只增加现有 manifest 的非阻塞元数据预检，拒绝非普通文件、链接及超过 16 KiB 的文件，缺失 manifest 仍允许返回配置并由 index 报 INDEX_MODEL_MISSING。
- index owner 与 runtime 仅登记本轮读取中关闭失败的自有 fd，等在途任务实际 settle 后再尝试释放，保留原读取错误、清理错误和未确认状态。

## 文件与数据契约

打开使用 O_RDONLY、O_NOFOLLOW 与 O_NONBLOCK，并在同一个 fd 上 fstat，必须确认为普通文件后才读正文。
缓存私有文件额外要求当前 UID 所有、单硬链接和 0600，模型 manifest 只是借用的只读资产，不修改权限或文件内容。
最大正文为 16384 字节，缓冲区固定为 16385 字节，即使文件在 stat 后增长也最多消费上限加一字节并拒绝，不以最初 stat.size 作为无界读取许可。

UTF-8 解码为 fatal，保留 BOM 供 JSON 语法拒绝，不静默替换非法字节，也不删除或改写合法字符串中的 BOM 与非 BMP 字符。
严格 JSON 先做语法解析，再以现有 yaml 依赖的 JSON schema 和 uniqueKeys 校验重复键，包括等价转义后的重复键，不接受 YAML 扩展。
返回的 text 是实际读取原文，cache 保留自身原有规范序列化及字段集合约束，仅做拒绝校验，不重新编码后写回坏文件。
未知 marker、额外字段、非法 UTF-8、重复键与错误 ready 身份均被拒绝并保留，不新增 reset 或删除能力，也不改变 matching 损坏持续失败的规则。

## 取消、fd 所有权与限制

signal 在 open、fstat、每次 read 前后及 close 完成后实际检查，取消不会继续启动后续正文读取，也不会用 Promise.race 提前返回却遗留读取任务。
打开的 fd 只由本次读取拥有，所有失败路径都先尝试 close。
若读取与关闭同时失败，INDEX_JSON_CLOSE_FAILED 同时保留 originalError、cleanupErrors 与仅可信所有者可用的 retainedFile，不能由关闭错误覆盖原始读取错误。
owner/runtime 先等待任务 settle，再对已登记的关闭失败 fd 调用 FileHandle.close，失败仍保留资源并阻止后续安装，不以复制句柄、回调返回或 PID 文件宣称资源已经释放。

O_NONBLOCK 加同 fd 普通文件检查解决本轮真实复现的 FIFO open 卡住与 stat→FIFO 替换问题，但不能抢占已经进入内核且因设备故障永久阻塞的 I/O。
即使 fd 指向普通文件，底层磁盘或文件系统故障仍可能使 fstat/read/close 永久阻塞，AbortSignal 无法强制打断它们。
后续生命周期收口已为公开取消与 close 提供固定有界的 UNCONFIRMED 返回，真实 I/O、promise、fd 与 worker 句柄仍由 owner 保留，不能因公开等待结束而声称底层已经停止或允许发布，具体见 `docs/n05-index-unconfirmed-lifecycle.md`。
仍不保证损坏操作系统或不可中断设备上的及时 KILL/reap，必须保留原 owner 并在实际完成后重试确认，不能丢弃实例或自动开始替代工作。
本轮没有注入永久设备 I/O、NFS、恶意同 UID、断电或操作系统 wait 失败，不把受控 facade 的结果冒充这些故障已获保证。

## 首轮红与实际验证

首轮受管日志为 `validation/project-cm/n05-json-bounds-first-red.{log,jsonl}`，current-index-fault 退出 1，7 项通过、3 项失败。
manifest FIFO 与 stat 后替换 FIFO 两项都触发自有外层期限，外层实际终止并回收子进程，测试仍判失败，而不是把超时计作通过。
超量 manifest 则错误继续进入依赖检查，未按字节边界拒绝，同样保留为红。
首轮测试驱动的 parentReaped=true、groupGone=true、cleanupErrors=[]，每个子探针 finally 也核对了自有 PID 已不可见。

修复后的独立日志前缀如下，每项同时保留 `.log` 与 `.jsonl`。

| 受管模式 | 实际结果 | 日志前缀 |
| --- | --- | --- |
| current-index-unit | 10/10 通过 | `validation/project-cm/n05-json-final2-index-unit` |
| current-index-fault | 14/14 通过 | `validation/project-cm/n05-json-final2-index-fault` |
| current-reader-unit | 5/5 通过 | `validation/project-cm/n05-json-final2-reader-unit` |
| current-reader-fault | 1/1 通过，包含多个内部故障断言 | `validation/project-cm/n05-json-final2-reader-fault` |
| current-index-real | 1/1 通过，保留 count 与旧 matching 损坏断言 | `validation/project-cm/n05-json-final2-index-real` |
| current-reader-real | 1/1 通过，保持 SQLite refs 水合与明确降级 | `validation/project-cm/n05-json-final2-reader-real` |

六项均退出 0、parentReaped=true、groupGone=true、cleanupErrors=[]，两个 real 的精确成功标记分别出现一次。
新 fault 包括真实 FIFO、stat/open 替换、超量普通文件、stat 后增长、读完取消、保留原错的首次 close 失败与第二次实际释放，以及配置层拒绝 FIFO manifest。
受控 close 失败和文件增长 facade 只存在于本次独占测试子进程，不修改父进程或正式运行时的 fs 对象，不用于冒充模型行为或内核设备故障。

本阶段历史源码与日志摘要保存于 `validation/project-cm/n05-json-bounds-evidence.json`，与之前交付证据分离，不覆盖 main 的独立复跑或历史红。
本轮不改变模型 repo/revision、document profile、mapping version、旧金标或旧响应账本，也不代表正式 Pi 插件和 main 独立 review 已完成。
