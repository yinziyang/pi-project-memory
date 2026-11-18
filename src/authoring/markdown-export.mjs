import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./knowledge-curation.mjs";
import { readCurrentCuration } from "../curated/current-curation.mjs";
import { validateKnowledgeProject } from "../curated/sqlite-knowledge.mjs";
// 动态围栏保留原文（含 BOM），不让标题、HTML 或链接成为可执行 Markdown 语法。
function literal(value) {
  const s = value === null ? "（SQL NULL）" : String(value);
  let longest = 2;
  for (const match of s.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}text
${s}
${fence}
`;
}
const label = (s) => String(s).replace(/[&<>"'\[\]\\`*_!()\r\n]/g, (c) => `&#${c.codePointAt(0)};`);
/** 从发布时绑定的同一 SQLite 快照生成只读视图，不接受旧发布库或 verified 标志。
 * 调用方独占源路径、可信父目录及连接；本函数持有 BEGIN IMMEDIATE 至同步子进程退出，阻止协作 SQLite writer，不防御同 UID 恶意替换。
 * 必须在 run.py 或等效有界进程组隔离中调用，取消由外层终止并回收整个进程组，不得在共享服务事件循环中调用。
 * Python 子进程只负责本地树校验和原子交换，不连接模型、网络或认证服务。
 * 源连接始终归调用方所有，ROLLBACK 失败会汇总原错与已知发布 outcome、snapshot 和 cleanupError，不关闭借用连接。
 * transaction-release-unconfirmed 表示调用方须在隔离进程中确认释放或退出，不得据此假定发布尚未提交。
 */
export function exportMarkdown(db, { project, parentPath, exclusiveSourcePath = false, timeoutMs = 15000, python = "python3", helperPath = fileURLToPath(new URL("./markdown-swap.py", import.meta.url)) }) {
  validateKnowledgeProject(project);
  if (exclusiveSourcePath !== true) {
    throw new Error("MD_EXCLUSIVE_SOURCE_REQUIRED");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new Error("MD_TIMEOUT");
  }
  let outcome = "not-started", snapshot, helperResult, originalError;
  db.exec("BEGIN IMMEDIATE");
  try {
    const checked = readCurrentCuration(db, { project });
    const rows = checked.rows;
    snapshot = checked.generation;
    const identity = Buffer.from(JSON.stringify({ version: 1, project, snapshot })).toString("base64");
    const files = {};
    let home = `<!-- project-memory-export:${identity} -->
# 项目知识阅读视图

${literal(project)}
快照：${snapshot}

仅包含宿主登记及精选发布的当前知识，不是自动事实验证或可编辑权威库。
`;
    for (const category of CATEGORIES) {
      home += `
## ${category}

`;
      for (const row of rows.filter((r) => r.projection.category === category)) {
        const p = row.projection, path = `${category}/${p.knowledgeId}.md`;
        home += `- [${label(p.title ?? p.knowledgeId)}](${encodeURI(path)})
`;
        let body = `# 知识正文

## 当前修订（revision）

${literal(row.revision)}
`;
        const headings = { knowledgeId: "稳定标识", category: "分类", scope: "适用范围", source: "来源", project: "项目", type: "知识类型", title: "标题", subtitle: "副标题", narrative: "正文", facts: "事实", concepts: "概念", created_at: "原始创建时间", created_at_epoch: "原始创建时间戳" };
        for (const [key, value] of Object.entries(p)) body += `## ${headings[key]}（${key}）

${literal(value)}
`;
        body += `## 公开实施证据

${row.evidence.map(literal).join("\n")}
## 快照

${literal(snapshot)}`;
        files[path] = body;
      }
    }
    files["README.md"] = home;
    // 从启动 helper 到取得可信成功回执前，失败只意味着提交未知，不能盲回滚文件树。
    outcome = "commitunknown";
    const result = spawnSync(python, [helperPath, parentPath], { input: JSON.stringify({ version: 1, project, snapshot, directories: CATEGORIES, files }), encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw new Error(`MD_SWAP_FAILED_OR_COMMIT_UNKNOWN: ${result.stderr || result.error?.code || result.signal}`);
    }
    helperResult = JSON.parse(result.stdout);
    if (!["committed", "unchanged"].includes(helperResult.status) || helperResult.snapshot !== snapshot) {
      throw new Error("MD_HELPER_RECEIPT");
    }
    outcome = helperResult.status;
  } catch (error) {
    originalError = error;
  }
  // 事务释放是独立清理阶段，失败不能覆盖文件树的已知提交结果或 helper 原错。
  try {
    db.exec("ROLLBACK");
  } catch (cleanupError) {
    const failure = new AggregateError(originalError ? [originalError, cleanupError] : [cleanupError], "MD_SOURCE_TRANSACTION_RELEASE_FAILED", { cause: originalError ?? cleanupError });
    Object.assign(failure, { outcome, snapshot, helperResult, originalError, cleanupError, sourceConnection: { owner: "caller", state: "transaction-release-unconfirmed" } });
    throw failure;
  }
  if (originalError) {
    Object.assign(originalError, { outcome, snapshot, sourceConnection: { owner: "caller", state: "transaction-released" } });
    throw originalError;
  }
  return helperResult;
}
