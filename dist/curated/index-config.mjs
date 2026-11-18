import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { readCaptureConfig } from './capture-config.mjs';
import { canonicalFuturePath } from './index/runtime-path.mjs';
import { INDEX_JSON_MAX_BYTES, readIndexJson } from './index/bounded-json.mjs';

const text = value => typeof value === 'string' && value.isWellFormed() && value.trim() && !value.includes('\0') && Buffer.byteLength(value) <= 4096;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;
const overlaps = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

// 配置读取与实际缓存打开共享同一祖先校验，保护路径尚未创建时也不能被忽略或被隐式创建。
async function canonicalCandidate(path) {
  try { return await canonicalFuturePath(path); }
  catch (error) { throw new Error('INDEX_CONFIG_UNSAFE', { cause: error }); }
}

// 安装回执只授权使用固定用户目录，不接受项目提供的可执行文件、模型或缓存路径。
async function userInstallation(home) {
  const root = join(home, '.local', 'share', 'local-project-memory');
  if (await canonicalCandidate(root) !== root) throw new Error('INDEX_CONFIG_UNSAFE');
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700) throw new Error('INDEX_CONFIG_UNSAFE');
    const { value } = await readIndexJson(join(root, 'index-receipt.json'), { privateFile: true });
    if (!exact(value, 'version') || value.version !== 1) throw new Error('INDEX_CONFIG_INVALID');
    return root;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** 返回用户级安装回执状态，不启动模型或重新校验资产内容。 */
export async function readIndexInstallation() {
  const root = await userInstallation(await realpath(process.env.HOME));
  if (!root) return { state: 'not-initialized', e5: 'unknown', chroma: 'unknown' };
  async function available(path, mode) {
    try { await access(path, mode); return 'present'; }
    catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) return 'unavailable'; throw error; }
  }
  return { state: 'initialized',
    e5: await available(join(root, 'models', 'Xenova', 'multilingual-e5-small', 'onnx', 'model.onnx'), constants.R_OK),
    chroma: await available(join(root, 'venv', 'bin', 'python'), constants.X_OK) === 'present'
      ? await available(join(root, 'venv', 'lib', 'python3.13', 'site-packages', 'chromadb-1.5.9.dist-info', 'METADATA'), constants.R_OK)
      : 'unavailable' };
}

async function defaultBinding(home, cwd, publication) {
  if (!publication || publication.canonicalCwd !== cwd) return null;
  const root = await userInstallation(home);
  if (!root) return null;
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);
  for (const dir of dirs) {
    const bunPath = join(await realpath(dir).catch(error => { if (error.code === 'ENOENT') return dir; throw error; }), 'bun');
    try { await access(bunPath, constants.X_OK); }
    catch (error) { if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) continue; throw error; }
    // 现有缓存根的所有权标记绑定单个 checkout 与项目，不允许不同项目共用一个根。
    const cacheKey = createHash('sha256').update(JSON.stringify([cwd, publication.project])).digest('hex');
    return { cwd, project: publication.project, cacheRoot: join(root, `cache-${cacheKey}`), modelRoot: join(root, 'models'),
      manifestPath: fileURLToPath(new URL('./e5-model-manifest.json', import.meta.url)),
      pythonPath: join(root, 'venv', 'bin', 'python'), bunPath, allowCreateCache: true };
  }
  throw new Error('DEPENDENCY_MISSING');
}

/** 旧显式配置优先，缺少匹配项时由可信发布和用户安装回执选择固定默认绑定，不创建目录或启动模型。
 * 目录必须为当前 UID 的 canonical 0700 目录，配置必须为单链接普通 0600 文件且至多 16 KiB，拒绝 BOM、坏 UTF-8、重复键和未知字段。
 * projects 最多 32 项，只有 enabled=true 且 canonical cwd 精确匹配的绑定能授权后续创建专用 cacheRoot，project 必须再由 runtime 对照可信安装值。
 * 停用 capture 的 privateRoot 仍作为保护路径读取，不启用 capture，也不读取其私有数据库或真实会话。
 * Python/Bun 的显式可执行文件可为可信虚拟环境符号链接，但其父路径不得经链接改写，模型与 manifest 只借用而不创建。
 */
export async function readIndexConfig(cwd, { publication } = {}) {
  if (!text(process.env.HOME) || !isAbsolute(process.env.HOME)) throw new Error('INDEX_CONFIG_UNSAFE');
  const home = await realpath(process.env.HOME);
  const directory = join(home, '.local-project-memory-index');
  async function explicitConfig() {
    let stat;
    try { stat = await lstat(directory); } catch (error) {
      if (error.code === 'ENOENT') return { enabled: true, projects: [] };
      throw new Error('INDEX_CONFIG_UNAVAILABLE');
    }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700 || await realpath(directory) !== directory) throw new Error('INDEX_CONFIG_UNSAFE');
  let file;
  try { file = await open(join(directory, 'config.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT') return { enabled: true, projects: [] };
    throw new Error('INDEX_CONFIG_UNSAFE');
  }
  let config;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600 || info.size > 16384) throw new Error('INDEX_CONFIG_UNSAFE');
    const bytes = Buffer.alloc(16385);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > 16384) throw new Error('INDEX_CONFIG_BYTES');
    try {
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
      config = JSON.parse(content);
      const parsed = parseDocument(content, { uniqueKeys: true, schema: 'json', strict: true });
      if (parsed.errors.length || parsed.warnings.length) throw new Error();
    } catch { throw new Error('INDEX_CONFIG_INVALID'); }
  } finally { await file.close(); }
  if (!exact(config, 'enabled,projects,version') || config.version !== 1 || typeof config.enabled !== 'boolean' || !Array.isArray(config.projects) || config.projects.length > 32) throw new Error('INDEX_CONFIG_INVALID');
    return config;
  }
  const config = await explicitConfig();
  const selectedCwd = await realpath(cwd);
  const seen = new Set();
  let selected;
  for (const binding of config.projects) {
    if (!exact(binding, 'allowCreateCache,bunPath,cacheRoot,cwd,manifestPath,modelRoot,project,pythonPath') || typeof binding.allowCreateCache !== 'boolean' || !Object.entries(binding).filter(([key]) => key !== 'allowCreateCache').every(([, value]) => text(value)) || Buffer.byteLength(binding.project) > 256) throw new Error('INDEX_CONFIG_INVALID');
    for (const key of ['cwd', 'cacheRoot', 'modelRoot', 'manifestPath', 'pythonPath', 'bunPath']) if (!isAbsolute(binding[key]) || resolve(binding[key]) !== binding[key]) throw new Error('INDEX_CONFIG_INVALID');
    if (seen.has(binding.cwd)) throw new Error('INDEX_CONFIG_INVALID');
    seen.add(binding.cwd);
    if (binding.cwd === selectedCwd) selected = binding;
  }
  if (!config.enabled) return null;
  selected ??= await defaultBinding(home, selectedCwd, publication);
  if (!selected) return null;
  // 配置阶段只做非阻塞元数据检查，实际读取仍由 index 在同一 O_NOFOLLOW/O_NONBLOCK fd 上复核，不能以此 stat 代替读取边界。
  try {
    const manifest = await lstat(selected.manifestPath);
    if (!manifest.isFile() || manifest.isSymbolicLink() || manifest.size > INDEX_JSON_MAX_BYTES) throw new Error('INDEX_CONFIG_MANIFEST_UNSAFE');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let capture;
  try { capture = await readCaptureConfig(cwd, { includeDisabled: true }); }
  catch (error) { throw new Error('INDEX_CONFIG_CAPTURE_INVALID', { cause: error }); }
  const protectedPaths = [selectedCwd, directory, join(home, '.local-project-memory-capture'), selected.modelRoot, selected.manifestPath];
  if (capture?.privateRoot) protectedPaths.push(capture.privateRoot);
  const canonical = await Promise.all(protectedPaths.map(canonicalCandidate));
  const cacheRoot = await canonicalCandidate(selected.cacheRoot);
  if (canonical.some(path => overlaps(cacheRoot, path))) throw new Error('INDEX_CONFIG_OVERLAP');
  if (capture?.privateRoot) {
    const privateRoot = await canonicalCandidate(capture.privateRoot);
    if ([directory, join(home, '.local-project-memory-capture')].some(path => overlaps(privateRoot, path))) throw new Error('INDEX_CONFIG_OVERLAP');
  }
  for (const key of ['pythonPath', 'bunPath']) await canonicalCandidate(dirname(selected[key]));
  return Object.freeze({ ...selected, cwd: selectedCwd, cacheRoot, excludedPaths: Object.freeze(canonical) });
}
