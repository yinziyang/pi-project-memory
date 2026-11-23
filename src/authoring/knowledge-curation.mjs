import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { openSync, closeSync, rmSync, lstatSync } from "node:fs";
import { SessionStore } from "./vendor/session-store.mjs";
import { SessionSearch } from "../curated/vendor/session-search.mjs";
import { readCurrentCuration } from "../curated/current-curation.mjs";
import { readKnowledgeRows, validateKnowledgeProject } from "../curated/sqlite-knowledge.mjs";
import { CATEGORIES } from "../curated/knowledge-categories.mjs";
export { CATEGORIES } from "../curated/knowledge-categories.mjs";
import { FIELDS } from "../curated/knowledge-fields.mjs";
export { FIELDS } from "../curated/knowledge-fields.mjs";
const text = (value) => {
  if (typeof value !== "string" || !value.isWellFormed() || !value.trim()) {
    throw new Error("CURATION_TEXT");
  }
  return value;
};
const bytes = (value) => Buffer.from(value, "utf8");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = (value) => {
  if (typeof value !== "string" || !/^k-[a-z0-9][a-z0-9-]{0,79}$/.test(value)) {
    throw new Error("CURATION_ID");
  }
};
const revision = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("CURATION_REVISION");
  }
};
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const decode = (value) => JSON.parse(decoder.decode(value));
function time(value) {
  text(value);
  if (!/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("CURATION_TIME");
  }
}
// 所有私有元数据先读取 typeof/BLOB，禁止 Bun 的宽松 TEXT 解码吞掉坏字节或 BOM。
function records(db, table, shape) {
  const fields = Object.keys(shape);
  return db.query(`SELECT ${fields.map((f) => `typeof(${f}) AS ${f}_type,CAST(${f} AS BLOB) AS ${f}_bytes`).join(",")} FROM ${table}`).all().map((raw) => {
    const row = {};
    for (const field of fields) {
      if (raw[field + "_type"] !== shape[field]) {
        throw new Error("CURATION_METADATA_TYPE");
      }
      const value = raw[field + "_bytes"];
      if (shape[field] === "blob") {
        row[field] = value;
        continue;
      }
      const decoded = decoder.decode(value);
      if (shape[field] === "integer") {
        if (!/^(0|[1-9][0-9]*)$/.test(decoded) || !Number.isSafeInteger(Number(decoded))) {
          throw new Error("CURATION_METADATA_INTEGER");
        }
        row[field] = Number(decoded);
      } else row[field] = text(decoded);
    }
    return row;
  });
}
function checkSchema(db) {
  if (db.query("PRAGMA encoding").get().encoding !== "UTF-8") {
    throw new Error("CURATION_ENCODING");
  }
  const meta = records(db, "curation_meta", { version: "integer" });
  if (meta.length !== 1 || meta[0].version !== 1) {
    throw new Error("CURATION_SCHEMA");
  }
}
function entries(db) {
  const rows = records(db, "curation_entry", { project: "text", knowledge_id: "text", observation_id: "integer", revision: "integer", status: "text" });
  for (const row of rows) {
    validateKnowledgeProject(row.project);
    id(row.knowledge_id);
    revision(row.revision);
    if (row.revision < 1 || row.observation_id < 1 || !["active", "needs_revalidation"].includes(row.status)) {
      throw new Error("CURATION_ENTRY");
    }
  }
  return rows;
}
function history(db, project, knowledgeId) {
  return records(db, "curation_revision", { project: "text", knowledge_id: "text", revision: "integer", projection: "blob", digest: "text", review: "blob", submission_digest: "text" }).filter((r) => r.project === project && r.knowledge_id === knowledgeId).map((r) => {
    revision(r.revision);
    if (r.revision < 1) {
      throw new Error("CURATION_REVISION");
    }
    const p = decode(r.projection), review = decode(r.review);
    if (p.project !== project || p.knowledgeId !== knowledgeId || digest(p) !== r.digest || digest([p, review]) !== r.submission_digest) {
      throw new Error("CURATION_HISTORY_BINDING");
    }
    validateReview(review, p);
    return { ...r, p, review };
  });
}
function projection(db, proposal) {
  id(proposal.knowledgeId);
  validateKnowledgeProject(proposal.project);
  if (!CATEGORIES.includes(proposal.category)) {
    throw new Error("CURATION_CATEGORY");
  }
  text(proposal.scope);
  text(proposal.source);
  const row = readKnowledgeRows(db, { project: proposal.project, selectedIds: [proposal.observationId] })[0];
  return { knowledgeId: proposal.knowledgeId, category: proposal.category, scope: proposal.scope, source: proposal.source, ...Object.fromEntries(FIELDS.map((key) => [key, row[key]])) };
}
/** 仅供受控宿主初始化私有 SessionStore 原连接，不创建第二个权威库，不关闭借用连接。
 * 调用方必须持有单 owner 且不得在其他事务中调用本模块的事务入口，不得把本 API 暴露给模型、RPC 或 apply。
 */
export function initializeCuration(db) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS curation_meta(version INTEGER NOT NULL CHECK(version=1));
      INSERT INTO curation_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM curation_meta);
      CREATE TABLE IF NOT EXISTS curation_entry(knowledge_id TEXT NOT NULL,project TEXT NOT NULL,observation_id INTEGER NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','needs_revalidation')),PRIMARY KEY(project,knowledge_id));
      CREATE TABLE IF NOT EXISTS curation_revision(project TEXT NOT NULL,knowledge_id TEXT NOT NULL,revision INTEGER NOT NULL,projection BLOB NOT NULL,digest TEXT NOT NULL,review BLOB NOT NULL,submission_digest TEXT NOT NULL,PRIMARY KEY(project,knowledge_id,revision));
      CREATE TABLE IF NOT EXISTS curation_invalidation(project TEXT NOT NULL,knowledge_id TEXT NOT NULL,revision INTEGER NOT NULL,record BLOB NOT NULL,PRIMARY KEY(project,knowledge_id,revision));`);
    for (const table of ["curation_revision", "curation_invalidation"]) {
      for (const operation of ["UPDATE", "DELETE"]) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable revision'); END;`);
      }
    }
    checkSchema(db);
  })();
}
/** 从同一快照形成待审核完整投影，返回值不含审核权限，也不代表验证成立。 */
export function prepareCuration(db, proposal) {
  return db.transaction(() => projection(db, proposal))();
}
function validateReview(review, p) {
  if (!review || typeof review !== "object" || Array.isArray(review) || "verified" in review) {
    throw new Error("CURATION_HOST_REVIEW_REQUIRED");
  }
  text(review.approvalId);
  text(review.reviewer);
  time(review.reviewedAt);
  if (digest(review.projection) !== digest(p)) {
    throw new Error("CURATION_REVIEW_BINDING");
  }
  if (!CATEGORIES.includes(p.category)) {
    throw new Error("CURATION_CATEGORY");
  }
  text(p.scope);
  text(p.source);
  if (!Array.isArray(review.evidence) || !review.evidence.length) {
    throw new Error("CURATION_EVIDENCE");
  }
  for (const e of review.evidence) {
    for (const key of ["implementation", "object", "method", "coverage", "source", "publicSummary"]) {
      text(e[key]);
    }
    // 结果必须有具体观测、独立期望和比较结论，字符串口号不是结果结构，但结构本身不证明真实性。
    if (!e.result || typeof e.result !== "object" || Array.isArray(e.result)) {
      throw new Error("CURATION_EVIDENCE_RESULT");
    }
    for (const key of ["observed", "expected", "comparison"]) {
      const value = e.result[key];
      if (typeof value !== "string" || !value.isWellFormed() || !value.trim()) {
        throw new Error("CURATION_EVIDENCE_RESULT");
      }
    }
  }
}
function saveRevision(db, p, review, next) {
  revision(next);
  if (next < 1) {
    throw new Error("CURATION_REVISION");
  }
  db.query("INSERT INTO curation_revision VALUES (CAST(? AS TEXT),?,?,?,?,?,?)").run(bytes(p.project), p.knowledgeId, next, bytes(JSON.stringify(p)), digest(p), bytes(JSON.stringify(review)), digest([p, review]));
}
/** 登记受控宿主审核，绑定完整投影与实际实施证据，宿主负责真实性、语义对应和公开字段批准。
 * expectedRevision 精确匹配或当前恰为原请求的成功结果时幂等，其余过期请求拒绝。
 * 失效后必须有未使用过的 approvalId 和晚于失效时间的新审核，调用方提供所有时间，本模块不自动验证业务事实。
 */
export function registerReviewed(db, { proposal, expectedRevision, review }) {
  revision(expectedRevision);
  return db.transaction(() => {
    checkSchema(db);
    const p = projection(db, proposal);
    validateReview(review, p);
    const current = entries(db).find((e) => e.project === p.project && e.knowledge_id === p.knowledgeId);
    const revisions = history(db, p.project, p.knowledgeId);
    const previous = current && revisions.find((r) => r.revision === current.revision);
    if (current && !previous) {
      throw new Error("CURATION_HISTORY_MISSING");
    }
    const submission = digest([p, review]);
    if (current?.status === "active" && [expectedRevision, expectedRevision + 1].includes(current.revision) && previous.submission_digest === submission && current.observation_id === proposal.observationId) {
      return current.revision;
    }
    if ((current?.revision ?? 0) !== expectedRevision) {
      throw new Error("CURATION_CONFLICT");
    }
    if (revisions.some((r) => r.review.approvalId === review.approvalId)) {
      throw new Error("CURATION_APPROVAL_REUSED");
    }
    if (current?.status === "needs_revalidation") {
      const invalidations = records(db, "curation_invalidation", { project: "text", knowledge_id: "text", revision: "integer", record: "blob" });
      const invalidation = invalidations.find((r) => r.project === p.project && r.knowledge_id === p.knowledgeId && r.revision === current.revision);
      if (!invalidation) {
        throw new Error("CURATION_INVALIDATION_MISSING");
      }
      const event = decode(invalidation.record);
      time(event.invalidatedAt);
      if (revisions.some((r) => r.review.approvalId === review.approvalId) || Date.parse(review.reviewedAt) <= Date.parse(event.invalidatedAt)) {
        throw new Error("CURATION_FRESH_APPROVAL_REQUIRED");
      }
    }
    const next = expectedRevision + 1;
    saveRevision(db, p, review, next);
    db.query(`INSERT INTO curation_entry VALUES (?,CAST(? AS TEXT),?,?,'active') ON CONFLICT(project,knowledge_id) DO UPDATE SET observation_id=excluded.observation_id,revision=excluded.revision,status='active'`).run(p.knowledgeId, bytes(p.project), proposal.observationId, next);
    return next;
  })();
}
/** 失效创建独立的私有不可变修订与原因、时间、审核者记录，立即撤出当前集合，旧审批不能重放复活。 */
export function invalidateKnowledge(db, { knowledgeId, project, expectedRevision, reason, invalidatedAt, reviewer }) {
  id(knowledgeId);
  validateKnowledgeProject(project);
  revision(expectedRevision);
  text(reason);
  text(reviewer);
  time(invalidatedAt);
  return db.transaction(() => {
    checkSchema(db);
    const entry = entries(db).find((e) => e.project === project && e.knowledge_id === knowledgeId);
    if (!entry || entry.revision !== expectedRevision || entry.status !== "active") {
      throw new Error("CURATION_CONFLICT");
    }
    const previous = history(db, project, knowledgeId).find((r) => r.revision === entry.revision);
    if (!previous) {
      throw new Error("CURATION_HISTORY_MISSING");
    }
    if (Date.parse(invalidatedAt) < Date.parse(previous.review.reviewedAt)) {
      throw new Error("CURATION_TIME");
    }
    const next = expectedRevision + 1;
    saveRevision(db, previous.p, previous.review, next);
    db.query("INSERT INTO curation_invalidation VALUES (CAST(? AS TEXT),?,?,?)").run(bytes(project), knowledgeId, next, bytes(JSON.stringify({ reason, invalidatedAt, reviewer })));
    db.query("UPDATE curation_entry SET status='needs_revalidation',revision=? WHERE CAST(project AS BLOB)=? AND knowledge_id=?").run(next, bytes(project), knowledgeId);
    return next;
  })();
}
/** 同一源事务验证全部当前登记，发布新 SessionStore observations/FTS 及只含当前公开审核元数据的映射。
 * 无登记项目拒绝，只有确定的 needs_revalidation 才可形成空快照，未登记 observation 不属于精选集合。
 * 源连接由单 owner 调用方持有，目标由本函数独占创建及关闭，失败只删除自己创建的文件。
 * 父目录必须可信且由调用方独占，创建前拒绝任何既存 main/-wal/-shm（含悬挂链接），不防御同 UID 持续恶意替换祖先路径。
 * 第三参数是目标资源故障测试的窄边界，createTarget 抛错前须释放其内部资源，返回后所有权交给本函数，closeTarget 只有确认关闭后才能成功返回。
 * 关闭未确认时保留整个目标文件族，调用方必须确认隔离进程已退出后再处理，不得直接删除仍可能被使用的数据库。
 * 清理失败抛出 AggregateError，cause/originalError 保留发布原错，cleanupErrors 和 retainedResources 记录逐项失败及归属，不包含正文。
 */
export function publishCurrentCuration(db, { targetPath, project }, {
  createTarget = (path) => new SessionStore(new Database(path), { syncOpsEnabled: false }),
  closeTarget = (store) => store.close(),
  removeTarget = (path) => rmSync(path, { force: true })
} = {}) {
  validateKnowledgeProject(project);
  const rows = db.transaction(() => {
    checkSchema(db);
    const selected = entries(db).filter((e) => e.project === project);
    if (!selected.length) {
      throw new Error("CURATION_NO_REGISTERED_PROJECT");
    }
    const rows2 = [];
    for (const e of selected) {
      const saved = history(db, project, e.knowledge_id).find((r) => r.revision === e.revision);
      if (!saved) {
        throw new Error("CURATION_HISTORY_MISSING");
      }
      if (e.status === "needs_revalidation") {
        const events = records(db, "curation_invalidation", { project: "text", knowledge_id: "text", revision: "integer", record: "blob" });
        const event = events.find((r) => r.project === project && r.knowledge_id === e.knowledge_id && r.revision === e.revision);
        if (!event) {
          throw new Error("CURATION_INVALIDATION_MISSING");
        }
        const record = decode(event.record);
        text(record.reason);
        text(record.reviewer);
        time(record.invalidatedAt);
        continue;
      }
      const current = projection(db, { ...saved.p, observationId: e.observation_id });
      if (digest(current) !== saved.digest) {
        throw new Error("CURATION_STALE_OBSERVATION");
      }
      rows2.push({ revision: e.revision, projection: current, evidence: saved.review.evidence.map((item) => item.publicSummary) });
    }
    return rows2.sort((a, b) => a.projection.knowledgeId < b.projection.knowledgeId ? -1 : 1);
  })();
  return writePublicProjection(rows, { targetPath, project }, { createTarget, closeTarget, removeTarget });
}

/** 从已核验的当前快照为人工确认的草稿构建新公开库，不修改或关闭借用的源连接。
 * 调用方必须绑定源代并独占暂存目录，发布前仍须协调读取及核对当前代。
 * 批次中有未改变公开内容的草稿时，整批拒绝且不创建目标文件。
 */
export function stageReviewedDrafts(source, { project, generation, targetPath, drafts, reviewedAt }) {
  validateKnowledgeProject(project);
  time(reviewedAt);
  if (!Array.isArray(drafts) || !drafts.length || drafts.length > 5) throw new Error("CURATION_DRAFTS");
  const current = source ? source.transaction(() => readCurrentCuration(source, { project }))() : { generation: null, rows: [] };
  if (current.generation !== generation) throw new Error("CURATION_CONFLICT");
  const rows = new Map(current.rows.map(row => [row.projection.knowledgeId, row]));
  const seen = new Set();
  let unchanged = false;
  for (const draft of drafts) {
    id(draft.knowledgeId);
    revision(draft.expectedRevision);
    if (seen.has(draft.knowledgeId) || (rows.get(draft.knowledgeId)?.revision ?? 0) !== draft.expectedRevision || draft.expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("CURATION_CONFLICT");
    }
    seen.add(draft.knowledgeId);
    if (!Array.isArray(draft.facts)) throw new Error("CURATION_DRAFTS");
    const p = { knowledgeId: draft.knowledgeId, category: draft.category, scope: draft.scope, source: draft.source,
      project, type: "discovery", title: text(draft.title), subtitle: null, narrative: text(draft.narrative),
      facts: JSON.stringify(draft.facts.map(text)), concepts: "[]", created_at: reviewedAt, created_at_epoch: Date.parse(reviewedAt) };
    validateReview({ approvalId: "staged-draft", reviewer: "trusted-manual-draft", reviewedAt, projection: p, evidence: draft.evidence }, p);
    const evidence = draft.evidence.map(item => [
      item.publicSummary, `验证：${item.implementation}`, `对象：${item.object}`, `方法：${item.method}`,
      `范围：${item.coverage}`, `来源：${item.source}`, `预期：${item.result.expected}`,
      `实际结果：${item.result.observed}`, `比较：${item.result.comparison}`,
    ].join("\n"));
    const previous = rows.get(p.knowledgeId);
    if (previous && samePublicDraft(previous, p, evidence)) unchanged = true;
    rows.set(p.knowledgeId, { revision: draft.expectedRevision + 1, projection: p, evidence });
  }
  if (unchanged) throw new Error("CURATION_UNCHANGED");
  return writePublicProjection([...rows.values()].sort((a, b) => a.projection.knowledgeId < b.projection.knowledgeId ? -1 : 1), { project, targetPath });
}

function samePublicDraft(previous, projection, evidence) {
  return Object.keys(projection).every(key => {
    if (key === "created_at" || key === "created_at_epoch") return true;
    if (key === "facts" || key === "concepts") {
      return digest(JSON.parse(previous.projection[key])) === digest(JSON.parse(projection[key]));
    }
    return previous.projection[key] === projection[key];
  }) && digest(previous.evidence) === digest(evidence);
}

/** 为可信发布宿主写入已审批的当前投影，不负责交换目录或协调读取。
 * rows 必须是调用方在同一事务内核验的全量公开条目，并按稳定知识 ID 升序排列。
 * 调用方必须独占暂存目录，且仅能将成功关闭的数据库用于发布。
 */
function writePublicProjection(rows, { targetPath, project }, {
  createTarget = (path) => new SessionStore(new Database(path), { syncOpsEnabled: false }),
  closeTarget = (store) => store.close(),
  removeTarget = (path) => rmSync(path, { force: true }),
} = {}) {
  const snapshot = digest({ version: 1, project, rows });
  let target, created = false;
  let closeAttempted = false;
  try {
    // 旧 sidecar 可能来自上次失败或指向其他文件，未取得所有权前既不能让 SQLite 接管，也不能清理它们。
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        lstatSync(targetPath + suffix);
      } catch (error) {
        if (error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      throw new Error("CURATION_TARGET_EXISTS");
    }
    const fd = openSync(targetPath, "wx", 0o600);
    created = true;
    closeSync(fd);
    target = createTarget(targetPath);
    new SessionSearch(target.db);
    const sid = target.createSDKSession("published-knowledge", project, "", undefined, "claude");
    target.db.query("UPDATE sdk_sessions SET project=CAST(? AS TEXT) WHERE id=?").run(bytes(project), sid);
    target.ensureMemorySessionIdRegistered(sid, "published-knowledge");
    target.db.transaction(() => {
      target.db.exec("CREATE TABLE curation_manifest(project TEXT NOT NULL,kind TEXT NOT NULL,count INTEGER NOT NULL,version INTEGER NOT NULL,snapshot TEXT NOT NULL); CREATE TABLE curation_current(observation_id INTEGER PRIMARY KEY,knowledge_id TEXT UNIQUE NOT NULL,revision INTEGER NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,source TEXT NOT NULL,public_evidence TEXT NOT NULL,projection_digest TEXT NOT NULL)");
      target.db.query("INSERT INTO curation_manifest VALUES (CAST(? AS TEXT),'curated-current',?,1,?)").run(bytes(project), rows.length, snapshot);
      const insert = target.db.query(`INSERT INTO observations(memory_session_id,${FIELDS.join(",")}) VALUES('published-knowledge',${FIELDS.map((f) => f === "created_at_epoch" ? "?" : "CAST(? AS TEXT)").join(",")})`);
      const mapping = target.db.query("INSERT INTO curation_current VALUES (?,?,?,CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),?)");
      for (const row of rows) {
        const p = row.projection;
        const result = insert.run(...FIELDS.map((f) => p[f] === null ? null : f === "created_at_epoch" ? p[f] : bytes(p[f])));
        mapping.run(result.lastInsertRowid, p.knowledgeId, row.revision, bytes(p.category), bytes(p.scope), bytes(p.source), bytes(JSON.stringify(row.evidence)), digest(row));
      }
    })();
    if (target.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get().busy !== 0) {
      throw new Error("CURATION_CHECKPOINT");
    }
    if (target.db.query("PRAGMA journal_mode=DELETE").get().journal_mode !== "delete") {
      throw new Error("CURATION_SINGLE_FILE");
    }
    closeAttempted = true;
    closeTarget(target);
    target = undefined;
    return { published: rows.length, contentReviewed: true, kind: "curated-current" };
  } catch (error) {
    const cleanupErrors = [], retainedResources = [];
    // 只有关库已确认才可删除文件，关闭失败不能被后续 unlink 掩盖或变成活库底层文件丢失。
    let closed = target === undefined;
    if (target && closeAttempted) {
      // 首次末尾关闭已失败，未知资源不能二次关闭后伪造成功或删除，交隔离 owner 回收。
      retainedResources.push({targetPath, owner: "publishCurrentCuration", state: "close-unconfirmed"});
    } else if (target) {
      try {
        closeAttempted = true;
        closeTarget(target);
        target = undefined;
        closed = true;
      } catch (closeError) {
        cleanupErrors.push({ operation: "close", path: targetPath, error: closeError });
        retainedResources.push({ targetPath, owner: "publishCurrentCuration", state: "close-unconfirmed" });
      }
    }
    if (created && closed) {
      for (const suffix of ["", "-wal", "-shm"]) {
        const path = targetPath + suffix;
        try {
          removeTarget(path);
        } catch (removeError) {
          cleanupErrors.push({ operation: "remove", path, error: removeError });
          retainedResources.push({ targetPath: path, owner: "publishCurrentCuration", state: "remove-failed" });
        }
      }
    }
    if (cleanupErrors.length) {
      const failure = new AggregateError([error, ...cleanupErrors.map((item) => item.error)], "CURATION_PUBLICATION_CLEANUP_FAILED", { cause: error });
      Object.assign(failure, { originalError: error, cleanupErrors, retainedResources });
      throw failure;
    }
    if (retainedResources.length) {
      const failure = new Error(error.message, {cause: error});
      Object.assign(failure, {originalError: error, cleanupErrors, retainedResources});
      throw failure;
    }
    throw error;
  }
}
