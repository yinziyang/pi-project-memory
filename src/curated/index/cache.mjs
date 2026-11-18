import { lstat, realpath, mkdir, writeFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './identity.mjs';
import { canonicalFuturePath } from './runtime-path.mjs';
import { readIndexJson } from './bounded-json.mjs';

const MARKER = 'curated-index-cache-v1';
const inside = (a, b) => a === b || a.startsWith(b + sep);

async function privateDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || await realpath(path) !== resolve(path)) throw new Error('INDEX_CACHE_UNSAFE');
}

async function privateJson(path, signal, ownedFiles) {
  try {
    const { value, text } = await readIndexJson(path, { signal, privateFile: true, ownedFiles });
    if (JSON.stringify(value) !== text) throw new Error('INDEX_CACHE_UNKNOWN');
    return value;
  } catch (error) {
    if (error?.retainedFile) throw error;
    signal?.throwIfAborted();
    if (error?.message === 'INDEX_CACHE_UNKNOWN' || error?.code === 'ENOENT') throw error;
    if (['INDEX_JSON_TYPE', 'INDEX_JSON_BYTES', 'INDEX_JSON_UNSAFE'].includes(error?.message) || error?.code === 'ELOOP') throw new Error('INDEX_CACHE_UNSAFE', { cause: error });
    throw new Error('INDEX_CACHE_UNKNOWN', { cause: error });
  }
}

/** 只初始化明确授权的新根，未知既有根、符号链接和与保护目录重叠的根均保留并拒绝使用。 */
export async function openIndexCache({ cacheRoot, excludedPaths, allowCreateCache = false, signal, ownedFiles }) {
  signal?.throwIfAborted();
  if (process.platform !== 'linux' || !Array.isArray(excludedPaths) || excludedPaths.length < 1) throw new Error('INDEX_RUNTIME_INVALID');
  const root = resolve(cacheRoot);
  const parent = await realpath(dirname(root));
  if (parent !== dirname(root)) throw new Error('INDEX_CACHE_UNSAFE');
  for (const path of excludedPaths) {
    let canonical;
    try { canonical = await canonicalFuturePath(path); }
    catch (error) { throw new Error('INDEX_CACHE_UNSAFE', { cause: error }); }
    signal?.throwIfAborted();
    if (inside(root, canonical) || inside(canonical, root)) throw new Error('INDEX_CACHE_OVERLAP');
  }
  let created = false;
  try { await lstat(root); } catch (error) {
    if (error.code !== 'ENOENT' || !allowCreateCache) throw new Error('INDEX_CACHE_UNKNOWN');
    await mkdir(root, { mode: 0o700 });
    created = true;
  }
  signal?.throwIfAborted();
  await privateDirectory(root);
  const markerPath = join(root, 'owner.json');
  if (created) await writeFile(markerPath, JSON.stringify({ kind: MARKER, token: randomUUID() }), { flag: 'wx', mode: 0o600 });
  let marker;
  try { marker = await privateJson(markerPath, signal, ownedFiles); }
  catch (error) {
    if (error?.retainedFile) throw error;
    signal?.throwIfAborted();
    throw new Error('INDEX_CACHE_UNKNOWN', { cause: error });
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) || Object.keys(marker).sort().join(',') !== 'kind,token' || marker.kind !== MARKER || typeof marker.token !== 'string' || !/^[a-f0-9-]{36}$/.test(marker.token)) throw new Error('INDEX_CACHE_UNKNOWN');
  async function recheck(operationSignal) {
    operationSignal?.throwIfAborted();
    await privateDirectory(root);
    if (digest(await privateJson(markerPath, operationSignal, ownedFiles)) !== digest(marker)) throw new Error('INDEX_CACHE_UNKNOWN');
  }
  return {
    root,
    async stage(identity, operationSignal) {
      await recheck(operationSignal);
      const name = digest({ identity, nonce: randomUUID() });
      const directory = join(root, name);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'owner.json'), JSON.stringify({ token: marker.token, identity }), { flag: 'wx', mode: 0o600 });
      return { name, directory };
    },
    async inspect(name, identity, operationSignal) {
      await recheck(operationSignal);
      if (!/^[a-f0-9]{64}$/.test(name)) throw new Error('INDEX_CACHE_UNKNOWN');
      const directory = join(root, name);
      await privateDirectory(directory);
      const owner = await privateJson(join(directory, 'owner.json'), operationSignal, ownedFiles);
      if (!owner || typeof owner !== 'object' || Array.isArray(owner) || Object.keys(owner).sort().join(',') !== 'identity,token' || owner.token !== marker.token || digest(owner.identity) !== digest(identity)) throw new Error('INDEX_CACHE_UNKNOWN');
      // 拒绝链接和硬链接，任何未知内容不授予删除权限。
      async function inspectTree(path) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          operationSignal?.throwIfAborted();
          const target = join(path, entry.name);
          const stat = await lstat(target);
          if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error('INDEX_CACHE_UNSAFE');
          if (stat.isDirectory()) await inspectTree(target);
        }
      }
      await inspectTree(directory);
      operationSignal?.throwIfAborted();
      return directory;
    },
    async readReady(identity, operationSignal) {
      await recheck(operationSignal);
      let pointer;
      try { pointer = await privateJson(join(root, 'ready.json'), operationSignal, ownedFiles); } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      }
      if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer) || Object.keys(pointer).sort().join(',') !== 'identity,name,refsDigest') throw new Error('INDEX_CACHE_UNKNOWN');
      if (digest(pointer.identity) !== digest(identity)) return undefined;
      const directory = await this.inspect(pointer.name, identity, operationSignal);
      return { ...pointer, directory };
    },
    // commit 必须由同一构建的持锁 lease worker 执行，父进程只准备临时指针并检查授权，不在 Pi Node 中同步 rename。
    async install(stage, identity, records, mayInstall = () => true, operationSignal, commit) {
      if (typeof commit !== 'function') throw new Error('INDEX_COMMIT_REQUIRED');
      await this.inspect(stage.name, identity, operationSignal);
      const pointer = { name: stage.name, identity, refsDigest: digest(records.map(({ id, ref }) => ({ id, ref }))) };
      const temporary = join(root, `${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(pointer), { flag: 'wx', mode: 0o600 });
      // 提交只能交给持有该根 flock 的隔离 lease worker，父进程不执行 rename，提交后仍须核对取消与 epoch。
      // 同 owner pump 等真实 build settle 才替换，跨 owner 必须等 lease 实际释放，新有效 ready 不会被晚旧提交覆盖。
      operationSignal?.throwIfAborted();
      if (!mayInstall()) throw new Error('INDEX_BINDING_STALE');
      await commit(temporary);
      operationSignal?.throwIfAborted();
      if (!mayInstall()) throw new Error('INDEX_BINDING_STALE');
      return { ...pointer, directory: stage.directory };
    },
  };
}
