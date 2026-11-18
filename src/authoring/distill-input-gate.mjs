import { createHash } from "node:crypto";
/** 仅标识可安全拒发的批准或绑定拒绝，不包装SQLite和事务清理故障。 */
export class GateError extends Error {
}
const MAX_BYTES = 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const fields = [
  "project",
  "approvalId",
  "sourceId",
  "reviewer",
  "reviewedAt",
  "snapshot",
  "method",
  "coverage",
  "observed",
  "expected",
  "comparison",
  "expectationSource",
  "evidenceRefs",
  "evidenceInputDigest",
  "approvedBytes"
];
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function text(value) {
  if (typeof value !== "string" || !value.trim() || !value.isWellFormed()) {
    throw new Error("INVALID_TEXT");
  }
  return value;
}
function approvalId(value) {
  text(value);
  if (value.includes("\0")) {
    throw new Error("INVALID_APPROVAL_ID");
  }
  return value;
}
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new Error("INVALID_FIELDS");
  }
}
function snapshot(value) {
  exact(value, ["object", "scope", "version", "contentDigest"]);
  return Object.fromEntries(["object", "scope", "version", "contentDigest"].map((key) => {
    text(value[key]);
    if (key === "contentDigest" && !/^[a-f0-9]{64}$/.test(value[key])) {
      throw new Error("INVALID_DIGEST");
    }
    return [key, value[key]];
  }));
}
// SQLite的原生TEXT读取可能静默丢失坏UTF8，必须先确认存储类型，再校验并绑定原字节。
// 身份是opaque值，不得trim、移除BOM或归一化，原文允许空BLOB以保持capture契约。
function source(db, id) {
  const row = db.query(`SELECT id,
    typeof(session) AS session_type, CAST(session AS BLOB) AS session_bytes,
    typeof(entry) AS entry_type, CAST(entry AS BLOB) AS entry_bytes,
    typeof(captured) AS captured_type, CAST(captured AS BLOB) AS captured_bytes,
    typeof(raw) AS raw_type, CAST(raw AS BLOB) AS raw_bytes
    FROM writer_source WHERE id=?`).get(id);
  if (!row) {
    throw new GateError("SOURCE_MISSING");
  }
  if (row.raw_type !== "blob" || ["session", "entry", "captured"].some((key) => row[`${key}_type`] !== "text")) {
    throw new GateError("SOURCE_TYPE");
  }
  if (row.raw_bytes.byteLength > MAX_BYTES) {
    throw new GateError("SOURCE_TOO_LARGE");
  }
  let identities;
  try {
    identities = [row.session_bytes, row.entry_bytes, row.captured_bytes].map((bytes) => decoder.decode(bytes));
    decoder.decode(row.raw_bytes);
  } catch (error) {
    throw new GateError("SOURCE_ENCODING", { cause: error });
  }
  // fatal且保留BOM的UTF8解码是无损表示，保持合法既有登记的绑定格式不变。
  return digest(JSON.stringify([row.id, ...identities, digest(row.raw_bytes)]));
}
function normalize(request) {
  exact(request, fields);
  const result = {};
  for (const key of fields) {
    if (!["sourceId", "snapshot", "evidenceRefs", "approvedBytes"].includes(key)) {
      result[key] = text(request[key]);
    }
  }
  if (!Number.isSafeInteger(request.sourceId) || request.sourceId <= 0) {
    throw new Error("INVALID_SOURCE_ID");
  }
  if (!Number.isFinite(Date.parse(result.reviewedAt)) || new Date(result.reviewedAt).toISOString() !== result.reviewedAt) {
    throw new Error("INVALID_TIME");
  }
  approvalId(result.approvalId);
  const bytes = request.approvedBytes;
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES) {
    throw new Error("INVALID_BYTES");
  }
  text(decoder.decode(bytes));
  if (!Array.isArray(request.evidenceRefs) || !request.evidenceRefs.length) {
    throw new Error("INVALID_EVIDENCE");
  }
  result.sourceId = request.sourceId;
  result.snapshot = snapshot(request.snapshot);
  result.evidenceRefs = Array.from(request.evidenceRefs, text);
  result.inputDigest = digest(bytes);
  if (result.evidenceInputDigest !== result.inputDigest) {
    throw new Error("EVIDENCE_BINDING");
  }
  return { metadata: result, bytes: Buffer.from(bytes) };
}
// 连接须独占借用且不在外层事务内，失败清理独立于原错误，绝不关闭调用方连接。
function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "GATE_TRANSACTION_FAILED", { cause: error });
    }
    throw error;
  }
}
function checked(row) {
  if (!row || row.revoked !== 0) {
    throw new GateError("APPROVAL_UNAVAILABLE");
  }
  if (digest(row.metadata) !== row.record_digest) {
    throw new GateError("RECORD_CHANGED");
  }
  const metadata = JSON.parse(row.metadata);
  if (metadata.approvalId !== row.approval_id || digest(row.input) !== metadata.inputDigest) {
    throw new GateError("INPUT_CHANGED");
  }
  return metadata;
}
/** 初始化私有登记表，不创建来源、候选、模型请求或发布数据，连接归调用方所有。 */
export function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS distill_approved_input (
    approval_id TEXT PRIMARY KEY, metadata TEXT NOT NULL, record_digest TEXT NOT NULL,
    input BLOB NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
  )`);
}
/** 仅供可信宿主调用，不得暴露为模型工具或RPC，不能识别同UID伪造者。
 * 宿主负责事实、独立期望、实施范围、证据对应及公开去敏，SHA只绑定一致性。
 * approvedBytes为非空合法UTF8且至多1MiB，snapshot须含工作区相关内容摘要而不只是HEAD。
 * 同ID同请求幂等，冲突或撤销拒绝，新批准必须用新ID。
 * 同步SQLite不承诺实时取消，须由调用方在有界进程内隔离，独占借用连接。
 */
export function registerApprovedInput(db, request) {
  const { metadata, bytes } = normalize(request);
  return transaction(db, () => {
    metadata.sourceBinding = source(db, metadata.sourceId);
    const serialized = JSON.stringify(metadata);
    const previous = db.query("SELECT * FROM distill_approved_input WHERE approval_id=?").get(metadata.approvalId);
    if (previous) {
      checked(previous);
      if (previous.metadata !== serialized || !Buffer.from(previous.input).equals(bytes)) {
        throw new Error("APPROVAL_CONFLICT");
      }
      return;
    }
    db.query("INSERT INTO distill_approved_input(approval_id,metadata,record_digest,input) VALUES (?,?,?,?)").run(metadata.approvalId, serialized, digest(serialized), bytes);
  });
}
/** 精确校验当前来源及宿主当前对象快照，只返回批准字节及安全身份，不返回原文、证据或reviewer。
 * 此API不接受替换正文，快照生产生成与失效触发尚未接入，SHA不是防恶意数据库重写认证。
 */
export function loadApprovedInput(db, request) {
  exact(request, ["project", "approvalId", "sourceId", "snapshot"]);
  if (!Number.isSafeInteger(request.sourceId) || request.sourceId <= 0) {
    throw new Error("INVALID_SOURCE_ID");
  }
  text(request.project);
  approvalId(request.approvalId);
  const current = snapshot(request.snapshot);
  return transaction(db, () => {
    const row = db.query("SELECT * FROM distill_approved_input WHERE approval_id=?").get(request.approvalId);
    const metadata = checked(row);
    if (metadata.sourceId !== request.sourceId || metadata.project !== request.project || JSON.stringify(metadata.snapshot) !== JSON.stringify(current) || metadata.sourceBinding !== source(db, metadata.sourceId)) {
      throw new GateError("BINDING_CHANGED");
    }
    return {
      project: metadata.project,
      approvalId: metadata.approvalId,
      inputDigest: metadata.inputDigest,
      approvedBytes: Buffer.from(row.input)
    };
  });
}
/** 显式永久撤销已有ID，重复撤销安全，缺失登记拒绝，不关闭借用连接。 */
export function invalidateApprovedInput(db, id) {
  approvalId(id);
  return transaction(db, () => {
    const result = db.query("UPDATE distill_approved_input SET revoked=1 WHERE approval_id=?").run(id);
    if (!result.changes) {
      throw new GateError("APPROVAL_UNAVAILABLE");
    }
  });
}
