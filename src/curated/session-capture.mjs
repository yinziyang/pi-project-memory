import { createHash } from 'node:crypto';

import { CAPTURE_POLICY, hasKnownSecret as hasSecret, safeCaptureId as opaque } from './capture-envelope.mjs';
export { CAPTURE_POLICY } from './capture-envelope.mjs';
const MAX_ENTRIES = 2048;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROUND = 1024 * 1024;
const MAX_MS = 25;
const hash = value => createHash('sha256').update(value).digest('hex');

/** 同步从公开 getEntry 复制当前祖先路径，最多 2048 项、4MiB 文本和 25ms，不读取任何 session 文件。
 * 返回值仅含自有已过滤对象，不保存 SDK 对象引用，不调用模型或异步 I/O。
 * 文本中的已知凭据模式拒绝整轮，工具参数与结果正文一律省略，不能保证识别未知秘密。
 * context_edit 涉及的轮保守拒绝，摘要不作为原对话，超预算标记 gap 后只处理有已结束轮边界的最近后缀。
 * 后缀首个终止助手之前全部舍弃，因此古老已提交历史不会永久阻断新短轮，也不伪称已补齐全部历史。
 */
export function captureSessionPath(manager) {
  const started = performance.now();
  const session = manager.getSessionId();
  const leaf = manager.getLeafId();
  if (!opaque(session) || (leaf !== null && !opaque(leaf))) {
    return { session: null, leaf: null, rounds: [], receipts: [{ state: 'rejected', reason: 'UNSAFE_ID' }] };
  }
  let partial = false;
  let size = 0;
  let next = leaf;
  const entries = [];
  const seen = new Set();
  const edits = new Set();
  function charge(value) {
    if (typeof value !== 'string' || !value.isWellFormed()) throw new Error('CAPTURE_TEXT');
    size += Buffer.byteLength(value);
    if (size > MAX_BYTES || performance.now() - started > MAX_MS) throw new Error('CAPTURE_BUDGET');
    return value;
  }
  try {
    while (next !== null) {
      if (seen.has(next)) throw new Error('CAPTURE_PATH');
      if (entries.length >= MAX_ENTRIES || performance.now() - started > MAX_MS) throw new Error('CAPTURE_BUDGET');
      seen.add(next);
      const source = manager.getEntry(next);
      if (!source || source.id !== next || !opaque(next) || (source.parentId !== null && !opaque(source.parentId))) throw new Error('CAPTURE_PATH');
      const entry = { id: next, type: source.type };
      if (source.type === 'context_edit') {
        if (!opaque(source.targetId)) throw new Error('CAPTURE_PATH');
        edits.add(source.targetId);
      }
      if (source.type === 'message') {
        const message = source.message;
        entry.role = message?.role;
        entry.content = [];
        entry.stopReason = message?.stopReason;
        if (entry.role === 'toolResult') {
          entry.toolCallId = charge(message.toolCallId);
          if (!opaque(entry.toolCallId)) entry.rejected = true;
          entry.isError = message.isError === true;
          entry.omitted = true;
        } else if (entry.role === 'user' || entry.role === 'assistant') {
          const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
          if (!Array.isArray(content) || content.length > 4096) throw new Error('CAPTURE_TEXT');
          for (const part of content) {
            if (part?.type === 'text') {
              const text = charge(part.text);
              if (hasSecret(text)) entry.rejected = true;
              else entry.content.push({ type: 'text', text });
            } else if (entry.role === 'assistant' && part?.type === 'toolCall') {
              const id = charge(part.id);
              if (!opaque(id)) entry.rejected = true;
              // 工具名只保留固定安全标记，任意名字、参数、details 和嵌套调用都不复制。
              entry.content.push({ type: 'toolCall', id, argumentsOmitted: true });
              entry.omitted = true;
            } else entry.omitted = true;
          }
        }
      }
      entries.push(entry);
      next = source.parentId;
    }
    if (session !== manager.getSessionId() || leaf !== manager.getLeafId()) throw new Error('CAPTURE_CHANGED');
  } catch (error) {
    if (error.message === 'CAPTURE_BUDGET' && entries.length) partial = true;
    else return { session, leaf, rounds: [], receipts: [{ state: 'gap', reason: 'PATH_BUDGET_OR_INVALID' }] };
  }
  const rounds = [];
  const receipts = partial ? [{ state: 'gap', reason: 'HISTORY_SUFFIX_ONLY' }] : [];
  let selected = entries.reverse();
  if (partial) {
    const boundary = selected.findIndex(entry => entry.type === 'message' && entry.role === 'assistant' && ['stop', 'length', 'error', 'aborted'].includes(entry.stopReason));
    selected = boundary === -1 ? [] : selected.slice(boundary + 1);
  }
  let round = [];
  let reason;
  let pending = new Set();
  let used = new Set();
  function finish(completed) {
    if (!round.length) return;
    if (!completed) reason ??= 'INCOMPLETE_ROUND';
    const ids = round.map(entry => entry.id);
    if (ids.some(id => edits.has(id))) reason = 'CONTEXT_EDIT';
    const envelope = { version: 1, policy: CAPTURE_POLICY, session, entryIds: ids, structuralComplete: completed && !reason,
      contentComplete: false, filtered: true, messages: round };
    const raw = JSON.stringify(envelope);
    if (Buffer.byteLength(raw) > MAX_ROUND) reason = 'ROUND_BYTES';
    if (reason) receipts.push({ state: 'rejected', reason, entryIds: ids });
    else rounds.push({ sourceSessionId: session, sourceEntryId: `auto:v1:${hash(JSON.stringify(ids))}`, raw,
      digest: hash(raw), entryIds: ids });
    round = [];
    reason = undefined;
    pending = new Set();
    used = new Set();
  }
  for (const entry of selected) {
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      finish(false);
      continue;
    }
    if (entry.type !== 'message' || !['user', 'assistant', 'toolResult'].includes(entry.role)) continue;
    if (!round.length && entry.role !== 'user') {
      receipts.push({ state: 'rejected', reason: 'ORPHAN_MESSAGE', entryIds: [entry.id] });
      continue;
    }
    round.push(entry);
    if (entry.rejected) reason = 'KNOWN_SECRET';
    if (entry.role === 'toolResult') {
      if (!pending.delete(entry.toolCallId)) reason = 'TOOL_PAIR';
      if (entry.isError) reason = 'TOOL_ERROR';
    } else if (entry.role === 'assistant') {
      const calls = entry.content.filter(part => part.type === 'toolCall');
      for (const call of calls) {
        if (used.has(call.id)) reason = 'TOOL_PAIR';
        used.add(call.id);
        pending.add(call.id);
      }
      if (entry.stopReason === 'stop') {
        if (pending.size || calls.length) reason = 'TOOL_PAIR';
        finish(true);
      } else if (entry.stopReason !== 'toolUse' || !calls.length) {
        reason = 'NON_FINAL_STOP';
        finish(false);
      }
    }
  }
  // 尚在生成的尾轮不归档，之后 settled 或重载仍可再次观察它，不把 observed 当 committed。
  if (round.length) finish(false);
  return Object.freeze({ session, leaf,
    rounds: Object.freeze(rounds.map(round => Object.freeze({ ...round, entryIds: Object.freeze(round.entryIds) }))),
    receipts: Object.freeze(receipts.map(receipt => Object.freeze({ ...receipt, ...(receipt.entryIds ? { entryIds: Object.freeze(receipt.entryIds) } : {}) }))) });
}
