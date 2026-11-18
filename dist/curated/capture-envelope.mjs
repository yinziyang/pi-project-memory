import { parseDocument } from 'yaml';

// 自动来源的字段白名单同时约束 SDK 副本和 archive IPC，不能把“已过滤”标志当作信任凭据。
export const CAPTURE_POLICY = 'visible-text-meta-v1';
const credential = /(?:\b(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]|\bbearer\s+\S+|\bsk-[\w-]{8,}|-----BEGIN [^-]*PRIVATE KEY-----|(?:^|[\s/\\])\.env(?:\b|\.)|(?:auth|models)\.json|\.private-real-distill|(?:^|[\s/\\])sessions?[\/\\])/i;

/** 只识别已知凭据、敏感路径与大写环境赋值模式，不承诺识别任意未知秘密。 */
export const hasKnownSecret = value => credential.test(value) || /\b[A-Z][A-Z0-9_]{2,}\s*=/.test(value);

/** 原样保留合法 opaque 标识，拒绝已知秘密、坏 Unicode、NUL、空值和超过 256 字节的值。 */
export const safeCaptureId = value => typeof value === 'string' && value.length > 0 && value.isWellFormed() && !value.includes('\0') && Buffer.byteLength(value) <= 256 && !hasKnownSecret(value);

const fields = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

/** 严格解析至多 1MiB 的过滤 JSON，任意层级的重复键及转义等价键均拒绝，不静默覆盖或重新编码原文。
 * JSON.parse 负责 JSON 语法，现有解析器只补重复键验证，返回对象用于绑定检查，调用方仍持久化已经验证的原始 bytes。
 * 所有解析及内容校验失败只抛固定安全错误，不携带原文、解析器诊断或秘密摘要。
 */
export function parseCaptureEnvelope(rawText) {
  try {
    if (typeof rawText !== 'string' || !rawText.isWellFormed() || Buffer.byteLength(rawText) > 1024 * 1024) throw new Error();
    const value = JSON.parse(rawText);
    const document = parseDocument(rawText, { uniqueKeys: true, schema: 'json', strict: true });
    if (document.errors.length || document.warnings.length) throw new Error();
    assertCaptureEnvelope(value);
    return value;
  } catch {
    throw new Error('CAPTURE_ENVELOPE');
  }
}

/** 校验已解析过滤 envelope 的结构，未知字段、正文秘密、工具正文、嵌套调用和不完整配对全部拒绝。
 * 本对象校验不能发现解析前丢失的重复键，原始 JSON 入口必须先使用 parseCaptureEnvelope，不能用对象校验替代无损验证。
 * 本校验只证明当前过滤策略与结构，不证明原始内容完整、事实正确、源 entry 真实或允许生成。
 */
export function assertCaptureEnvelope(value) {
  function invalid() { throw new Error('CAPTURE_ENVELOPE'); }
  if (!fields(value, ['version', 'policy', 'session', 'entryIds', 'structuralComplete', 'contentComplete', 'filtered', 'messages']) ||
      value.version !== 1 || value.policy !== CAPTURE_POLICY || !safeCaptureId(value.session) || value.structuralComplete !== true || value.contentComplete !== false || value.filtered !== true ||
      !Array.isArray(value.entryIds) || !value.entryIds.length || value.entryIds.length > 2048 || !value.entryIds.every(safeCaptureId) || new Set(value.entryIds).size !== value.entryIds.length ||
      !Array.isArray(value.messages) || value.messages.length !== value.entryIds.length) invalid();
  const used = new Set();
  const pending = new Set();
  for (const [index, message] of value.messages.entries()) {
    if (!fields(message, ['id', 'type', 'role', 'content'], ['stopReason', 'omitted', 'toolCallId', 'isError']) ||
        message.id !== value.entryIds[index] || message.type !== 'message' || !['user', 'assistant', 'toolResult'].includes(message.role) ||
        !Array.isArray(message.content) || message.content.length > 4096 || (Object.hasOwn(message, 'omitted') && message.omitted !== true)) invalid();
    if (index === 0 && message.role !== 'user') invalid();
    if (message.role === 'toolResult') {
      if (Object.hasOwn(message, 'stopReason') || message.content.length || message.omitted !== true || message.isError !== false || !safeCaptureId(message.toolCallId) || !pending.delete(message.toolCallId)) invalid();
    } else {
      if (Object.hasOwn(message, 'toolCallId') || Object.hasOwn(message, 'isError')) invalid();
      let calls = 0;
      for (const part of message.content) {
        if (part?.type === 'text') {
          if (!fields(part, ['type', 'text']) || typeof part.text !== 'string' || !part.text.isWellFormed() || hasKnownSecret(part.text)) invalid();
        } else if (part?.type === 'toolCall') {
          if (message.role !== 'assistant' || !fields(part, ['type', 'id', 'argumentsOmitted']) || !safeCaptureId(part.id) || part.argumentsOmitted !== true || message.omitted !== true || used.has(part.id)) invalid();
          calls++;
          used.add(part.id);
          pending.add(part.id);
        } else invalid();
      }
      if (message.role === 'assistant') {
        if (index === value.messages.length - 1 ? message.stopReason !== 'stop' || calls || pending.size : message.stopReason !== 'toolUse' || !calls) invalid();
      } else if (Object.hasOwn(message, 'stopReason')) invalid();
    }
  }
  if (value.messages.at(-1).role !== 'assistant' || pending.size) invalid();
}
