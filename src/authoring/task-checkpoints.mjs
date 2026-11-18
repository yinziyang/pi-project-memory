import { createHash, randomUUID } from 'node:crypto';
import { hasKnownSecret } from '../curated/capture-envelope.mjs';

const FIELDS = ['goal', 'constraints', 'done', 'next', 'blockers'];
const digest = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(value, 'utf8');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const text = (value, limit) => typeof value === 'string' && value.isWellFormed() && bytes(value) <= limit;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const sha = value => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
const commit = value => value === null || (typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value));
function validCheckout(value, worktree) {
  return exact(value, ['version', 'kind', 'worktree', 'commit', 'tree', 'detached', 'unborn', 'dirty', 'dirtyDigest', 'stable', 'generation']) &&
    value.version === 1 && ['git', 'nonGit'].includes(value.kind) && value.worktree === worktree && value.stable === true &&
    [value.detached, value.unborn, value.dirty].every(item => typeof item === 'boolean') && commit(value.commit) && commit(value.tree) && sha(value.dirtyDigest) && sha(value.generation);
}

/** 验证模型仅可提交的五个字符串与 CAS 版本，不改写 BOM、空白或非 BMP 字符。
 * knownSecrets 由可信宿主传入，此检查不能删除 SDK 已写入原始会话的工具参数，也不是完整秘密识别器。
 */
export function validateCheckpointInput(input, knownSecrets = []) {
  if (!exact(input, [...FIELDS, 'revision']) || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      FIELDS.some(key => !text(input[key], key === 'goal' ? 1024 : 2048)) || !input.goal.trim() || bytes(JSON.stringify(input)) > 8192) {
    throw new Error('TASK_INPUT');
  }
  if (!Array.isArray(knownSecrets) || knownSecrets.some(value => !text(value, 65536) || !value)) throw new Error('TASK_SECRET_CONFIG');
  const payload = Object.fromEntries(FIELDS.map(key => [key, input[key]]));
  const raw = JSON.stringify(payload);
  if (FIELDS.some(key => hasKnownSecret(input[key])) || knownSecrets.some(secret => FIELDS.some(key => input[key].includes(secret))) ||
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/.test(raw)) throw new Error('TASK_SECRET');
  return Object.freeze(payload);
}

/** 在借用的独占 writer 数据库中维护不可变检查点，不关闭连接、不创建 job、不批准或调用模型。
 * 所有方法同步执行，调用方负责在唯一 owner 队列中串行调用并将 SQL/事务异常作为 owner 致命故障处理。
 * project/worktree 在构造时固定，历史达到容量后拒绝写入，不自动删除或驱逐旧版本。
 * prepare 提交后才能 appendEntry，确认只保存低敏 marker 身份，崩溃后必须凭实际祖先 marker 恢复关联。
 */
export function initializeTaskCheckpoints(db, { project, worktree, maxRevisions = 10000, maxAssociations = 20000, knownSecrets = [], now = Date.now, newId = randomUUID }) {
  if (!text(project, 512) || !project.trim() || typeof worktree !== 'string' || !/^[a-f0-9]{64}$/.test(worktree) ||
      !Number.isSafeInteger(maxRevisions) || maxRevisions < 1 || !Number.isSafeInteger(maxAssociations) || maxAssociations < 1) throw new Error('TASK_BINDING');
  validateCheckpointInput({ revision: 0, goal: 'validation', constraints: '', done: '', next: '', blockers: '' }, knownSecrets);
  const secrets = [...knownSecrets];
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_namespace(singleton INTEGER PRIMARY KEY CHECK(singleton=1),project BLOB NOT NULL,worktree TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_identity(task_id TEXT PRIMARY KEY,origin_session BLOB NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS task_revision(task_id TEXT NOT NULL,revision INTEGER NOT NULL,parent_rev INTEGER,origin_session BLOB NOT NULL,checkout BLOB NOT NULL,public_generation TEXT,payload BLOB NOT NULL,payload_digest TEXT NOT NULL,created_at INTEGER NOT NULL,declared_by TEXT NOT NULL CHECK(declared_by IN ('model','host')),PRIMARY KEY(task_id,revision),FOREIGN KEY(task_id) REFERENCES task_identity(task_id));
    CREATE TABLE IF NOT EXISTS task_association(association_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0),session BLOB NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(task_id) REFERENCES task_identity(task_id));
    CREATE TABLE IF NOT EXISTS task_confirmation(association_id TEXT PRIMARY KEY,session BLOB NOT NULL,entry_id BLOB NOT NULL,FOREIGN KEY(association_id) REFERENCES task_association(association_id));
  `);
  db.transaction(() => {
    const binding = db.query('SELECT project,worktree FROM task_namespace WHERE singleton=1').get();
    if (binding && (decoder.decode(binding.project) !== project || binding.worktree !== worktree)) throw new Error('TASK_NAMESPACE');
    if (!binding) db.run('INSERT INTO task_namespace VALUES(1,?,?)', [Buffer.from(project), worktree]);
  }).immediate();

  function timestamp() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('TASK_CLOCK');
    return value;
  }
  function id() {
    const value = newId();
    if (!uuid(value)) throw new Error('TASK_ID');
    return value;
  }
  function session(value) {
    if (!text(value, 512) || !value) throw new Error('TASK_SESSION');
    return Buffer.from(value);
  }
  function head(taskId) {
    if (!uuid(taskId)) throw new Error('TASK_ID');
    if (!db.query('SELECT task_id FROM task_identity WHERE task_id=?').get(taskId)) throw new Error('TASK_NOT_FOUND');
    const value = db.query('SELECT MAX(revision) AS revision FROM task_revision WHERE task_id=?').get(taskId).revision;
    if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new Error('TASK_CORRUPT');
    return value ?? 0;
  }
  function count(table) {
    // 表名仅来自本模块常量，不能将工具参数或宿主命令拼入 SQL。
    const value = db.query(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('TASK_CORRUPT');
    return value;
  }
  function associate(taskId, revision, originSession) {
    if (count('task_association') >= maxAssociations) throw new Error('TASK_CAPACITY');
    const associationId = id();
    db.run('INSERT INTO task_association VALUES(?,?,?,?,?)', [associationId, taskId, revision, session(originSession), timestamp()]);
    return { associationId, taskId, revision };
  }
  return Object.freeze({
    createTask(originSession) {
      return db.transaction(() => {
        if (count('task_identity') >= maxRevisions) throw new Error('TASK_CAPACITY');
        const taskId = id();
        db.run('INSERT INTO task_identity VALUES(?,?,?)', [taskId, session(originSession), timestamp()]);
        // revision=0 只表示可信命令选中新任务，不创建伪造的空检查点。
        return associate(taskId, 0, originSession);
      }).immediate();
    },
    prepareCheckpoint({ taskId, originSession, checkoutObservation, publicGeneration = null, declaredBy, input }) {
      const payload = validateCheckpointInput(input, secrets);
      if (!['model', 'host'].includes(declaredBy) || !validCheckout(checkoutObservation, worktree) || !sha(publicGeneration)) throw new Error('TASK_OBSERVATION');
      const checkout = JSON.stringify(checkoutObservation);
      if (bytes(checkout) > 4096 || !checkout.isWellFormed()) throw new Error('TASK_OBSERVATION');
      return db.transaction(() => {
        const previous = head(taskId);
        if (previous !== input.revision) throw new Error('TASK_CAS');
        if (count('task_revision') >= maxRevisions || previous >= Number.MAX_SAFE_INTEGER) throw new Error('TASK_CAPACITY');
        const revision = previous + 1;
        const raw = Buffer.from(JSON.stringify(payload));
        db.run('INSERT INTO task_revision VALUES(?,?,?,?,?,?,?,?,?,?)', [taskId, revision, previous || null, session(originSession), Buffer.from(checkout), publicGeneration, raw, digest(raw), timestamp(), declaredBy]);
        return associate(taskId, revision, originSession);
      }).immediate();
    },
    // 只有可信命令可调用固定 revision 的显式关联，不将此方法暴露给模型。
    prepareAssociation({ taskId, revision, originSession }) {
      return db.transaction(() => {
        head(taskId);
        if (!Number.isSafeInteger(revision) || revision < 0 || (revision > 0 && !db.query('SELECT revision FROM task_revision WHERE task_id=? AND revision=?').get(taskId, revision))) throw new Error('TASK_REVISION');
        return associate(taskId, revision, originSession);
      }).immediate();
    },
    confirmAssociation({ associationId, originSession, entryId }) {
      if (!uuid(associationId) || !text(entryId, 512) || !entryId) throw new Error('TASK_MARKER');
      const sessionBytes = session(originSession);
      return db.transaction(() => {
        const association = db.query('SELECT session FROM task_association WHERE association_id=?').get(associationId);
        if (!association || decoder.decode(association.session) !== originSession) throw new Error('TASK_MARKER');
        const previous = db.query('SELECT session,entry_id FROM task_confirmation WHERE association_id=?').get(associationId);
        if (previous && (decoder.decode(previous.session) !== originSession || decoder.decode(previous.entry_id) !== entryId)) throw new Error('TASK_MARKER_CONFLICT');
        if (!previous) db.run('INSERT INTO task_confirmation VALUES(?,?,?)', [associationId, sessionBytes, Buffer.from(entryId)]);
        return { state: 'confirmed' };
      }).immediate();
    },
    readAssociation({ associationId, originSession }) {
      if (!uuid(associationId)) throw new Error('TASK_MARKER');
      session(originSession);
      const row = db.query('SELECT a.task_id,a.revision,a.session,r.payload,r.payload_digest,r.checkout,r.public_generation,r.declared_by FROM task_association a LEFT JOIN task_revision r ON r.task_id=a.task_id AND r.revision=a.revision WHERE a.association_id=?').get(associationId);
      if (!row || decoder.decode(row.session) !== originSession) return null;
      if (!uuid(row.task_id) || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('TASK_CORRUPT');
      if (row.revision === 0) return { associationId, taskId: row.task_id, revision: 0, payload: null, project, worktree };
      if (!(row.payload instanceof Uint8Array) || digest(row.payload) !== row.payload_digest ||
          !sha(row.public_generation) || !['model', 'host'].includes(row.declared_by)) throw new Error('TASK_CORRUPT');
      const payload = JSON.parse(decoder.decode(row.payload));
      const checkoutObservation = JSON.parse(decoder.decode(row.checkout));
      if (!validCheckout(checkoutObservation, worktree)) throw new Error('TASK_CORRUPT');
      validateCheckpointInput({ ...payload, revision: row.revision }, secrets);
      return { associationId, taskId: row.task_id, revision: row.revision, payload, payloadDigest: row.payload_digest,
        checkoutObservation, publicGeneration: row.public_generation, declaredBy: row.declared_by, project, worktree };
    },
    status() {
      return { tasks: count('task_identity'), revisions: count('task_revision'), associations: count('task_association'), confirmations: count('task_confirmation'), maxRevisions, maxAssociations };
    }
  });
}
