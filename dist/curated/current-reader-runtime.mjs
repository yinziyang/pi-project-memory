import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCuratedReaderBridge } from './curated-reader-bridge.mjs';
import { createCurrentIndexOwner } from './index/current-index-owner.mjs';
import { readIndexJson } from './index/bounded-json.mjs';
import { INDEX_CLOSE_SETTLE_MS, waitIndexSettlement } from './index/settlement.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const permissionKeys = ['sourceBinding', 'checkoutToken', 'ownerEpoch'];
const unavailable = new Set(['INDEX_MISSING', 'INDEX_GENERATION_MISMATCH', 'INDEX_MODEL_MISSING', 'DEPENDENCY_MISSING', 'INDEX_MODEL_PROFILE_MISMATCH', 'BUILDING', 'INDEX_CACHE_UNAVAILABLE']);
const code = error => /^[A-Z_]+$/.test(error?.message) ? error.message : 'INDEX_INVALID';

async function namespace(config, binding, signal, ownedFiles) {
  signal.throwIfAborted();
  let created = false;
  try { await lstat(config.cacheRoot); } catch (error) {
    if (error.code !== 'ENOENT' || !config.allowCreateCache) throw new Error('INDEX_CACHE_UNKNOWN');
    await mkdir(config.cacheRoot, { mode: 0o700 });
    created = true;
  }
  const stat = await lstat(config.cacheRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700 || await realpath(config.cacheRoot) !== resolve(config.cacheRoot)) throw new Error('INDEX_CACHE_UNSAFE');
  const expected = { version: 1, kind: 'current-reader-cache-base', cwd: config.cwd, project: config.project };
  const marker = join(config.cacheRoot, '.current-reader-owner.json');
  if (created) await writeFile(marker, JSON.stringify(expected), { mode: 0o600, flag: 'wx' });
  try {
    const { text } = await readIndexJson(marker, { signal, privateFile: true, ownedFiles });
    if (text !== JSON.stringify(expected)) throw new Error('INDEX_CACHE_UNKNOWN');
  } catch (error) {
    if (error?.retainedFile) throw error;
    signal.throwIfAborted();
    throw new Error('INDEX_CACHE_UNKNOWN', { cause: error });
  }
  signal.throwIfAborted();
  return join(config.cacheRoot, digest({ version: 1, cwd: config.cwd, project: config.project,
    sourceBinding: binding.sourceBinding, checkoutToken: binding.checkoutToken, ownerEpoch: binding.ownerEpoch }));
}

/** 创建 Node 所有的当前 reader，index 与 Bun bridge 都由本对象创建并负责实际关闭，配置为 null 时保持纯 SQLite 行为。
 * indexConfig 只能来自 readIndexConfig，getBinding({signal}) 必须合作取消并返回宿主当前 sourceBinding/checkoutToken/ownerEpoch，不能从公开 descriptor 取得授权。
 * Linux 本地宿主必须传入规范 cwd，install 通过 PATH 上的 python3 在打开的目录 inode 上取得共享锁。
 * 既有 Pi 实例必须全部升级并重启才会参与协作，外部非协作读者不受此锁约束。
 * install 等待锁、Bun 启动与只读安装，index 的整个后台初始化（含 namespace）独立使用 180000 毫秒预算，toolTimeoutMs 仅显式启用 index 时为 180000，否则为 15000。
 * transition 先撤销绑定并取消全部自有任务，再实际关 index 与 bridge，未确认回收会保留每项诊断且阻止重新 install。
 * 公开操作取消后最多等待 3500 毫秒，transition/close 固定 5000 毫秒，未 settle 时返回 UNCONFIRMED 并保留真实任务、fd 与 owner，不能据此安装或发布。
 * close 为终态且允许重复尝试收尾，不关闭借用回调或借用模型，调用方必须等待 close 成功且 retainedResources 为空后才能释放配置与发布目录。
 */
export function createCurrentReaderRuntime({ project, cwd, bunPath = 'bun', indexConfig = null, getBinding }) {
  if (indexConfig && (indexConfig.cwd !== cwd || indexConfig.project !== project || typeof getBinding !== 'function')) throw new Error('INDEX_BINDING_INVALID');
  const bridge = createCuratedReaderBridge({ project, bunPath: indexConfig?.bunPath ?? bunPath, allowDense: Boolean(indexConfig) });
  let slot;
  let index;
  let indexState = indexConfig ? 'INDEX_MISSING' : 'OFF';
  let lastIndexError;
  let installing;
  let epoch = 0;
  let closed = false;
  let stopping;
  let closeTask;
  let busy = false;
  let recoveryRequired = false;
  let directoryLock;
  const tasks = new Set();
  const cleanupErrors = [];
  const retainedInputs = new Map();
  const ownedFiles = new Set();
  const retained = () => [
    ...(index?.diagnostics() ?? []).map(resource => ({ ...resource, owner: 'current-index-owner' })),
    ...(bridge.diagnostics.retainedResources ?? []),
    ...[...new Set([...retainedInputs.keys(), ...(recoveryRequired ? ownedFiles : [])])].map(() => ({ owner: 'current-reader-cache-marker', state: 'close-unconfirmed' })),
    ...(recoveryRequired && directoryLock ? [{ owner: 'current-reader-directory-lock', state: 'close-unconfirmed' }] : []),
    ...(recoveryRequired ? [{ owner: 'current-reader-runtime', state: tasks.size ? 'operation-unsettled' : 'retry-required', count: tasks.size }] : []),
  ];
  // Bun 和宿主共享打开文件描述，不能主动解锁；必须确认 bridge、索引和在途任务均已回收才关闭宿主副本。
  async function releaseDirectoryLock() {
    if (!directoryLock) return;
    await directoryLock.close();
    directoryLock = undefined;
  }
  function tracked(task) {
    tasks.add(task);
    task.then(() => tasks.delete(task), () => tasks.delete(task));
    return task;
  }
  function revoke(error) {
    epoch++;
    const previous = slot;
    slot = undefined;
    previous?.controller.abort(error);
    installing?.controller.abort(error);
  }
  function quarantine(error) {
    recoveryRequired = true;
    revoke(error);
    // 等待者返回 UNCONFIRMED 后仍持有并推进真实收尾，晚结果只能释放资源，不能清除恢复门禁。
    startStop().catch(failure => { cleanupErrors.push(failure); });
  }
  function expose(task, signal) {
    return waitIndexSettlement(task, { signal, code: 'CURRENT_READER_OPERATION_UNCONFIRMED', onUnconfirmed: quarantine });
  }
  async function authorization(signal) {
    signal.throwIfAborted();
    let current;
    try { current = await getBinding({ signal }); }
    catch (error) { signal.throwIfAborted(); throw new Error('INDEX_BINDING_STALE', { cause: error }); }
    signal.throwIfAborted();
    if (!current || !['sourceBinding', 'checkoutToken'].every(key => typeof current[key] === 'string' && current[key].isWellFormed() && current[key].trim() && !current[key].includes('\0') && Buffer.byteLength(current[key]) <= 4096) || !Number.isSafeInteger(current.ownerEpoch) || current.ownerEpoch < 0) throw new Error('INDEX_BINDING_INVALID');
    return Object.fromEntries(permissionKeys.map(key => [key, current[key]]));
  }
  async function permitted(selected, signal) {
    signal.throwIfAborted();
    if (closed || slot !== selected || selected.epoch !== epoch) throw new Error('INDEX_BINDING_STALE');
    if (indexConfig && digest(await authorization(signal)) !== digest(Object.fromEntries(permissionKeys.map(key => [key, selected.binding[key]])))) throw new Error('INDEX_BINDING_STALE');
  }
  async function startIndex(selected, signal) {
    try {
      const cacheRoot = await namespace(indexConfig, selected.binding, signal, ownedFiles);
      signal.throwIfAborted();
      if (slot !== selected) throw new Error('INDEX_BINDING_STALE');
      index = createCurrentIndexOwner({ nodeExecutable: process.execPath,
        bunExecutable: indexConfig.bunPath, pythonExecutable: indexConfig.pythonPath,
        manifestPath: indexConfig.manifestPath,
        modelRoot: indexConfig.modelRoot, cacheRoot, excludedPaths: indexConfig.excludedPaths,
        allowCreateCache: indexConfig.allowCreateCache, budgetMs: 180000,
        checkBinding: async (binding, requestSignal) => {
          await permitted(selected, requestSignal);
          return digest(binding) === digest(selected.binding);
        },
      });
      await index.refresh(selected.binding, signal);
      await permitted(selected, signal);
      indexState = 'READY';
    } catch (error) {
      if (error?.retainedFile) retainedInputs.set(error.retainedFile, error);
      if (slot === selected && !selected.signal.aborted) {
        lastIndexError = code(error);
        indexState = lastIndexError.startsWith('INDEX_CACHE_') ? 'INDEX_CACHE_UNAVAILABLE' : unavailable.has(lastIndexError) ? lastIndexError : 'INDEX_INVALID';
      }
      // 后台构建的失败通过固定状态与可信 diagnostics 保留，不把它当正常构建，也不让拒绝失去所有者。
    }
  }
  function operation(args, work) {
    if (recoveryRequired) return Promise.reject(new Error('CURRENT_READER_CLOSE_UNCONFIRMED'));
    if (closed || !slot) return Promise.reject(new Error('PUBLIC_UNAVAILABLE'));
    if (busy) return Promise.reject(new Error('BUSY'));
    busy = true;
    const selected = slot;
    const signal = AbortSignal.any([selected.signal, AbortSignal.timeout(indexConfig ? 180000 : 15000), ...(args?.signal ? [args.signal] : [])]);
    const task = tracked(Promise.resolve().then(async () => {
      await permitted(selected, signal);
      const result = await work(selected, signal);
      await permitted(selected, signal);
      return result;
    }).finally(() => { busy = false; }));
    return expose(task, signal);
  }
  function startStop() {
    if (stopping) return stopping;
    const currentTasks = [...tasks];
    stopping = (async () => {
      const results = await Promise.allSettled([...(index ? [index.close()] : []), bridge.transition()]);
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) {
        cleanupErrors.push(...failures);
        throw new AggregateError(failures, 'CURRENT_READER_CLOSE_UNCONFIRMED');
      }
      // 子进程已确认关闭后才等待原生任务并释放可释放项，未 settle 的真实任务与 fd 始终强引用保留。
      await Promise.allSettled(currentTasks);
      const files = new Set([...ownedFiles, ...retainedInputs.keys()]);
      const fileResults = await Promise.allSettled([...files].map(async file => {
        await file.close();
        ownedFiles.delete(file);
        retainedInputs.delete(file);
      }));
      failures.push(...retainedInputs.values(), ...fileResults.filter(result => result.status === 'rejected').map(result => result.reason));
      if (failures.length) {
        cleanupErrors.push(...failures);
        throw new AggregateError(failures, 'CURRENT_READER_CLOSE_UNCONFIRMED');
      }
      await releaseDirectoryLock();
      index = undefined;
      indexState = indexConfig ? 'INDEX_MISSING' : 'OFF';
    })().finally(() => { stopping = undefined; });
    return stopping;
  }
  async function transition({ signal } = {}) {
    const deadline = performance.now() + INDEX_CLOSE_SETTLE_MS;
    revoke(new Error('INDEX_BINDING_STALE'));
    try {
      await waitIndexSettlement(startStop(), { deadline, code: 'CURRENT_READER_CLOSE_UNCONFIRMED', onUnconfirmed: quarantine });
      recoveryRequired = false;
      signal?.throwIfAborted();
    } catch (error) {
      recoveryRequired = true;
      Object.assign(error, { cleanupErrors: [...cleanupErrors], retainedResources: retained() });
      throw error;
    }
  }
  return {
    toolTimeoutMs: indexConfig ? 180000 : 15000,
    install({ publicPath, generation, signal }) {
      if (recoveryRequired || closed || slot || installing || stopping || retained().length) return Promise.reject(new Error('TRANSITION_REQUIRED'));
      const controller = new AbortController();
      const stamp = epoch;
      installing = { controller };
      const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(indexConfig ? 180000 : 15000), ...(signal ? [signal] : [])]);
      // 先登记启动任务，transition 才能取消并等待仍在授权或安装阶段的工作，不能让晚 install 越过新 epoch。
      const task = tracked(Promise.resolve().then(async () => {
        combined.throwIfAborted();
        if (process.platform !== 'linux' || typeof cwd !== 'string' || !cwd.isWellFormed() || !cwd || cwd.includes('\0') || resolve(cwd) !== cwd) throw new Error('PUBLIC_LOCK_CWD_INVALID');
        directoryLock = await open(cwd, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const canonical = await realpath(cwd);
        const opened = await directoryLock.stat({ bigint: true });
        const current = await lstat(cwd, { bigint: true });
        if (canonical !== cwd || !current.isDirectory() || opened.ino !== current.ino || opened.dev !== current.dev) throw new Error('PUBLIC_LOCK_CWD_INVALID');
        combined.throwIfAborted();
        const permission = indexConfig ? await authorization(combined) : {};
        combined.throwIfAborted();
        if (stamp !== epoch || closed) throw new Error('INDEX_BINDING_STALE');
        await bridge.install({ publicPath, generation, signal: combined, lockFd: directoryLock.fd });
        const publicStatus = await bridge.status({ signal: combined });
        if (publicStatus.project !== project || publicStatus.generation !== generation || !Number.isSafeInteger(publicStatus.totalRows) || publicStatus.totalRows < 0 || Object.keys(publicStatus).length !== 3) throw new Error('PUBLIC_STATUS_INVALID');
        combined.throwIfAborted();
        if (stamp !== epoch || closed) throw new Error('INDEX_BINDING_STALE');
        const selected = { epoch: stamp, controller, signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]), publicStatus, binding: { project, generation, publicPath, ...permission } };
        slot = selected;
        if (indexConfig) {
          indexState = 'BUILDING';
          lastIndexError = undefined;
          const backgroundSignal = AbortSignal.any([selected.signal, AbortSignal.timeout(180000)]);
          // namespace 的原生读取也可能不合作取消，必须观察整个初始化而非只观察 index.refresh，且 tasks 只能登记真实任务。
          // 观察超限先由 quarantine 撤 slot、epoch 并 abort，晚结果仅能收尾，显式 transition/close 确认前不能恢复服务。
          const backgroundTask = tracked(Promise.resolve().then(() => startIndex(selected, backgroundSignal)));
          expose(backgroundTask, backgroundSignal).catch(error => {
            // 普通构建失败已由 startIndex 保存，此处只补观察超限诊断，不能让晚完成清除隔离状态。
            if (error.message === 'CURRENT_READER_OPERATION_UNCONFIRMED') lastIndexError = error.message;
          });
        }
      }).catch(async error => {
        controller.abort(error);
        try {
          await bridge.transition();
          await releaseDirectoryLock();
        } catch (cleanupError) {
          recoveryRequired = true;
          const failure = new AggregateError([error, cleanupError], 'CURRENT_READER_INSTALL_CLEANUP_FAILED');
          Object.assign(failure, { originalError: error, cleanupErrors: [cleanupError], retainedResources: retained() });
          throw failure;
        }
        throw error;
      }).finally(() => { installing = undefined; }));
      return expose(task, combined);
    },
    search(args) {
      if (!args || Object.keys(args).some(key => !['query', 'topK', 'signal'].includes(key))) return Promise.reject(new Error('INVALID_QUERY'));
      return operation(args, async (selected, signal) => {
        let result;
        let degradation;
        if (indexConfig) {
          if (index) {
            try { result = await index.search({ ...args, expectedBinding: selected.binding, signal }); }
            catch (error) {
              signal.throwIfAborted();
              if (!['INDEX_MODEL_MISSING', 'DEPENDENCY_MISSING', 'INDEX_MODEL_PROFILE_MISMATCH'].includes(error.message)) throw error;
              degradation = error.message;
            }
          } else degradation = indexState;
          degradation ??= result?.degradation;
          await permitted(selected, signal);
          if (result && !degradation) return bridge.searchIndexed({ query: args.query, topK: args.topK ?? 5, generation: selected.binding.generation, candidates: result.candidates, signal });
        }
        if (indexConfig && degradation === 'INDEX_INVALID') throw new Error('INDEX_INVALID');
        if (indexConfig && !unavailable.has(degradation)) throw new Error('DENSE_PROTOCOL_ERROR');
        const fallback = await bridge.search({ ...args, signal });
        if (indexConfig) {
          if (!unavailable.has(degradation)) throw new Error('DENSE_PROTOCOL_ERROR');
          return { ...fallback, degradation };
        }
        return fallback;
      });
    },
    /** 仅可信宿主显式修复已配置索引，不删除缓存或重读公开授权，matching 损坏在此操作成功前不会被降级吞掉。 */
    refreshIndex(args = {}) {
      if (!indexConfig) return Promise.reject(new Error('INDEX_DISABLED'));
      return operation(args, async (selected, signal) => {
        if (!index) throw new Error(lastIndexError ?? 'INDEX_MISSING');
        indexState = 'BUILDING';
        lastIndexError = undefined;
        try {
          await index.refresh(selected.binding, signal);
          indexState = 'READY';
          return { state: 'READY' };
        } catch (error) {
          lastIndexError = code(error);
          indexState = index.status().state;
          throw error;
        }
      });
    },
    read(args) { return operation(args, (_selected, signal) => bridge.read({ ...args, signal })); },
    status({ signal: callerSignal } = {}) {
      if (recoveryRequired) return Promise.reject(new Error('CURRENT_READER_CLOSE_UNCONFIRMED'));
      if (closed || !slot) return Promise.reject(new Error('PUBLIC_UNAVAILABLE'));
      const selected = slot;
      const signal = AbortSignal.any([selected.signal, AbortSignal.timeout(15000), ...(callerSignal ? [callerSignal] : [])]);
      // 总数来自 install 后同一只读事务的完整状态，查询模型时无需占用 Bun 的唯一 IPC 请求槽。
      const task = tracked(Promise.resolve().then(async () => {
        await permitted(selected, signal);
        return { ...selected.publicStatus, index: index?.status() ?? { state: indexState } };
      }));
      return expose(task, signal);
    },
    transition,
    async close() {
      closed = true;
      if (closeTask) return closeTask;
      closeTask = (async () => {
        const results = await Promise.allSettled([transition(), bridge.close()]);
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) {
          const error = new AggregateError(failures, 'CURRENT_READER_CLOSE_UNCONFIRMED');
          Object.assign(error, { cleanupErrors: [...cleanupErrors, ...failures], retainedResources: retained() });
          throw error;
        }
      })().finally(() => { closeTask = undefined; });
      return closeTask;
    },
    get diagnostics() { return { bridge: bridge.diagnostics, index: index?.diagnostics() ?? [], lastIndexError, cleanupErrors: cleanupErrors.map(code), retainedResources: retained() }; },
  };
}
