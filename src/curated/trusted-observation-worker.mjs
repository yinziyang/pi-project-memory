import { isAbsolute } from 'node:path';
import { readCaptureConfig } from './capture-config.mjs';
import { readIndexConfig, readIndexInstallation } from './index-config.mjs';
import { readTrustedDescriptor } from './trusted-descriptor.mjs';
import { observeCheckoutInWorker } from './trusted-checkout.mjs';

// 固定只读入口由专用 subreaper 拥有，Pi 不在自己的事件循环内执行这些文件系统调用。
const [cwd, home, version, role] = process.argv.slice(2);
if (process.argv.length !== 6 || !isAbsolute(cwd) || !isAbsolute(home) || version !== '1' || role !== 'read-only') throw new Error('OBSERVATION_ARGUMENTS');
process.env.HOME = home;
let stopped = false;
let active;
let pending = Buffer.alloc(0);
function stop() {
  stopped = true;
  active?.abort();
  process.stdin.destroy();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stderr.on('error', stop);
process.stdout.on('error', stop);

function encode(value) {
  let size = 1;
  function visit(item, depth = 0) {
    if (depth > 16) throw new Error('OBSERVATION_FRAME');
    if (typeof item === 'string') {
      size += 2;
      for (const character of item) {
        const cp = character.codePointAt(0);
        size += character === '"' || character === '\\' || [8, 9, 10, 12, 13].includes(cp) ? 2 : cp < 32 ? 6 : Buffer.byteLength(character);
        if (size > 131072) throw new Error('OBSERVATION_FRAME');
      }
    } else if (item !== null && typeof item === 'object') {
      size += 2;
      for (const [key, child] of Object.entries(item)) { if (!Array.isArray(item)) visit(key, depth + 1); size += 2; visit(child, depth + 1); }
    } else size += JSON.stringify(item)?.length ?? 4;
    if (size > 131072) throw new Error('OBSERVATION_FRAME');
  }
  visit(value);
  return JSON.stringify(value) + '\n';
}
async function reply(value) {
  const bytes = encode(value);
  await new Promise((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()));
}
async function command(request) {
  if (!request || Object.keys(request).sort().join(',') !== 'command,id' || !Number.isSafeInteger(request.id) || request.id < 1) throw new Error('OBSERVATION_PROTOCOL');
  if (request.command === 'close') { stopped = true; return 'closed'; }
  active = new AbortController();
  const timer = setTimeout(() => active?.abort(), 2000);
  try {
    if (request.command === 'capture-config') return await readCaptureConfig(cwd);
    if (request.command === 'draft-binding') {
      const binding = await readCaptureConfig(cwd, { includeDisabled: true });
      if (!binding) return null;
      const checkout = await observeCheckoutInWorker(cwd, active.signal);
      const publication = await readTrustedDescriptor(cwd, { requireDatabase: false, allowPaused: true });
      if (!checkout.stable || (publication && publication.project !== binding.project)) throw new Error('MEMORY_DRAFT_STALE');
      return { binding, checkout, generation: publication?.generation ?? null };
    }
    if (request.command === 'index-config') return await readIndexConfig(cwd, { publication: await readTrustedDescriptor(cwd) });
    if (request.command === 'index-installation') return await readIndexInstallation();
    if (request.command === 'checkout') return await observeCheckoutInWorker(cwd, active.signal);
    if (request.command === 'publication') return await readTrustedDescriptor(cwd);
    if (request.command === 'archive-binding') return await readTrustedDescriptor(cwd, { requireDatabase: false, allowPaused: true });
    throw new Error('OBSERVATION_COMMAND');
  } finally { clearTimeout(timer); active = undefined; }
}
try {
  await reply({ kind: 'READY' });
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > 8192) throw new Error('OBSERVATION_FRAME');
    let end;
    while (!stopped && (end = pending.indexOf(10)) !== -1) {
      const raw = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      const request = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
      try { await reply({ id: request.id, result: await command(request) }); }
      catch (error) {
        if (stopped) throw error;
        await reply({ id: request.id, error: /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'OBSERVATION_FAILED' });
      }
    }
    if (stopped) break;
  }
  if (pending.length && !stopped) throw new Error('OBSERVATION_FRAME');
} catch {
  process.exitCode = 1;
} finally { stop(); }
