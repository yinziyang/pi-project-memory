import {constants} from 'node:fs';
import {open, opendir} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {isAlias, isMap, isScalar, parseDocument, visit} from 'yaml';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RECORDS = 1000;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** 单条可见记忆；所有文本均为不可信资料，不得作为指令执行，来源引用永不展开。 */
export interface MemoryRecord {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly verification: string;
  readonly body: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** 本模块未加载归档，不代表磁盘不存在归档。 */
  readonly archive: 'not_loaded';
}

/** 一次加载的只读内存视图，不跟踪磁盘后续变化，也不按 scope 自动过滤或注入。 */
export interface ProjectMemory {
  readonly projectId: string;
  readonly records: readonly MemoryRecord[];
  /** 按原样 ID 读取；不存在时返回 undefined，不展开来源文件。 */
  read(id: string): MemoryRecord | undefined;
  /** 空白分词后作大小写无关的 AND 子串匹配，空查询返回空数组，结果按 ID 稳定排序。 */
  search(query: string): readonly MemoryRecord[];
}

function checkText(text: string): void {
  if (text.isWellFormed() === false || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new Error('文本包含非法 Unicode 或控制字符');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error('元数据必须是对象');
  }
  return value;
}

function field(data: Record<string, unknown>, name: string): string {
  const value = data[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少或非法字段：${name}`);
  checkText(value);
  return value;
}

function identifier(data: Record<string, unknown>, name: string): string {
  const value = field(data, name);
  if (!ID.test(value)) throw new Error(`非法标识：${name}`);
  return value;
}

// 所有来源只作为数据保留，冻结递归结构，防止调用方改动一次加载的共享视图。
function freezeData(value: unknown): unknown {
  if (typeof value === 'string') checkText(value);
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      checkText(key);
      freezeData(child);
    }
    Object.freeze(value);
  }
  return value;
}

function parseMemory(text: string): MemoryRecord {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
  if (!match || match[1] === undefined || match[2] === undefined) throw new Error('缺少 YAML frontmatter');
  const doc = parseDocument(match[1], {uniqueKeys: true, strict: true, schema: 'core'});
  if (doc.errors.length || doc.warnings.length) throw new Error(`非法 YAML：${[...doc.errors, ...doc.warnings].map(e => e.message).join(', ')}`);
  visit(doc, (_key, node) => {
    if (isAlias(node)) throw new Error('不允许 YAML alias');
    if (isMap(node) && node.items.some(pair => !isScalar(pair.key) || typeof pair.key.value !== 'string')) {
      throw new Error('YAML 映射键必须是字符串');
    }
    if (typeof node === 'object' && node !== null && 'anchor' in node && node.anchor) throw new Error('不允许 YAML anchor');
  });
  const decoded: unknown = doc.toJS({maxAliasCount: 0});
  const data = object(decoded);
  if (data.schema_version !== 1) throw new Error('不支持记忆 schema_version');
  const allowed = new Set(['schema_version', 'id', 'kind', 'status', 'verification', 'task_id', 'session_id', 'source_record', 'base_commit', 'files', 'supersedes', 'entry_id', 'tool_call_id', 'source_revision', 'content_hash', 'scope', 'file_hashes']);
  for (const [key, value] of Object.entries(data)) {
    if (!allowed.has(key)) throw new Error(`未知记忆字段：${key}`);
    if (['files', 'supersedes'].includes(key)) {
      if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && v.trim())) throw new Error(`非法数组：${key}`);
    } else if (key === 'scope' || key === 'file_hashes') {
      const entries = object(value);
      if (!Object.values(entries).every(v => typeof v === 'string')) throw new Error(`非法映射：${key}`);
    } else if (key !== 'schema_version') {
      field(data, key);
    }
  }
  const id = identifier(data, 'id');
  const kind = field(data, 'kind');
  const status = field(data, 'status');
  const verification = field(data, 'verification');
  if (!['lesson', 'checkpoint', 'constraint', 'overview'].includes(kind)) throw new Error('非法 kind');
  if (!['active', 'superseded', 'archived'].includes(status)) throw new Error('非法 status');
  if (!['unverified', 'user_confirmed', 'tool_verified'].includes(verification)) throw new Error('非法 verification');
  const body = match[2];
  if (!body.trim()) throw new Error('正文不能为空');
  freezeData(data);
  return Object.freeze({id, kind, status, verification, body, metadata: data, archive: 'not_loaded'});
}

function fdPath(handle: FileHandle, child?: string): string {
  return `/proc/self/fd/${handle.fd}${child === undefined ? '' : `/${child}`}`;
}

async function openDirectory(path: string, signal: AbortSignal): Promise<FileHandle> {
  signal.throwIfAborted();
  const handle = await open(path, DIRECTORY_FLAGS);
  try {
    signal.throwIfAborted();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// 从文件系统根逐级锚定，拒绝调用方路径中任何符号链接及点路径，不用先检查后普通打开。
async function openRoot(path: string, signal: AbortSignal): Promise<FileHandle> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('projectRoot 必须是绝对路径');
  const components = path.split('/').filter(Boolean);
  if (components.some(c => c === '.' || c === '..')) throw new Error('projectRoot 不允许点路径');
  checkText(path);
  let current = await openDirectory('/', signal);
  try {
    for (const component of components) {
      const next = await openDirectory(fdPath(current, component), signal);
      const previous = current;
      current = next;
      await previous.close();
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

async function readText(parent: FileHandle, name: string, signal: AbortSignal): Promise<{text: string; bytes: number}> {
  signal.throwIfAborted();
  const handle = await open(fdPath(parent, name), FILE_FLAGS);
  try {
    signal.throwIfAborted();
    const before = await handle.stat({bigint: true});
    if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES)) throw new Error(`${name} 非普通文件或超过 1 MiB`);
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(65536, MAX_FILE_BYTES + 1 - length));
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, null);
      signal.throwIfAborted();
      length += bytesRead;
      if (length > MAX_FILE_BYTES) throw new Error(`${name} 超过 1 MiB`);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, length);
    const after = await handle.stat({bigint: true});
    signal.throwIfAborted();
    if (bytes.length > MAX_FILE_BYTES || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(`${name} 读取期间发生变化`);
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
    checkText(text);
    return {text, bytes: bytes.length};
  } finally {
    await handle.close();
  }
}

async function list(parent: FileHandle, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const directory = await opendir(fdPath(parent), {bufferSize: 1});
  const names: string[] = [];
  // 异步迭代器在成功、异常及取消的退出路径关闭目录，避免超限时仍分配整个清单。
  for await (const entry of directory) {
    signal.throwIfAborted();
    if (names.length === MAX_RECORDS) throw new Error('memories 条目超过 1000');
    const name = entry.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,123}\.md$/u.test(name)) throw new Error(`memories 仅允许直接子级 Markdown 文件：${name}`);
    names.push(name);
  }
  return names.sort();
}

/** 内部只读快照入口，仅供专属子进程使用，禁止作为公共调用入口，父进程拥有总截止、取消和强制回收责任。 */
export async function readProjectMemory(projectRoot: string, {signal}: {signal: AbortSignal}): Promise<{projectId: string; records: readonly MemoryRecord[]}> {
  signal.throwIfAborted();
  if (process.platform !== 'linux') throw new Error('第一版只支持 Linux /proc/self/fd');
  const root = await openRoot(projectRoot, signal);
  try {
    const managed = await openDirectory(fdPath(root, '.project-memory'), signal);
    try {
      const configText = (await readText(managed, 'config.json', signal)).text;
      const config = object(JSON.parse(configText));
      const configDocument = parseDocument(configText, {uniqueKeys: true, schema: 'json', strict: true});
      if (configDocument.errors.length || configDocument.warnings.length) throw new Error('config.json 包含重复键或非法 JSON 字段');
      if (config.schema_version !== 1) throw new Error('不支持 config schema_version');
      if (Object.keys(config).some(key => !['schema_version', 'project_id'].includes(key))) throw new Error('未知 config 字段');
      const projectId = identifier(config, 'project_id');
      const directory = await openDirectory(fdPath(managed, 'memories'), signal);
      try {
        const before = await directory.stat({bigint: true});
        const names = await list(directory, signal);
        const records: MemoryRecord[] = [];
        const byId = new Map<string, MemoryRecord>();
        let total = 0;
        for (const name of names) {
          await setImmediate(undefined, {signal});
          const content = await readText(directory, name, signal);
          total += content.bytes;
          if (total > MAX_TOTAL_BYTES) throw new Error('记忆总量超过 16 MiB');
          let record: MemoryRecord;
          try {
            record = parseMemory(content.text);
          } catch (error) {
            throw new Error(`memories/${name}：${error instanceof Error ? error.message : String(error)}`, {cause: error});
          }
          if (byId.has(record.id)) throw new Error(`重复记忆 ID：${record.id}`);
          byId.set(record.id, record);
          records.push(record);
        }
        const afterNames = await list(directory, signal);
        const after = await directory.stat({bigint: true});
        signal.throwIfAborted();
        if (JSON.stringify(names) !== JSON.stringify(afterNames) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('memories 清单读取期间发生变化');
        records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        Object.freeze(records);
        return {projectId, records};
      } finally {
        await directory.close();
      }
    } finally {
      await managed.close();
    }
  } finally {
    await root.close();
  }
}
