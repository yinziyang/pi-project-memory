import { mkdirSync, lstatSync, writeFileSync, unlinkSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { assertPublicationSeparation } from "./private-directory.mjs";
import { publishCurrentCuration } from "./knowledge-curation.mjs";
import { exportMarkdown } from "./markdown-export.mjs";
import { readCurrentCuration } from "../curated/current-curation.mjs";
const PAUSE = "local-project-memory-paused-v1\n";
/** 实际插件 pause 完成后由可信宿主持久封锁重开，既存未知 marker 不覆盖。 */
export function retainPublicationPause(projectPath) {
  const marker = join(projectPath, ".project-memory-paused");
  try {
    writeFileSync(marker, PAUSE, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || readFileSync(marker, "utf8") !== PAUSE) {
      throw new Error("PUBLIC_PAUSE_CONFLICT");
    }
  }
}
/** 在全部协作 reader 已暂停后构建并交换 SQLite、MD、descriptor 整套快照。
 * projectPath 必须是可信宿主选定的当前项目真实目录，不能来自模型参数。
 * 调用方独占父目录且保证暂停所有 reader，失败时必须保持停用，不自动恢复 last-good。
 * 同步 Python 工作只允许在宿主隔离进程内执行，Linux 本地文件系统限定，交换后的清理失败保留 committed 状态。
 */
export function publishProject(db, { project, projectPath, readersPaused, python = "python3" }, { openPublic = (path) => new Database(path), closePublicConnection = (connection) => connection.close() } = {}) {
  if (readersPaused !== true) {
    throw new Error("READERS_MUST_BE_PAUSED");
  }
  if (typeof projectPath !== "string" || realpathSync(projectPath) !== projectPath || !lstatSync(projectPath).isDirectory()) {
    throw new Error("PUBLIC_PROJECT_PATH");
  }
  assertPublicationSeparation(db, projectPath);
  retainPublicationPause(projectPath);
  const stage = join(projectPath, ".project-memory-next");
  try {
    lstatSync(stage);
    throw new Error("PUBLIC_STAGE_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  db.exec("CREATE TABLE IF NOT EXISTS host_publication(id INTEGER PRIMARY KEY CHECK(id=1),stage TEXT NOT NULL,generation TEXT);CREATE TABLE IF NOT EXISTS host_publication_owner(id INTEGER PRIMARY KEY CHECK(id=1),parent BLOB NOT NULL,token TEXT NOT NULL)");
  const token = randomUUID();
  db.transaction(() => {
    db.run("INSERT INTO host_publication VALUES(1,'building',NULL) ON CONFLICT(id) DO UPDATE SET stage='building',generation=NULL");
    db.run("INSERT INTO host_publication_owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,token=excluded.token", [Buffer.from(projectPath), token]);
  })();
  mkdirSync(stage, { mode: 0o700 });
  writeFileSync(join(stage, ".stage-owner"), token, { flag: "wx", mode: 0o600 });
  let publicDb, closeAttempted = false, generation, receipt, originalError;
  let phase = "building", outcome = "not-committed";
  const cleanupErrors = [], retainedResources = [];
  function closePublic() {
    closeAttempted = true;
    try {
      closePublicConnection(publicDb);
      publicDb = undefined;
    } catch (error) {
      retainedResources.push({ owner: "publishProject", resource: "staged-public-sqlite", state: "close-unconfirmed" });
      throw error;
    }
  }
  try {
    publishCurrentCuration(db, { project, targetPath: join(stage, "knowledge.sqlite") });
    publicDb = openPublic(join(stage, "knowledge.sqlite"));
    generation = readCurrentCuration(publicDb, { project }).generation;
    exportMarkdown(publicDb, { project, parentPath: stage, exclusiveSourcePath: true, python, timeoutMs: 15000 });
    closePublic();
    unlinkSync(join(stage, ".md-export.lock"));
    writeFileSync(join(stage, "curated.json"), JSON.stringify({ version: 1, project, generation }) + "\n", { flag: "wx", mode: 0o600 });
    phase = "commit-unconfirmed";
    outcome = "unconfirmed";
    db.run("UPDATE host_publication SET stage='commit-unconfirmed',generation=? WHERE id=1", [generation]);
    unlinkSync(join(stage, ".stage-owner"));
    const helper = spawnSync(python, [fileURLToPath(new URL("./publication-swap.py", import.meta.url))], {
      input: JSON.stringify({ project, parent: projectPath }),
      encoding: "utf8",
      timeout: 15000,
      killSignal: "SIGKILL",
      maxBuffer: 8192
    });
    if (helper.error || helper.status !== 0) {
      throw new Error("PUBLICATION_UNCONFIRMED");
    }
    receipt = JSON.parse(helper.stdout);
    if (receipt.stage !== "committed" || receipt.generation !== generation || !["none", "removed", "retained"].includes(receipt.cleanup)) {
      throw new Error("PUBLICATION_UNCONFIRMED");
    }
    phase = "committed";
    outcome = "committed";
    db.run("UPDATE host_publication SET stage='committed' WHERE id=1");
    if (receipt.cleanup === "retained") {
      throw new Error("PUBLICATION_COMMITTED_CLEANUP_RETAINED");
    }
    retainPublicationPause(projectPath);
    unlinkSync(join(projectPath, ".project-memory-paused"));
  } catch (error) {
    originalError = error;
  }
  // 清理独立于原错与提交结果，只尝试关闭一次，未知关闭状态保留 stage，不能重试 close 后谎报已释放。
  if (publicDb && !closeAttempted) {
    try {
      closePublic();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (originalError || cleanupErrors.length) {
    const failure = cleanupErrors.length ? new AggregateError([originalError, ...cleanupErrors].filter(Boolean), "PUBLICATION_CLEANUP_FAILED", { cause: originalError ?? cleanupErrors[0] }) : originalError;
    Object.assign(failure, { originalError, cleanupErrors, retainedResources, publication: { stage: phase, generation, outcome } });
    throw failure;
  }
  return receipt;
}
/** 新宿主取得私有 owner 且实际暂停全部 reader 后显式恢复，不从未确认结果回滚。
 * 已封存整套 snapshot 验证一致后续交或确认已提交，部分构建只移入保留目录而不删除或发布。
 * 未知文件、链接、错误 owner、手改 manifest 或未知 marker 拒绝，失败继续保持持久停服。
 */
export function recoverProject(db, { project, projectPath, readersPaused, python = "python3" }) {
  if (readersPaused !== true) {
    throw new Error("READERS_MUST_BE_PAUSED");
  }
  assertPublicationSeparation(db, projectPath);
  retainPublicationPause(projectPath);
  const owner = db.query("SELECT parent,token FROM host_publication_owner WHERE id=1").get();
  const state = db.query("SELECT stage,generation FROM host_publication WHERE id=1").get();
  if (!owner || !state || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(owner.parent) !== projectPath) {
    throw new Error("RECOVERY_OWNER_REQUIRED");
  }
  const result = spawnSync(python, [fileURLToPath(new URL("./publication-recover.py", import.meta.url))], {
    input: JSON.stringify({ project, parent: projectPath, generation: state.generation, token: owner.token }),
    encoding: "utf8",
    timeout: 15000,
    killSignal: "SIGKILL",
    maxBuffer: 8192
  });
  if (result.error || result.status !== 0) {
    throw new Error("RECOVERY_UNCONFIRMED");
  }
  const receipt = JSON.parse(result.stdout);
  if (receipt.stage === "staging-retained") {
    db.run("UPDATE host_publication SET stage='staging-retained' WHERE id=1");
    return receipt;
  }
  if (receipt.stage !== "committed" || receipt.generation !== state.generation || !["none", "removed"].includes(receipt.cleanup)) {
    throw new Error("RECOVERY_UNCONFIRMED");
  }
  db.run("UPDATE host_publication SET stage='committed' WHERE id=1");
  retainPublicationPause(projectPath);
  unlinkSync(join(projectPath, ".project-memory-paused"));
  return receipt;
}
