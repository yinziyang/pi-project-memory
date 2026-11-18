import { GateError, initialize, loadApprovedInput } from "./distill-input-gate.mjs";
import { Database } from "bun:sqlite";
import { existsSync, openSync, closeSync } from "node:fs";
import { SessionStore } from "./vendor/session-store.mjs";
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const bytes = (value) => new TextEncoder().encode(value);
function text(value) {
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new Error("INVALID_TEXT");
  }
  return value;
}
function validate(value) {
  if (typeof value === "string") {
    text(value);
  } else if (Array.isArray(value)) value.forEach(validate);
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => {
    text(key);
    validate(item);
  });
}

// 构造失败后没有可交还的实例，未确认释放的句柄必须强持有到隔离进程终结，不能由 GC 提前释放 owner。
const retainedConstructionResources = new Set();
function failConstruction(originalError, db, owner) {
  const cleanupErrors = [];
  const retainedResources = [];
  let databaseClosed = db === undefined;
  if (db) {
    try {
      db.close();
      databaseClosed = true;
    } catch (error) {
      cleanupErrors.push(error);
      retainedResources.push({resource: "database", state: "close-unconfirmed"});
    }
  }
  if (databaseClosed) {
    try {
      owner.close();
    } catch (error) {
      cleanupErrors.push(error);
      retainedResources.push({resource: "owner", state: "close-unconfirmed"});
    }
  } else {
    retainedResources.push({resource: "owner", state: "retained-until-process-exit"});
  }
  if (retainedResources.length) {
    retainedConstructionResources.add({db, owner});
  }
  if (cleanupErrors.length) {
    const failure = new AggregateError([originalError, ...cleanupErrors], "WRITER_START_CLEANUP_FAILED", {cause: originalError});
    Object.assign(failure, {originalError, cleanupErrors, retainedResources});
    throw failure;
  }
  throw originalError;
}

/**
 * LocalWriter 将私有来源、批准输入与完整响应绑定到构造时必需的 project，既有库必须已有相同的有效绑定。
 * project 是原样保留的非空 UTF-8 标识，最多 256 字节，不接受纯空白或 NUL，不自动迁移无绑定旧库。
 * 生成请求只能显式选择本机 HTTP adapter 或可信 generate 接缝，两者共用最终批准、attempt 和完整响应协议，不存在未批准 fallback。
 * 调用方负责取消网络并关闭连接，同步SQLite由外层进程限时隔离。
 * source与响应正文固定各限1MiB原始字节，不保证SQLite或HTTP运行时的全部内部内存分配有界。
 */
export class LocalWriter {
  constructor(path, { project } = {}) {
    if (typeof project !== "string" || !project.trim() || !project.isWellFormed() || project.includes("\0") || Buffer.byteLength(project) > 256) {
      throw new Error("WRITER_PROJECT_REQUIRED");
    }
    Object.defineProperty(this, "project", { value: project, enumerable: true });
    // 独立SQLite所有权文件持有写锁直到主库关闭，崩溃由内核释放，不猜测PID是否仍活跃。
    this.owner = new Database(`${path}.owner`);
    try {
      this.owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch (error) {
      failConstruction(new Error("WRITER_BUSY", {cause: error}), undefined, this.owner);
    }
    try {
      const existing = existsSync(path);
      if (!existing) {
        const fd = openSync(path, "wx", 0o600);
        closeSync(fd);
      }
      this.db = new Database(path);
      // 依赖迁移会创建未纳入其缓存的 prepare 语句，自有连接必须跟踪它们并在关闭前显式 finalize，不能依赖 GC 释放跨进程锁。
      // 只包装本实例拥有的连接，不修改 Database 原型，弱引用避免把已由依赖释放的临时语句强留到退出。
      const prepare = this.db.prepare.bind(this.db);
      let statements = [];
      this.finalizePrepared = () => {
        for (const reference of statements) reference.deref()?.finalize();
        statements = [];
      };
      this.db.prepare = (...args) => {
        if (statements.length >= 512) statements = statements.filter(reference => reference.deref() !== undefined);
        const statement = prepare(...args);
        statements.push(new WeakRef(statement));
        return statement;
      };
      // 先验证绑定再让依赖运行迁移，拒绝把旧库或损坏元数据静默收编为当前项目。
      if (existing) {
        let metadata;
        try {
          const columns = this.db.query("PRAGMA table_info(writer_meta)").all();
          if (columns.map((column) => column.name).join(",") !== "singleton,version,project") {
            throw new Error();
          }
          const rows = this.db.query("SELECT singleton,version,typeof(project) AS project_type,CAST(project AS BLOB) AS project_bytes FROM writer_meta").all();
          for (const row of rows) {
            if (row.project_type !== "text") {
              throw new Error();
            }
            row.project = decoder.decode(row.project_bytes);
          }
          if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].version !== 1 || typeof rows[0].project !== "string" || !rows[0].project || !rows[0].project.isWellFormed() || rows[0].project.includes("\0")) {
            throw new Error();
          }
          metadata = rows[0];
        } catch {
          throw new Error("WRITER_METADATA_INVALID");
        }
        if (metadata.project !== project) {
          throw new Error("WRITER_PROJECT_MISMATCH");
        }
        for (const table of ["sdk_sessions", "observations", "session_summaries"]) {
          if (!this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
            throw new Error("WRITER_METADATA_INVALID");
          }
          if (this.db.query(`SELECT 1 FROM ${table} WHERE project IS NULL OR project<>CAST(? AS TEXT) LIMIT 1`).get(bytes(project))) {
            throw new Error("WRITER_METADATA_INVALID");
          }
        }
      } else {
        this.db.exec("CREATE TABLE writer_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,project TEXT NOT NULL)");
        this.db.run("INSERT INTO writer_meta VALUES (1,1,CAST(? AS TEXT))", [bytes(project)]);
      }
      this.store = new SessionStore(this.db, { syncOpsEnabled: false });
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS writer_source(id INTEGER PRIMARY KEY, session TEXT NOT NULL, entry TEXT NOT NULL, captured TEXT NOT NULL, raw BLOB NOT NULL, UNIQUE(session,entry));
      CREATE TABLE IF NOT EXISTS writer_job(id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL UNIQUE REFERENCES writer_source(id), state TEXT NOT NULL, diagnostic TEXT);
      CREATE TABLE IF NOT EXISTS writer_job_approval(job_id INTEGER PRIMARY KEY REFERENCES writer_job(id), approval_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS writer_attempt(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL UNIQUE REFERENCES writer_job(id), state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS writer_response(job_id INTEGER PRIMARY KEY REFERENCES writer_job(id), raw BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS writer_result(job_id INTEGER NOT NULL REFERENCES writer_job(id), kind TEXT NOT NULL, result_id INTEGER NOT NULL, UNIQUE(job_id,kind,result_id));
      `);
      initialize(this.db);
      this.db.transaction(() => {
        this.db.run("UPDATE writer_attempt SET state='unknown' WHERE state='dispatching'");
        this.db.run("UPDATE writer_job SET state='unknown',diagnostic='RESTART_UNCERTAIN' WHERE state='dispatching'");
      })();
    } catch (error) {
      failConstruction(error, this.db, this.owner);
    }
  }
  /** 原始输入至多1MiB，超限在解码和入库前拒绝，相同来源必须具有相同字节，重复捕获不刷新日期，拒绝非法UTF-8和Unicode。 */
  capture({ sourceSessionId, sourceEntryId, capturedAt, raw }) {
    [sourceSessionId, sourceEntryId, capturedAt].forEach(text);
    if (!sourceSessionId || !sourceEntryId || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(capturedAt) || !Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) {
      throw new Error("INVALID_SOURCE");
    }
    if (!(raw instanceof Uint8Array)) {
      throw new Error("INVALID_RAW");
    }
    if (raw.byteLength > MAX_SOURCE_BYTES) {
      throw new Error("SOURCE_TOO_LARGE");
    }
    text(decoder.decode(raw));
    return this.db.transaction(() => {
      const previous = this.db.query("SELECT id,raw FROM writer_source WHERE session=CAST(? AS TEXT) AND entry=CAST(? AS TEXT)").get(bytes(sourceSessionId), bytes(sourceEntryId));
      if (previous) {
        if (!Buffer.from(previous.raw).equals(Buffer.from(raw))) {
          throw new Error("SOURCE_CONFLICT");
        }
        return previous.id;
      }
      const id = Number(this.db.query("INSERT INTO writer_source(session,entry,captured,raw) VALUES (CAST(? AS TEXT),CAST(? AS TEXT),CAST(? AS TEXT),?)").run(bytes(sourceSessionId), bytes(sourceEntryId), bytes(capturedAt), raw).lastInsertRowid);
      this.db.run("INSERT INTO writer_job(id,source_id,state) VALUES (?,?,'queued')", [id, id]);
      return id;
    }).immediate();
  }
  /** 只返回持久状态，不将缓存失效事件视为job完成凭据。 */
  receipt(id) {
    return this.db.query("SELECT id,state,diagnostic FROM writer_job WHERE id=?").get(id);
  }
  /** 可信宿主显式选择批准ID，选择不授信且不可重绑，变更须创建新来源任务或等待后续显式CAS协议。 */
  selectApprovedInput(jobId, { approvalId }) {
    if (!Number.isSafeInteger(jobId) || jobId <= 0 || typeof approvalId !== "string" || !approvalId.trim() || !approvalId.isWellFormed() || approvalId.includes("\0")) {
      throw new Error("INVALID_SELECTION");
    }
    return this.db.transaction(() => {
      const job = this.receipt(jobId);
      const attempt = this.db.query("SELECT id FROM writer_attempt WHERE job_id=?").get(jobId);
      if (job?.state !== "queued" || attempt) {
        throw new Error("SELECTION_LOCKED");
      }
      const previous = this.db.query("SELECT approval_id FROM writer_job_approval WHERE job_id=?").get(jobId);
      if (previous) {
        if (previous.approval_id !== approvalId) {
          throw new Error("SELECTION_CONFLICT");
        }
        return;
      }
      this.db.run("INSERT INTO writer_job_approval(job_id,approval_id) VALUES (?,?)", [jobId, approvalId]);
    }).immediate();
  }
  /** 可信宿主须提供project和当前currentSnapshot，未选择或批准绑定失败时保持queued且不建立attempt。
   * 选择不授信，正文只来自最终加载的批准字节，不回退source原文。
   * before_send 在最终加载前执行，snapshotProvider 在其后同步读取可信当前对象，不能传入模型提供的回调。
   * request_started 表示 fetch 或可信 generate 已调用而非网络已经送达，交网请求不能承诺撤回。
   * 调用方必须传入取消信号，发送前已取消不登记attempt，响应逐块限1MiB，发送后失败保留unknown。
   * GateError为安全拒发，SQLite与事务清理故障向调用方传播，由所有者统一停止和释放连接。
   */
  async dispatch(id, { endpoint, generate, authorized, online, signal, project, currentSnapshot, snapshotProvider, checkpoint = async () => {
  } }) {
    if (project !== undefined && project !== this.project) {
      throw new Error("WRITER_PROJECT_MISMATCH");
    }
    if (!authorized || !online) {
      return this.receipt(id);
    }
    if (generate !== undefined && (typeof generate !== "function" || endpoint !== undefined)) {
      throw new Error("INVALID_TRANSPORT");
    }
    const url = generate ? undefined : new URL(text(endpoint));
    if (url && (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.username || url.password)) {
      throw new Error("LOCAL_ONLY");
    }
    if (!(signal instanceof AbortSignal)) {
      throw new Error("SIGNAL_REQUIRED");
    }
    if (this.receipt(id)?.state !== "queued" || signal.aborted) {
      return this.receipt(id);
    }
    // before_send是发送前可重入屏障，尚无attempt，最终批准加载必须在其后执行。
    await checkpoint("before_send");
    if (signal.aborted || this.receipt(id)?.state !== "queued") {
      return this.receipt(id);
    }
    const selection = this.db.query(`SELECT j.source_id,a.approval_id FROM writer_job j
      LEFT JOIN writer_job_approval a ON a.job_id=j.id WHERE j.id=?`).get(id);
    const snapshot = snapshotProvider ? snapshotProvider(id) : currentSnapshot;
    if (!selection?.approval_id || project === undefined || snapshot === undefined) {
      this.db.run("UPDATE writer_job SET diagnostic='APPROVAL_REQUIRED' WHERE id=? AND state='queued'", [id]);
      return this.receipt(id);
    }
    let approved;
    try {
      approved = loadApprovedInput(this.db, {
        project,
        approvalId: selection.approval_id,
        sourceId: selection.source_id,
        snapshot
      });
    } catch (error) {
      // 仅自有批准拒绝可继续消费，SQLite和AggregateError必须交给统一收尾。
      if (!(error instanceof GateError)) {
        throw error;
      }
      this.db.run("UPDATE writer_job SET diagnostic='APPROVAL_REJECTED' WHERE id=? AND state='queued'", [id]);
      return this.receipt(id);
    }
    // 从最终load到fetch调用无await或宿主回调，不给撤销与来源修改留下可重入窗口。
    const changed = this.db.transaction(() => {
      const result = this.db.run("UPDATE writer_job SET state='dispatching' WHERE id=? AND state='queued'", [id]);
      if (!result.changes) {
        return false;
      }
      this.db.run("INSERT INTO writer_attempt(job_id,state) VALUES (?,'dispatching')", [id]);
      return true;
    }).immediate();
    if (!changed) {
      return this.receipt(id);
    }
    // 只取消本次拥有的请求，不改变调用方controller，异常路径的取消等待最多1秒。
    const requestController = new AbortController();
    const requestSignal = AbortSignal.any([signal, requestController.signal]);
    let reader;
    let bodyComplete = false;
    let persistencePhase = false;
    let checkpointActive = false;
    try {
      // 请求创建即接管拒绝，request_started屏障期间也不会产生未处理Promise。
      const request = generate ? generate({ approvedBytes: approved.approvedBytes, signal: requestSignal }) : fetch(url, { method: "POST", body: approved.approvedBytes, signal: requestSignal, redirect: "error" });
      const pending = Promise.resolve(request).then((response2) => ({ response: response2 }), (error) => ({ error }));
      checkpointActive = true;
      await checkpoint("request_started");
      checkpointActive = false;
      const settled = await pending;
      if (settled.error) {
        throw settled.error;
      }
      const response = settled.response;
      if (!response.ok) {
        throw new Error("HTTP_REFUSED");
      }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
        throw new Error("INCOMPLETE_BODY");
      }
      if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
        throw new Error("RESPONSE_TOO_LARGE");
      }
      const chunks = [];
      let total = 0;
      reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value.byteLength > MAX_RESPONSE_BYTES - total) {
            throw new Error("RESPONSE_TOO_LARGE");
          }
          total += value.byteLength;
          chunks.push(value);
        }
      }
      if (length !== null && Number(length) !== total) {
        throw new Error("INCOMPLETE_BODY");
      }
      bodyComplete = true;
      const raw = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        raw.set(chunk, offset);
        offset += chunk.byteLength;
      }
      // 已取得完整 body 后进入私有持久化阶段，SQLite、事务与可信 checkpoint 故障必须原样传播给 owner 停服。
      persistencePhase = true;
      await checkpoint("received");
      this.db.transaction(() => {
        this.db.run("INSERT INTO writer_response(job_id,raw) VALUES (?,?)", [id, raw]);
        this.db.run("UPDATE writer_attempt SET state='response_ready' WHERE job_id=?", [id]);
        this.db.run("UPDATE writer_job SET state='response_ready' WHERE id=?", [id]);
      }).immediate();
      await checkpoint("response_ready");
    } catch (error) {
      if (persistencePhase || checkpointActive) {
        if (!bodyComplete) {
          requestController.abort();
        }
        throw error;
      }
      // 仅传输与 body 协议失败记为 unknown，状态记录本身的数据库故障仍向 owner 传播。
      // 先推进网络取消，再进入不可抢占的SQLite状态写入。
      if (!bodyComplete) {
        requestController.abort();
      }
      const diagnostic = error?.message === "RESPONSE_TOO_LARGE" ? "RESPONSE_TOO_LARGE" : "TRANSPORT_UNCERTAIN";
      this.db.transaction(() => {
        this.db.run("UPDATE writer_job SET state='unknown',diagnostic=CAST(? AS TEXT) WHERE id=? AND state='dispatching'", [bytes(diagnostic), id]);
        this.db.run("UPDATE writer_attempt SET state='unknown' WHERE job_id=? AND state='dispatching'", [id]);
      })();
    } finally {
      if (!bodyComplete) {
        requestController.abort();
      }
      if (reader) {
        let timer;
        try {
          // 已拒绝的响应不会再使用，abort后的cancel失败可丢弃，不能让其阻塞任务状态交还。
          if (!bodyComplete) await Promise.race([reader.cancel().catch(() => {
          }), new Promise((resolve) => {
            timer = setTimeout(resolve, 1000);
          })]);
        } finally {
          clearTimeout(timer);
          reader.releaseLock();
        }
      }
    }
    return this.receipt(id);
  }
  /** 仅从已落盘完整响应apply，故障钩子同步执行，记忆、映射与job终态共用同连接事务。 */
  apply(id, checkpoint = () => {
  }) {
    if (this.receipt(id)?.state !== "response_ready") {
      return this.receipt(id);
    }
    // 数据库读取不属于解析边界，原生或聚合清理错误不能伪装为模型坏 JSON。
    const response = this.db.query("SELECT raw FROM writer_response WHERE job_id=?").get(id);
    if (!response || !(response.raw instanceof Uint8Array)) {
      throw new Error("WRITER_RESPONSE_UNAVAILABLE");
    }
    let parsed;
    try {
      parsed = JSON.parse(decoder.decode(response.raw));
      validate(parsed);
      // SDK 已返回的完整 length/error 对象必须保留私有响应，但不能借完整 JSON 外形取得有效候选。
      if (parsed && Object.hasOwn(parsed, "sdkResponse") && parsed.sdkResultStatus !== "complete") {
        throw new Error("SDK_RESULT_INVALID");
      }
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.observations) || !(parsed.summary === null || parsed.summary && typeof parsed.summary === "object")) {
        throw new Error("SHAPE");
      }
      for (const item of parsed.observations) {
        if (!item || !["type", "title"].every((key) => typeof item[key] === "string" && item[key].trim()) || !["subtitle", "narrative"].every((key) => item[key] === null || typeof item[key] === "string")) {
          throw new Error("OBS_SHAPE");
        }
        for (const key of ["facts", "concepts", "files_read", "files_modified"]) {
          if (!Array.isArray(item[key]) || item[key].some((value) => typeof value !== "string")) {
            throw new Error("LIST_SHAPE");
          }
        }
        for (const key of ["agent_type", "agent_id", "metadata"]) {
          if (item[key] !== undefined && item[key] !== null && typeof item[key] !== "string") {
            throw new Error("OPTIONAL_TEXT_SHAPE");
          }
        }
      }
      if (parsed.summary !== null) {
        for (const key of ["request", "investigated", "learned", "completed", "next_steps"]) {
          if (typeof parsed.summary[key] !== "string") {
            throw new Error("SUMMARY_SHAPE");
          }
        }
        if (!(parsed.summary.notes === null || typeof parsed.summary.notes === "string")) {
          throw new Error("SUMMARY_NOTES");
        }
        for (const key of ["files_read", "files_edited"]) {
          if (parsed.summary[key] !== undefined && (!Array.isArray(parsed.summary[key]) || parsed.summary[key].some((value) => typeof value !== "string"))) {
            throw new Error("SUMMARY_LIST");
          }
        }
      }
    } catch {
      this.db.run("UPDATE writer_job SET state='invalid_response',diagnostic='INVALID_RESPONSE' WHERE id=? AND state='response_ready'", [id]);
      return this.receipt(id);
    }
    // job编号不承担source身份，apply与dispatch必须沿同一持久关系读取实际来源。
    const source = this.db.query(`SELECT s.captured FROM writer_job j
      JOIN writer_source s ON s.id=j.source_id WHERE j.id=?`).get(id);
    this.db.transaction(() => {
      if (this.receipt(id).state !== "response_ready") {
        return;
      }
      const memoryId = `writer-${id}`;
      const sid = this.store.createSDKSession(`writer-source-${id}`, this.project, "", undefined, "claude");
      this.store.ensureMemorySessionIdRegistered(sid, memoryId);
      const result = this.store.storeObservations(memoryId, this.project, parsed.observations, parsed.summary, undefined, 0, Date.parse(source.captured), "trusted-host", { skipTitleDedup: true });
      // 依赖的字符串写入路径会吞开头 BOM，必须在同一事务按自有 ID 写回原始 UTF-8 TEXT。
      // 独立 BLOB 断言验证的是存储字节，不依赖原生 TEXT reader 的宽松解码。
      this.db.run("UPDATE sdk_sessions SET project=CAST(? AS TEXT) WHERE id=?", [bytes(this.project), sid]);
      for (const observationId of result.observationIds) {
        this.db.run("UPDATE observations SET project=CAST(? AS TEXT) WHERE id=?", [bytes(this.project), observationId]);
      }
      if (result.summaryId !== null) {
        this.db.run("UPDATE session_summaries SET project=CAST(? AS TEXT) WHERE id=?", [bytes(this.project), result.summaryId]);
      }
      checkpoint("observations_written");
      for (const obs of result.observationIds) {
        this.db.run("INSERT INTO writer_result VALUES (?,'observation',?)", [id, obs]);
      }
      if (result.summaryId !== null) {
        this.db.run("INSERT INTO writer_result VALUES (?,'summary',?)", [id, result.summaryId]);
      }
      this.db.run("UPDATE writer_job SET state='applied',diagnostic=NULL WHERE id=?", [id]);
    }).immediate();
    // 此私有进程不加载缓存服务或注册上游listener，提前失效不作为成功，唯一回执来自最外层提交后的SQLite。
    return this.receipt(id);
  }
  /** 调用方须先等待在途dispatch结束，关闭后不得再使用借用的db。 */
  close() {
    if (this.closed) {
      return;
    }
    // 自有 db.query 缓存也持有 prepared statements，必须先清理再让 store 严格关闭，不能依赖 lazy close 或 GC 释放锁。
    this.finalizePrepared();
    this.db.clearQueryCache();
    this.store.close();
    this.owner.close();
    this.closed = true;
  }
}
