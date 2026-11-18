import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';

const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);

/** 仅在隔离观察 worker 内读取固定 cwd 的公开描述与文件身份，不打开 SQLite 或授权新的 project/path。
 * requireDatabase=false 仅供归档观测，公开 reader 与任务读取必须要求真实文件并检查暂停标记。
 * 返回 null 只表示公开目录或描述尚不存在，畸形描述、链接和暂停均拒绝，不退回 last-good。
 */
export async function readTrustedDescriptor(cwd, { requireDatabase = true, allowPaused = false } = {}) {
  const root = await realpath(cwd);
  const paused = join(root, '.project-memory-paused');
  if (!allowPaused) {
    try { await lstat(paused); throw new Error('PUBLICATION_PAUSED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const directory = join(root, '.project-memory');
  let directoryStat;
  let file;
  try {
    directoryStat = await lstat(directory, { bigint: true });
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('INVALID_PUBLIC_DIRECTORY');
    file = await open(join(directory, 'curated.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let config;
  let descriptorStat;
  try {
    descriptorStat = await file.stat({ bigint: true });
    if (!descriptorStat.isFile() || descriptorStat.size > 8192n) throw new Error('INVALID_DESCRIPTOR');
    const bytes = Buffer.alloc(8193);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 8192) throw new Error('INVALID_DESCRIPTOR');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    config = JSON.parse(content);
    const parsed = parseDocument(content, { uniqueKeys: true, schema: 'json', strict: true });
    if (parsed.errors.length || parsed.warnings.length || !config || typeof config !== 'object' || Array.isArray(config) ||
        Object.keys(config).sort().join(',') !== 'generation,project,version' || config.version !== 1 ||
        typeof config.project !== 'string' || !config.project.isWellFormed() || !config.project.trim() || config.project.includes('\0') || Buffer.byteLength(config.project) > 256 ||
        typeof config.generation !== 'string' || !/^[a-f0-9]{64}$/.test(config.generation)) throw new Error('INVALID_DESCRIPTOR');
    if (JSON.stringify(identity(descriptorStat)) !== JSON.stringify(identity(await file.stat({ bigint: true })))) throw new Error('PUBLIC_UNSTABLE');
  } finally { await file.close(); }
  const publicPath = join(directory, 'knowledge.sqlite');
  let databaseStat;
  if (requireDatabase) {
    databaseStat = await lstat(publicPath, { bigint: true });
    if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error('INVALID_PUBLIC_FILE');
  }
  if (!allowPaused) {
    try { await lstat(paused); throw new Error('PUBLICATION_PAUSED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { ...config, publicPath, canonicalCwd: root,
    scope: createHash('sha256').update(JSON.stringify([root, config.project])).digest('hex'),
    fileIdentity: JSON.stringify([identity(directoryStat), identity(descriptorStat), ...(databaseStat ? [identity(databaseStat)] : [])]), paused: false, stable: true };
}
