import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fail = (code) => new Error(code);

/** 创建 Node 专用公开 reader，调用方拥有本对象并必须 await close，不在导入时启动 Bun。
 * bunPath 必须是可信宿主指定的本机 Bun，workerPath 仅供受控测试替换，不接受模型输入。
 * startupMs 默认 5000 毫秒覆盖启动及安装，requestMs 默认 10000 毫秒覆盖写入和执行，范围均为 1 至 10000 的整数。
 * 单请求并发拒绝 BUSY，取消或超时使本代下线，确认回收后须显式重新 install，不自动恢复旧代。
 * transition 同步关门后回收进程，宿主必须等待它确认 close 后再失效私有状态或发布公开文件。
 * allowDense 默认 false，仅可信宿主可开启 searchIndexed，普通请求输入上限仍为 8192 字节，indexed 请求单独允许 32768 字节。
 * 帧上限输出 131072 字节，stderr 总量 65536 字节，不向工具转发原始诊断。
 * TERM 后 200 毫秒升级 KILL，再最多等待 1000 毫秒确认 close，未知资源保留并阻止安装。
 * diagnostics 仅给可信 owner，shutdown 为固定关库状态码，exit 为实际 code/signal，cleanupErrors 不代表仍有活资源。
 * 已确认 close 时 transition/close 正常返回且保留关库或退出异常诊断，重复调用保留本代诊断，显式 install 才重置。
 * 关库失败但进程已 close 时不伪报 retained 或禁止发布，本代仍停服，transition 后须显式 install 才能重新服务。
 * close 是对象终态，重复 close 安全，之后不可再 install，宿主如需新生命周期须创建新桥。
 * 主动 stopping 仅忽略预期的完整 stdout EOF，不忽略半帧、坏协议或运行中意外断流，首错不被后续退出覆盖。
 */
export function createCuratedReaderBridge({ project, bunPath, workerPath = fileURLToPath(new URL('./curated-reader-worker.mjs', import.meta.url)), startupMs = 5000, requestMs = 10000, allowDense = false }) {
  if (typeof allowDense !== 'boolean') throw fail('INVALID_BRIDGE_OPTIONS');
  if (typeof project !== 'string' || !project.isWellFormed() || !project.trim() || project.includes('\0') ||
      typeof bunPath !== 'string' || !bunPath.isWellFormed() || !bunPath || bunPath.includes('\0')) throw fail('INVALID_BRIDGE_OPTIONS');
  for (const value of [startupMs, requestMs]) {
    if (!Number.isInteger(value) || value < 1 || value > 10000) throw fail('INVALID_BRIDGE_OPTIONS');
  }
  let child, closed = false, available = false, epoch = 0, serial = 0, incarnation = 0;
  let pending, stopTask, closePromise, closeResolve, didClose = true, ready = false;
  let diagnostic;
  let stopping = false;
  let active = 0;
  const diagnostics = { pid: undefined, forced: false, cleanupErrors: [], retainedResources: [] };

  // 控制状态先推进，不能让输出背压、日志或故障管道阻止停服。
  function pause() {
    available = false;
    epoch++;
  }
  function stop() {
    pause();
    if (stopTask) return stopTask;
    if (!child || didClose) {
      diagnostics.retainedResources = [];
      return Promise.resolve();
    }
    const owned = child;
    stopping = true;
    stopTask = (async () => {
      let termTimer, killTimer;
      const timeout = new Promise((_, reject) => {
        termTimer = setTimeout(() => {
          diagnostics.forced = true;
          try { owned.kill('SIGKILL'); } catch (error) { diagnostics.cleanupErrors.push(error.message); }
          killTimer = setTimeout(() => reject(fail('PUBLIC_CLOSE_UNCONFIRMED')), 1000);
        }, 200);
      });
      try {
        try { owned.kill('SIGTERM'); } catch (error) { diagnostics.cleanupErrors.push(error.message); }
        await Promise.race([closePromise, timeout]);
        diagnostics.retainedResources = [];
      } catch (error) {
        diagnostic ??= error;
        diagnostics.retainedResources = [{ pid: owned.pid, owner: 'curated-reader-bridge' }];
        error.cleanupErrors = [...diagnostics.cleanupErrors];
        error.retainedResources = [...diagnostics.retainedResources];
        throw error;
      } finally {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
      }
    })().finally(() => { stopTask = undefined; });
    return stopTask;
  }
  function protocolFailure(error) {
    diagnostic ??= error;
    pause();
    pending?.reject(error);
    // 事件回调立即接管拒绝，操作所有者仍会再次等待并传播回收失败。
    void stop().catch((failure) => { diagnostic ??= failure; });
  }
  function launch() {
    ready = false;
    stopping = false;
    diagnostic = undefined;
    diagnostics.cleanupErrors = [];
    diagnostics.shutdown = undefined;
    diagnostics.exit = undefined;
    didClose = false;
    incarnation++;
    const ownIncarnation = incarnation;
    closePromise = new Promise((resolve) => { closeResolve = resolve; });
    try {
      child = spawn(bunPath, [workerPath, String(incarnation), ...(allowDense ? ['dense-v1'] : [])], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' } });
    } catch (error) {
      // spawn 同步失败时没有取得新进程，不能留下虚假的未确认资源阻止后续显式安装。
      didClose = true;
      closeResolve();
      throw error;
    }
    diagnostics.pid = child.pid;
    diagnostics.forced = false;
    let bytes = [], stderrBytes = 0;
    child.once('error', (error) => protocolFailure(error));
    child.once('exit', (code, signal) => {
      diagnostics.exit = { code, signal };
      pause();
      pending?.reject(fail('WORKER_EXITED'));
    });
    child.once('close', (code, signal) => {
      diagnostics.exit = { code, signal };
      // 已回收与关库成功是两个事实，非零退出保诊断但不虚构仍存活的资源。
      const expectedSignal = stopping && (signal === 'SIGTERM' || (diagnostics.forced && signal === 'SIGKILL'));
      if (code !== 0 && !expectedSignal) {
        if (!diagnostics.cleanupErrors.includes('WORKER_EXIT_FAILED')) diagnostics.cleanupErrors.push('WORKER_EXIT_FAILED');
        diagnostic ??= fail('WORKER_EXIT_FAILED');
      }
      didClose = true;
      diagnostics.retainedResources = [];
      closeResolve();
      pending?.reject(fail('WORKER_CLOSED'));
    });
    child.stdin.on('error', protocolFailure);
    child.stdout.on('error', protocolFailure);
    child.stderr.on('error', protocolFailure);
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65536) protocolFailure(fail('STDERR_LIMIT'));
    });
    child.stdout.on('end', () => {
      if (bytes.length) protocolFailure(fail('OUTPUT_TRUNCATED_FRAME'));
      else if (!didClose && !stopping) protocolFailure(fail('OUTPUT_CLOSED'));
    });
    child.stdout.on('data', (chunk) => {
      try {
        // 逐段限额后才解码，禁止无换行洪泛和 UTF-8 静默替换。
        for (const part of chunk) {
          if (bytes.length >= 131072) throw fail('OUTPUT_FRAME_LIMIT');
          if (part !== 10) {
            bytes.push(part);
            continue;
          }
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(bytes));
          bytes = [];
          const frame = JSON.parse(text);
          if (frame?.version !== 1 || frame.incarnation !== ownIncarnation) throw fail('PROTOCOL_ERROR');
          // 本代主动 stop 后只接受一次固定 shutdown 诊断，不依赖尚未完成的请求，也不把它当安装或回收 ACK。
          if (frame.kind === 'shutdown') {
            if (!stopping || !ready || diagnostics.shutdown || frame.id !== 0 ||
                !['PUBLIC_READER_CLOSED', 'PUBLIC_READER_CLOSE_FAILED'].includes(frame.code) ||
                Object.keys(frame).sort().join(',') !== 'code,id,incarnation,kind,version') throw fail('PROTOCOL_ERROR');
            diagnostics.shutdown = { code: frame.code };
            if (frame.code === 'PUBLIC_READER_CLOSE_FAILED') {
              diagnostics.cleanupErrors.push(frame.code);
              diagnostic ??= fail(frame.code);
            }
            continue;
          }
          if (!pending) throw fail('PROTOCOL_ERROR');
          if (frame.kind === 'ready') {
            if (ready || pending.id !== 0 || frame.id !== 0) throw fail('PROTOCOL_ERROR');
            ready = true;
          } else if (!ready || frame.kind !== 'result' || frame.id !== pending.id || typeof frame.ok !== 'boolean') throw fail('PROTOCOL_ERROR');
          if (frame.kind === 'result' && frame.ok &&
              (pending.op === 'install' ? frame.value !== null :
                !frame.value || typeof frame.value !== 'object' || Array.isArray(frame.value))) {
            throw fail('PROTOCOL_ERROR');
          }
          if (frame.kind === 'result' && !frame.ok &&
              (typeof frame.code !== 'string' || !/^[A-Z_]+$/.test(frame.code))) {
            throw fail('PROTOCOL_ERROR');
          }
          const task = pending;
          pending = undefined;
          if (frame.kind === 'result' && !frame.ok) {
            task.reject(fail(frame.code === 'STALE_REFERENCE' ? 'STALE_REFERENCE: 请重新搜索' : frame.code));
          } else task.resolve(frame.value);
        }
      } catch (error) { protocolFailure(error); }
    });
  }
  async function exchange(op, args, signal, deadline) {
    signal?.throwIfAborted();
    if (pending) throw fail('BUSY');
    const stamp = epoch;
    active++;
    let timer, abort;
    try {
      const result = await new Promise((resolve, reject) => {
        const id = op === 'ready' ? 0 : ++serial;
        pending = { id, op, resolve, reject };
        timer = setTimeout(() => reject(fail('DEADLINE_EXCEEDED')), Math.max(0, deadline - Date.now()));
        abort = () => reject(fail('CANCELLED'));
        signal?.addEventListener('abort', abort, { once: true });
        if (op !== 'ready') {
          const frame = Buffer.from(JSON.stringify({ version: 1, kind: 'request', incarnation, id, op, args }) + '\n');
          if (frame.length > (op === 'searchIndexed' && allowDense ? 32768 : 8192)) {
            reject(fail('INPUT_FRAME_LIMIT'));
            return;
          }
          child.stdin.write(frame, (error) => { if (error) reject(error); });
        }
      });
      if (stamp !== epoch) throw fail('STALE_REFERENCE: 请重新搜索');
      return result;
    } catch (error) {
      diagnostic ??= error;
      try { await stop(); } catch (cleanupError) {
        const failure = new AggregateError([error, cleanupError], 'PUBLIC_CLOSE_UNCONFIRMED', { cause: error });
        Object.assign(failure, {
          originalError: error,
          cleanupErrors: [cleanupError],
          retainedResources: structuredClone(diagnostics.retainedResources)
        });
        throw failure;
      }
      throw error;
    } finally {
      active--;
      pending = undefined;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async function operation(op, args = {}) {
    args.signal?.throwIfAborted();
    if (!available) throw fail('PUBLIC_UNAVAILABLE');
    const { signal, ...payload } = args;
    return exchange(op, payload, signal, Date.now() + requestMs);
  }
  async function transition({ signal } = {}) {
    pause();
    pending?.reject(fail('STALE_REFERENCE: 请重新搜索'));
    await stop();
    signal?.throwIfAborted();
  }
  return {
    async install({ publicPath, generation, signal }) {
      signal?.throwIfAborted();
      if (closed || active || pending || stopTask || !didClose) throw fail('TRANSITION_REQUIRED');
      if (typeof publicPath !== 'string' || !publicPath.isWellFormed() || !publicPath || publicPath.includes('\0') ||
          typeof generation !== 'string' || !generation.isWellFormed() || !generation) throw fail('INVALID_BRIDGE_OPTIONS');
      const deadline = Date.now() + startupMs;
      const stamp = epoch;
      launch();
      await exchange('ready', {}, signal, deadline);
      await exchange('install', { publicPath, generation, project }, signal, deadline);
      if (stamp !== epoch) throw fail('STALE_REFERENCE: 请重新搜索');
      available = true;
    },
    search(args) {
      if (!args || Object.keys(args).some(key => !['query', 'topK', 'signal'].includes(key))) return Promise.reject(fail('INVALID_QUERY'));
      return operation('search', args);
    },
    searchIndexed(args) {
      if (!allowDense) return Promise.reject(fail('DENSE_DISABLED'));
      return operation('searchIndexed', args);
    },
    status: (args = {}) => operation('status', args),
    read: (args) => operation('read', args),
    transition,
    async close() {
      closed = true;
      await transition();
    },
    get diagnostics() { return { ...structuredClone(diagnostics), closed: didClose, lastError: diagnostic?.message }; }
  };
}
