const maxDigestsPerScope = 64;
const maxScopes = 64;
const notice = '本轮收到可信验证凭据。如结论可复用，可运行 /memory-draft。提醒不代表事实已审核。';

function isIdentifier(value) {
  return typeof value === 'string' && value.trim() !== '' &&
      value.isWellFormed() && !value.includes('\0');
}

function isTrustedContext(context) {
  return context?.trusted === true && isIdentifier(context.cwd) &&
      isIdentifier(context.sessionId);
}

/**
 * 创建仅在内存中保存状态的提炼提醒，不需要用户启用。
 * 主入口按轮调用 begin 和 settle，并仅将可信扩展总线的凭据交给 record，不得从工具输出或对话构造凭据。
 * 凭据必须带有匹配的 cwd、sessionId 和 64 位小写十六进制 digest。
 * 每轮仅在 settle 收到同一可信上下文且 aborted 严格为 false 时返回固定提示，否则返回 undefined。
 * 每个会话与项目组合最多记住 64 个已提醒摘要，实例最多缓存 64 个组合。
 * 达到上限时不淘汰旧记录，以免同一凭据重新触发提醒。
 * 主入口切换上下文或关闭时应调用 reset，同时丢弃待结算凭据和去重记录。
 */
export function createDraftReminder() {
  let run;
  const seenByScope = new Map();
  return {
    reset() {
      run = undefined;
      seenByScope.clear();
    },
    begin(context) {
      run = undefined;
      if (!isTrustedContext(context)) return;
      const { cwd, sessionId } = context;
      const scope = JSON.stringify([sessionId, cwd]);
      const seen = seenByScope.get(scope);
      if (seen ? seen.size >= maxDigestsPerScope : seenByScope.size >= maxScopes) return;
      run = { cwd, sessionId, scope, seen };
    },
    record(receipt) {
      if (!run || run.digest || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return;
      if (!Object.hasOwn(receipt, 'cwd') || !Object.hasOwn(receipt, 'sessionId') ||
          !Object.hasOwn(receipt, 'digest') || receipt.cwd !== run.cwd || receipt.sessionId !== run.sessionId) return;
      const { digest } = receipt;
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || run.seen?.has(digest)) return;
      run.digest = digest;
    },
    settle(context) {
      const previous = run;
      run = undefined;
      if (!previous?.digest || !isTrustedContext(context) || context.aborted !== false ||
          previous.cwd !== context.cwd || previous.sessionId !== context.sessionId) return;
      const seen = previous.seen ?? new Set();
      seen.add(previous.digest);
      seenByScope.set(previous.scope, seen);
      return notice;
    },
  };
}
