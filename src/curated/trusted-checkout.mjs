import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const retainedKey = Symbol.for('local-project-memory.checkout.retained.v1');
const retained = globalThis[retainedKey] ??= new Set();

/** 关闭不明的 Git 子进程仍由模块保留，调用方不得宣称已完成资源收尾或启动替代周期。 */
function assertCheckoutReadersClosed() {
  if (retained.size) throw new Error('CHECKOUT_CLOSE_UNCONFIRMED');
}

const digest = value => createHash('sha256').update(value).digest('hex');
const decode = value => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);

/** 仅由隔离观察 worker 调用，native 文件系统调用与 Git 后代均留在专用 subreaper 子树内。
 * 只读观察 canonical cwd 与 Git/worktree，固定 argv、无 shell、无全局配置与交互，不 fetch 或修改 index。
 * 总预算 2000ms，每命令 stdout+stderr 合计最多 1MiB，支持取消，超限 TERM 后 100ms KILL 并等待实际 close。
 * 状态采用 porcelain -z 原始字节摘要，路径不按换行切分，dirtyDigest 不是文件内容摘要或审批凭据。
 * 只保证两次 HEAD/status 观察一致，不声称 Git 提供跨命令原子快照，unborn 与 nonGit 均为有效观察。
 */
export async function observeCheckoutInWorker(cwd, signal) {
  assertCheckoutReadersClosed();
  const canonicalCwd = await realpath(cwd);
  const deadline = performance.now() + 2000;
  let active;
  async function git(args) {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('CHECKOUT_TIMEOUT');
    return await new Promise((resolve, reject) => {
      let chunks = [];
      let size = 0;
      let failure;
      let killTimer;
      let closeTimer;
      let closed = false;
      const child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.pager=cat', ...args], {
        cwd: canonicalCwd, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
      });
      active = child;
      function stop() {
        failure ??= new Error('CHECKOUT_UNAVAILABLE');
        if (!closed) {
          child.kill('SIGTERM');
          killTimer ??= setTimeout(() => child.kill('SIGKILL'), 100);
          closeTimer ??= setTimeout(() => {
            chunks = [];
            retained.add(child);
            reject(new Error('CHECKOUT_CLOSE_UNCONFIRMED'));
          }, 1200);
        }
      }
      const timer = setTimeout(stop, Math.max(0, deadline - performance.now()));
      const consume = (chunk, output) => {
        size += chunk.length;
        if (size > 1024 * 1024) { stop(); return; }
        if (output && !failure) chunks.push(chunk);
      };
      signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', chunk => consume(chunk, true));
      child.stderr.on('data', chunk => consume(chunk, false));
      child.stdout.on('error', stop);
      child.stderr.on('error', stop);
      child.on('error', stop);
      child.once('close', code => {
        closed = true;
        active = undefined;
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(closeTimer);
        retained.delete(child);
        signal?.removeEventListener('abort', stop);
        if (failure) reject(failure);
        else resolve({ code, data: Buffer.concat(chunks) });
        chunks = [];
      });
    });
  }
  async function line(args, optional = false) {
    const result = await git(args);
    if (result.code !== 0) {
      if (optional) return null;
      throw new Error('CHECKOUT_GIT_FAILED');
    }
    const text = decode(result.data);
    if (!text.endsWith('\n')) throw new Error('CHECKOUT_GIT_INVALID');
    return text.slice(0, -1);
  }
  try {
    const root = await line(['rev-parse', '--path-format=absolute', '--show-toplevel'], true);
    if (root === null) {
      // rev-parse 失败也可能是损坏或权限问题，额外核对 Git 标记，不能静默认作普通目录。
      const { lstat } = await import('node:fs/promises');
      let parent = canonicalCwd;
      const { dirname, join } = await import('node:path');
      for (;;) {
        try { await lstat(join(parent, '.git')); throw new Error('CHECKOUT_GIT_FAILED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (dirname(parent) === parent) break;
        parent = dirname(parent);
      }
      return Object.freeze({ version: 1, kind: 'nonGit', canonicalCwd, root: canonicalCwd, gitDir: null, commonDir: null,
        worktree: digest(JSON.stringify([canonicalCwd, null])), commit: null, tree: null, detached: false, unborn: false, dirty: false, dirtyDigest: null, stable: true });
    }
    const gitDir = await realpath(await line(['rev-parse', '--absolute-git-dir']));
    const commonDir = await realpath(await line(['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const firstHead = await line(['rev-parse', '--verify', 'HEAD'], true);
    const tree = await line(['rev-parse', '--verify', 'HEAD^{tree}'], true);
    const symbolic = await line(['symbolic-ref', '-q', 'HEAD'], true);
    const firstStatus = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all']);
    const lastHead = await line(['rev-parse', '--verify', 'HEAD'], true);
    const lastStatus = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all']);
    if (firstStatus.code || lastStatus.code || (firstHead !== null && !/^[a-f0-9]{40,64}$/.test(firstHead)) || (tree !== null && !/^[a-f0-9]{40,64}$/.test(tree))) throw new Error('CHECKOUT_GIT_INVALID');
    return Object.freeze({ version: 1, kind: 'git', canonicalCwd, root: await realpath(root), gitDir, commonDir,
      worktree: digest(JSON.stringify([canonicalCwd, gitDir, commonDir])), commit: firstHead, tree, detached: symbolic === null,
      unborn: firstHead === null, dirty: firstStatus.data.length > 0, dirtyDigest: digest(firstStatus.data),
      stable: firstHead === lastHead && firstStatus.data.equals(lastStatus.data) });
  } finally {
    // 每个 git 调用只有 close 后才完成，不能提前释放仍在读的 owner 或清理测试 cwd。
    if (active) throw new Error('CHECKOUT_CLOSE_UNCONFIRMED');
  }
}
