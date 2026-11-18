import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import net from 'node:net';
import { modelFingerprint, MODEL_PROFILE } from './identity.mjs';
import { localRuntimeModuleURL } from './runtime-path.mjs';
import { readIndexJson } from './bounded-json.mjs';

// 此入口只能由 Node owner 启动，加载和同步 ORT 的取消由父进程终止、等待回收，不伪称同步计算可抢占。
let tokenizer;
let model;
let fingerprint;
let initSeen = false;
let stopping = false;
const controller = new AbortController();
const interrupt = () => { stopping = true; controller.abort(new Error('INDEX_CANCELLED')); process.stdin.destroy(); };
process.on('SIGTERM', interrupt);
process.on('SIGINT', interrupt);
globalThis.fetch = async () => { throw new Error('INDEX_NETWORK_DISABLED'); };
net.Socket.prototype.connect = function () { throw new Error('INDEX_NETWORK_DISABLED'); };

async function initialize(message) {
  if (initSeen) throw new Error('INDEX_PROTOCOL_INVALID');
  initSeen = true;
  let manifest;
  try { manifest = (await readIndexJson(message.manifestPath, { signal: controller.signal })).value; }
  catch (error) {
    controller.signal.throwIfAborted();
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') throw new Error('INDEX_MODEL_MISSING', { cause: error });
    throw new Error('INDEX_MODEL_PROFILE_MISMATCH', { cause: error });
  }
  fingerprint = modelFingerprint(manifest);
  if (fingerprint !== message.fingerprint) throw new Error('INDEX_MODEL_PROFILE_MISMATCH');
  const root = await realpath(message.modelRoot);
  for (const file of manifest.files) {
    const path = join(root, manifest.repo, file.path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || await realpath(path) !== resolve(path) || !path.startsWith(root + sep)) throw new Error('INDEX_MODEL_MISSING');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    if (hash.digest('hex') !== file.sha256) throw new Error('INDEX_MODEL_PROFILE_MISMATCH');
  }
  const { env, AutoTokenizer, AutoModel } = await import(localRuntimeModuleURL(message.transformersEntry));
  env.allowRemoteModels = false;
  env.useFSCache = false;
  env.localModelPath = root + sep;
  tokenizer = await AutoTokenizer.from_pretrained(MODEL_PROFILE.repo, { local_files_only: true });
  model = await AutoModel.from_pretrained(MODEL_PROFILE.repo, {
    dtype: 'fp32', device: 'cpu', local_files_only: true,
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  });
  return { fingerprint };
}

async function embed({ texts, kind }) {
  if (!model || !Array.isArray(texts) || texts.length > 4 || !['query', 'passage'].includes(kind) || texts.some((value) => typeof value !== 'string' || !value.isWellFormed() || value.length > 32768)) throw new Error('INDEX_PROTOCOL_INVALID');
  if (!texts.length) return [];
  const prefix = kind === 'query' ? MODEL_PROFILE.queryPrefix : MODEL_PROFILE.passagePrefix;
  const inputs = tokenizer(texts.map((text) => prefix + text), { padding: true, truncation: true, max_length: 512 });
  const [rows, width] = inputs.input_ids.dims;
  const ids = inputs.input_ids.data;
  const mask = inputs.attention_mask.data;
  // tokenizer 的截断可能丢失末尾 SEP，固定模型 profile 要求恢复真实 token 的末尾分隔符。
  if (width === 512) for (let row = 0; row < rows; row++) {
    const last = row * width + width - 1;
    if (mask[last] === 1n) ids[last] = BigInt(tokenizer.sep_token_id);
  }
  const { last_hidden_state: hidden } = await model(inputs);
  if (rows !== texts.length || hidden.dims.length !== 3 || hidden.dims[0] !== rows || hidden.dims[1] !== width || hidden.dims[2] !== 384 || hidden.data.length !== rows * width * 384) throw new Error('INDEX_VECTOR_INVALID');
  const result = [];
  for (let row = 0; row < rows; row++) {
    const vector = new Float32Array(384);
    let count = 0;
    for (let token = 0; token < width; token++) if (mask[row * width + token] === 1n) {
      count++;
      for (let dim = 0; dim < 384; dim++) vector[dim] += hidden.data[(row * width + token) * 384 + dim];
    }
    for (let dim = 0; dim < 384; dim++) vector[dim] /= count;
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm === 0) throw new Error('INDEX_VECTOR_INVALID');
    result.push(Array.from(vector, (value) => value / norm));
  }
  return result;
}

try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const message = JSON.parse(line);
    const result = message.op === 'resolve' && !initSeen ? { path: fileURLToPath(import.meta.resolve('@huggingface/transformers')) } : message.op === 'init' ? await initialize(message) : message.op === 'embed' ? await embed(message) : (() => { throw new Error('INDEX_PROTOCOL_INVALID'); })();
    if (stopping) break;
    await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`, (error) => error ? reject(error) : resolve()));
  }
} catch (error) {
  process.exitCode = 1;
  const allowed = ['INDEX_MODEL_MISSING', 'INDEX_MODEL_PROFILE_MISMATCH'];
  const code = allowed.includes(error.message) ? error.message : error.code === 'ENOENT' ? 'INDEX_MODEL_MISSING' : error.code === 'ERR_MODULE_NOT_FOUND' ? 'DEPENDENCY_MISSING' : 'INDEX_INVALID';
  try {
    await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`, (failure) => failure ? reject(failure) : resolve()));
  } catch {
    // 输出路径已坏时只能由父进程观察 EOF/退出码，不能再依赖同一管道报告错误。
  }
} finally {
  if (model) await model.dispose();
}
