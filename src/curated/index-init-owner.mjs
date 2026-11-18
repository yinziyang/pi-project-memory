import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const jobKey = Symbol.for('local-project-memory.index-init.job.v1');
const codes = new Set(['READY', 'FAILED', 'BUSY', 'UNSAFE_PATH', 'UV_UNAVAILABLE', 'MODEL_DOWNLOAD_FAILED', 'MANIFEST_INVALID', 'PYTHON_UNAVAILABLE', 'CHROMA_FAILED', 'INVALID_ARGUMENTS', 'EXISTING_ASSET_INVALID'].map(code => `INDEX_INSTALL_${code}`));

/** 用户命令独占安装子树，只接受专用监管器的实际回收凭证，不能以父进程退出代替。 */
export function startIndexInstall(home) {
  if (process.platform !== 'linux' || typeof home !== 'string' || !isAbsolute(home)) throw new Error('INDEX_INSTALL_UNSUPPORTED');
  if (globalThis[jobKey]) throw new Error('INDEX_INSTALL_BUSY');
  const supervisor = fileURLToPath(new URL('../authoring/supervise.py', import.meta.url));
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const child = spawn('python3', [supervisor, 'python3', 'index-install', home, packageRoot], {
    cwd: packageRoot, stdio: ['ignore', 'pipe', 'ignore', 'pipe'],
    env: { HOME: home, PATH: process.env.PATH, LANG: 'C.UTF-8', LOCAL_MEMORY_REAP_FD: '3' },
  });
  let proof = '';
  let output = '';
  let bad = false;
  let spawnFailed = false;
  let resolveClose;
  const closed = new Promise(resolve => { resolveClose = resolve; });
  const stop = () => { child.kill('SIGTERM'); };
  const abortTimer = setTimeout(stop, 900000);
  let resolveResult;
  const result = new Promise(resolve => { resolveResult = resolve; });
  const waitTimer = setTimeout(() => resolveResult('INDEX_INSTALL_CLOSE_UNCONFIRMED'), 904000);
  const job = {
    result,
    async close() {
      stop();
      let timer;
      try {
        const confirmed = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(false), 4000); })]);
        if (!confirmed) throw new Error('INDEX_INSTALL_CLOSE_UNCONFIRMED');
      } finally { clearTimeout(timer); }
    },
  };
  globalThis[jobKey] = job;
  child.on('error', () => { spawnFailed = child.pid === undefined; });
  for (const [stream, limit, append] of [[child.stdout, 1024, bytes => { output += bytes; return output.length; }], [child.stdio[3], 32, bytes => { proof += bytes; return proof.length; }]]) {
    stream.on('error', () => { bad = true; stop(); });
    stream.on('data', bytes => { if (!bad && append(bytes) > limit) { bad = true; stop(); } });
  }
  child.on('close', code => {
    clearTimeout(abortTimer);
    clearTimeout(waitTimer);
    const confirmed = spawnFailed || proof === 'REAP_CONFIRMED\n';
    if (confirmed && globalThis[jobKey] === job) delete globalThis[jobKey];
    resolveClose(confirmed);
    if (!confirmed) { resolveResult('INDEX_INSTALL_CLOSE_UNCONFIRMED'); return; }
    let record;
    try { record = JSON.parse(output); } catch { /* 无合法状态帧时仅报告固定失败码。 */ }
    const verdict = !bad && record && Object.keys(record).length === 1 && codes.has(record.code) && (record.code !== 'INDEX_INSTALL_READY' || code === 0);
    resolveResult(verdict ? record.code : 'INDEX_INSTALL_FAILED');
  });
  return job;
}
