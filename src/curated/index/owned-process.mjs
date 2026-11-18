import { spawn } from 'node:child_process';
import { waitIndexSettlement } from './settlement.mjs';

/** 每个句柄只拥有自己直接启动的进程，不创建进程组，不向共享 run.py 组发送信号。
 * budgetMs 在 spawn 前开始计时，默认 180000 毫秒，graceMs 默认 500 毫秒，二者必须为正安全整数。
 * maxBytes 默认 8 MiB，分别限制单个 stdout 帧和 stderr 总量，request 只允许单个在途请求。
 * signal 取消整个进程，finish 关闭输入并等待退出且传播执行错误，close 请求终止并等待实际回收且允许重复调用。
 * available 只表明进程尚可接收请求，不能替代 close 对实际回收的确认。
 * TERM 宽限后升级 KILL，再最多等待 2000 毫秒，未确认时通知可信 onRetained 并拒绝，不可据此删除进程可能仍持有的目录。
 */
export function createOwnedProcess(command, args, { signal, budgetMs = 180000, graceMs = 500, maxBytes = 8 * 1024 * 1024, onRetained = () => {} } = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || !Number.isSafeInteger(graceMs) || graceMs < 1) throw new Error('INDEX_RUNTIME_INVALID');
  const deadline = performance.now() + budgetMs;
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: false, env: {
    PATH: process.env.PATH, LANG: 'en_US.UTF-8', OMP_NUM_THREADS: '1',
    OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', ANONYMIZED_TELEMETRY: 'False',
  } });
  let closed = false;
  let failure;
  let pending;
  let buffer = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let frameBytes = 0;
  let stderrBytes = 0;
  let killTimer;
  let reapTimer;
  let resolveExit;
  let rejectExit;
  const exited = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  let resolveActualClose;
  const actualClose = new Promise(resolve => { resolveActualClose = resolve; });
  // 启动与每个请求共用进程绝对预算，取消必须先终止进程，等待 close 后才能释放目录。
  const stop = (error = new Error('INDEX_CLOSED')) => {
    failure ??= error;
    if (closed || killTimer) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    reapTimer = setTimeout(() => {
      const error = Object.assign(new Error('INDEX_REAP_UNCONFIRMED'), { retainedPid: child.pid });
      onRetained({ pid: child.pid, reason: 'reap-unconfirmed' });
      pending?.reject(error);
      pending = undefined;
      rejectExit(error);
    }, graceMs + 2000);
  };
  const abort = () => stop(signal.reason ?? new Error('INDEX_CANCELLED'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new Error('INDEX_BUDGET_EXCEEDED')), Math.max(0, deadline - performance.now()));
  child.on('error', (error) => stop(Object.assign(new Error('DEPENDENCY_MISSING'), { cause: error })));
  child.stdin.on('error', (error) => stop(Object.assign(new Error('INDEX_PIPE_FAILED'), { cause: error })));
  child.stdout.on('error', (error) => stop(Object.assign(new Error('INDEX_PIPE_FAILED'), { cause: error })));
  child.stderr.on('error', (error) => stop(Object.assign(new Error('INDEX_PIPE_FAILED'), { cause: error })));
  child.stderr.on('data', (bytes) => {
    stderrBytes += bytes.length;
    if (stderrBytes > maxBytes) stop(new Error('INDEX_OUTPUT_LIMIT'));
  });
  child.stdout.on('data', (bytes) => {
    frameBytes += bytes.length;
    if (frameBytes > maxBytes) return stop(new Error('INDEX_OUTPUT_LIMIT'));
    try { buffer += decoder.decode(bytes, { stream: true }); }
    catch { return stop(new Error('INDEX_PROTOCOL_INVALID')); }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      frameBytes -= Buffer.byteLength(line) + 1;
      if (!pending) return stop(new Error('INDEX_PROTOCOL_INVALID'));
      try {
        const value = JSON.parse(line);
        if (!value || value.ok !== true) {
          const codes = ['DEPENDENCY_MISSING', 'INDEX_MODEL_MISSING', 'INDEX_MODEL_PROFILE_MISMATCH', 'INDEX_INVALID', 'INDEX_BUSY'];
          throw new Error(codes.includes(value?.code) ? value.code : 'INDEX_WORKER_FAILED');
        }
        const waiter = pending;
        pending = undefined;
        waiter.resolve(value.result);
      } catch (error) { stop(error); }
    }
  });
  child.on('close', (code) => {
    if (code !== 0 && !failure) failure = new Error('INDEX_WORKER_FAILED');
    try { if (decoder.decode() || buffer) failure ??= new Error('INDEX_PROTOCOL_INVALID'); }
    catch { failure ??= new Error('INDEX_PROTOCOL_INVALID'); }
    closed = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(reapTimer);
    signal?.removeEventListener('abort', abort);
    if (pending) pending.reject(failure ?? new Error('INDEX_WORKER_EOF'));
    pending = undefined;
    resolveExit({ code });
    resolveActualClose({ code });
  });
  // 即使调用方还没进入 finally，异常退出也不能制造未处理拒绝。
  exited.catch(() => {});
  return {
    get pid() { return child.pid; },
    get closed() { return closed; },
    get available() {
      return !closed && !failure && child.exitCode === null && child.signalCode === null && performance.now() < deadline;
    },
    async request(value) {
      if (closed || failure) throw failure ?? new Error('INDEX_CLOSED');
      if (pending) throw new Error('INDEX_BUSY');
      const encoded = `${JSON.stringify(value)}\n`;
      const result = new Promise((resolve, reject) => { pending = { resolve, reject }; });
      try { child.stdin.write(encoded, (error) => { if (error) stop(error); }); }
      catch (error) { stop(error); }
      return result;
    },
    async close() {
      if (closed) return;
      const deadline = performance.now() + graceMs + 2000;
      stop();
      // exited 的首轮期限可能已经失败，重试必须等待真实 close 事件，不能复用永久拒绝的首轮等待结果。
      await waitIndexSettlement(actualClose, { deadline, code: 'INDEX_REAP_UNCONFIRMED' });
    },
    async finish() {
      if (!closed && !failure) child.stdin.end();
      await exited;
      if (failure) throw failure;
    },
  };
}
