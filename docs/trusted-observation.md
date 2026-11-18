# 有界可信观察与当前 reader 接线

## 责任边界

配置、descriptor/文件身份和 checkout 的 native 文件系统操作位于专用 Node 观察进程，不在 Pi 的主事件循环内执行。
该进程由现有 Python subreaper 管理，Git 及其后代属于同一自有子树，取消后必须实际等待回收。
无法确认关闭的 PID 跨 reload 保留，后续不得绕过它另起 owner，不把发送 TERM/KILL 说成已回收。
内核永久不可杀死的进程只能报告未确认并保留所有权，不能承诺任意设备故障下进程一定立即消失。

SDK appendEntry 自身的同步会话写入由 SDK 拥有，本插件不修改 SDK、劫持会话文件或承诺该写入在设备永久故障下可取消。
既有 owner-diagnostics 持久写入及 N05 runtime 的 cache namespace I/O 有各自契约，观察隔离不自动证明这些路径也可强制取消。
这两个模块不在本片授权修改范围，相关缺口必须继续单独记录，不扩大“有界观察”的结论，也不将待收口的自有 I/O 当作验收豁免。
N05 模块所有者正在补齐 cache namespace 的有界 UNCONFIRMED 与资源保留，本片不并行修改其源码。

## 固定只读观察操作

`createTrustedObservationOwner({cwd, home, requestMs})` 固定项目 cwd 与可信 HOME，不接受模型参数决定任意文件路径。
`home` 缺省为父宿主当前 HOME，`requestMs` 为包含排队的毫秒截止，默认 2000，允许 1 到 5000。
正式调用使用当前 Node、固定 worker 与 Python supervisor，不从配置选择观察脚本或 Node 执行器。
测试用 spawnOwner 仅替换进程启动边界，不构成生产 RPC 能力。

- `captureConfig()` 调用现有 capture 配置读取器，不改变其默认 OFF 或 includeDisabled 语义。
- `indexConfig()` 调用现有 index 配置读取器，不导入模型、不创建 cacheRoot。
- `publication()` 只读固定公开 descriptor 和文件身份，暂停、链接、畸形数据或重复键拒绝。
- `archiveBinding()` 只为私有归档读取公开元数据，允许公开暂停或 SQLite 尚未存在，不授权任务恢复或公开读取。
- `checkout()` 执行现有有界 Git 观察，结果不是跨命令原子快照，dirtyDigest 不是内容 hash。
- `close()` 停止新请求并等待真实子树关闭，重复调用安全，未确认时允许后续重试回收。

每个 owner 串行执行，最多另排队 8 项，输入最多 8192 字节，单响应最多 131072 字节，stderr 合计最多 65536 字节。
响应在 stringify 前累计字节预算，输出不包含原始 Error、cause 或 stack。
排队取消只撤销本请求，在途取消或截止会终止并等待整个专用观察子树。
关闭最多等待 4000 毫秒，超过后返回未确认状态并保留 owner，不用提前返回遗弃后台文件操作。
Python supervisor 的正常工作阶段最多一小时，关闭后不再启动新工作。
若内核无法回收后代，监管进程在三秒报告未确认并保留既有 pidfd，宿主在四秒内返回 UNCONFIRMED，而不是让监管进程先退出并把未知后代遗弃给 init。
只有实际 waitpid 确认无后代后，supervisor 才通过不向后代继承的 fd 3 发送固定回收凭证，父宿主不能把 supervisor 的 exit/close 单独当作子树已回收。
异常保留状态只承担既有资源回收，不接受新工作或新建其他进程，不是另启 daemon 绕过失败。
当前 uv Python 3.13.2 缺少 pidfd_open/pidfd_send_signal 语言封装时，通过 ctypes 补 Linux x86_64/aarch64 的固定内核调用，未切换解释器或安装依赖，本片仅实际验证 Linux amd64。

初始没有 capture/index 启用绑定且没有公开描述的实例，只允许必要只读观察，不启动 writer、不复制 SDK 会话祖先、不创建 HOME 数据目录。
任务 context 在读取祖先前先核实已启用状态，SDK session ID 仅在显式 index 授权下作为宿主元数据参与绑定。
没有公开发布的正常 OFF 状态不触发诊断文件创建，已有显式发布场景的诊断持久化契约不擅自删除。

## writer 的首次目录创建

Node capture-owner 只做字符串、角色和启动参数检查，不再同步 realpath/mkdir/lstat。
实际私有目录分离、UID、权限及 canonical 校验在受监督的 Bun archive 入口完成，而且在首次创建私有目录前校验 privateRoot 与 projectPath 双向分离。
数据库仍由原 LocalWriter 唯一拥有，assistant-local 不增加 approve、wake、review、publish 或通用 SQL 能力。
ACK 截止设置明确的 ackUnknown 诊断并实际关闭子树，不根据超时猜测事务未提交，也不自动重发 task-save。

## N05 绑定与状态

Pi 使用正式 createCurrentReaderRuntime，并仅在显式 index 配置下使用 180000 毫秒工具窗口，否则保持 15000 毫秒。
sourceBinding 来自当前可信 session ID、canonical cwd 和 project，不从 descriptor、模型内容或工具参数取得授权。
checkoutToken 来自实际 checkout 观察，ownerEpoch 代表 reader 权限周期，不复用采集 ticket、每次任务调用或普通 leaf。
getBinding 每次重新核对当前生命周期、session、checkout、配置与公开文件身份，不返回安装时捕获的恒真授权。
同周期并发 preflight 合并，普通 task 保存、状态查询或新 leaf 不得反复撤销同一次 index build。
采集首次 checkout 只建立基线，公开 reader 已有独立 preflight，不因 undefined 基线重复安装初始 reader。

`/memory-refresh index` 只由可信宿主显式调用正式 refreshIndex，matching 损坏在修复成功前不能被降级吞掉。
普通模型工具不能调用该修复入口，INDEX_INVALID 不能作为成功 degradation。
当前公开数量只取 runtime.status.totalRows，当前索引数量只取 generation 匹配且 READY 的 index.count，不能从公开总数或分页长度推导。
OFF、BUILDING、INDEX_MISSING 分别呈现 disabled、building、missing，count 为 null，其他未验证状态也不伪造数量。
传给 N04 的 index 投影只有 state、count、code，不复制额外 runtime 诊断字段。

## 受管验证入口

- `--trusted-observation`：Node 测试，40 秒，真实只读进程、阻塞 FS、队列取消、Git 后代和未知 PID 保留。
- `--task-ipc-fault`：Node 测试，40 秒，实际 task commit 后丢 ACK、SQLite 同步卡住与跨 reload 禁第二 owner。
- `--current-reader-pi-sdk`：真实 SDK 脚本，300 秒，复用 N05_MANAGED_RUN 与 N05_TEST_RUNTIME 的既有离线资源。

第三项只用合成 LLM provider，index 模型与 Chroma 使用 N05 已安装资源，不下载、不请求外部模型服务或消耗真实 Luna 额度。
SDK 夹具用有截止的进程门控越过默认 15 秒窗口，并检查冷 query 未结束时新的状态刷新已经完成，不用固定等待假装模型就绪。
三项必须由 main 接入 run.py 后执行，本片不裸跑未接模式，也不将脚本存在说成验证已通过。
