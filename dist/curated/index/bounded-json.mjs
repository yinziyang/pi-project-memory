import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { parseDocument } from 'yaml';

export const INDEX_JSON_MAX_BYTES = 16384;

/** 读取 index 的本地 JSON，固定最多 16 KiB，返回原始 text 与未经重编码修复的 value。
 * 使用 O_NOFOLLOW/O_NONBLOCK 打开并在同一 fd 上确认普通文件，privateFile 额外要求当前 UID、单硬链接与 0600 权限。
 * signal 在打开、stat、每次有限读取和关闭之后检查，不能抢占已经进入内核的永久设备 I/O，调用方不得用提前返回冒充其停止。
 * ownedFiles 仅供具体 owner 登记自有 fd 的强引用，正常关闭后才删除，不能由 owner 在读取仍在途时提前关闭。
 * 本函数拥有 fd 并总会尝试关闭，关闭失败保留原错、cleanupErrors 与仅可信所有者可用的 retainedFile，不声称 fd 已释放。
 */
export async function readIndexJson(path, { signal, privateFile = false, ownedFiles } = {}) {
  signal?.throwIfAborted();
  let file;
  let result;
  let originalError;
  let failed = false;
  try {
    file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    ownedFiles?.add(file);
    signal?.throwIfAborted();
    const stat = await file.stat();
    signal?.throwIfAborted();
    if (!stat.isFile()) throw new Error('INDEX_JSON_TYPE');
    if (privateFile && (stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600)) throw new Error('INDEX_JSON_UNSAFE');
    if (stat.size > INDEX_JSON_MAX_BYTES) throw new Error('INDEX_JSON_BYTES');
    const bytes = Buffer.alloc(INDEX_JSON_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      signal?.throwIfAborted();
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > INDEX_JSON_MAX_BYTES) throw new Error('INDEX_JSON_BYTES');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
    catch { throw new Error('INDEX_JSON_ENCODING'); }
    let value;
    try { value = JSON.parse(text); }
    catch { throw new Error('INDEX_JSON_SYNTAX'); }
    const document = parseDocument(text, { uniqueKeys: true, schema: 'json', strict: true });
    if (document.errors.length || document.warnings.length) throw new Error('INDEX_JSON_SYNTAX');
    signal?.throwIfAborted();
    result = { value, text };
  } catch (error) {
    failed = true;
    originalError = error;
  }
  if (file) {
    try { await file.close(); ownedFiles?.delete(file); }
    catch (cleanupError) {
      const failure = new AggregateError([...(failed ? [originalError] : []), cleanupError], 'INDEX_JSON_CLOSE_FAILED', { cause: originalError });
      Object.assign(failure, { originalError, cleanupErrors: [cleanupError], retainedResources: [{ owner: 'index-json-reader', state: 'close-unconfirmed' }] });
      Object.defineProperty(failure, 'retainedFile', { value: file });
      throw failure;
    }
  }
  if (failed) throw originalError;
  signal?.throwIfAborted();
  return result;
}
