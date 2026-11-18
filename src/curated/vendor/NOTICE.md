# 上游检索产物来源

`session-search.mjs` 是 claude-mem 的 SessionSearch 及其静态传递依赖的独立 ESM 构建产物，用于专用 Bun 只读进程。
上游固定提交为 `f705e9b99601dd9ac03e2f77c5aded6ff3d9471b`，源入口为 `src/services/sqlite/SessionSearch.ts`。
上游按 Apache License 2.0 授权，许可证完整副本为本目录 `LICENSE.claude-mem`。
第三方源码注释保留原文，构建产物内的 `validation/upstream` 只表示构建来源注释，不是运行时导入路径。

维护者在已有固定检出和 esbuild 0.28.2 环境中可按以下命令重新生成，本包的普通构建及消费者运行不执行此命令，也不依赖该检出。

```sh
node scripts/regenerate-curated-search.mjs
```

构建时将上游 paths/logger 两个副作用边界替换为本目录的窄适配器，禁止默认库路径、用户 settings 发现及上游日志初始化，检索 SQL 与查询实现不变。
诊断仅向专用 worker 的 stderr 写固定事件，不携带正文或原始异常。
本产物不包含 SessionStore 写库入口、模型调用或提炼 worker。
