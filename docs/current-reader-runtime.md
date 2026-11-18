# 正式当前 reader 与本地 index 接线

本文件约定正式工厂、私有 indexed IPC 和显式本地配置，Pi 入口已使用该工厂并接入任务与状态来源。
后台 namespace 预算与 FIFO 注入有效性两 P2 已修复并独立复审关闭，真实本地 E5/Chroma、专项 reader/index 与最终 Pi 入口的正式 SDK 组合均已有主代理独验，Linux 六套回归已完成，不推广为模型质量或 macOS 通过。

## 工厂与所有权

```js
const indexConfig = await readIndexConfig(canonicalCwd);
const reader = createCurrentReaderRuntime({
  project,
  cwd: canonicalCwd,
  bunPath: trustedBunPath,
  indexConfig,
  getBinding: async ({ signal }) => {
    signal.throwIfAborted();
    return { sourceBinding, checkoutToken, ownerEpoch };
  },
});
await reader.install({ publicPath, generation, signal });
```

`getBinding` 只在 index 显式启用时需要，必须来自可信宿主当前 scope，不得从公开 descriptor、模型响应或 tool 参数构造授权。
回调必须合作取消，并返回非空有效 Unicode 的 sourceBinding/checkoutToken 和非负安全整数 ownerEpoch，runtime 在每次跨进程工作前后重新核对三者与安装时快照完全一致。
canonical cwd、project 与已读取 index 配置必须精确相同，公开 descriptor 仅选择当前 SQLite，不可授权新的模型、Python 或缓存路径。

工厂提供与既有 reader 兼容的 install/search/read/transition/close，并新增 status、仅可信宿主显式修复索引的 refreshIndex 与只给可信宿主的 diagnostics。
`status({signal})` 返回 `{project,generation,totalRows,index}`，totalRows 来自 install 后同一完整校验只读事务，不是分页候选数，也不因 index 未就绪而归零。
状态快照不占用 Bun 的唯一 IPC 槽，因此在 E5 冷 query 期间仍能读取，但授权已改变或 transition 后必须拒绝旧快照。

runtime 独占 Node index owner 与 Bun bridge，index 直接拥有 Bun 导出、Node E5 和 Python Chroma/lease worker，Bun reader 不派生进程。
模型文件只是只读借用，runtime 不关闭 getBinding 回调所引用的宿主资源，也不修改或删除全局模型缓存。
调用方须以固定 revision 的不可变目录提供模型资产，所有借用实例完成 close 前不得原地替换，升级时使用新目录与重新核对的配置和许可，本库不能阻止其他进程修改借用资产。

## 超时与自动构建

install 只等待旧有 Bun 的 5 秒启动/安装及完整状态读取，不等待 E5 或 Chroma 初始化。
后台 index 构建与 Node dense 查询固定使用 180000 毫秒总预算，取消仍需 TERM 宽限、KILL 与实际回收确认，取消后固定最多等待 3500 毫秒，未 settle 只返回 UNCONFIRMED 并保留真实任务与资源，不提前返回假装同步 ORT 已停止。
后台预算观察覆盖 namespace 初始化与后续构建，namespace 的真实 fd 仍在途时必须隔离停服，不得无限保持 BUILDING 并继续成功降级。
Bun IPC 的单请求预算仍为 10000 毫秒，没有把模型放进旧 5 秒/10 秒窗口。

显式 index 配置时工厂公开 `toolTimeoutMs=180000`，正式 Pi 接线仅在该情况下将 `createMemoryTools` 的 timeoutMs 设为该值，未配置时仍为原 15000 毫秒。
构建 E5 仍独立启动，查询 E5 按需启动并在同一索引所有者内短时复用，空闲 15 秒后开始关闭并等待实际回收。
首次启动仍校验模型文件，查询预算不因复用延长，取消、刷新或撤销旧绑定后不能把旧进程交给后续查询。
Chroma 仍按查询打开和关闭，首次查询不等于热查询。

安装当前代后自动启动一次构建，BUILDING、缺模型、缺依赖、旧代或 profile 不合均明确走当前 SQLite FTS，并保留固定 degradation。
matching index 的内容或协议错误会锁存 INDEX_INVALID，第一次与连续后续检索都必须失败，重启后对 matching ready 重新验证发现坏内容也必须持续失败，不能把撤销 ready 当作缺索引并偷偷转为 FTS 成功。
只有可信宿主显式调用 `await runtime.refreshIndex({signal})` 并成功验证或重建后才能恢复 dense，该方法不新增配置、不删除旧 stage、不授予未知缓存根的 reset 权限，也不由普通 search 自动调用。
显式修复使用相同 180000 毫秒预算并保留当前绑定，修复期间独占检索槽，status 仍可读取，失败会继续保持错误状态。
允许成功降级的完整枚举为 `INDEX_MISSING`、`INDEX_GENERATION_MISMATCH`、`INDEX_MODEL_MISSING`、`DEPENDENCY_MISSING`、`INDEX_MODEL_PROFILE_MISMATCH`、`BUILDING` 与 `INDEX_CACHE_UNAVAILABLE`，INDEX_INVALID 不是 degradation。
INDEX_CACHE_UNAVAILABLE 只表示尚未建立可信 matching index 的未知或不可用缓存被拒绝并保留，不代表已发现 matching 数据损坏可以降级。

## 私有 indexed IPC

`createCuratedReaderBridge` 的 allowDense 默认为 false，只有可信 runtime 构造时可以开启。
默认普通请求输入上限仍为 8192 字节，只有显式 searchIndexed 请求可使用 32768 字节，输出上限仍为 131072 字节。
普通 search 在 Node bridge、Bun worker 和 public reader 三层均拒绝 dense/candidates 等未知字段，不接受从 tool 或公开 descriptor 注入的向量候选。

runtime 先在 Node owner 中完成 index.search，再调用 bridge.searchIndexed({query,topK,generation,candidates,signal})。
worker 只在这一串行请求内建立借用 dense adapter，允许最多十个 v2 稳定 refs，拒绝重复引用、错误分数和额外正文字段。
既有 public reader 随后在当前只读 SQLite 事务中严格核对 project/generation/knowledgeId/revision，并从 SQLite 生成 title、summary、scope 和 source，index body 不参与水合。
adapter 在请求 finally 中撤销，普通 search 不会沿用上一个 indexed 请求的候选。

旧 source ref 在 G2 安装后必须失败，即使旧 observation rowid 与新数据碰巧相同，也不得用 rowid、索引正文或分数替代稳定引用。

## 用户级初始化与显式 HOME 配置

在可信项目中执行 `/memory-init`，使用已有 Python 3.13 与 `uv` 将固定 E5 模型和锁定的 Chroma 环境安装到 `~/.local/share/local-project-memory/`。
安装成功回执让本用户打开的可信有效发布项目默认使用向量索引，不扫描其他项目，不在加载插件时自动安装或下载。
各项目共享模型和 Python 环境，缓存根按规范 checkout 路径与项目标识分开。
`/memory-status` 的安装文件状态不代表当前索引已验证，更不代表每次检索成功。缺少可用资产时可走 SQLite 降级，匹配索引损坏仍按前述规则报错。

可选覆盖文件为 HOME/.local-project-memory-index/config.json，显式 `enabled=false` 优先关闭。未配置且没有有效安装回执时默认关闭，不创建目录、不启动模型或读取会话。
HOME 仅由可信宿主提供，测试必须使用 synthetic HOME，不读取真实用户 auth/models/capture 数据库。
配置目录要求当前 UID 所有、canonical、0700，文件要求无链接、单硬链接普通文件、0600、至多 16 KiB，严格 JSON 拒绝 BOM、坏 UTF-8、重复键和未知字段。

```json
{
  "version": 1,
  "enabled": true,
  "projects": [
    {
      "cwd": "/canonical/project",
      "project": "approved-project",
      "cacheRoot": "/canonical/private-index-base",
      "modelRoot": "/canonical/read-only-models",
      "manifestPath": "/canonical/e5-model-manifest.json",
      "pythonPath": "/canonical/project-runtime/.venv/bin/python",
      "bunPath": "/canonical/project-runtime/bin/bun",
      "allowCreateCache": true
    }
  ]
}
```

projects 最多 32 项，cwd 不可重复，字段必须是绝对规范路径，只有当前 canonical cwd 精确匹配的一项生效。
Node 固定使用 process.execPath，Transformers 只在已有 E5 隔离子进程的只解析模式通过 import.meta.resolve 解析根依赖入口，不在 Pi Node 同步解析包元数据，也不在配置读取或普通 SQLite 安装期间导入模型代码。
Python/Bun 可使用可信虚拟环境可执行文件的叶符号链接，但其父路径不能经链接改写。
allowCreateCache 只授权在已存在规范父目录下创建指定专用 cacheRoot 及其派生 namespace，不创建未知祖先、下载模型或安装依赖。

cacheRoot 与项目、模型、manifest、index/capture 配置目录和 capture privateRoot 均不得相互包含。
`readCaptureConfig(cwd,{includeDisabled:true})` 只为该安全检查读取停用绑定的 cwd/project/privateRoot 元数据，不返回停用绑定的 Bun 启动能力，默认调用行为保持不变。
archive/cache/config 物理重叠、符号链接缓存根、未知手工缓存根或错误归属 marker 均拒绝，不提供 reset 或自动递归删除。

cacheRoot 是受标记的专用基目录，内部叶名固定为 `sha256({version:1,cwd,project,sourceBinding,checkoutToken,ownerEpoch})`，不拼接原始 metadata。
不同工作树、来源、checkout 或 epoch 使用不同 ready 指针，旧 build 即使晚结束也不能安装到新的运行 namespace。
该正式工厂的 namespace 策略比独立 index 的通用 cacheRoot 接口更严格，不把运行许可混入模型 fingerprint。

## transition 与关闭

transition 先同步撤销 slot、推进 epoch、取消在途 query/build/install，再并行实际关闭 index 与 Bun，最后等待全部已登记任务 settle。
启动任务在授权回调和 Bun 启动之前登记，晚授权或晚安装不能在 transition 后重新开门。
transition/close 从入口起最多等待 5000 毫秒，超时撤销所有服务资格并返回 UNCONFIRMED，真实 promise/fd/worker 强引用仍留在 owner，禁止安装和发布。
close 为终态，不接收新调用，重复调用可以在真实工作完成后重新确认清理，晚回调仅收尾而不重新开门。
当前具体屏障、错误码与门控证据以 `docs/n05-index-unconfirmed-lifecycle.md` 为准。
一项 close 失败不能跳过另一项释放，抛出的 AggregateError 保留每项 cleanupErrors 与 retainedResources，原始路径/错误只留在可信 diagnostics，不进入 tool 或状态输出。
回收不确定时保留 owner 和目录并禁止新的 install，不用回调返回、Promise.race 或 PID 文件假称 worker 已关闭。

## 受管验证与剩余边界

Node manifest/cache JSON 有界读取收口见 `docs/n05-index-json-boundary.md`，之后的公开有界等待、UNCONFIRMED 强引用与隔离提交见 `docs/n05-index-unconfirmed-lifecycle.md`，下列记录保留为 matching 持续失败修复阶段的证据，不冒充当前源码的独立复验。

独有测试入口为 `tests/current-reader-unit.test.mjs`、`tests/current-reader-fault.test.mjs` 与 `tests/current-reader-real.test.mjs`，只能通过 run.py 对应专属模式执行行为测试。
fault/real 由 run.py 提供 N05_MANAGED_RUN=1 与只含路径的 N05_TEST_RUNTIME，预算分别为 40 秒与 300 秒，unit 预算为 40 秒。
真实 fixture 通过既有审核与 publication 协议生成 G1/G2/G3，不伪造 curated flag，也不访问远端模型或 MCP。

原独立 index 的首次红与正式根依赖证据已单独保存在 `validation/project-cm/n05-frozen-*-20260817.{log,jsonl}`，其摘要为 `validation/project-cm/n05-frozen-evidence-20260817.json`。
这些已通过证据不自动覆盖此处新增 runtime/config/bridge，新的首轮失败与复验另行记录，不覆盖 main 的独立复跑日志。

本轮 current-reader-unit 首次 5/5 通过，fault 首次 1/1 通过，real 首次因未创建的 capture 保护路径被误要求 realpath 而失败，首次日志保留为 `validation/project-cm/n05-current-reader-{unit,fault,real}-first.{log,jsonl}`。
共享 canonicalFuturePath 现在校验现有祖先并保留未来目录的完整后缀，不隐式创建目录，也不把未来保护路径忽略掉。
matching 连续查询缺失拒绝的真实红保留为 `validation/project-cm/n05-matching-repeat-red.{log,jsonl}`，修复后 owner 与 runtime 都持续失败，直到显式修复成功。

| 专属受管模式 | 修复后实际结果 | 独立日志前缀 |
| --- | --- | --- |
| current-reader-unit | 5/5 通过，exit 0 | `validation/project-cm/n05-current-reader-unit-fix1` |
| current-reader-fault | 1/1 通过，含私有 IPC、坏 refs、缺模型/依赖与未知 cache，exit 0 | `validation/project-cm/n05-current-reader-fault-fix1` |
| current-reader-real | 1/1 通过，84.67 秒，成功 marker 一次 | `validation/project-cm/n05-current-reader-real-fix1` |
| current-index-unit | 8/8 通过，新增未来保护路径检查，exit 0 | `validation/project-cm/n05-index-unit-matching-fix1` |
| current-index-fault | 7/7 通过，exit 0 | `validation/project-cm/n05-index-fault-matching-fix1` |
| current-index-real | 1/1 通过，131.529 秒，含重复查询、重启发现 matching 损坏与显式重建，exit 0 | `validation/project-cm/n05-index-real-matching-fix1` |

以上日志均为 `.log` 与 `.jsonl` 两个独立文件，全部确认 parentReaped=true、groupGone=true、cleanupErrors=[]，没有以 Popen 的 ready 标记代替模型 READY。
上述表格仅为 matching 阶段历史记录，不自动覆盖后续后台预算与 FIFO 修复，定版源码须分别绑定独立快照。
后续两 P2 修复后，主代理已独验 index unit10/0、fault16/0、real1/0及 reader unit5/0、fault5/0、real1/0，真实索引135.774秒与reader83.741秒均完成回收，无外层强杀和cleanup错误。
相应证据前缀为 `validation/project-cm/main-n05-p2-*`，正式 SDK 另有 `main-current-reader-pi-sdk-p2-capture-fixed-1.*` 的108.328秒组合证据，不把该次记录自动归给后续 Pi 入口修订。

Linux 本地文件系统限定，不承诺 macOS、NFS、恶意同 UID 或断电持久性。
最终 Pi 入口修订后另行独跑正式 SDK 组合110.731秒通过，覆盖真实加载、自动构建与查询、task/status、scope/checkout 变更后的旧 refs 拒绝，源码快照稳定、实际回收、无外层强杀和cleanup错误，证据为 `validation/project-cm/main-current-reader-pi-sdk-final-diag-fixed-1.*`。
Linux 六套26个受管模式已全部通过，相关独立只读复审已关闭本轮确认问题，N05按上述限定验收完成，不能用组合通过覆盖历史裸E5 top1红门禁。
