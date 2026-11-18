# Pi 项目只读插件切片

## 方案与取舍

保留根包的旧 Markdown 原型 API，独立提供 `./pi-extension` 入口和 `dist/curated/pi-extension.mjs` 构建产物。
本页记录此前只接通已经审核发布 curated v2 SQLite 的只读切片，该切片本身不采集会话、不调用模型、不执行提炼或自动审核，也不读取私有工作库。
后续显式启用的私有采集属于独立 archive-only 通道，默认仍关闭，当前配置与隐私边界见 [自动私有归档](automatic-capture.md)。
必要自有读取运行时迁入 `src/curated`，validation 兼容入口复用相同实现，固定上游的 SessionSearch 作为附带许可证的独立只读检索产物随包提供。
构建只复制自包含运行时，消费者不需要 validation、上游源码检出或开发机 SDK 路径。

宿主在会话 cwd 的固定 `.project-memory/curated.json` 选择当前发布，使用新文件名以免把旧 Markdown `config.json` 当作正式 SQLite 配置。
项目根就是 `ctx.cwd`，不向上搜索，也不扫描私有目录。
描述文件只允许 `version`、`project`、`generation` 三个字段，版本必须为 1，项目为非空有效 Unicode 字符串，generation 为 64 位小写十六进制内容代。
公开 SQLite 固定为同目录 `knowledge.sqlite`，没有路径配置或模型可修改的选择参数。
描述与 SQLite 必须是可信宿主独占的普通文件，插件拒绝符号链接、缺失文件、错误类型、非法编码、超限描述、旧库、未审核库和内容代不匹配，不回退 last-good。
宿主负责在所有读取者停服并确认回收后发布，不允许在运行中改写公开文件或使用描述文件代表审核授权。

工厂只注册两个工具、生命周期处理器和一个宿主命令，不启动后台资源。
`session_start` 校验可信项目并有界安装，只在专用 Bun worker 中打开 SQLite。
`session_shutdown` 先使工具不可用，再取消并等待实际进程 close，不关闭 Pi 借用资源，也不改其他扩展的 active tools。
`/memory-refresh` 不带参数时显式停止旧读取周期、清除候选并重新读取宿主描述文件，不能由 memory_search 或 memory_read 选择项目、路径或代。
发布前必须按以下顺序推进，不能仅凭当前进程已暂停就假定重启也安全。

1. 实际执行 `/memory-refresh pause` 并确认没有 SDK 安全错误回执，暂停全部协作 reader 且确认旧 worker 已回收。
2. 向可信写宿主发送 `pause-confirmed`，成功建立 `.project-memory-paused` 后才可 invalidate 和 publish，插件重启也会保持不可用。
3. 确认整套提交和必要清理成功、解除已知归属 marker 后，再执行不带参数的 `/memory-refresh` 安装新代。

Pi 的 `/memory-refresh` 仅接受固定的 `pause`、`index` 或空参数，不接受项目、路径、代或任何审核输入。
`index` 是可信宿主显式修复派生索引的入口，不授予知识审核或发布权限。
刷新失败保持不可用，旧 UUID 不跨代、跨项目或跨 session 复用。
桥的启动与安装共享 5000 毫秒预算，请求 10000 毫秒预算，停止先 TERM、200 毫秒后 KILL、再最多等待 1000 毫秒实际 close。
5000 毫秒仅覆盖 bridge 启动和 install，不包含生命周期队列、旧桥回收、前置描述文件 I/O 或私有诊断 I/O，不是整个 session_start 的总预算。
无法确认回收时保留桥的 PID 与所有权，不启动替代 worker，不提前删除仍可能被使用的文件。
本片不宣称覆盖操作系统冻结，也不替 SDK 提供其未承诺的全局进程退出保证。

## 验证计划

用真实 DefaultResourceLoader 和 extension runner 加载分发入口，以内存 auth/settings/session 和纯机械合成 provider 验证 search/read、scope/provenance、刷新、重启和故障不可用。
测试 HOME/cwd 隔离且禁止网络与自动发现，临时数据库只含合成项目，进程由现有 run.py 有界收割并确认资源回收后删除。
复跑既有三组切片检查与根测试、typecheck，并在干净临时 consumer 中检查包入口、worker 路径和无开发机绝对路径依赖。
完整后台提炼到审核发布的更新闭环不属于本片，`docs/1.md` 仍暂缓。


## 实际验证与剩余边界

实现者执行 `bash validation/project-cm/check-curated-extension-slice.sh`，最终 10 pass / 0 fail，真实 loader 集成 1，外层退出 0，约 12.141 秒，父进程与进程组实际回收且无强制外层收尾或 cleanupErrors。
测试使用现有 Pi SDK 1.5.2，SDK 的绝对安装路径只出现在验证 probe，不进入正式包运行时或构建。
临时 consumer 的依赖由本地 npm tarball 离线安装，YAML 2.9.1 物料来自本项目已安装的精确依赖，不使用真实用户 npm 缓存、NODE_PATH 或网络。
消费者包内重新运行构建后，由真实 DefaultResourceLoader 加载包内产物，并实际启动该包内的 Bun worker 完成 SQLite search/read。

旧三条源码检查 `check-curated-pi-sdk-slice.sh`、`check-curated-public-slice.sh`、`check-dispatch-slice.sh` 均退出 0。
其中背压 14 项、close/input 6 项、bridge 15 项、旧 SDK 集成 1、公开读取 29 项、Node 语义 3 项、legacy 6 项、gate 41 项、writer 10 项、source 1 项、capture 3 项、curation 20 项、Markdown 32 项、中断回收 6 项、根 14 项及 typecheck 均保持通过。
异步旧检查另覆盖正常集成 1 与五类故障六个结果，全部 18 个新旧 runner 的 ready、parentReaped、groupGone 为 true，forced 为 false，cleanupErrors 为空。
实际输出分别保存在 `validation/project-cm/curated-extension-run.json`、`curated-extension-green-check.log`、`curated-extension-old-sdk-check.log`、`curated-extension-old-public-check.log` 和 `curated-extension-old-dispatch-check.log`。

全局 settings 发现的受控回归在 9 项版探针中实际替换为可加载的旧上游 bundle，透明 fs 观测接缝捕获 FORBIDDEN_SETTINGS_DISCOVERY，结果为 7 pass / 2 fail，其中另一项失败为禁止失败后报告集成通过的总断言。
对应证据为 `curated-extension-settings-confirmed-red-{run.json,output.jsonl}`，这是行为断言拒绝错误实现，不是构建失败，也不是原生 FIFO 阻塞证明。
最初 npm 缓存和工具 allowlist 的 1 pass / 7 fail 记录为 `curated-extension-first-failure-*`，后续错误命令异常预期导致的 3 pass / 6 fail 另保留为 `curated-extension-settings-probe-fixture-failure-*`。
其他名称含 settings-access-red 的早期尝试实际没有传入旧 vendor 注入参数，不能算有效 red 或有效变异证据，原始记录不删除。

本次是 Linux amd64 的实现者验证与 wd-code-review 交付自检，不冒充主代理独立复跑、独立 AI Review 或人工审核。
没有新增依赖或修改锁文件，没有全局安装、网络请求、真实模型调用，也没有读取真实认证、模型配置或会话原文。
未直接注入插件层的 close-unknown 加 reload 组合、真实 OS kill/wait 故障或操作系统文件 I/O 冻结，不将已有桥 unknown 检查扩大为这些组合已验证。
宿主必须继续独占发布目录、检查 SDK 安全错误回执并遵守先停读再发布，插件不提供 watcher、跨进程广播、自动事实审核或生产写入宿主。
后台提炼→审核发布的生产更新闭环仍由下一切片完成，`docs/1.md` 未修改。

## P2 宿主私有故障诊断修复

原闭包 diagnostics 没有可读出口，且只在 close 抛错时采样，导致 confirmed-close 的 cleanup 异常随桥丢失，本次只修此插件交付缺口，不重开既有 bridge 关库／退出协议问题。
Pi 的 appendEntry、自定义消息和 SDK 错误不是私有故障存储，因此使用 Node 文件能力交付固定 HOME 私有快照，不向 session 或模型公开，也不追加命令或配置开关。
具体实现为 `src/curated/owner-diagnostics.mjs`，位置固定为 HOME 下 `.local-project-memory-diagnostics/curated.json`，目录 0700、文件 0600，检查当前用户归属并拒绝符号链接、硬链接和不符权限的现存对象。
最多保留 32 条且完整 JSON 不超过 32768 字节，字段仅包含白名单机器码、阶段、生命周期操作及 bridge 的 PID、closed、forced、exit、shutdown、cleanupErrors、retainedResources，不保存原始异常或任何正文、密钥和路径。
每次 close 均采样，包括实际 confirmed-close 后的关库异常，已释放资源不再保留为 unknown，后续安装和发布仍允许继续。
失败记录同步推进到跨 reload 的有界安全内存，生命周期先推进控制状态并等待进程回收，再有界等待最多一个诊断写任务，不使用 fire-and-forget。
写失败保留原安全故障及独立写失败记录，SDK 只收到无 stack／cause 的固定 `PRIVATE_DIAGNOSTIC_WRITE_FAILED`，本周期工具停用且持有的桥经过回收，后续生命周期重试。
原子 rename 只保证完整快照可见性，多进程为最后成功写入者快照，不保证完整跨进程历史或掉电持久性。
诊断公开等待固定为 1000 毫秒，超时或取消返回 `STOP_UNCONFIRMED`，实际任务、句柄与临时文件跨 reload 保留，不表示底层 I/O 已停止。
未实际完成时拒绝新 flush，不积累写队列或重复关闭仍在途的 fd，确认完成后才允许重试清理与新快照。
晚 open/close 回执只登记并清理，不能恢复正文 write/rename，已发起的 rename 无法抢占，旧任务实际完成前不能开始新快照。

先以旧可构建插件运行新增真实 loader 断言，得到 9 pass / 4 fail，三个诊断场景均明确失败于宿主出口不存在，第四项为禁止失败后报告集成成功的总断言，记录为 `curated-extension-diagnostic-red-*`。
最终从源码重建并执行四条安全脚本，全部退出 0，插件 13 pass / 0 fail、集成 1，约 13.240 秒，原 10 项、干净离线 consumer、settings 隔离和全部旧回归保持通过。
新增场景覆盖实际启动／安装故障的 owner 记录、32 条／32 KiB 限额及 0700／0600、生产 worker stop 的受控关库异常在 confirmed-close 后交付宿主、pause／reload／shutdown 后继续可用、以及真实目标目录冲突导致的诊断写失败和重载重试。
关库异常 fixture 仍实际执行生产 worker stop 和真实 reader close，仅在已关连接后注入固定私有异常，不是 SQLite 原生 close 失败复现。
目标目录冲突验证不代表已模拟磁盘满、内核写故障、native FileHandle close／unlink 失败或文件系统冻结，插件 close-unknown＋reload 组合仍未直接注入。
最新全部 18 个 runner 退出 0，ready／parentReaped／groupGone 为 true、forced 为 false、cleanupErrors 为空，根 14 项和 typecheck 保持通过。
最终日志为 `curated-extension-diagnostic-green-check.log`、`curated-extension-diagnostic-sdk-check.log`、`curated-extension-diagnostic-public-check.log`、`curated-extension-diagnostic-dispatch-check.log`，实现者自检不代替主代理独立复跑及原 reviewer 复核。

主代理已从最终源码独立执行四条安全检查，均退出 0，插件 13 项及真实 loader 集成 1 通过，耗时 11.036 秒，全部旧回归通过。
独立日志为 `../validation/project-cm/curated-extension-diagnostic-main-checks.log`，测试前后核对的源码摘要均一致，18 个外层 runner 确认回收且无外层强杀或清理错误。
原 reviewer 串行只读复核已关闭诊断 P2，只读切片限定验收通过。
后续可信写宿主更新闭环也已完成主代理独立复跑及串行只读复核，当前完整总览以 [`docs/1.md`](1.md) 为准，不以本页历史只读切片记录代替写侧证据。
本轮诊断挂起 open/close 产品首红为 0/2，修后主代理独立故障片为 6/0，均实际回收，证据见 `owner-diagnostics-red-2-*` 与 `main-owner-diagnostics-independent-1.*`。
该故障片和只读复审不能替代新分发、旧状态迁移专项或最终完整组合的验证。
