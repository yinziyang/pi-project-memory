// 可信 supervisor 专用入口：bun manual-draft-cli.mjs PRIVATE_DIR PROJECT CWD。
// stdin 为最多 1 MiB 的单条 UTF-8 JSON（含可选末尾换行），发送完必须关闭 stdin。
// stdout 只返回一条成功或安全拒绝帧；超过 supervisor 截止时间或未取得有效帧时，调用方不得推定未提交。
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const MAX_REQUEST_BYTES = 1024 * 1024;
const PRIVATE_FILES = new Set([
  'private.sqlite', 'private.sqlite-wal', 'private.sqlite-shm',
  'private.sqlite.owner', 'private.sqlite.owner-journal',
]);

class DraftError extends Error {}

function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every(field => Object.hasOwn(value, field));
}

function text(value) {
  return typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && Boolean(value.trim());
}

function validDraft(draft, categories) {
  const evidenceFields = ['implementation', 'object', 'method', 'coverage', 'source', 'publicSummary'];
  const resultFields = ['observed', 'expected', 'comparison'];
  return exactFields(draft, ['knowledgeId', 'expectedRevision', 'category', 'scope', 'source', 'title', 'narrative', 'facts', 'evidence'])
    && typeof draft.knowledgeId === 'string' && /^k-[a-z0-9][a-z0-9-]{0,79}$/.test(draft.knowledgeId)
    && Number.isSafeInteger(draft.expectedRevision) && draft.expectedRevision >= 0
    && categories.includes(draft.category)
    && [draft.scope, draft.source, draft.title, draft.narrative].every(text)
    && Array.isArray(draft.facts) && draft.facts.every(text)
    && Array.isArray(draft.evidence) && draft.evidence.length > 0
    && draft.evidence.every(item => exactFields(item, [...evidenceFields, 'result'])
      && evidenceFields.every(field => text(item[field]))
      && exactFields(item.result, resultFields) && resultFields.every(field => text(item.result[field])));
}

async function readRequest() {
  const chunks = [];
  let size = 0;
  let lineEnded = false;
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      const end = chunk.indexOf(10);
      if (size > MAX_REQUEST_BYTES || lineEnded || (end !== -1 && end !== chunk.length - 1)) {
        throw new DraftError('MANUAL_DRAFT_INPUT');
      }
      lineEnded = end !== -1;
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    throw new DraftError('MANUAL_DRAFT_INPUT');
  }
}

// 不调用会创建目录和 owner 的 privateDirectory，路径与两份现存文件必须在启动 SQLite 之前确认。
// 可信父进程负责保证祖先目录不会被同 UID 进程恶意更换，与现有 authoring 宿主采用相同的所有权边界。
function existingLibrary(root, cwd, assertSeparatedDirectories) {
  try {
    assertSeparatedDirectories(root, cwd);
    const uid = process.getuid();
    const dir = lstatSync(root);
    if (realpathSync(root) !== root || !dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o777) !== 0o700) {
      throw new Error();
    }
    const names = readdirSync(root);
    if (!names.includes('private.sqlite') || !names.includes('private.sqlite.owner')) throw new Error();
    for (const name of names) {
      if (!PRIVATE_FILES.has(name)) throw new Error();
      const file = lstatSync(join(root, name));
      if (!file.isFile() || file.uid !== uid || file.nlink !== 1 || (file.mode & 0o077) !== 0) throw new Error();
    }
    if (lstatSync(join(root, 'private.sqlite')).size === 0) throw new Error();
    return join(root, 'private.sqlite');
  } catch {
    throw new DraftError('MANUAL_DRAFT_LIBRARY');
  }
}

function writeDraft(writer, draft, curation) {
  const { db, store, project } = writer;
  // 外层立即事务先锁定写入，SessionStore 和审核入口的嵌套事务只释放保存点，不独立提交。
  return db.transaction(() => {
    curation.initializeCuration(db);
    const now = Date.now();
    const submission = `manual-draft-${randomUUID()}`;
    const sessionId = store.createSDKSession(submission, project, '', undefined, 'claude', now);
    store.ensureMemorySessionIdRegistered(sessionId, submission);
    const observation = store.storeObservation(submission, project, {
      type: 'discovery', title: draft.title, subtitle: null, narrative: draft.narrative,
      facts: draft.facts, concepts: [], files_read: [], files_modified: [],
    }, undefined, 0, now, undefined, { skipTitleDedup: true });
    if (!Number.isSafeInteger(observation.id) || observation.id <= 0 || observation.mergedIntoExisting) {
      throw new DraftError('MANUAL_DRAFT_FAILED');
    }
    // Bun 的字符串绑定会吞开头的 BOM，先按 UTF-8 字节恢复原值，再生成实际审核投影。
    db.run('UPDATE sdk_sessions SET project=CAST(? AS TEXT) WHERE id=?', [Buffer.from(project), sessionId]);
    db.run('UPDATE observations SET project=CAST(? AS TEXT),title=CAST(? AS TEXT),narrative=CAST(? AS TEXT) WHERE id=?',
      [Buffer.from(project), Buffer.from(draft.title), Buffer.from(draft.narrative), observation.id]);
    const proposal = {
      project, observationId: observation.id, knowledgeId: draft.knowledgeId,
      category: draft.category, scope: draft.scope, source: draft.source,
    };
    const review = {
      approvalId: submission, reviewer: 'trusted-manual-draft', reviewedAt: new Date(now).toISOString(),
      projection: curation.prepareCuration(db, proposal), evidence: draft.evidence,
    };
    return curation.registerReviewed(db, { proposal, expectedRevision: draft.expectedRevision, review });
  }).immediate();
}

async function run() {
  const [root, project, cwd] = process.argv.slice(2);
  if (process.argv.length !== 5 || !text(root) || !isAbsolute(root) || resolve(root) !== root
      || !text(project) || Buffer.byteLength(project) > 256 || !text(cwd) || !isAbsolute(cwd)) {
    throw new DraftError('MANUAL_DRAFT_ARGUMENTS');
  }
  const inputDeadline = setTimeout(() => process.stdin.destroy(new DraftError('MANUAL_DRAFT_INPUT')), 4000);
  let draft;
  try {
    draft = await readRequest();
  } finally {
    clearTimeout(inputDeadline);
  }
  const { assertSeparatedDirectories } = await import('./private-directory.mjs');
  const { CATEGORIES } = await import('../curated/knowledge-categories.mjs');
  if (!validDraft(draft, CATEGORIES)) throw new DraftError('MANUAL_DRAFT_INPUT');
  const path = existingLibrary(root, cwd, assertSeparatedDirectories);
  const { LocalWriter } = await import('./local-writer.mjs');
  const curation = await import('./knowledge-curation.mjs');
  if (stopped) throw new DraftError('MANUAL_DRAFT_INTERRUPTED');
  const writer = new LocalWriter(path, { project });
  try {
    return { revision: writeDraft(writer, draft, curation) };
  } finally {
    // 即使事务已经提交，未确认主库和 owner 均关闭也不得回报成功。
    try { writer.close(); } catch { throw new DraftError('MANUAL_DRAFT_CLOSE'); }
  }
}

function safeCode(error) {
  if (error instanceof DraftError) return error.message;
  if (error?.message === 'CURATION_CONFLICT') return 'CURATION_CONFLICT';
  if (error?.message === 'WRITER_BUSY') return 'MANUAL_DRAFT_BUSY';
  if (['WRITER_PROJECT_MISMATCH', 'WRITER_METADATA_INVALID'].includes(error?.message)) return 'MANUAL_DRAFT_LIBRARY';
  return 'MANUAL_DRAFT_FAILED';
}

// 入口只接受一个以 EOF 结束的请求，不启动常驻工作。
// 本地截止覆盖异步输入、装载和输出，不能中断的文件系统及 SQLite 同步调用由 supervisor 限时终止并回收。
const deadline = setTimeout(() => process.exit(1), 5000);
let stopped = false;
function stop() {
  stopped = true;
  process.exitCode = 1;
  process.stdin.destroy();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdout.on('error', stop);
try {
  let response;
  try {
    const result = await run();
    response = { ok: true, result };
  } catch (error) {
    process.exitCode = 1;
    response = { ok: false, code: safeCode(error) };
  }
  if (stopped) response = { ok: false, code: 'MANUAL_DRAFT_INTERRUPTED' };
  await new Promise(resolveWrite => process.stdout.write(JSON.stringify(response) + '\n', error => {
    if (error) stop();
    resolveWrite();
  }));
} finally {
  clearTimeout(deadline);
  process.stdin.destroy();
}
