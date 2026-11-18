# 私有写宿主依赖来源

`session-store.mjs` 是固定 claude-mem 提交 `f705e9b99601dd9ac03e2f77c5aded6ff3d9471b` 的 SessionStore 及静态依赖构建产物，按 Apache License 2.0 授权，完整许可证为 `LICENSE.claude-mem`。
第三方源码注释保留原文，构建来源注释中的 validation 路径不是运行时导入。
构建替换 paths、settings、logger 三个副作用边界，禁止默认用户数据库、用户配置发现和上游日志初始化，固定关闭模糊去重，实际 SQLite schema 与写入仍由上游实现。
正式宿主及发布器必须传入显式 `Database` 与 `{syncOpsEnabled:false}`，不能调用默认路径构造。
再生成仅由维护者运行 `node scripts/regenerate-authoring-store.mjs`，普通消费者构建不读取固定检出。
检索器复用相邻 `curated/vendor/session-search.mjs`，其许可证与来源说明随正式包一起分发。
