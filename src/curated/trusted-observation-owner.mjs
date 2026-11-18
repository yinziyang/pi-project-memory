import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const key = Symbol.for('local-project-memory.observation.retained.v1');
const retained = globalThis[key] ??= new Set();
const text = value => typeof value === 'string' && value.isWellFormed() && value && !value.includes('\0') && Buffer.byteLength(value) <= 4096;

/** 未确认关闭的观察子树跨 reload 保留，不能绕过旧 owner 新起观察进程。 */
export function assertTrustedObservationOwnersClosed() {
  if (retained.size) throw new Error('OBSERVATION_CLOSE_UNCONFIRMED');
}

/** 创建固定 cwd/HOME 的只读观察 owner，不读取会话、不打开数据库、不创建目录。
 * requestMs 为含排队的毫秒预算，默认 2000，范围 1 到 5000，最多排队 8 项，输入 8192 字节、输出 131072 字节、stderr 合计 65536 字节。
 * 逐请求截止或在途取消会实际停止专用 subreaper 子树，关闭最多等待 4000ms，超时保留未知所有者而不声称资源已释放。
 * spawnOwner 只用于受管进程测试替换启动边界，正式调用使用固定 Python supervisor、当前 Node 和固定观察 worker，不是公开配置或模型 RPC。
 */
export async function createTrustedObservationOwner({ cwd, home = process.env.HOME, requestMs = 2000, spawnOwner = spawn }) {
  if (!text(cwd) || !isAbsolute(cwd) || !text(home) || !isAbsolute(home) || !Number.isSafeInteger(requestMs) || requestMs < 1 || requestMs > 5000) throw new Error('OBSERVATION_CONFIG');
  for (const previous of [...retained]) await previous.close();
  const supervisor = fileURLToPath(new URL('../authoring/supervise.py', import.meta.url));
  const child = spawnOwner('python3', [supervisor, process.execPath, 'observe', cwd, home, '1', 'read-only'], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { HOME: home, PATH: process.env.PATH, LANG: 'C.UTF-8', LOCAL_MEMORY_REAP_FD: '3' }
  });
  let closed = false;
  let stopping = false;
  let failure;
  let pending;
  let serial = 0;
  let closeId;
  let queue = [];
  let bytes = Buffer.alloc(0);
  let stderrBytes = 0;
  let treeReaped = !Number.isSafeInteger(child.pid);
  let proof = Buffer.alloc(0);
  const expectedProof = Buffer.from('REAP_CONFIRMED\n');
  let shutdown;
  let resolveClosed;
  let resolveReady;
  let rejectReady;
  const actualClose = new Promise(resolve => { resolveClosed = resolve; });
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const diagnostics = { pid: child.pid, closed: false, supervisorClosed: false, treeReaped: false, retained: false, exit: null };
  function rejectWork(error) {
    pending?.reject(error);
    for (const item of queue) item.reject(error);
    queue = [];
  }
  function fail() {
    failure ??= new Error('OBSERVATION_UNAVAILABLE');
    rejectReady(failure);
    rejectWork(failure);
    if (!closed) void owner.close().catch(() => { /* 未确认子树已由保留集接管，后续创建被阻塞。 */ });
  }
  child.once('error', fail);
  child.once('exit', () => { if (!stopping) fail(); });
  // 只接受不向后代继承的专用回收凭证，supervisor 意外退出不能被当成整个子树已停。
  child.once('close', (code, signal) => {
    closed = true;
    diagnostics.supervisorClosed = true;
    diagnostics.treeReaped = treeReaped;
    diagnostics.closed = treeReaped;
    diagnostics.exit = { code, signal };
    if (treeReaped) retained.delete(owner); else retained.add(owner);
    diagnostics.retained = !treeReaped;
    resolveClosed();
    if (!stopping || code !== 0) fail();
  });
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.on('error', fail);
  child.stdio[3].on('error', fail);
  child.stdio[3].on('data', chunk => {
    if (proof.length + chunk.length > expectedProof.length) { treeReaped = false; fail(); return; }
    proof = Buffer.concat([proof, chunk]);
    if (!expectedProof.subarray(0, proof.length).equals(proof)) { treeReaped = false; fail(); return; }
    treeReaped = proof.equals(expectedProof);
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 65536) fail(); });
  child.stdout.on('end', () => { if (bytes.length || !stopping) fail(); });
  child.stdout.on('data', chunk => {
    try {
      bytes = Buffer.concat([bytes, chunk]);
      let end;
      while ((end = bytes.indexOf(10)) !== -1) {
        if (end > 131072) throw new Error('OBSERVATION_FRAME');
        const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end)));
        bytes = bytes.subarray(end + 1);
        if (frame.kind === 'READY' && serial === 0) { serial = 1; resolveReady(); }
        else if (stopping && frame.id === closeId) { /* close ACK 不是实际进程回收，仍等待 actualClose。 */ }
        else if (pending && frame.id === pending.id) {
          const current = pending;
          pending = undefined;
          if (frame.error) current.reject(new Error(/^[A-Z_]{1,80}$/.test(frame.error) ? frame.error : 'OBSERVATION_FAILED'));
          else current.resolve(frame.result);
          drain();
        } else throw new Error('OBSERVATION_PROTOCOL');
      }
      if (bytes.length > 131072) throw new Error('OBSERVATION_FRAME');
    } catch { fail(); }
  });
  function drain() {
    if (pending || stopping || closed || failure || !queue.length) return;
    const item = queue.shift();
    pending = item;
    child.stdin.write(JSON.stringify({ id: item.id, command: item.command }) + '\n', error => { if (error) fail(); });
  }
  async function request(command, { signal } = {}) {
    signal?.throwIfAborted();
    if (stopping || closed || failure) throw new Error('OBSERVATION_UNAVAILABLE');
    if (queue.length >= 8) throw new Error('OBSERVATION_BUSY');
    const item = { id: ++serial, command };
    let timer;
    const abort = () => {
      const index = queue.indexOf(item);
      if (index !== -1) { queue.splice(index, 1); item.reject(new Error('OBSERVATION_CANCELLED')); }
      else if (pending === item) fail();
    };
    try {
      return await new Promise((resolve, reject) => {
        Object.assign(item, { resolve, reject });
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, requestMs);
        queue.push(item);
        drain();
      });
    } catch (error) {
      if (failure || stopping) await owner.close();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  const owner = Object.freeze({
    diagnostics,
    captureConfig: options => request('capture-config', options),
    draftBinding: options => request('draft-binding', options),
    indexConfig: options => request('index-config', options),
    indexInstallation: options => request('index-installation', options),
    publication: options => request('publication', options),
    archiveBinding: options => request('archive-binding', options),
    checkout: options => request('checkout', options),
    close() {
      if (shutdown) return shutdown;
      stopping = true;
      rejectWork(new Error('OBSERVATION_STOPPED'));
      shutdown = Promise.resolve().then(async () => {
        if (closed) { if (!treeReaped) throw new Error('OBSERVATION_CLOSE_UNCONFIRMED'); return; }
        let term;
        let deadline;
        const timeout = new Promise((_, reject) => {
          term = setTimeout(() => child.kill('SIGTERM'), pending ? 0 : 1000);
          deadline = setTimeout(() => reject(new Error('OBSERVATION_CLOSE_UNCONFIRMED')), 4000);
        });
        try {
          if (!pending) {
            // 关闭帧写失败仍推进 TERM 并等待 actualClose，不能把管道异常当作子树已停止。
            closeId = ++serial;
            try {
              if (child.stdin?.writable) child.stdin.write(JSON.stringify({ id: closeId, command: 'close' }) + '\n', error => { if (error) child.kill('SIGTERM'); });
              else child.kill('SIGTERM');
            } catch { child.kill('SIGTERM'); }
          }
          await Promise.race([actualClose, timeout]);
          if (!treeReaped) throw new Error('OBSERVATION_CLOSE_UNCONFIRMED');
        } catch (error) {
          retained.add(owner);
          diagnostics.retained = true;
          shutdown = undefined;
          throw error;
        } finally { clearTimeout(term); clearTimeout(deadline); }
      });
      return shutdown;
    }
  });
  let startup;
  try {
    await Promise.race([ready, new Promise((_, reject) => { startup = setTimeout(() => reject(new Error('OBSERVATION_STARTUP')), 2000); })]);
    if (closed || failure || stopping) throw new Error('OBSERVATION_STARTUP');
    return owner;
  } catch {
    await owner.close();
    throw new Error('OBSERVATION_STARTUP');
  } finally { clearTimeout(startup); }
}
