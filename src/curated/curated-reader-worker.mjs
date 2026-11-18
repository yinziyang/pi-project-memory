import { createCuratedPublicReader } from './curated-public-reader.mjs';

// 此入口仅供可信 Node 宿主启动，不加载模型、扩展或任何私有数据库，不派生进程，dense 只借用当前请求携带的稳定引用。
const incarnation = Number(process.argv[2]);
const allowDense = process.argv[3] === 'dense-v1';
let denseContext;
let installedGeneration;
const dense = {
  get available() { return Boolean(denseContext); },
  get generation() { return denseContext?.generation; },
  async search() {
    if (!denseContext) throw new Error('DENSE_PROTOCOL_ERROR');
    return denseContext.candidates;
  },
};
let reader;
let busy = false;
let stopping = false;
let stopTask;
let bytes = [];
let lastRequestId = 0;
const codes = new Set(['INVALID_QUERY', 'INVALID_TOP_K', 'PUBLIC_UNAVAILABLE', 'PUBLIC_INSTALL_REJECTED', 'TRANSITION_REQUIRED', 'DENSE_DISABLED', 'DENSE_PROTOCOL_ERROR', 'DENSE_CONTENT_MISMATCH', 'DENSE_SEARCH_FAILED']);

function send(frame) {
  const text = JSON.stringify({ version: 1, incarnation, ...frame }) + '\n';
  if (Buffer.byteLength(text) > 131072) throw new Error('OUTPUT_FRAME_LIMIT');
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => error ? reject(error) : resolve());
  });
}

// 信号先停接收再关闭 SQLite，外层桥负责不可抢占同步调用及输出阻塞时的升级终止。
// shutdown 只传固定码，不传可能含私有路径的 Error 属性，原始异常仅由此独占进程持有至诊断发送结束。
// 此帧不是 OS 回收确认，宿主仍须等待 close 并独立记录退出码和信号。
function stop() {
  if (stopTask) return stopTask;
  stopping = true;
  process.stdin.destroy();
  stopTask = (async () => {
    let closeFailure;
    try { await reader?.close(); } catch (error) {
      closeFailure = { originalError: error };
      process.exitCode = 1;
    }
    try {
      await send({ kind: 'shutdown', id: 0, code: closeFailure ? 'PUBLIC_READER_CLOSE_FAILED' : 'PUBLIC_READER_CLOSED' });
    } catch {
      // 管道已坏时不能再传诊断，非零退出及宿主的管道首错仍分别保留。
      process.exitCode = 1;
    }
  })();
  return stopTask;
}
process.on('SIGTERM', () => { void stop(); });
process.stdin.on('error', () => {
  process.exitCode = 1;
  void stop();
});
process.stdout.on('error', () => {
  process.exitCode = 1;
  void stop();
});
process.stdin.on('end', () => {
  if (bytes.length) process.exitCode = 1;
  void stop();
});

async function handle(raw) {
  if (busy || stopping) throw new Error('PROTOCOL_ERROR');
  busy = true;
  try {
    const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(raw)));
    if (frame?.version !== 1 || frame.kind !== 'request' || frame.incarnation !== incarnation || !Number.isSafeInteger(frame.id) || frame.id <= lastRequestId || !frame.args || typeof frame.args !== 'object' || Array.isArray(frame.args)) throw new Error('PROTOCOL_ERROR');
    lastRequestId = frame.id;
    if (raw.length + 1 > 8192 && (!allowDense || frame.op !== 'searchIndexed')) throw new Error('PROTOCOL_ERROR');
    let value;
    try {
      if (frame.op === 'install') {
        if (reader || typeof frame.args.project !== 'string' || !frame.args.project.isWellFormed() ||
            typeof frame.args.publicPath !== 'string' || !frame.args.publicPath.isWellFormed() || frame.args.publicPath.includes('\0') ||
            typeof frame.args.generation !== 'string' || !frame.args.generation.isWellFormed()) throw new Error('PUBLIC_INSTALL_REJECTED');
        reader = createCuratedPublicReader({ project: frame.args.project, dense: allowDense ? dense : undefined });
        await reader.install(frame.args);
        installedGeneration = frame.args.generation;
        value = null;
      } else if (reader && frame.op === 'searchIndexed') {
        if (!allowDense) throw new Error('DENSE_DISABLED');
        const args = frame.args;
        if (Object.keys(args).some(key => !['query', 'topK', 'generation', 'candidates'].includes(key)) || !Array.isArray(args.candidates) || !Number.isInteger(args.topK) || args.topK < 1 || args.topK > 10 || args.candidates.length > args.topK) throw new Error('DENSE_PROTOCOL_ERROR');
        if (args.generation !== installedGeneration) throw new Error('DENSE_CONTENT_MISMATCH');
        const seen = new Set();
        for (const ref of args.candidates) {
          if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(key => !['version', 'project', 'generation', 'knowledgeId', 'revision', 'fragmentKey', 'score'].includes(key)) || (ref.fragmentKey !== undefined && ref.fragmentKey !== 'body') || (ref.score !== undefined && !Number.isFinite(ref.score))) throw new Error('DENSE_PROTOCOL_ERROR');
          const key = JSON.stringify([ref.project, ref.generation, ref.knowledgeId, ref.revision]);
          if (seen.has(key)) throw new Error('DENSE_PROTOCOL_ERROR');
          seen.add(key);
        }
        // adapter 只活在这一次串行请求内，引用中的身份还必须由当前 SQLite 再次完整校验并水合。
        denseContext = { generation: args.generation, candidates: args.candidates };
        value = await reader.search({ query: args.query, topK: args.topK });
      } else if (reader && (frame.op === 'search' || frame.op === 'read' || frame.op === 'status')) {
        if (frame.op === 'search' && Object.keys(frame.args).some(key => !['query', 'topK'].includes(key))) throw new Error('INVALID_QUERY');
        value = await reader[frame.op](frame.args);
      } else throw new Error('PROTOCOL_ERROR');
    } catch (error) {
      const code = error.message === 'STALE_REFERENCE: 请重新搜索' ? 'STALE_REFERENCE' : codes.has(error.message) ? error.message : 'PUBLIC_OPERATION_FAILED';
      await send({ kind: 'result', id: frame.id, ok: false, code });
      return;
    }
    await send({ kind: 'result', id: frame.id, ok: true, value });
  } finally { denseContext = undefined; busy = false; }
}
process.stdin.on('data', (chunk) => {
  try {
    for (const byte of chunk) {
      if (bytes.length >= (allowDense ? 32768 : 8192)) throw new Error('INPUT_FRAME_LIMIT');
      if (byte !== 10) {
        bytes.push(byte);
        continue;
      }
      const frame = bytes;
      bytes = [];
      void handle(frame).catch(() => {
        process.exitCode = 1;
        void stop();
      });
    }
  } catch {
    process.exitCode = 1;
    void stop();
  }
});
await send({ kind: 'ready', id: 0 });
