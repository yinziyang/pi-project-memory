import { LocalWriter } from "./local-writer.mjs";
import { initializeCaptureArchive } from './capture-archive.mjs';
import { initializeTaskOwner } from './task-owner.mjs';
import { readDurableMemoryStatus } from './durable-status.mjs';
import { registerApprovedInput, invalidateApprovedInput } from "./distill-input-gate.mjs";
import { initializeCuration, prepareCuration, registerReviewed, invalidateKnowledge } from "./knowledge-curation.mjs";
import { privateDirectory, secureOwnedFiles, assertSeparatedDirectories } from "./private-directory.mjs";
import { publishProject, retainPublicationPause, recoverProject } from "./publication.mjs";
import { realpathSync } from "node:fs";
import { CATEGORIES } from "../curated/knowledge-categories.mjs";
const MAX_REPLY_BYTES = 1024 * 1024;

// 先逐字段计算 JSON 转义后的实际字节数，再构造字符串，过大响应只发固定错误，不截断或伪称完整结果。
function encodeReply(value) {
  let size = 1;
  function add(bytes) {
    size += bytes;
    if (size > MAX_REPLY_BYTES) {
      throw new RangeError('HOST_RESPONSE_TOO_LARGE');
    }
  }
  function string(text) {
    add(2);
    for (const character of text) {
      const code = character.codePointAt(0);
      if (character === '"' || character === '\\' || [8, 9, 10, 12, 13].includes(code)) {
        add(2);
      } else if (code < 32 || (code >= 0xd800 && code <= 0xdfff)) {
        add(6);
      } else {
        add(Buffer.byteLength(character));
      }
    }
  }
  function visit(item, depth = 0) {
    if (depth > 64) {
      throw new RangeError('HOST_RESPONSE_TOO_LARGE');
    }
    if (typeof item === 'string') {
      string(item);
    } else if (item === null || typeof item !== 'object') {
      add(JSON.stringify(item)?.length ?? 4);
    } else if (Array.isArray(item)) {
      add(2 + Math.max(0, item.length - 1));
      for (const child of item) {
        visit(child, depth + 1);
      }
    } else {
      add(2);
      let first = true;
      for (const [key, child] of Object.entries(item)) {
        if (child === undefined) {
          continue;
        }
        add(first ? 1 : 2);
        first = false;
        string(key);
        visit(child, depth + 1);
      }
    }
  }
  try {
    visit(value);
    return JSON.stringify(value) + '\n';
  } catch (error) {
    if (!(error instanceof RangeError) || error.message !== 'HOST_RESPONSE_TOO_LARGE') {
      throw error;
    }
    return JSON.stringify({id: Number.isSafeInteger(value.id) ? value.id : undefined, error: 'HOST_RESPONSE_TOO_LARGE'}) + '\n';
  }
}

/** runAuthoringHost 在专用 Bun 进程拥有 stdio、信号、私有 SQLite 与唯一串行 consumer，不允许在 Pi 主事件循环内调用。
 * 可信父宿主提供项目、目录及唯一 transport，archiveOnly=true 时禁止 transport，只开放 archive、receipt、只读 status、close，不恢复响应或启动 consumer。
 * assistantLocal=true 仅在 archiveOnly 的隔离基础上添加固定 task IPC，不改变 archive-only 白名单，不恢复响应或消费 job。
 * 所有 stdio 命令都属于可信宿主通道，不能注册为模型工具或公开 RPC，archiveOnly 仍由同一 LocalWriter 独占数据库。
 * capture 只等待私有归档回执，批准、当前快照及输出审核由独立可信命令提供，generator 只能在最终门槛和 attempt 之后执行。
 * onStopping 是入口立即启动强制收尾预算的同步回调，必须快速返回，入口仍须确认实际进程回收，不把取消误称远端停止。
 * 默认 requestMs 为 10000、范围 1–60000ms，lifetimeMs 为 3600000、范围 1–3600000ms，异常最终向入口传播且不在库内退出进程。
 */
export async function runAuthoringHost({ rootPath, endpointUrl, generate, closeGenerator, onStopping = () => {
}, project, projectPath, archiveOnly = false, assistantLocal = false, worktree, requestMs = 10000, lifetimeMs = 3600000 } = {}) {
  const started = performance.now();
  if (!Number.isSafeInteger(requestMs) || requestMs < 1 || requestMs > 60000 || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 3600000) {
    throw new Error("HOST_BUDGET");
  }
  if (typeof assistantLocal !== 'boolean' || (assistantLocal && !archiveOnly)) throw new Error('HOST_ROLE');
  assertSeparatedDirectories(rootPath, projectPath);
  const path = privateDirectory(rootPath);
  const root = realpathSync(rootPath);
  const endpoint = endpointUrl === undefined ? undefined : new URL(endpointUrl);
  if (typeof archiveOnly !== 'boolean' || (archiveOnly ? endpoint !== undefined || generate !== undefined || closeGenerator !== undefined : (endpoint !== undefined) === (generate !== undefined))) {
    throw new Error("HOST_TRANSPORT_REQUIRED");
  }
  if (endpoint && (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password)) {
    throw new Error("LOCAL_ONLY");
  }
  const writer = new LocalWriter(path, { project });
  let captureArchive;
  let taskOwner;
  const taskCommands = Object.freeze({ 'task-new': 'newTask', 'task-save': 'saveCheckpoint', 'task-link': 'linkTask', 'task-read': 'readVisibleTask', 'task-confirm': 'confirmTask', 'task-status': 'taskStatus' });
  const taskRejections = new Set(['TASK_INPUT', 'TASK_SECRET', 'TASK_CAS', 'TASK_CAPACITY', 'TASK_NOT_FOUND', 'TASK_REVISION', 'TASK_SESSION', 'TASK_ID', 'TASK_MARKER', 'TASK_OBSERVATION']);
  try {
    if (archiveOnly) captureArchive = initializeCaptureArchive(writer, worktree);
    if (assistantLocal) taskOwner = initializeTaskOwner(writer, { project, worktree });
    secureOwnedFiles(root);
    initializeCuration(writer.db);
    writer.db.exec("CREATE TABLE IF NOT EXISTS host_snapshot(job_id INTEGER PRIMARY KEY,snapshot BLOB NOT NULL)");
  } catch (error) {
    try {
      writer.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "HOST_START_CLEANUP_FAILED");
    }
    throw error;
  }
  let readersPaused = false;
  const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  function base64(value) {
    if (typeof value !== "string" || value.length > 1398104) {
      throw new Error("HOST_BYTES");
    }
    const result = Buffer.from(value, "base64");
    if (result.toString("base64") !== value) {
      throw new Error("HOST_BYTES");
    }
    return result;
  }
  function statusRequest(request) {
    const limit = request.limit === undefined ? 100 : request.limit;
    const input = request.cursor === undefined ? {} : request.cursor;
    const names = ['jobs', 'candidates', 'responses', 'attempts'];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
        !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !names.includes(key))) {
      throw new Error('HOST_STATUS_ARGUMENTS');
    }
    const cursor = {};
    for (const name of names) {
      const value = input[name] === undefined ? 0 : input[name];
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('HOST_STATUS_ARGUMENTS');
      }
      cursor[name] = value;
    }
    return {limit, cursor};
  }

  // 每个集合使用独立递增游标，SQL 在读取边界最多取 limit+1 行，不把无界原文 metadata 搬入 JS。
  // 分类建议只是私有模型数据，缺失或非法不猜默认值，最终 category 仍须可信 review 显式选择。
  function readStatus({limit, cursor}) {
    const categories = CATEGORIES.map(category => `'${category}'`).join(',');
    const suggested = `json_valid(o.metadata) AND json_type(o.metadata)='object'
      AND json_type(o.metadata,'$.categorySuggestion')='text'
      AND json_extract(o.metadata,'$.categorySuggestion') IN (${categories})`;
    const queries = {
      jobs: 'SELECT id AS position,id,state,diagnostic FROM writer_job WHERE id>? ORDER BY id LIMIT ?',
      candidates: `SELECT r.rowid AS position,r.kind,r.result_id AS id,r.job_id AS jobId,
        CASE WHEN json_valid(o.metadata) THEN CASE WHEN ${suggested}
          THEN json_extract(o.metadata,'$.categorySuggestion') ELSE NULL END ELSE NULL END AS categorySuggestion,
        CASE WHEN o.metadata IS NULL THEN 'missing' WHEN NOT json_valid(o.metadata) THEN 'invalid'
          WHEN json_type(o.metadata)<>'object' THEN 'missing'
          WHEN json_type(o.metadata,'$.categorySuggestion') IS NULL THEN 'missing'
          WHEN ${suggested} THEN 'suggested' ELSE 'invalid' END AS categorySuggestionState
        FROM writer_result r LEFT JOIN observations o ON r.kind='observation' AND o.id=r.result_id
        WHERE r.rowid>? ORDER BY r.rowid LIMIT ?`,
      responses: 'SELECT job_id AS position,job_id AS jobId,length(raw) AS bytes FROM writer_response WHERE job_id>? ORDER BY job_id LIMIT ?',
      attempts: 'SELECT id AS position,id,job_id AS jobId,state FROM writer_attempt WHERE id>? ORDER BY id LIMIT ?',
    };
    const result = {limit, next: {}, hasMore: {}};
    for (const [name, sql] of Object.entries(queries)) {
      const fetched = writer.db.query(sql).all(cursor[name], limit + 1);
      result.hasMore[name] = fetched.length > limit;
      const rows = fetched.slice(0, limit);
      result.next[name] = rows.length ? rows.at(-1).position : cursor[name];
      if (!Number.isSafeInteger(result.next[name])) {
        throw new Error('HOST_STATUS_POSITION');
      }
      result[name] = rows.map(({position, ...row}) => row);
    }
    result.publication = writer.db.query("SELECT name FROM sqlite_master WHERE name='host_publication'").get()
      ? writer.db.query('SELECT stage,generation FROM host_publication WHERE id=1').get() : null;
    return result;
  }
  const controller = new AbortController();
  let closing = false;
  let consumer = null;
  let wakeRequested = false;
  let shutdown = null;
  let failure = null;
  const cleanupErrors = [];
  const pendingReplies = new Set();
  const lifetime = setTimeout(() => close(new Error("HOST_DEADLINE")), Math.max(0, lifetimeMs - (performance.now() - started)));
  function remember(error) {
    failure ??= error;
  }
  // 控制状态必须先于任何输出等待推进，所有异步回调都只调用不会reject的close。
  function stop(error) {
    if (error) {
      remember(error);
    }
    const firstStop = !closing;
    closing = true;
    controller.abort();
    for (const cancel of [...pendingReplies]) {
      cancel();
    }
    process.stdin.destroy();
    if (firstStop) {
      try {
        onStopping();
      } catch (error2) {
        remember(error2);
      }
    }
  }
  function close(error) {
    stop(error);
    if (shutdown) {
      return shutdown;
    }
    shutdown = (async () => {
      clearTimeout(lifetime);
      await consumer;
      if (closeGenerator) {
        try {
          await closeGenerator();
        } catch (error2) {
          cleanupErrors.push("generator-unreleased");
          remember(error2);
        }
      }
      // 各项分别尝试释放，DB未关闭是保留owner的安全例外，原始运行错优先保留。
      let dbClosed = false;
      try {
        writer.finalizePrepared();
        writer.db.clearQueryCache();
        writer.store.close();
        dbClosed = true;
      } catch (error2) {
        cleanupErrors.push("db-unreleased");
        remember(error2);
      }
      // DB关闭未确认时保留owner，避免仍活连接与第二writer并用，由外层确认进程退出后再接管。
      if (dbClosed) {
        try {
          writer.owner.close();
        } catch (error2) {
          cleanupErrors.push("owner-unreleased");
          remember(error2);
        }
      } else cleanupErrors.push("owner-retained");
      try {
        process.stdin.destroy();
      } catch (error2) {
        cleanupErrors.push("stdin");
        remember(error2);
      }
      process.stderr.write(JSON.stringify({ kind: "WORKER_STOPPED", failure: failure ? "HOST_FAILED" : null, cleanupErrors }) + "\n");
    })();
    // close本身也在创建当刻接管，输出诊断的同步失败仍标记失败，不产生悬空reject。
    shutdown = shutdown.catch(remember);
    return shutdown;
  }
  process.stderr.on("error", (error) => {
    close(error);
  });
  process.on("SIGTERM", () => {
    close();
  });
  process.on("SIGINT", () => {
    close();
  });
  process.stdout.on("error", (error) => {
    close(error);
  });
  process.stdout.on("close", () => {
    if (!closing) {
      close(new Error("OUTPUT_CLOSED"));
    }
  });
  // write回调表示该次写入完成，取消、error或close都必须结算并移除监听，不依赖drain单一事件。
  function reply(value, allowClosing = false) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        process.stdout.off("error", onError);
        process.stdout.off("close", onClose);
        pendingReplies.delete(onAbort);
        error ? reject(error) : resolve();
      };
      const onError = (error) => {
        close(error);
        finish(error);
      };
      const onClose = () => onError(new Error("OUTPUT_CLOSED"));
      const onAbort = () => finish(failure ?? new Error("CLOSING"));
      process.stdout.once("error", onError);
      process.stdout.once("close", onClose);
      pendingReplies.add(onAbort);
      if (closing && !allowClosing) {
        onAbort();
        return;
      }
      try {
        process.stdout.write(encodeReply(value), (error) => {
          if (error) {
            onError(error);
          } else {
            finish();
          }
        });
      } catch (error) {
        onError(error);
      }
    });
  }
  // 只有此consumer派发，拒绝处理器在创建当刻接管SQLite存取错误，完成凭据永不reject。
  function kick() {
    if (closing) {
      return;
    }
    wakeRequested = true;
    if (consumer) {
      return;
    }
    consumer = (async () => {
      while (wakeRequested && !closing) {
        wakeRequested = false;
        const maximum = writer.db.query('SELECT coalesce(max(id),0) AS id FROM writer_job').get().id;
        let after = 0;
        while (!closing) {
          const candidates = writer.db.query("SELECT id,state FROM writer_job WHERE id>? AND id<=? AND state IN ('queued','response_ready') ORDER BY id LIMIT 100").all(after, maximum);
          if (!candidates.length) {
            break;
          }
          for (const row of candidates) {
            if (closing) {
              return;
            }
            after = row.id;
            if (row.state === 'queued') {
              await writer.dispatch(row.id, {
                endpoint: endpoint?.href, generate, authorized: true, online: true,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestMs)]), project,
                snapshotProvider: jobId => {
                  const current = writer.db.query('SELECT snapshot FROM host_snapshot WHERE job_id=?').get(jobId);
                  return current ? JSON.parse(decode.decode(current.snapshot)) : undefined;
                },
              });
            }
            if (!closing) {
              writer.apply(row.id);
            }
            // 每项之后交还事件循环，使信号、stdin 与总预算不会被同步 SQLite apply 饥饿。
            await new Promise(resolve => setImmediate(resolve));
          }
        }
      }
    })().then(() => {
      consumer = null;
    }, (error) => {
      stop(error);
      close();
    });
  }
  let pending = Buffer.alloc(0);
  try {
    // 重开只恢复已落盘响应，不自动重发unknown，也不自动启动queued。
    let recoveredAfter = 0;
    while (!closing && !archiveOnly) {
      const rows = writer.db.query("SELECT id FROM writer_job WHERE state='response_ready' AND id>? ORDER BY id LIMIT 100").all(recoveredAfter);
      if (!rows.length) {
        break;
      }
      for (const row of rows) {
        if (closing) {
          break;
        }
        writer.apply(row.id);
        recoveredAfter = row.id;
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    await reply({ kind: "READY", pid: process.pid });
    for await (const chunk of process.stdin) {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 3 * 1024 * 1024) {
        throw new Error("COMMAND_LIMIT");
      }
      let end;
      while (!closing && (end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        // 仅纯输入与源文件读取阶段可回复后继续，进入DB或可信宿主回调后不能假定连接仍可使用。
        let canReplyOnFailure = true;
        try {
          if (!Number.isSafeInteger(request.id)) {
            throw new Error("INVALID_ID");
          }
          let result;
          const taskMethod = Object.hasOwn(taskCommands, request.command) ? taskCommands[request.command] : null;
          if (archiveOnly && !['archive', 'receipt', 'status', 'close'].includes(request.command) && !(assistantLocal && taskMethod)) throw new Error('ARCHIVE_ONLY');
          if (assistantLocal && taskMethod) {
            if (Object.keys(request).sort().join(',') !== 'command,id,payload' || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) throw new Error('TASK_INPUT');
            canReplyOnFailure = false;
            result = taskOwner[taskMethod](request.payload);
          } else if (archiveOnly && request.command === 'status') {
            if (Object.keys(request).sort().join(',') !== 'command,id') throw new Error('HOST_STATUS_ARGUMENTS');
            // 只借用当前 writer 的 deferred 只读事务，不启动 owner、consumer 或生成。
            canReplyOnFailure = false;
            result = readDurableMemoryStatus(writer);
          } else if (archiveOnly && request.command === 'archive') {
            const round = { ...request.round, raw: base64(request.round.rawBase64) };
            delete round.rawBase64;
            canReplyOnFailure = false;
            result = captureArchive.archive(round, request.observation);
          } else if (archiveOnly && request.command === 'receipt') {
            if (!Number.isSafeInteger(request.jobId) || request.jobId < 1) throw new Error('CAPTURE_INPUT');
            canReplyOnFailure = false;
            result = captureArchive.receipt(request.jobId);
          } else if (request.command === "capture") {
            const round = { ...request.round, raw: base64(request.round.rawBase64) };
            delete round.rawBase64;
            canReplyOnFailure = false;
            result = writer.receipt(writer.capture(round));
          } else if (request.command === "approve-input") {
            if (request.approval.project !== project) {
              throw new Error("WRITER_PROJECT_MISMATCH");
            }
            const approval = { ...request.approval, approvedBytes: base64(request.approval.approvedBytes) };
            canReplyOnFailure = false;
            registerApprovedInput(writer.db, approval);
            writer.selectApprovedInput(request.jobId, { approvalId: approval.approvalId });
            result = "approved";
          } else if (request.command === "revoke-input") {
            canReplyOnFailure = false;
            invalidateApprovedInput(writer.db, request.approvalId);
            result = "revoked";
          } else if (request.command === "set-current") {
            canReplyOnFailure = false;
            if (!writer.receipt(request.jobId)) {
              throw new Error("HOST_JOB");
            }
            writer.db.run("INSERT INTO host_snapshot VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET snapshot=excluded.snapshot", [request.jobId, Buffer.from(JSON.stringify(request.snapshot))]);
            result = "snapshot-recorded";
          } else if (request.command === "candidate") {
            if (request.proposal.project !== project) {
              throw new Error("WRITER_PROJECT_MISMATCH");
            }
            canReplyOnFailure = false;
            result = prepareCuration(writer.db, request.proposal);
          } else if (request.command === "review") {
            if (request.submission.proposal.project !== project) {
              throw new Error("WRITER_PROJECT_MISMATCH");
            }
            canReplyOnFailure = false;
            result = registerReviewed(writer.db, request.submission);
          } else if (request.command === "pause-confirmed") {
            if (request.confirmation !== "all-readers-stopped") {
              throw new Error("READERS_MUST_BE_PAUSED");
            }
            canReplyOnFailure = false;
            retainPublicationPause(projectPath);
            readersPaused = true;
            result = "paused";
          } else if (request.command === "invalidate") {
            if (!readersPaused) {
              throw new Error("READERS_MUST_BE_PAUSED");
            }
            if (request.invalidation.project !== project) {
              throw new Error("WRITER_PROJECT_MISMATCH");
            }
            canReplyOnFailure = false;
            result = invalidateKnowledge(writer.db, request.invalidation);
          } else if (request.command === "publish") {
            canReplyOnFailure = false;
            result = publishProject(writer.db, { project, projectPath, readersPaused });
            readersPaused = false;
          } else if (request.command === "recover") {
            canReplyOnFailure = false;
            result = recoverProject(writer.db, { project, projectPath, readersPaused });
            if (result.stage === "committed") {
              readersPaused = false;
            }
          } else if (request.command === "status" || request.command === "receipt") {
            const page = statusRequest(request);
            canReplyOnFailure = false;
            result = readStatus(page);
          } else if (request.command === "wake" || request.command === "consume") {
            canReplyOnFailure = false;
            kick();
            result = "awake";

          } else if (request.command === "close") {
            canReplyOnFailure = false;
            await close();
            await reply({ id: request.id, result: "closed" }, true);
            break;
          } else throw new Error("COMMAND");
          await reply({ id: request.id, result });
        } catch (error) {
          if (assistantLocal && Object.hasOwn(taskCommands, request.command) && taskRejections.has(error.message) && !closing) {
            // 仅已知输入/CAS/容量拒绝可在事务回滚后继续，其他持久化与协议故障统一停 owner。
            await reply({ id: request.id, error: error.message });
            continue;
          }
          if (closing || !canReplyOnFailure) {
            // 先停止接收并取消在途任务，原错交给最外层finally统一关闭，不依赖错误回执可写。
            stop(error);
            throw error;
          }
          await reply({ id: request.id, error: "HOST_COMMAND_REJECTED" });
        }
      }
      if (closing) {
        break;
      }
    }
    if (pending.length && !closing) {
      throw new Error("INCOMPLETE_COMMAND");
    }
  } catch (error) {
    if (!closing || failure) {
      remember(error);
    }
  } finally {
    await close();
  }
  if (failure) {
    throw new Error("HOST_FAILED", { cause: failure });
  }
}
