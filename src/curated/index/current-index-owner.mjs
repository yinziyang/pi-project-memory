import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { INDEX_CLOSE_SETTLE_MS, waitIndexSettlement } from './settlement.mjs';
import { openIndexCache } from './cache.mjs';
import { readIndexJson } from './bounded-json.mjs';
import { createOwnedProcess } from './owned-process.mjs';
import { digest, indexIdentity, mapCurrentRows, modelFingerprint, validateCandidates } from './identity.mjs';
import { localRuntimeModuleURL } from './runtime-path.mjs';

const workerPath = (name) => fileURLToPath(new URL(name, import.meta.url));
const referenceRows = (records) => records.map(({ id, ref }) => ({ id, ref }));
const QUERY_E5_IDLE_MS = 15000;
const validBinding = (binding) => binding && ['sourceBinding', 'checkoutToken'].every((key) => typeof binding[key] === 'string' && binding[key].length > 0) && Number.isSafeInteger(binding.ownerEpoch) && binding.ownerEpoch >= 0;

/** 创建 Linux 本地索引所有者，调用方只借用模型文件，必须等待 close 后才释放运行时与公开路径。
 * trustedRuntime 必须来自宿主可信配置，checkBinding 负责核对当前 checkout、来源和 epoch，不能用模型身份代替运行许可。
 * 缺依赖、缺索引或未知缓存仅返回显式 degradation，matching 索引损坏会持续拒绝后续查询，直到显式 refresh 验证或重建成功，正文仍由当前 SQLite 水合。
 * 同步 ORT 和 Chroma 以自有直接子进程隔离，取消给 3500 毫秒确认窗口，close 固定 5000 毫秒，超限只返回 UNCONFIRMED 并保留真实任务、fd、进程句柄和产物。
 * 查询 E5 按需保留单个子进程，空闲 15000 毫秒即回收，进程绝对预算与单次查询预算分别计时，构建 E5 和 Chroma 不复用查询进程。
 * 只有重复 close 实际成功才解除恢复门禁，晚回调只能收尾，不能把旧构建重新安装，不能保证永久内核故障下一定可 KILL/reap。
 */
export function createCurrentIndexOwner(trustedRuntime) {
  const runtime = trustedRuntime;
  if (!runtime || typeof runtime.checkBinding !== 'function' || !Number.isSafeInteger(runtime.budgetMs) || runtime.budgetMs < 1000 || runtime.budgetMs > 300000) throw new Error('INDEX_RUNTIME_INVALID');
  let state = 'INDEX_MISSING';
  let recoveryRequired = false;
  let closing;
  let closed = false;
  let ready;
  let invalidReadyName;
  let fingerprint;
  let transformersEntry = runtime.transformersEntry;
  let cache;
  let activeBuild;
  let pendingBuild;
  let pumping;
  let queryActive = false;
  let queryController;
  let queryEmbedder;
  let sequence = 0;
  const lifetime = new AbortController();
  const operations = new Set();
  const retained = [];
  const retainedFiles = new Map();
  const ownedFiles = new Set();
  const processes = new Set();

  function resourceDiagnostics() {
    const live = [...processes].filter(handle => !handle.closed);
    const pids = new Set(live.map(handle => handle.pid));
    const resources = retained.filter(resource => pids.has(resource.pid));
    if (recoveryRequired) for (const handle of live) if (!resources.some(resource => resource.pid === handle.pid)) resources.push({ pid: handle.pid, reason: 'close-unconfirmed' });
    const files = new Set([...retainedFiles.keys(), ...(recoveryRequired ? ownedFiles : [])]);
    return [...structuredClone(resources), ...[...files].map(() => ({ owner: 'index-json-reader', state: 'close-unconfirmed' })),
      ...(recoveryRequired ? [{ owner: 'current-index-owner', state: operations.size ? 'operation-unsettled' : 'retry-required', count: operations.size }] : [])];
  }
  function suspend(error) {
    recoveryRequired = true;
    closed = true;
    sequence++;
    state = 'INDEX_CLOSE_UNCONFIRMED';
    lifetime.abort(error);
  }
  function expose(task, signal) {
    return waitIndexSettlement(task, { signal, code: 'INDEX_OPERATION_UNCONFIRMED', onUnconfirmed: suspend });
  }
  function track(task) {
    operations.add(task);
    task.then(() => operations.delete(task), () => operations.delete(task));
    return task;
  }
  function combined(signal) {
    return AbortSignal.any([lifetime.signal, AbortSignal.timeout(runtime.budgetMs), ...(signal ? [signal] : [])]);
  }
  function spawnWorker(command, args, signal) {
    const handle = createOwnedProcess(command, args, { signal, budgetMs: runtime.budgetMs,
      onRetained: (resource) => retained.push(resource) });
    processes.add(handle);
    return handle;
  }
  async function release(handle, finish = false) {
    try { await (finish ? handle.finish() : handle.close()); }
    finally { if (handle.closed) processes.delete(handle); }
  }
  async function permitted(binding, signal) {
    signal.throwIfAborted();
    if (retained.length || retainedFiles.size) throw new Error('INDEX_REAP_UNCONFIRMED');
    if (closed || !validBinding(binding) || await runtime.checkBinding(binding, signal) !== true) throw new Error('INDEX_BINDING_STALE');
    signal.throwIfAborted();
    if (retained.length || retainedFiles.size) throw new Error('INDEX_REAP_UNCONFIRMED');
  }
  async function initialize(signal) {
    signal.throwIfAborted();
    if (!fingerprint) {
      let manifest;
      try { manifest = (await readIndexJson(runtime.manifestPath, { signal, ownedFiles })).value; }
      catch (error) {
        if (error?.retainedFile) throw error;
        signal.throwIfAborted();
        if (error?.code === 'ENOENT' || error?.code === 'EACCES') throw new Error('INDEX_MODEL_MISSING', { cause: error });
        throw new Error('INDEX_MODEL_PROFILE_MISMATCH', { cause: error });
      }
      const nextFingerprint = modelFingerprint(manifest);
      for (const executable of [runtime.nodeExecutable, runtime.pythonExecutable, runtime.bunExecutable]) {
        try { await access(executable, constants.X_OK); } catch { throw new Error('DEPENDENCY_MISSING'); }
      }
      if (transformersEntry === undefined) {
        // import.meta.resolve 也可能访问磁盘，只在已有 E5 隔离入口的只解析模式执行，不占用 Pi 主事件循环。
        const resolver = spawnWorker(runtime.nodeExecutable, [workerPath('e5-worker.mjs')], signal);
        try {
          const result = await resolver.request({ op: 'resolve' });
          if (!result || typeof result.path !== 'string') throw new Error('INDEX_PROTOCOL_INVALID');
          localRuntimeModuleURL(result.path);
          transformersEntry = result.path;
          await resolver.finish();
        } finally { await release(resolver); }
      }
      try { await access(transformersEntry); } catch { throw new Error('DEPENDENCY_MISSING'); }
      cache = await openIndexCache({ ...runtime, signal, ownedFiles });
      signal.throwIfAborted();
      fingerprint = nextFingerprint;
    }
  }
  async function snapshot(binding, signal) {
    const handle = spawnWorker(runtime.bunExecutable, [workerPath('snapshot-worker.mjs')], signal);
    try {
      const header = await handle.request({ op: 'init', publicPath: binding.publicPath, project: binding.project });
      if (header.generation !== binding.generation || !Number.isSafeInteger(header.count) || header.count < 0 || header.count > 10000) throw new Error('INDEX_PUBLICATION_INVALID');
      const rows = [];
      while (rows.length < header.count) {
        signal.throwIfAborted();
        const batch = await handle.request({ op: 'next', offset: rows.length });
        if (batch.offset !== rows.length || !Array.isArray(batch.rows) || batch.rows.length !== Math.min(4, header.count - rows.length)) throw new Error('INDEX_PROTOCOL_INVALID');
        rows.push(...batch.rows);
      }
      await handle.finish();
      return { generation: header.generation, rows };
    } finally { await release(handle); }
  }
  function spawnE5(signal) {
    return spawnWorker(runtime.nodeExecutable, [workerPath('e5-worker.mjs')], signal);
  }
  async function initializeE5(handle) {
    const result = await handle.request({ op: 'init', manifestPath: runtime.manifestPath, modelRoot: runtime.modelRoot,
      fingerprint, transformersEntry });
    if (result.fingerprint !== fingerprint) throw new Error('INDEX_MODEL_PROFILE_MISMATCH');
  }
  async function e5(signal) {
    const handle = spawnE5(signal);
    try {
      await initializeE5(handle);
      return handle;
    } catch (error) { await release(handle); throw error; }
  }
  // 定时器、取消和 refresh 共用实际回收屏障，未收到 close 事件前不能创建替代进程。
  function retireQueryEmbedder() {
    const slot = queryEmbedder;
    if (!slot) return;
    clearTimeout(slot.idleTimer);
    if (!slot.retiring) {
      slot.retiring = track(release(slot.handle).then(() => { queryEmbedder = undefined; }, error => {
        suspend(error);
        throw error;
      }));
      // 空闲回收没有直接调用者，失败已在上面关闭门禁并保留进程句柄。
      slot.retiring.catch(() => {});
    }
    return slot.retiring;
  }
  async function acquireQueryEmbedder(signal) {
    signal.throwIfAborted();
    const slot = queryEmbedder;
    if (slot && !slot.retiring && slot.handle.available && performance.now() < slot.idleDeadline) {
      clearTimeout(slot.idleTimer);
      return slot.handle;
    }
    if (slot) await retireQueryEmbedder();
    signal.throwIfAborted();
    // 进程只受所有者生命周期和绝对预算约束，查询取消由本次 search 负责，不能绑定到下一次查询。
    const handle = spawnE5(lifetime.signal);
    queryEmbedder = { handle };
    await initializeE5(handle);
    return handle;
  }
  function parkQueryEmbedder(handle) {
    const slot = queryEmbedder;
    if (!slot || slot.handle !== handle || slot.retiring || !handle.available) return retireQueryEmbedder();
    slot.idleDeadline = performance.now() + QUERY_E5_IDLE_MS;
    slot.idleTimer = setTimeout(retireQueryEmbedder, QUERY_E5_IDLE_MS);
  }
  async function chroma(directory, identity, signal, create) {
    const handle = spawnWorker(runtime.pythonExecutable, [workerPath('chroma-worker.py')], signal);
    try {
      await handle.request({ op: 'init', directory, identity, create, collection: `curated-${digest(identity)}` });
      return handle;
    } catch (error) { await release(handle); throw error; }
  }
  async function verify(directory, identity, records, signal) {
    const handle = await chroma(directory, identity, signal, false);
    try {
      const result = await handle.request({ op: 'verify', records: referenceRows(records) });
      if (result.count !== records.length) throw new Error('INDEX_INVALID');
    } finally { await release(handle, true); }
  }
  async function build(job) {
    const signal = AbortSignal.any([job.controller.signal, job.signal]);
    await permitted(job.binding, signal);
    await initialize(signal);
    signal.throwIfAborted();
    const lease = spawnWorker(runtime.pythonExecutable, [workerPath('lease-worker.py')], signal);
    try {
      const result = await lease.request({ directory: cache.root });
      if (result.held !== true) throw new Error('INDEX_PROTOCOL_INVALID');
      await buildSnapshot(job, signal, lease);
    } finally { await release(lease, true); }
  }
  async function buildSnapshot(job, signal, lease) {
    const identity = indexIdentity(job.binding, fingerprint);
    const current = await snapshot(job.binding, signal);
    if (current.rows.length > 10000) throw new Error('INDEX_CAPACITY_EXCEEDED');
    const records = mapCurrentRows(current, identity);
    const existing = await cache.readReady(identity, signal);
    if (existing && existing.name !== invalidReadyName) {
      while (queryActive) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        signal.throwIfAborted();
      }
      if (existing.refsDigest !== digest(referenceRows(records))) {
        invalidReadyName = existing.name;
        throw new Error('INDEX_INVALID');
      }
      try { await verify(existing.directory, identity, records, signal); }
      catch (error) {
        if (error.message === 'INDEX_INVALID') invalidReadyName = existing.name;
        throw error;
      }
      await permitted(job.binding, signal);
      if (job.sequence !== sequence) throw new Error('INDEX_BINDING_STALE');
      ready = { ...existing, records, binding: structuredClone(job.binding) };
      state = 'READY';
      return;
    }
    const stage = await cache.stage(identity, signal);
    let embedder;
    let writer;
    try {
      writer = await chroma(stage.directory, identity, signal, true);
      if (records.length) embedder = await e5(signal);
      for (let offset = 0; offset < records.length; offset += 4) {
        signal.throwIfAborted();
        // 查询使用独立只读目录和 worker，有限批次之间主动让出调度权，不让一批无限增长。
        while (queryActive) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          signal.throwIfAborted();
        }
        const batch = records.slice(offset, offset + 4);
        const vectors = await embedder.request({ op: 'embed', kind: 'passage', texts: batch.map((record) => record.document) });
        await writer.request({ op: 'add', records: referenceRows(batch), vectors });
      }
      await writer.request({ op: 'verify', records: referenceRows(records) });
    } finally {
      const results = await Promise.allSettled([...(embedder ? [release(embedder, true)] : []), ...(writer ? [release(writer, true)] : [])]);
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
    // 只有构建进程实际关闭并重新打开持久目录校验后才发布指针，旧 epoch 或被取代的构建永不安装。
    await verify(stage.directory, identity, records, signal);
    await permitted(job.binding, signal);
    if (job.sequence !== sequence) throw new Error('INDEX_BINDING_STALE');
    const installed = await cache.install(stage, identity, records, () => job.sequence === sequence && !signal.aborted && !closed, signal, async temporary => {
      const result = await lease.request({ op: 'commit', temporary: basename(temporary) });
      if (result.installed !== true) throw new Error('INDEX_PROTOCOL_INVALID');
    });
    signal.throwIfAborted();
    if (job.sequence !== sequence) throw new Error('INDEX_BINDING_STALE');
    ready = { ...installed, records, binding: structuredClone(job.binding) };
    invalidReadyName = undefined;
    state = 'READY';
  }
  async function pump() {
    while (pendingBuild && !closed) {
      const job = pendingBuild;
      pendingBuild = undefined;
      job.dispose();
      activeBuild = job;
      state = 'BUILDING';
      try {
        await retireQueryEmbedder();
        await build(job);
        job.resolve({ state });
      }
      catch (error) {
        if (error?.retainedFile) retainedFiles.set(error.retainedFile, error);
        const failureCode = typeof error?.message === 'string' ? error.message : '';
        if (job.sequence === sequence) {
          if (['DEPENDENCY_MISSING', 'INDEX_MODEL_MISSING', 'INDEX_MODEL_PROFILE_MISMATCH'].includes(failureCode)) state = failureCode;
          else if (failureCode.startsWith('INDEX_CACHE_') && !invalidReadyName) state = 'INDEX_CACHE_UNAVAILABLE';
          else state = 'INDEX_INVALID';
        }
        job.reject(error);
      } finally { activeBuild = undefined; }
    }
  }
  return {
    refresh(binding, signal) {
      if (recoveryRequired) return Promise.reject(new Error('INDEX_CLOSE_UNCONFIRMED'));
      if (closed) return Promise.reject(new Error('INDEX_CLOSED'));
      signal?.throwIfAborted();
      sequence++;
      activeBuild?.controller.abort(new Error('INDEX_BUILD_SUPERSEDED'));
      pendingBuild?.dispose();
      pendingBuild?.resolve({ state: 'SUPERSEDED' });
      const operationSignal = combined(signal);
      let job;
      const result = new Promise((resolve, reject) => {
        job = { binding: structuredClone(binding), signal: operationSignal, sequence, controller: new AbortController(), resolve, reject };
        const abort = () => {
          if (pendingBuild !== job) return;
          pendingBuild = undefined;
          job.dispose();
          reject(operationSignal.reason);
        };
        job.dispose = () => operationSignal.removeEventListener('abort', abort);
        operationSignal.addEventListener('abort', abort, { once: true });
        pendingBuild = job;
      });
      queryController?.abort(new Error('INDEX_BINDING_STALE'));
      const reaping = retireQueryEmbedder();
      if (!pumping) {
        // 先登记真实 pump，再进入可能重入关闭的调用方回调，公开等待的期限不能取代串行提交屏障。
        pumping = track(Promise.resolve().then(pump)).finally(() => { pumping = undefined; });
        pumping.catch(() => {});
      }
      return expose(result.finally(() => reaping), AbortSignal.any([operationSignal, job.controller.signal]));
    },
    search({ query, topK = 5, expectedBinding, signal: callerSignal }) {
      if (recoveryRequired) return Promise.reject(new Error('INDEX_CLOSE_UNCONFIRMED'));
      if (queryController) return Promise.reject(new Error('INDEX_BUSY'));
      const controller = new AbortController();
      queryController = controller;
      const signal = combined(AbortSignal.any([controller.signal, ...(callerSignal ? [callerSignal] : [])]));
      const abort = () => { retireQueryEmbedder(); };
      let embedder;
      let reusable = false;
      // 查询即使尚在验证授权或 Chroma，也必须在取消时停止复用进程，且在归还进程前先解绑该次取消监听。
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const task = track(Promise.resolve().then(async () => {
        if (closed) throw new Error('INDEX_CLOSED');
        if (typeof query !== 'string' || !query.isWellFormed() || !query.trim() || Buffer.byteLength(query) > 2048 || !Number.isInteger(topK) || topK < 1 || topK > 10) throw new Error('INVALID_QUERY');
        if (queryActive) throw new Error('INDEX_BUSY');
        await permitted(expectedBinding, signal);
        const selected = ready;
        // matching 损坏是已知失败，不得因 ready 被撤销而把第二次查询伪装成缺失后的成功降级。
        if (state === 'INDEX_INVALID') throw new Error('INDEX_INVALID');
        if (['BUILDING', 'DEPENDENCY_MISSING', 'INDEX_MODEL_MISSING', 'INDEX_MODEL_PROFILE_MISMATCH', 'INDEX_CACHE_UNAVAILABLE'].includes(state)) return { candidates: [], degradation: state };
        if (!selected) return { candidates: [], degradation: 'INDEX_MISSING' };
        if (digest(selected.binding) !== digest(expectedBinding)) return { candidates: [], degradation: 'INDEX_GENERATION_MISMATCH' };
        queryActive = true;
        let reader;
        let candidates;
        try {
          await cache.inspect(selected.name, selected.identity, signal);
          reader = await chroma(selected.directory, selected.identity, signal, false);
          await reader.request({ op: 'verify', records: referenceRows(selected.records) });
          if (!selected.records.length) return { candidates: [] };
          embedder = await acquireQueryEmbedder(signal);
          signal.throwIfAborted();
          const vectors = await embedder.request({ op: 'embed', kind: 'query', texts: [query] });
          const result = await reader.request({ op: 'query', vector: vectors[0], topK });
          candidates = validateCandidates(result, selected.records, selected.identity, topK);
          await permitted(expectedBinding, signal);
          if (ready !== selected) throw new Error('INDEX_BINDING_STALE');
        } catch (error) {
          if (error?.retainedFile) retainedFiles.set(error.retainedFile, error);
          retireQueryEmbedder();
          signal.throwIfAborted();
          // 进程绝对寿命耗尽不是持久索引损坏，只有确认回收后下一次查询才可重新启动。
          if (error.message !== 'INDEX_BINDING_STALE' && error.message !== 'INDEX_BUDGET_EXCEEDED') {
            if (['DEPENDENCY_MISSING', 'INDEX_MODEL_MISSING', 'INDEX_MODEL_PROFILE_MISMATCH'].includes(error.message)) state = error.message;
            else {
              invalidReadyName = selected.name;
              ready = undefined;
              state = 'INDEX_INVALID';
            }
          }
          throw error;
        } finally {
          if (reader) await release(reader, true);
        }
        signal.throwIfAborted();
        reusable = true;
        return { candidates };
      }).finally(async () => {
        signal.removeEventListener('abort', abort);
        try {
          if (reusable && !signal.aborted) await parkQueryEmbedder(embedder);
          else await retireQueryEmbedder();
        } finally {
          queryActive = false;
          queryController = undefined;
        }
      }));
      return expose(task, signal);
    },
    /** count 仅在 READY 时返回最后完整验证的索引存量，其余状态为 null，空索引的已知零不等于未知。
     * 调用方还须核对 generation 与当前公开版本，不得把历史已验证存量冒充当前覆盖数量。
     */
    status() {
      return { state, generation: ready?.identity.generation,
        count: state === 'READY' ? ready.records.length : null,
        building: Boolean(activeBuild), pending: Boolean(pendingBuild), retained: resourceDiagnostics().length };
    },
    diagnostics: resourceDiagnostics,
    async close() {
      const deadline = performance.now() + INDEX_CLOSE_SETTLE_MS;
      closed = true;
      if (!recoveryRequired) state = 'CLOSING';
      sequence++;
      lifetime.abort(new Error('INDEX_CLOSED'));
      clearTimeout(queryEmbedder?.idleTimer);
      pendingBuild?.dispose();
      pendingBuild?.reject(new Error('INDEX_CLOSED'));
      pendingBuild = undefined;
      if (!closing) closing = (async () => {
        // 先确认自有子进程实际关闭，再等真实任务 settle，仍被任务使用的 fd 不得提前释放。
        const processResults = await Promise.allSettled([...processes].map(handle => handle.close()));
        const processErrors = processResults.filter(result => result.status === 'rejected').map(result => result.reason);
        for (const handle of processes) if (handle.closed) processes.delete(handle);
        for (let i = retained.length - 1; i >= 0; i--) if (![...processes].some(handle => handle.pid === retained[i].pid)) retained.splice(i, 1);
        if (processErrors.length || processes.size) throw new AggregateError(processErrors, 'INDEX_REAP_UNCONFIRMED');
        await Promise.allSettled([...operations]);
        const files = new Set([...ownedFiles, ...retainedFiles.keys()]);
        const fileResults = await Promise.allSettled([...files].map(async file => {
          await file.close();
          ownedFiles.delete(file);
          retainedFiles.delete(file);
        }));
        const fileErrors = fileResults.filter(result => result.status === 'rejected').map(result => result.reason);
        if (fileErrors.length) {
          const failure = new AggregateError([...retainedFiles.values(), ...fileErrors], 'INDEX_JSON_CLOSE_FAILED');
          Object.assign(failure, { cleanupErrors: fileErrors });
          throw failure;
        }
        ready = undefined;
        queryEmbedder = undefined;
      })().finally(() => { closing = undefined; });
      try {
        await waitIndexSettlement(closing, { deadline, code: 'INDEX_CLOSE_UNCONFIRMED', onUnconfirmed: suspend });
        recoveryRequired = false;
        state = 'CLOSED';
      } catch (error) {
        suspend(error);
        Object.assign(error, { retainedResources: resourceDiagnostics() });
        throw error;
      }
    },
  };
}
