import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { parseDocument } from 'yaml';

const safeText = value => typeof value === 'string' && value.isWellFormed() && value.trim() && !value.includes('\0') && Buffer.byteLength(value) <= 4096;
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === fields;

/** 只读固定 HOME/.local-project-memory-capture/config.json，缺失时返回 null，绝不创建目录或读取会话。
 * 配置目录须当前 UID 所有且 0700，文件须单链接普通文件、0600、至多 16KiB，拒绝链接、BOM、坏 UTF-8、重复键和未知字段。
 * 显式 enabled=true 才按 canonical cwd 精确选择最多 32 个项目绑定，不接受模型参数或公开 descriptor 授权。
 * includeDisabled 默认 false，仅显式 true 时允许返回停用绑定的 cwd/project/privateRoot 安全元数据，不返回启动能力且不启用 capture。
 * 当前调用方需保证可信 HOME 及祖先不被同 UID 恶意替换，返回路径不得写入公开状态或会话日志。
 */
export async function readCaptureConfig(cwd, { includeDisabled = false } = {}) {
  if (typeof includeDisabled !== 'boolean') throw new Error('CAPTURE_CONFIG_INVALID');
  const directory = join(process.env.HOME, '.local-project-memory-capture');
  let stat;
  try { stat = await lstat(directory); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('CAPTURE_CONFIG_UNAVAILABLE');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw new Error('CAPTURE_CONFIG_UNSAFE');
  const file = await open(join(directory, 'config.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > 16384) throw new Error('CAPTURE_CONFIG_UNSAFE');
    const buffer = Buffer.alloc(16385);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 16384) throw new Error('CAPTURE_CONFIG_BYTES');
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
  const config = JSON.parse(text);
  const parsed = parseDocument(text, { uniqueKeys: true, schema: 'json', strict: true });
  if (parsed.errors.length || parsed.warnings.length || !exact(config, 'enabled,projects,version') || config.version !== 1 || typeof config.enabled !== 'boolean' ||
      !Array.isArray(config.projects) || config.projects.length > 32) throw new Error('CAPTURE_CONFIG_INVALID');
  const selectedCwd = cwd === undefined ? null : await realpath(cwd);
  const bindings = new Set();
  let selected = null;
  for (const binding of config.projects) {
    if (!exact(binding, 'bunPath,cwd,privateRoot,project') || !Object.values(binding).every(safeText) || Buffer.byteLength(binding.project) > 256 ||
        !isAbsolute(binding.cwd) || resolve(binding.cwd) !== binding.cwd || !isAbsolute(binding.privateRoot) || resolve(binding.privateRoot) !== binding.privateRoot ||
        (!isAbsolute(binding.bunPath) && binding.bunPath !== 'bun') || bindings.has(binding.cwd)) throw new Error('CAPTURE_CONFIG_INVALID');
    bindings.add(binding.cwd);
    if (binding.cwd === selectedCwd) selected = Object.freeze({ ...binding });
  }
  if (config.enabled) return selected;
  return includeDisabled && selected ? Object.freeze({ cwd: selected.cwd, project: selected.project, privateRoot: selected.privateRoot }) : null;
}
