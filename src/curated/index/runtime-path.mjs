import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** 将可信本地入口路径转换为 ESM URL，保留空格、井号、问号与非 ASCII 字符，不接受相对路径或 URL 字符串。 */
export function localRuntimeModuleURL(filePath) {
  if (typeof filePath !== 'string' || !filePath.isWellFormed() || filePath.includes('\0') || !isAbsolute(filePath)) throw new Error('INDEX_RUNTIME_INVALID');
  return pathToFileURL(filePath).href;
}

/** 校验规范绝对路径的现有祖先并保留未创建的后缀，不创建目录，拒绝链接改写，适用于尚未存在的受保护目录。 */
export async function canonicalFuturePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.isWellFormed() || filePath.includes('\0') || !isAbsolute(filePath) || resolve(filePath) !== filePath) throw new Error('INDEX_PATH_UNSAFE');
  let current = filePath;
  const suffix = [];
  while (true) {
    try {
      await lstat(current);
      if (await realpath(current) !== current) throw new Error('INDEX_PATH_UNSAFE');
      return join(current, ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('INDEX_PATH_UNSAFE', { cause: error });
      const parent = dirname(current);
      if (parent === current) throw new Error('INDEX_PATH_UNSAFE');
      suffix.push(current.slice(parent.length + (parent === sep ? 0 : 1)));
      current = parent;
    }
  }
}
