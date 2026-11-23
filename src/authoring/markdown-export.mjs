import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./knowledge-curation.mjs";
import { readCurrentCuration } from "../curated/current-curation.mjs";
import { validateKnowledgeProject } from "../curated/sqlite-knowledge.mjs";
// 内容按纯文本渲染，不允许知识正文注入 Markdown 结构、HTML 或主动链接。
const label = value => value.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\r\n]/g, character => `&#${character.codePointAt(0)};`);
const prose = value => value.split(/\r\n?|\n/).map(line => label(line).replace(/^[ \t]+/, spaces => [...spaces].map(character => `&#${character.codePointAt(0)};`).join(""))).join("  \n");

function renderKnowledge(row) {
  const p = row.projection;
  const facts = JSON.parse(p.facts ?? "[]");
  const lines = [`# ${label(p.title?.trim() || p.knowledgeId)}`, ""];
  if (p.subtitle?.trim()) lines.push(prose(p.subtitle), "");
  if (p.narrative?.trim()) lines.push(prose(p.narrative), "");
  if (facts.length) lines.push("## 要点", "", ...facts.map(value => `- ${prose(value).replaceAll("\n", "\n  ")}`), "");
  lines.push("## 适用范围", "", prose(p.scope), "", "## 如何核对", "");
  for (const evidence of row.evidence) lines.push(prose(evidence), "");
  lines.push(`来源：${label(p.source)}  `, `修订：${row.revision}（${label(p.knowledgeId)}）`, "");
  return lines.join("\n");
}
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

项目：${label(project)}

这是从 SQLite 生成的阅读视图，请勿直接编辑。
`;
    for (const category of CATEGORIES) {
      home += `
## ${category}

`;
      for (const row of rows.filter((r) => r.projection.category === category)) {
        const p = row.projection, path = `${category}/${p.knowledgeId}.md`;
        home += `- [${label(p.title ?? p.knowledgeId)}](${encodeURI(path)})
`;
        files[path] = renderKnowledge(row);
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
