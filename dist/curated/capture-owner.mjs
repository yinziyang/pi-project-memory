import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, isAbsolute } from 'node:path';

// 关闭未确认的专用 subreaper 必须跨 reload 保留，后续启动不得遗弃旧所有者。
const key = Symbol.for('local-project-memory.capture.retained.v1');
const retained = globalThis[key] ??= new Set();

/** 收尾完成前检查跨 reload 保留集，启动失败取得但未返回的 owner 也不能被上层漏报为已关闭。 */
export function assertCaptureOwnersClosed() {
  if (retained.size) throw new Error('CAPTURE_CLOSE_UNCONFIRMED');
}

/** 创建只接受过滤来源的串行 archive IPC owner，调用方必须 await close 后才能手动打开同一私有库。
 * 启动与每帧各限 2000ms，输入最多 1500000 字节，archive-only 输出最多 8192 字节，assistant-local 输出最多 16384 字节，stderr 合计最多 65536 字节。
 * role 仅允许 archive-only（默认）或 assistant-local，后者只添加固定 task IPC，不添加批准、消费或发布权限。
 * readStatus 的主动取消在关闭确认后拒绝为原 signal.reason，已存在的 IPC 故障或关闭未确认优先传播。
 * spawnOwner 只供受管测试注入实际进程故障，正式调用使用固定 supervisor，不从模型或项目配置读取此选项。
 * close 先发协议关闭，1 秒后 TERM 专用 subreaper，由其 pidfd 管理子树，总计最多等 4 秒，未知 PID 保留且阻止重开。
 * 不杀共享进程组或提前杀 subreaper，不读取认证、不加载 SDK、不创建 transport，不自动重试 ACK 未知的写入。
 */
export async function createCaptureOwner(config, checkout, { role = 'archive-only', spawnOwner = spawn } = {}) {
  if (!['archive-only', 'assistant-local'].includes(role)) throw new Error('CAPTURE_ROLE');
  if (!config || !['cwd', 'privateRoot', 'bunPath', 'project'].every(key => typeof config[key] === 'string' && config[key] && config[key].isWellFormed() && !config[key].includes('\0')) ||
      !isAbsolute(config.cwd) || !isAbsolute(config.privateRoot) || !checkout || !/^[a-f0-9]{64}$/.test(checkout.worktree)) throw new Error('CAPTURE_CONFIG');
  const replyBytes = role === 'assistant-local' ? 16384 : 8192;
  for (const owner of [...retained]) await owner.close();
  // 分离、创建及权限检查在受 supervisor 截止保护的 Bun 入口内执行，Node 只构造固定启动参数。
  const rootPath = join(config.privateRoot, checkout.worktree);
  const script = fileURLToPath(new URL('../authoring/supervise.py', import.meta.url));
  const child = spawnOwner('python3', [script, config.bunPath, 'archive', rootPath, config.project, config.cwd, checkout.worktree], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: 'C.UTF-8', LOCAL_MEMORY_HOST_ROLE: role, LOCAL_MEMORY_REAP_FD: '3' }
  });
  let closed = false;
  let stopping = false;
  let serial = 0;
  let pending;
  let failure;
  let bytes = Buffer.alloc(0);
  let stderrBytes = 0;
  let busy = false;
  let stderrTail = '';
  let treeReaped = !Number.isSafeInteger(child.pid);
  let proof = Buffer.alloc(0);
  const expectedProof = Buffer.from('REAP_CONFIRMED\n');
  let shutdown;
  let resolveClose;
  const actualClose = new Promise(resolve => { resolveClose = resolve; });
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const diagnostics = { pid: child.pid, closed: false, supervisorClosed: false, treeReaped: false, exit: null, retained: false, ackUnknown: false };
  const fail = () => {
    failure ??= new Error('CAPTURE_OWNER_UNAVAILABLE');
    readyReject(failure);
    pending?.reject(failure);
    // 协议或输出故障立即收尾，不等下一次归档或宿主 shutdown，close 自身负责保留未知资源。
    if (!closed) void owner.close().catch(() => {});
  };
  child.once('error', fail);
  child.once('exit', fail);
  // supervisor 消失不等于后代已停，只有不向后代继承的 fd 3 凭证才能解除未知资源保留。
  child.once('close', (code, signal) => {
    closed = true;
    diagnostics.supervisorClosed = true;
    diagnostics.treeReaped = treeReaped;
    diagnostics.closed = treeReaped;
    diagnostics.exit = { code, signal };
    if (!treeReaped) { retained.add(owner); diagnostics.retained = true; }
    if (code !== 0) failure ??= new Error('CAPTURE_OWNER_FAILED');
    resolveClose();
    fail();
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
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    const message = stderrTail + chunk.toString('utf8');
    busy ||= message.includes('"kind":"ARCHIVE_WRITER_BUSY"');
    stderrTail = message.slice(-256);
    if (stderrBytes > 65536) fail();
  });
  child.stdout.on('end', () => { if (bytes.length || !stopping) fail(); });
  child.stdout.on('data', chunk => {
    try {
      // 逐字节帧预算避免一大块输出先分配无界缓存，IPC 只保留固定安全回执。
      for (const byte of chunk) {
        if (bytes.length >= replyBytes) throw new Error('CAPTURE_FRAME');
        if (byte !== 10) { bytes = Buffer.concat([bytes, Buffer.from([byte])]); continue; }
        const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
        bytes = Buffer.alloc(0);
        if (frame.kind === 'READY' && serial === 0) { serial = 1; readyResolve(); }
        else if (pending && frame.id === pending.id) {
          const current = pending;
          pending = undefined;
          if (frame.error) current.reject(new Error(['TASK_INPUT', 'TASK_SECRET', 'TASK_CAS', 'TASK_CAPACITY', 'TASK_NOT_FOUND', 'TASK_REVISION'].includes(frame.error) ? frame.error : 'CAPTURE_COMMAND_REJECTED'));
          else current.resolve(frame.result);
        } else throw new Error('CAPTURE_PROTOCOL');
      }
    } catch { fail(); }
  });
  async function exchange(command, fields = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (pending || closed || ((stopping || failure) && command !== 'close')) throw new Error('CAPTURE_OWNER_UNAVAILABLE');
    const id = ++serial;
    const frame = JSON.stringify({ id, command, ...fields }) + '\n';
    if (Buffer.byteLength(frame) > 1500000) throw new Error('CAPTURE_FRAME');
    let timer;
    // status 无写入副作用，主动取消保留原因身份以区别生命周期停止与真实 IPC 故障。
    // 私有标记支持任意 signal.reason，只有尚无故障时才标记，未确认关闭必须覆盖取消并向上传播。
    const statusCancellation = new Error('CAPTURE_STATUS_CANCELLED');
    const abort = () => {
      if (command === 'status' && !failure) {
        failure = statusCancellation;
        // 主动取消已结束只读请求的 ACK 等待，关闭另受自身期限约束，不能把关闭耗时再次记成 ACK 未知。
        clearTimeout(timer);
      }
      fail();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        pending = { id, resolve, reject };
        timer = setTimeout(() => {
          diagnostics.ackUnknown = true;
          failure ??= new Error('CAPTURE_ACK_UNKNOWN');
          fail();
          reject(failure);
        }, 2000);
        child.stdin.write(frame, error => { if (error) fail(); });
      });
    } catch (error) {
      // 取消或 ACK 未知后等待实际 owner 收尾，不能提前返回并让 SQL 继续占用私有库。
      if (failure || signal?.aborted) await owner.close();
      if (error === statusCancellation) throw signal.reason;
      throw error;
    } finally { clearTimeout(timer); pending = undefined; signal?.removeEventListener('abort', abort); }
  }
  // 角色只决定能力，停止由 exchange 统一拒绝，关闭 ACK 到实际退出之间也不能接纳新任务或误报角色错误。
  function task(command, payload, options) {
    if (role !== 'assistant-local') throw new Error('CAPTURE_ROLE');
    return exchange(command, { payload }, options);
  }
  const owner = {
    rootPath,
    worktree: checkout.worktree,
    diagnostics,
    readStatus: options => exchange('status', {}, options),
    newTask: (payload, options) => task('task-new', payload, options),
    saveCheckpoint: (payload, options) => task('task-save', payload, options),
    linkTask: (payload, options) => task('task-link', payload, options),
    readVisibleTask: (payload, options) => task('task-read', payload, options),
    confirmTask: (payload, options) => task('task-confirm', payload, options),
    taskStatus: (payload, options) => task('task-status', payload, options),
    archive(round, observation) {
      if (stopping) throw new Error('CAPTURE_STOPPED');
      return exchange('archive', { round: { sourceSessionId: round.sourceSessionId, sourceEntryId: round.sourceEntryId,
        capturedAt: new Date().toISOString(), rawBase64: Buffer.from(round.raw).toString('base64') }, observation });
    },
    close() {
      if (shutdown) return shutdown;
      stopping = true;
      shutdown = (async () => {
        let term;
        let deadline;
        const timeout = new Promise((_, reject) => {
          term = setTimeout(() => { child.kill('SIGTERM'); }, 1000);
          deadline = setTimeout(() => reject(new Error('CAPTURE_CLOSE_UNCONFIRMED')), 4000);
        });
        try {
          if (!closed && !pending) void exchange('close').catch(() => {});
          await Promise.race([actualClose, timeout]);
          if (!treeReaped) throw new Error('CAPTURE_CLOSE_UNCONFIRMED');
          retained.delete(owner);
          diagnostics.retained = false;
        } catch (error) {
          retained.add(owner);
          diagnostics.retained = true;
          shutdown = undefined;
          throw error;
        } finally { clearTimeout(term); clearTimeout(deadline); }
      })();
      return shutdown;
    }
  };
  let startupTimer;
  try {
    await Promise.race([ready, new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error('CAPTURE_STARTUP')), 2000); })]);
    if (closed || failure || stopping) throw new Error('CAPTURE_STARTUP');
    return owner;
  } catch {
    await owner.close();
    throw new Error(busy ? 'CAPTURE_WRITER_BUSY' : 'CAPTURE_START_FAILED');
  } finally { clearTimeout(startupTimer); }
}
