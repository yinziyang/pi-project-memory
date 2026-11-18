const QUERIES = Object.freeze({
  archivedSources: ['writer_source', 'SELECT COUNT(*) AS count FROM writer_source'],
  approvalRecords: ['distill_approved_input', 'SELECT COUNT(*) AS count FROM distill_approved_input'],
  attempts: ['writer_attempt', 'SELECT COUNT(*) AS count FROM writer_attempt'],
  unknownAttempts: ['writer_attempt', "SELECT COUNT(*) AS count FROM writer_attempt WHERE state='unknown'"],
  responses: ['writer_response', 'SELECT COUNT(*) AS count FROM writer_response'],
  candidateRecords: ['writer_result', "SELECT COUNT(*) AS count FROM writer_result WHERE kind='observation'"],
  reviewedRevisions: ['curation_revision', 'SELECT COUNT(*) AS count FROM curation_revision WHERE project=CAST(? AS TEXT)'],
  activeReviewedEntries: ['curation_entry', "SELECT COUNT(*) AS count FROM curation_entry WHERE project=CAST(? AS TEXT) AND status='active'"]
});

function unknown(code) {
  return { state: 'unknown', count: null, code };
}

function unavailable(state, code) {
  return {
    version: 1,
    state,
    code,
    ...Object.fromEntries(Object.keys(QUERIES).map(key => [key, unknown(code)]))
  };
}

/**
 * 从已打开的 LocalWriter 借用 db，只读返回固定 v1 私有存量事实，不返回正文、标识或路径。
 * 不传 writer 表示缺少句柄而非磁盘上没有数据，已关闭或读取失败统一返回离线安全码。
 * 调用方负责 writer 的项目绑定、串行使用和同步 SQLite 的有界进程隔离，不得在写事务内调用。
 * 本函数不初始化表、不启动 owner、不批准或生成、不关闭连接，也不修改借用连接的设置。
 * 计数为当前已提交行存量而非分页、回执或本实例成功次数，历史批准不表示当前授权，审核记录不表示当前发布。
 */
export function readDurableMemoryStatus(writer) {
  try {
    if (writer == null) return unavailable('missing', 'PRIVATE_NOT_ATTACHED');
    if (writer.closed === true) return unavailable('offline', 'PRIVATE_OFFLINE');
    const db = writer.db;
    return db.transaction(() => {
      const result = unavailable('available', 'OK');
      for (const [key, [table, sql]] of Object.entries(QUERIES)) {
        if (!db.query("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
          result[key] = unknown('FACT_UNAVAILABLE');
          continue;
        }
        const scoped = key === 'reviewedRevisions' || key === 'activeReviewedEntries';
        if (scoped && (typeof writer.project !== 'string' || !writer.project || !writer.project.isWellFormed() || writer.project.includes('\0'))) {
          result[key] = unknown('FACT_UNAVAILABLE');
          continue;
        }
        const row = scoped ? db.query(sql).get(Buffer.from(writer.project)) : db.query(sql).get();
        const count = row?.count;
        result[key] = Number.isSafeInteger(count) && count >= 0
          ? { state: 'known', count, code: 'OK' }
          : unknown('COUNT_INVALID');
      }
      return result;
    }).deferred();
  } catch {
    return unavailable('offline', 'PRIVATE_READ_FAILED');
  }
}
