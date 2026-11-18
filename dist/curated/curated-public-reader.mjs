import { Database } from "bun:sqlite";
import { SessionSearch } from "./vendor/session-search.mjs";
import { readCurrentCuration } from "./current-curation.mjs";
const stale = () => new Error("STALE_REFERENCE: 请重新搜索");
/** 创建只读当前代的所有者，仅用于有界 worker 内，publicPath 及其父目录必须由可信宿主独占。
 * dense 是调用方借用的合作取消 adapter，available=false 时仅暂停该请求的 dense，search 必须在 signal 取消后停止并 settle，本对象不会关闭它。
 * 宿主必须先 await transition，再改私有状态或发布，最后 install，不提供 watcher 或 last-good 回退。
 * search 候选保留已审核 scope，read 的 publicSource 是公开来源字符串，source 仍为稳定引用。
 * search 的 query 为非空有效 Unicode 且 UTF-8 不超过 2048 字节，topK 默认 5，允许整数 1 至 10。
 * transition 的 signal 在进入和回收完成后检查，不提前遗弃仍在 settle 的依赖。
 * close 先停服并等待在途任务，失败保留未确认连接供重复 close 重试，不关闭借用的 dense。
 * SQLite 同步操作不可抢占，进程级时间上限由 Node bridge 的实际终止与回收负责。
 */
function createCuratedPublicReader({ project, dense }) {
  let slot;
  let closed = false;
  let stopping;
  const active = new Set();
  const retired = new Set();
  function current() {
    if (closed || !slot) throw new Error("PUBLIC_UNAVAILABLE");
    return slot;
  }
  function source(s, row) {
    return { version: 2, project, generation: s.generation, knowledgeId: row.projection.knowledgeId, revision: row.revision };
  }
  async function operation(signal, work) {
    signal?.throwIfAborted();
    const s = current();
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const entry = { controller };
    // 先登记所有权，再在微任务中执行依赖，transition 才不会漏掉刚启动的工作。
    active.add(entry);
    entry.done = Promise.resolve().then(() => {
      combined.throwIfAborted();
      return work(s, combined);
    });
    try {
      const result = await entry.done;
      combined.throwIfAborted();
      if (slot !== s) throw stale();
      return result;
    } finally {
      active.delete(entry);
    }
  }
  function transition({ signal } = {}) {
    signal?.throwIfAborted();
    if (stopping) return stopping.then(() => signal?.throwIfAborted());
    const old = slot;
    slot = undefined;
    if (old) retired.add(old.db);
    const pending = [...active];
    for (const task of pending) task.controller.abort(stale());
    // 取消后的 settle 是关闭连接的前提，不用 Promise.race 假装后台已停止。
    stopping = (async () => {
      await Promise.allSettled(pending.map((task) => task.done));
      const errors = [];
      for (const db of retired) {
        try {
          db.close();
          retired.delete(db);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        const failure = new AggregateError(errors, "PUBLIC_CLOSE_UNCONFIRMED");
        failure.cleanupErrors = errors;
        failure.retainedResources = [{ owner: "curated-public-reader", state: "close-unconfirmed", count: retired.size }];
        throw failure;
      }
    })().finally(() => {
      stopping = undefined;
    });
    return stopping.then(() => signal?.throwIfAborted());
  }
  return {
    async install({ publicPath, generation, signal }) {
      signal?.throwIfAborted();
      if (closed || slot || stopping || retired.size) throw new Error("TRANSITION_REQUIRED");
      let db;
      try {
        db = new Database(publicPath, { readonly: true });
        db.exec("BEGIN");
        const checked = readCurrentCuration(db, { project });
        if (generation !== checked.generation) throw new Error("GENERATION_MISMATCH");
        const search = new SessionSearch(db, { readOnly: true });
        signal?.throwIfAborted();
        slot = { ...checked, db, search };
      } catch (error) {
        try {
          db?.close();
        } catch (cleanupError) {
          retired.add(db);
          const failure = new AggregateError([error, cleanupError], "PUBLIC_INSTALL_CLEANUP_FAILED", { cause: error });
          Object.assign(failure, { originalError: error, cleanupErrors: [cleanupError], retainedResources: [{ owner: "curated-public-reader", state: "close-unconfirmed" }] });
          throw failure;
        }
        throw new Error("PUBLIC_INSTALL_REJECTED", { cause: error });
      }
    },
    search(args) {
      if (!args || Object.keys(args).some(key => !['query', 'topK', 'signal'].includes(key))) return Promise.reject(new Error('INVALID_QUERY'));
      const { query, topK = 5, signal } = args;
      if (typeof query !== "string" || !query.isWellFormed() || !query.trim() || Buffer.byteLength(query) > 2048) return Promise.reject(new Error("INVALID_QUERY"));
      if (!Number.isInteger(topK) || topK < 1 || topK > 10) return Promise.reject(new Error("INVALID_TOP_K"));
      return operation(signal, async (s, combined) => {
        let rows, used_strategy = "sqlite-current", degradation;
        const activeDense = dense?.available === false ? undefined : dense;
        if (!activeDense || activeDense.generation !== s.generation) {
          degradation = activeDense ? "INDEX_GENERATION_MISMATCH" : "INDEX_MISSING";
        } else {
          let candidates;
          try {
            candidates = await activeDense.search({ query, topK, signal: combined });
          } catch (error) {
            combined.throwIfAborted();
            throw new Error("DENSE_SEARCH_FAILED", { cause: error });
          }
          combined.throwIfAborted();
          if (slot !== s) throw stale();
          if (activeDense.generation !== s.generation) degradation = "INDEX_GENERATION_MISMATCH";
          else {
            if (!Array.isArray(candidates)) throw new Error("DENSE_PROTOCOL_ERROR");
            rows = candidates.map((candidate) => {
              if (!candidate || typeof candidate !== "object" ||
                  Array.isArray(candidate) || candidate.version !== 2 ||
                  typeof candidate.project !== "string" ||
                  !candidate.project.isWellFormed() || !candidate.project.trim() ||
                  typeof candidate.generation !== "string" ||
                  !/^[a-f0-9]{64}$/.test(candidate.generation) ||
                  typeof candidate.knowledgeId !== "string" ||
                  !/^k-[a-z0-9][a-z0-9-]{0,79}$/.test(candidate.knowledgeId) ||
                  !Number.isSafeInteger(candidate.revision) || candidate.revision < 1) {
                throw new Error("DENSE_PROTOCOL_ERROR");
              }
              const row = s.rows.find((item) => item.projection.knowledgeId === candidate.knowledgeId && item.revision === candidate.revision);
              if (candidate.project !== project || candidate.generation !== s.generation || !row) {
                throw new Error("DENSE_CONTENT_MISMATCH");
              }
              return row;
            });
            used_strategy = "current-dense";
          }
        }
        if (!rows) {
          const matches = s.search.searchObservations(query, { project, limit: topK });
          // 完整校验已确保映射唯一，按检索顺序水合，不能重新按稳定标识排序。
          rows = matches.map((match) => {
            const mapping = s.current.find((item) => item.observation_id === match.id);
            return s.rows.find((row) => row.projection.knowledgeId === mapping.knowledge_id);
          });
        }
        const candidates = [...new Set(rows)].slice(0, topK).map((row) => ({
          title: row.projection.title ?? "",
          summary: row.projection.narrative ?? "",
          scope: row.projection.scope,
          source: source(s, row)
        }));
        return {project, generation:s.generation, used_strategy, degradation, candidates};
      });
    },
    /** 返回同一已完整校验只读事务中的总行数，不受搜索分页或 index 状态影响。 */
    status({ signal } = {}) {
      return operation(signal, (s) => ({ project, generation: s.generation, totalRows: s.rows.length }));
    },
    read({ source: ref, signal }) {
      return operation(signal, (s) => {
        if (!ref || ref.version !== 2 || ref.project !== project || ref.generation !== s.generation) throw stale();
        const row = s.rows.find((r) => r.projection.knowledgeId === ref.knowledgeId && r.revision === ref.revision);
        if (!row) throw stale();
        return structuredClone({
          ...row.projection,
          publicSource: row.projection.source,
          evidence: row.evidence,
          source: source(s, row)
        });
      });
    },
    transition,
    async close() {
      closed = true;
      await transition();
    }
  };
}
export {
  createCuratedPublicReader
};
