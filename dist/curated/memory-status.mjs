/** 本扩展独占的状态键，不得用于 footer 或其他扩展的状态槽。 */
export const MEMORY_STATUS_KEY = 'local-project-memory.status.v1';

const PRIVATE_KEYS = [
  'archivedSources', 'approvalRecords', 'attempts', 'unknownAttempts',
  'responses', 'candidateRecords', 'reviewedRevisions', 'activeReviewedEntries'
];
const UNKNOWN_CODES = ['PRIVATE_NOT_ATTACHED', 'PRIVATE_OFFLINE', 'PRIVATE_READ_FAILED', 'FACT_UNAVAILABLE', 'COUNT_INVALID'];

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}

function unknown(code = 'STATUS_INPUT_INVALID') {
  return { state: 'unknown', count: null, code };
}

function fact(value, unknownCodes) {
  if (!exact(value, ['state', 'count', 'code'])) return unknown();
  const { state, count, code } = value;
  if (state === 'known' && code === 'OK' && Number.isSafeInteger(count) && count >= 0) {
    return { state: 'known', count, code: 'OK' };
  }
  if (state === 'unknown' && count === null && unknownCodes.includes(code)) return unknown(code);
  return unknown();
}

function privateFacts(value) {
  const invalid = code => ({
    state: 'unknown', code,
    ...Object.fromEntries(PRIVATE_KEYS.map(key => [key, unknown(code)]))
  });
  if (value === null) return { ...invalid('PRIVATE_NOT_ATTACHED'), state: 'missing' };
  if (!exact(value, ['version', 'state', 'code', ...PRIVATE_KEYS])) return invalid('STATUS_INPUT_INVALID');
  const { version, state, code } = value;
  if (version !== 1) return invalid('STATUS_INPUT_INVALID');
  const codes = { available: 'OK', missing: 'PRIVATE_NOT_ATTACHED', offline: ['PRIVATE_OFFLINE', 'PRIVATE_READ_FAILED'] };
  const expected = Object.hasOwn(codes, state) ? codes[state] : undefined;
  if (!(Array.isArray(expected) ? expected.includes(code) : expected !== undefined && expected === code)) return invalid('STATUS_INPUT_INVALID');
  const result = { state, code };
  for (const key of PRIVATE_KEYS) {
    result[key] = fact(value[key], UNKNOWN_CODES);
    if (state !== 'available' && (result[key].state !== 'unknown' || result[key].code !== code)) return invalid('STATUS_INPUT_INVALID');
  }
  return result;
}

function indexFact(value) {
  if (!exact(value, ['state', 'count', 'code'])) return unknown();
  const { state, count, code } = value;
  if (['ready', 'stale'].includes(state) && code === 'OK' && Number.isSafeInteger(count) && count >= 0) {
    return { state, count, code: 'OK' };
  }
  if (['unknown', 'unavailable', 'disabled', 'building', 'missing'].includes(state) && count === null && code === 'FACT_UNAVAILABLE') {
    return { state, count: null, code: 'FACT_UNAVAILABLE' };
  }
  return unknown();
}

/**
 * 校验可信调用者提供的私有投影、当前发布和索引快照，仅复制固定字段，不推断公开层事实。
 * 未提供的层返回 unknown，0 只能来自已验证的非负安全整数，不从 healthy、分页长度或回执推导。
 * 快照必须由调用者验证当前发布及索引的身份、完整性与时效，形状校验不证明调用者可信。
 * 畸形对象或 getter 失败均折叠为固定安全码，不返回异常对象或任意输入字符串。
 */
export function projectMemoryStatus(input) {
  const result = {
    version: 1,
    private: privateFacts(undefined),
    publication: unknown('FACT_UNAVAILABLE'),
    index: unknown('FACT_UNAVAILABLE')
  };
  try {
    if (!exact(input, ['private', 'publication', 'index'])) return result;
    result.private = privateFacts(input.private);
    result.publication = input.publication == null ? unknown('FACT_UNAVAILABLE') : fact(input.publication, ['FACT_UNAVAILABLE']);
    result.index = input.index == null ? unknown('FACT_UNAVAILABLE') : indexFact(input.index);
    return result;
  } catch {
    return { ...result, private: privateFacts(undefined), publication: unknown(), index: unknown() };
  }
}

function format(snapshot) {
  const count = value => value.count === null ? `未知(${value.code})` : String(value.count);
  const p = snapshot.private;
  if (p.state === 'missing') {
    return `项目记忆：私有库未连接(${p.code})；当前发布=${count(snapshot.publication)}；索引=${snapshot.index.state}/${count(snapshot.index)}。`;
  }
  return `项目记忆：私有库=${p.state}(${p.code})；归档来源=${count(p.archivedSources)}；历史批准=${count(p.approvalRecords)}；尝试=${count(p.attempts)}；结果未知尝试=${count(p.unknownAttempts)}；完整响应=${count(p.responses)}；候选记录=${count(p.candidateRecords)}；审核版本=${count(p.reviewedRevisions)}；活跃审核条目=${count(p.activeReviewedEntries)}；当前发布=${count(snapshot.publication)}；索引=${snapshot.index.state}/${count(snapshot.index)}。连接可用不等于已保存，批准历史不等于当前授权，候选不等于已审核。`;
}

/**
 * 创建无后台任务的状态呈现器，readStatus 只返回固定快照，可返回 Promise，不得返回正文或启动 owner。
 * refresh 返回固定快照、安全文本和 code，供无 UI 命令直接使用，不自行打印、通知或注册命令。
 * 调用方负责 readStatus 的有界等待与取消，refresh 的可选 signal 原样传递，等待中的工作仍归调用方所有。
 * 仅在 hasUI 为 true 时写自己的状态键，clear 仅清除此键且幂等，不关闭借用 UI 或修改工具。
 * 并发刷新和清理以最后发起的操作为准，旧读取结束后不得恢复已清除的状态。
 */
export function createMemoryStatus({ readStatus } = {}) {
  let generation = 0;
  return Object.freeze({
    async refresh(ctx, { signal } = {}) {
      const ticket = ++generation;
      let snapshot;
      let code = 'OK';
      try {
        snapshot = projectMemoryStatus(await readStatus({ signal }));
      } catch {
        snapshot = projectMemoryStatus(null);
        code = 'STATUS_READ_FAILED';
      }
      const text = format(snapshot);
      try {
        if (ticket === generation && ctx?.hasUI === true) ctx.ui.setStatus(MEMORY_STATUS_KEY, text);
      } catch {
        code = 'STATUS_UI_FAILED';
      }
      return { snapshot, text, code };
    },
    clear(ctx) {
      ++generation;
      try {
        if (ctx?.hasUI === true) ctx.ui.setStatus(MEMORY_STATUS_KEY, undefined);
        return { code: 'OK' };
      } catch {
        return { code: 'STATUS_UI_FAILED' };
      }
    }
  });
}
