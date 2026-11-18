import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// 仅此插件的有界安全故障快照跨reload保留，不保存原始异常、正文、项目路径或会话内容。
// 固定单文件是最近成功写入者的快照，不充当多进程审计日志，也不读取先前文件或任何用户环境配置。
const key = Symbol.for('local-project-memory.curated.owner-diagnostics.v1');
const state = globalThis[key] ??= { records: [], sequence: 0, flushed: 0, bounded: true, active: undefined };
const flushBudgetMs = 1000;
const operations = new Set(['startup', 'reload', 'new', 'resume', 'fork', 'refresh', 'pause', 'shutdown']);
const stages = new Set(['trust', 'descriptor', 'install', 'close', 'quarantine-close', 'diagnostic-write']);
const codes = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'ELOOP', 'ENOTDIR', 'EISDIR',
  'INVALID_PUBLIC_FILE', 'INVALID_DESCRIPTOR', 'INVALID_PUBLIC_DIRECTORY', 'PROJECT_NOT_TRUSTED',
  'INVALID_BRIDGE_OPTIONS', 'PUBLIC_INSTALL_REJECTED', 'PUBLIC_OPERATION_FAILED', 'PUBLIC_UNAVAILABLE',
  'PUBLIC_READER_CLOSED', 'PUBLIC_READER_CLOSE_FAILED', 'PUBLIC_CLOSE_UNCONFIRMED', 'TRANSITION_REQUIRED',
  'WORKER_EXITED', 'WORKER_CLOSED', 'WORKER_EXIT_FAILED', 'CANCELLED', 'DEADLINE_EXCEEDED',
  'PROTOCOL_ERROR', 'OUTPUT_CLOSED', 'OUTPUT_TRUNCATED_FRAME', 'INPUT_FRAME_LIMIT', 'OUTPUT_FRAME_LIMIT', 'STDERR_LIMIT',
  'OWNER_DIAGNOSTIC_DIRECTORY_REJECTED', 'OWNER_DIAGNOSTIC_TARGET_REJECTED', 'OWNER_DIAGNOSTIC_PERMISSION_REJECTED',
  'STOP_UNCONFIRMED', 'ABORT_ERR'
]);
const signals = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGABRT', 'SIGFPE', 'SIGKILL', 'SIGSEGV', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGBUS']);
function code(value, fallback = 'MEMORY_LIFECYCLE_FAILED') {
  try {
    for (const candidate of [typeof value === 'string' ? value : undefined, value?.code, value?.message]) {
      if (codes.has(candidate)) return candidate;
      if (candidate === 'STALE_REFERENCE: 请重新搜索') return 'STALE_REFERENCE';
    }
  } catch {
    // 即使异常属性访问器故障，也不能把原始异常复制进快照。
  }
  return fallback;
}
const pid = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
function bridgeSnapshot(value) {
  if (!value) return undefined;
  return {
    pid: pid(value.pid), closed: value.closed === true, forced: value.forced === true,
    exit: value.exit ? { code: Number.isSafeInteger(value.exit.code) ? value.exit.code : null, signal: signals.has(value.exit.signal) ? value.exit.signal : null } : null,
    shutdown: value.shutdown ? { code: code(value.shutdown.code, 'BRIDGE_SHUTDOWN_UNKNOWN') } : null,
    cleanupErrors: Array.isArray(value.cleanupErrors) ? value.cleanupErrors.slice(0, 8).map((item) => code(item, 'BRIDGE_CLEANUP_FAILED')) : [],
    retainedResources: Array.isArray(value.retainedResources) ? value.retainedResources.slice(0, 4).map((item) => ({ pid: pid(item?.pid), owner: 'curated-reader-bridge' })) : [],
    lastError: value.lastError ? code(value.lastError) : null
  };
}
function retain(record) {
  state.records.push({ sequence: ++state.sequence, processPid: process.pid, ...record });
  while (state.records.length > 32 || Buffer.byteLength(JSON.stringify({ version: 1, records: state.records })) > 32768) state.records.shift();
}

/** 同步记录白名单故障投影，不执行I/O，不复制原始Error，最多32条且完整JSON不超过32768字节。
 * bridge为可信owner的诊断快照，confirmed-close的cleanup异常也须调用，不能只在close抛错时采样。
 */
export function recordOwnerFault({ operation, stage, error, bridge }) {
  const snapshot = bridgeSnapshot(bridge);
  if (!error && !snapshot?.cleanupErrors.length && !snapshot?.retainedResources.length && !snapshot?.lastError) return;
  retain({
    operation: operations.has(operation) ? operation : 'startup',
    stage: stages.has(stage) ? stage : 'install',
    code: error ? code(error) : snapshot.cleanupErrors[0] ?? snapshot.lastError ?? 'PUBLIC_CLOSE_UNCONFIRMED',
    ...(snapshot ? { bridge: snapshot } : {})
  });
}

function fixedError(name) {
  return Object.assign(new Error(name), { code: name });
}
function failure(job, name = 'PRIVATE_DIAGNOSTIC_WRITE_FAILED') {
  return Object.assign(fixedError(name), {
    originalCode: job.originalError ? code(job.originalError) : null,
    cleanupCodes: job.cleanupErrors.slice(0, 8).map(error => code(error, 'DIAGNOSTIC_CLEANUP_FAILED'))
  });
}
function checkpoint(job) {
  job.controller.signal.throwIfAborted();
}
function noteFailure(job, stopped = false) {
  const flag = stopped ? 'stopNoted' : 'failureNoted';
  if (job[flag]) return;
  job[flag] = true;
  retain({ operation: job.operation, stage: 'diagnostic-write', code: stopped ? 'STOP_UNCONFIRMED' : 'PRIVATE_DIAGNOSTIC_WRITE_FAILED',
    ioCode: code(job.originalError ?? job.controller.signal.reason),
    cleanupErrors: job.cleanupErrors.slice(0, 8).map(error => code(error, 'DIAGNOSTIC_CLEANUP_FAILED')) });
}

// acquire 必须在取消检查前登记晚返回的句柄或已完成的关闭，不能把丢掉返回值误当成没有资源。
// cleanup 阶段仍响应调用方等待的取消，但晚回执只继续释放已有资源，不恢复正文流水线。
async function nativeStep(job, action, acquire = () => {}, cleanup = false) {
  if (!cleanup) checkpoint(job);
  const pending = Promise.resolve(action());
  job.pending = pending;
  try {
    const result = await pending;
    acquire(result);
    if (!cleanup) checkpoint(job);
    else job.cancelledDuringCleanup = job.controller.signal.aborted;
    return result;
  } finally { if (job.pending === pending) job.pending = undefined; }
}

async function cleanupSnapshot(job) {
  if (job.file) {
    try { await nativeStep(job, () => job.file.close(), () => { job.file = undefined; }, true); }
    catch (error) { job.cleanupErrors.push(error); }
  }
  // 未确认关闭的fd仍拥有临时文件，不提前unlink，也不删除共享诊断目录。
  if (!job.file && job.temporary) {
    try { await nativeStep(job, () => unlink(job.temporary), () => { job.temporary = undefined; }, true); }
    catch (error) {
      if (error.code === 'ENOENT') job.temporary = undefined;
      else job.cleanupErrors.push(error);
    }
  }
}

async function writeSnapshot(job) {
  if (job.file || job.temporary) {
    await cleanupSnapshot(job);
    if (job.cleanupErrors.length) { noteFailure(job); return { error: failure(job) }; }
    // 旧失败已保留在有界记录中，只有实际清理完成才开启一次新写入尝试。
    job.originalError = undefined;
  }
  let written = false;
  try {
    checkpoint(job);
    if (state.flushed === state.sequence) return {};
    const sequence = state.sequence;
    const text = JSON.stringify({ version: 1, records: state.records });
    const directory = join(homedir(), '.local-project-memory-diagnostics');
    const target = join(directory, 'curated.json');
    try { await nativeStep(job, () => mkdir(directory, { mode: 0o700 })); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    checkpoint(job);
    const dir = await nativeStep(job, () => lstat(directory));
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o7777) !== 0o700) throw fixedError('OWNER_DIAGNOSTIC_DIRECTORY_REJECTED');
    try {
      const existing = await nativeStep(job, () => lstat(target));
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.uid !== process.getuid?.() || (existing.mode & 0o7777) !== 0o600) throw fixedError('OWNER_DIAGNOSTIC_TARGET_REJECTED');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    checkpoint(job);
    // 私有目录由本机可信用户独占，rename仅提供完整快照可见性，不承诺掉电持久或同UID恶意替换防御。
    const candidate = join(directory, `.curated-${process.pid}-${randomUUID()}.tmp`);
    await nativeStep(job, () => open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600), file => {
      job.file = file;
      job.temporary = candidate;
    });
    const stat = await nativeStep(job, () => job.file.stat());
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600) throw fixedError('OWNER_DIAGNOSTIC_PERMISSION_REJECTED');
    await nativeStep(job, () => job.file.writeFile(text, { signal: job.controller.signal }));
    await nativeStep(job, () => job.file.close(), () => { job.file = undefined; });
    await nativeStep(job, () => rename(job.temporary, target), () => { job.temporary = undefined; });
    state.flushed = Math.max(state.flushed, sequence);
    written = true;
  } catch (error) {
    if (error !== job.controller.signal.reason) job.originalError ??= error;
  } finally { await cleanupSnapshot(job); }
  if (written && !job.cleanupErrors.length) return {};
  if (job.originalError || job.cleanupErrors.length) { noteFailure(job); return { error: failure(job) }; }
  return { error: fixedError('CANCELLED') };
}

function makeJob(operation, previous) {
  return { operation: operations.has(operation) ? operation : 'startup', controller: new AbortController(),
    file: previous?.file, temporary: previous?.temporary, originalError: previous?.originalError,
    cleanupErrors: [], finished: false, pending: undefined };
}
function complete(job, result) {
  job.finished = true;
  if (!job.file && !job.temporary && state.active === job) state.active = undefined;
  return result;
}

// 升级时接管旧版实际Promise而不是假设其已完成，不接纳新的旧版写队列。
// 无法倒改旧闭包的取消行为，但其真实settle及原清理资源仍是新版开始写入的前置条件。
if (!state.bounded) {
  const legacy = state.writing;
  const job = makeJob('reload');
  state.active = job;
  state.bounded = true;
  state.writing = Object.freeze({ then() { throw fixedError('STOP_UNCONFIRMED'); } });
  job.done = Promise.resolve(legacy).catch(error => { job.originalError = error; }).then(() => {
    job.file = state.recovery?.file;
    job.temporary = state.recovery?.temporary;
    state.recovery = undefined;
    return complete(job, {});
  });
}

// 只有本次发起者持有等待器，后续flush立即拒绝，不为同一挂起操作积累无限队列或监听器。
function waitForJob(job, signal) {
  return new Promise((resolve, reject) => {
    const detach = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const stop = reason => {
      job.controller.abort(fixedError(reason));
      detach();
      // 先推进控制状态，再记录有界内存诊断，绝不等待日志或文件系统后才取消。
      noteFailure(job, true);
      reject(failure(job, 'STOP_UNCONFIRMED'));
    };
    const abort = () => stop('CANCELLED');
    const timer = setTimeout(() => stop('DEADLINE_EXCEEDED'), flushBudgetMs);
    signal?.addEventListener('abort', abort, { once: true });
    job.done.then(result => {
      detach();
      if (result.error) reject(result.error); else resolve();
    }).catch(() => {});
    if (signal?.aborted) abort();
  });
}

/** 有界等待本插件安全故障快照，固定HOME目录0700、目标0600，不接受模型指定路径。
 * 总等待固定1000毫秒，覆盖写入和清理，signal可提前取消等待及尚未发起的正文步骤。
 * 超时或未确认工作返回code/message为STOP_UNCONFIRMED，不表示native I/O已停止，实际Promise、fd、临时文件和控制器跨reload强引用保留。
 * 任一时刻最多一个active，未settle时新flush立即返回STOP_UNCONFIRMED，不排队、不重复close在途fd，也不开始新写。
 * 晚open/close只登记结果并清理，不能继续write/rename，已发起的rename不能抢占，直到实际settle前禁止新快照写入。
 * 清理失败返回PRIVATE_DIAGNOSTIC_WRITE_FAILED，originalCode/cleanupCodes分别投影原错和清理错，资源保留到后续显式flush重试。
 * 调用方必须先推进自身停止状态，SDK自有同步会话写入不属于此异步文件资源契约。
 */
export function flushOwnerDiagnostics(operation, { signal } = {}) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(fixedError('OWNER_DIAGNOSTIC_INPUT'));
  const previous = state.active;
  if (previous && !previous.finished) return Promise.reject(failure(previous, 'STOP_UNCONFIRMED'));
  if (signal?.aborted) return Promise.reject(fixedError(previous ? 'STOP_UNCONFIRMED' : 'CANCELLED'));
  if (!previous && state.flushed === state.sequence) return Promise.resolve();
  const job = makeJob(operation, previous);
  state.active = job;
  job.done = Promise.resolve().then(() => writeSnapshot(job)).then(result => complete(job, result), error => {
    job.originalError ??= error;
    noteFailure(job);
    return complete(job, { error: failure(job) });
  });
  return waitForJob(job, signal);
}
