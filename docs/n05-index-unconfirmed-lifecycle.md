# N05 有界等待与未确认资源收口

本轮只修改 index/runtime 的等待、资源登记和同一 lease 的提交路径，不修改 N03 的配置观察、descriptor、checkout worker、插件或 SDK 文件。
已有六个真实受管模式、模型身份、金标、count 与当前 SQLite refs 水合规则保持不变。

## 对外等待与真实任务

操作仍受原有执行预算控制，取消后固定再给 3500 毫秒确认窗口，transition/close 从调用入口起固定最多等待 5000 毫秒。
这些常量不是新配置项，不把模型塞进旧 Bun 5 秒启动或 10 秒 IPC 窗口。

期限内真实任务完成才可返回结果或其实际错误，期限届满只能抛 INDEX_OPERATION_UNCONFIRMED、INDEX_CLOSE_UNCONFIRMED、CURRENT_READER_OPERATION_UNCONFIRMED 或 CURRENT_READER_CLOSE_UNCONFIRMED，进程自身未回收仍可报告 INDEX_REAP_UNCONFIRMED。
UNCONFIRMED 是失败，不进入成功 degradation 枚举，也不表示 stopped 或可以继续发布。

公开等待只观察结果，owner 的 Set 始终保留真实 promise，而不是把已超时的等待包装当作后台任务。
所有任务先登记再在微任务中进入调用方回调或 I/O，避免同步重入 close 时漏掉刚启动的工作。
readIndexJson 打开 fd 后立即登记强引用，真实 close 成功后才删除，读取仍在途时不能被收尾流程抢先释放。
进程句柄在真实 close 事件之前始终保留，首轮退出等待超时不能销毁用于重复 close 的真实退出 promise。

超限先同步撤销 slot、停止接收、推进 epoch/sequence 并 abort，然后对外报 UNCONFIRMED。
晚回调只能完成 fd/进程收尾，不能重新 install、返回旧查询正文或清除恢复门禁。
即使门控后来释放，调用方仍须显式重试 close/transition 并取得成功确认，不能把晚回调自动解释为先前失败已经变成成功。

## 收尾顺序与调用方责任

先确认自有子进程真实关闭，再等待已登记的任务 settle，最后才关闭这些任务不再使用的自有 fd。
任何一步仍未知都保留原 owner、真实任务、fd、worker 句柄及诊断，不清空来伪造关闭成功。
重复 close 等待已有真实收尾工作，不重新打开资源，也不在任务使用 fd 时并发关闭它。

runtime 的 retainedResources 区分 operation-unsettled、close-unconfirmed 和需要再次确认的 retry-required，状态不包含路径、query 或原始 stderr。
index count 仍只在 READY 返回存量，close 入口即进入 CLOSING 并返回 null，未确认状态也为 null，不能用旧 READY 或分页数假装当前覆盖已知。
bridge.closed 只代表 Bun 进程，不代表整个 runtime 已经停止。

main/N03 必须保留抛出 UNCONFIRMED 的原 reader 实例，禁止 install 与发布，只有重复 close/transition 成功且 retainedResources 为空后才能释放或替换 owner。
close 仍为终态，确认关闭后如需重新服务，应创建新 runtime，transition 的成功则允许按原协议重新安装。

## 提交隔离与晚旧构建屏障

cache.install 不再在 Pi Node 调用 renameSync，也不直接发起无 lease 保护的异步 rename。
可能同步访问包元数据的 import.meta.resolve 同样移到现有 E5 直接子进程的只解析模式，配置读取和普通 SQLite 安装不导入模型，不增加通用 RPC 或用户配置项。
Node 仅异步准备专用临时指针并检查当前授权，然后向当前构建已经持有的 Python lease worker 发送一次 commit 请求。
原子替换只在该直接子进程内执行，worker 在替换 syscall 返回或实际退出前始终持有同一个 build.lock flock，不派生后代。

同一 owner 的 pump 等待真实 build，不等待可超时返回的公开视图，因此旧父进程 native 任务未 settle 时不会推进下一构建。
如果子进程首轮退出等待已失败但实际 close 仍未到达，进程句柄与恢复门禁仍保留，不能仅因 build promise 已拒绝就启动替代工作。
跨 owner 的合作写入必须先取得同一 root 的 flock，旧提交即使不可及时停止，也不能在释放该锁之后再执行其旧替换。
如果旧 worker 未确认退出，新提交不能越过其锁，owner 也不得安装替代工作。
正式 runtime 再以 canonical cwd、sourceBinding、checkoutToken、ownerEpoch 派生独立 namespace，旧 epoch 的 root 本身不同于新 root。

最终授权检查仍在提交前后执行，取消或 sequence 改变后即使旧指针曾落盘，也不能被旧 Node 回调安装为当前 READY。
新有效 ready 只有在旧持锁提交完成或真实停止后才能安装，因此不是把同步最后检查直接改成裸 async rename，让晚旧 syscall 覆盖新有效指针。

## 实际复验

定版源码经同一 run.py 的六个受管入口复验，index unit/fault/real 分别为 10/16/1 个通过，reader unit/fault/real 分别为 5/4/1 个通过，均无失败。
六项 exitCode=0、parentReaped=true、groupGone=true、forced=false、cleanupErrors=[]，两个 real 的成功 marker 各出现一次。
28 个自有源码与测试文件通过 JS 语法或 Python AST 检查，项目原有 TypeScript noEmit 检查退出零，但后者不覆盖本轮 MJS/Python。
这些机械结果不能代替永久设备故障保证或正式插件验收，语义自检只覆盖本轮等待、所有权、提交、门控与对应注释文档。

## 受控验证及限制

新增门控探针分别覆盖 index 的输入 fd 与 search 回调、runtime 的 install 回调与 cache marker fd。
取消或 close 返回 UNCONFIRMED 时，外部持有者仍确认任务尚未停止、fd 尚未关闭、安装被拒绝，释放门控后才确认真实 cleanup 与重复 close 成功。
cache marker 探针还确认 Bun 已实际关闭，但运行中的 fd 仍保留，不能只看 bridge.closed 就放行。

独立提交探针在真实 lease worker 的 os.replace 前门控，确认新 lease 在旧提交持锁时被 INDEX_BUSY 拒绝。
取消旧 worker 并确认真实关闭后才提交新 ready，再释放旧门控不能覆盖新指针。
这些 facade 只存在于独占测试子进程，不被冒充为真实设备故障，不保证任意永久设备 I/O 都能 KILL 成功。

公开等待预算依赖 Node 事件循环仍能推进，真实内核 I/O 可能继续未 settle，此时只报告并保留 UNCONFIRMED，不报告成功停止，也不释放或发布。
未 settle 的原生 I/O 仍可能占用线程或 fd，不能通过丢弃 owner、重新初始化 scope 或解除门禁来假装资源已释放。
macOS、NFS、恶意同 UID、断电与操作系统损坏仍不在本轮承诺范围。

当前定版日志、逐项结果与源码摘要见 `validation/project-cm/n05-unsettled-evidence.json`，不覆盖之前 JSON 边界首红、main 的独立复跑或旧质量红。
本轮未执行正式 Pi 插件最终验收，main/N03 的接线与独立 review 状态应分别记录。
