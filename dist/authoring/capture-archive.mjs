import { createHash } from 'node:crypto';
import { parseCaptureEnvelope, safeCaptureId } from '../curated/capture-envelope.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sha = value => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
const commit = value => value === null || (typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value));
function validCheckout(value, worktree) {
  return value && Object.keys(value).sort().join(',') === 'commit,detached,dirty,dirtyDigest,generation,kind,stable,tree,unborn,version,worktree' &&
    value.version === 1 && value.worktree === worktree && ['git', 'nonGit'].includes(value.kind) && value.stable === true &&
    [value.detached, value.dirty, value.unborn].every(item => typeof item === 'boolean') &&
    commit(value.commit) && commit(value.tree) && sha(value.dirtyDigest) && sha(value.generation);
}

/** 将自动归档绑定到独占 writer 的工作树命名空间，不建立第二套 raw store，也不赋予批准或生成权限。
 * 调用方只可传入过滤后的自有 envelope，事务失败时 source、观察和 cursor 全部回滚，可用同一来源安全重放。
 * cursor 只表示此轮已归档，不声称当前分支全部历史已覆盖，不将旧 checkout 更新为当前 checkpoint。
 */
export function initializeCaptureArchive(writer, worktree) {
  if (!/^[a-f0-9]{64}$/.test(worktree)) throw new Error('CAPTURE_NAMESPACE');
  writer.db.exec(`
    CREATE TABLE IF NOT EXISTS capture_namespace(singleton INTEGER PRIMARY KEY CHECK(singleton=1),worktree TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS capture_observation(source_id INTEGER NOT NULL,session TEXT NOT NULL,leaf TEXT NOT NULL,checkout BLOB NOT NULL,ticket INTEGER NOT NULL,UNIQUE(source_id,session,leaf,checkout));
    CREATE TABLE IF NOT EXISTS capture_cursor(session TEXT NOT NULL,entry_set TEXT NOT NULL,source_id INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(session,entry_set));
  `);
  const previous = writer.db.query('SELECT worktree FROM capture_namespace WHERE singleton=1').get();
  if (previous && previous.worktree !== worktree) throw new Error('CAPTURE_NAMESPACE_MISMATCH');
  if (!previous) writer.db.run('INSERT INTO capture_namespace VALUES(1,?)', [worktree]);
  return Object.freeze({
    archive(round, observation) {
      if (!round || !safeCaptureId(round.sourceSessionId) || !safeCaptureId(round.sourceEntryId) || !(round.raw instanceof Uint8Array) || round.raw.byteLength > 1024 * 1024 ||
          !observation || observation.worktree !== worktree || !safeCaptureId(observation.leaf) || !Number.isSafeInteger(observation.ticket) || observation.ticket < 1 ||
          !validCheckout(observation.checkout, worktree) || Object.keys(observation).sort().join(',') !== 'checkout,leaf,ticket,worktree') throw new Error('CAPTURE_INPUT');
      const rawText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(round.raw);
      // 必须先验证原始 JSON 没有重复键，再存相同 bytes，否则末值校验会掩盖原文中被覆盖的秘密。
      const envelope = parseCaptureEnvelope(rawText);
      if (envelope.session !== round.sourceSessionId || round.sourceEntryId !== `auto:v1:${hash(JSON.stringify(envelope.entryIds))}`) throw new Error('CAPTURE_ENVELOPE');
      const digest = hash(round.raw);
      return writer.db.transaction(() => {
        const id = writer.capture(round);
        const binding = Buffer.from(JSON.stringify(observation.checkout));
        writer.db.run('INSERT OR IGNORE INTO capture_observation VALUES(?,CAST(? AS TEXT),CAST(? AS TEXT),?,?)',
          [id, Buffer.from(round.sourceSessionId), Buffer.from(observation.leaf), binding, observation.ticket]);
        writer.db.run('INSERT INTO capture_cursor VALUES(CAST(? AS TEXT),CAST(? AS TEXT),?,?) ON CONFLICT(session,entry_set) DO NOTHING',
          [Buffer.from(round.sourceSessionId), Buffer.from(round.sourceEntryId), id, digest]);
        return { state: 'committed', sourceId: id, job: writer.receipt(id), digest };
      }).immediate();
    },
    receipt(id) { return writer.receipt(id); }
  });
}
