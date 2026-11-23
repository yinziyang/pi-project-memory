import { parseDocument } from 'yaml';
import { CATEGORIES } from './knowledge-categories.mjs';
import { createDraftReminder } from './draft-reminder.mjs';
import { startProjectDraft } from './manual-draft-owner.mjs';

const draftPrompt = [
  '开始提炼项目记忆。只在本轮回复中展示草稿，不修改文件、不写库、不发布、不调用其他模型或子代理。',
  '只考虑当前项目已经实施且能用独立证据核对的事实，或有明确记录的决定。不得把计划、模型自评、未跑过的检查或无法核验的结论写成事实。',
  '先判断知识值不值得保留：它必须说明下次遇到什么场景、能帮助做什么判断或避免什么错误。不能回答就不生成条目，即使事实已经验证。',
  '不要复述现有 README、命令说明、一次性修复过程或测试流水账。若其中有可迁移的经验，提炼原因、取舍、适用边界和验证方法，不重复过程。',
  '没有可复用且证据充分的内容时，直接说明“本次没有值得提炼的内容”及简短原因。',
  '如果当前项目能查到已发布知识，先查同主题条目。同主题更新沿用已有知识 ID，只有已证实不再适用才建议撤下。',
  '每条展示标题、建议操作、旧结论与变更（如适用）、分类、结论、适用范围、独立证据、必要公开安全代码和拟保存路径 .project-memory/md/<分类>/<knowledgeId>.md。不复制聊天原文、凭据或私有路径。',
  '正文、事实、来源、证据和代码示例均不得包含源码或测试文件名、路径、行号；不要改用带这些定位信息的链接。保存路径仅供确认目标，不写入知识正文。',
  '用验证场景、操作、预期和实际结果说明证据。必要时使用不依赖文件位置的独立短代码示例。',
  '如有能提交的新增或更新，在最终回复附上唯一的 ```memory-draft 代码块，内容为纯 JSON 数组（最多五条，16 KiB）。不要在此块中放失效建议或不能核验的条目。',
  '每条 JSON 须有 knowledgeId、expectedRevision、category、scope、source、title、narrative、facts、evidence。新增修订填 0，更新用可核验的旧修订号，未知就不要放入块。代码可写入 narrative。evidence 为数组，每项包含 implementation、object、method、coverage、source、publicSummary 与 result:{observed,expected,comparison}。',
  '分类仅选项目概况、领域规则、代码导航、开发操作、设计决策、排障经验、项目约定。最后明确说明草稿未写入，由 Pi 展示并由用户确认。',
].join('\n');

const maxBytes = 16384;
const safeText = value => typeof value === 'string' && value.isWellFormed() && value.trim() && !/[\p{Cf}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;
function validDraft(draft) {
  return exact(draft, 'category,evidence,expectedRevision,facts,knowledgeId,narrative,scope,source,title') &&
    typeof draft.knowledgeId === 'string' && /^k-[a-z0-9][a-z0-9-]{0,79}$/.test(draft.knowledgeId) &&
    Number.isSafeInteger(draft.expectedRevision) && draft.expectedRevision >= 0 && draft.expectedRevision < Number.MAX_SAFE_INTEGER &&
    CATEGORIES.includes(draft.category) && [draft.scope, draft.source, draft.title, draft.narrative].every(safeText) &&
    Array.isArray(draft.facts) && draft.facts.every(safeText) && Array.isArray(draft.evidence) && draft.evidence.length > 0 &&
    draft.evidence.every(item => exact(item, 'coverage,implementation,method,object,publicSummary,result,source') &&
      [item.coverage, item.implementation, item.method, item.object, item.publicSummary, item.source].every(safeText) &&
      exact(item.result, 'comparison,expected,observed') && Object.values(item.result).every(safeText));
}
function draftsFrom(text) {
  if (!text || !text.includes('```memory-draft')) return [];
  const blocks = [...text.matchAll(/^```memory-draft[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (blocks.length !== 1 || Buffer.byteLength(blocks[0][1]) > maxBytes) throw new Error('MANUAL_DRAFT_INPUT');
  const raw = blocks[0][1];
  const drafts = JSON.parse(raw);
  const parsed = parseDocument(raw, { uniqueKeys: true, schema: 'json', strict: true });
  if (parsed.errors.length || parsed.warnings.length || !Array.isArray(drafts) || drafts.length > 5 || !drafts.every(validDraft) ||
      new Set(drafts.map(draft => draft.knowledgeId)).size !== drafts.length) throw new Error('MANUAL_DRAFT_INPUT');
  // 拦截常见写法而非猜测任意自然语言中的定位信息，剩余内容由人工核对。
  const sourceLocation = /(?<![\w.-])[\w.-]+\.(?:[cm]?[jt]sx?|pyi?|go|rs|java|kt|kts|cs|cpp|cc|cxx|hpp|h|c|rb|php|swift|scala|sh|sql|vue|svelte)(?![\w.-])|#L\d+\b|第\s*\d+\s*行|\b(?:line|lines)\s+\d+\b/i;
  if (sourceLocation.test(raw) || sourceLocation.test(JSON.stringify(drafts))) throw new Error('MEMORY_DRAFT_SOURCE_LOCATION');
  return drafts;
}

function renderDraft(draft, target) {
  const operation = draft.expectedRevision === 0 ? '新增' : `更新（当前修订 ${draft.expectedRevision}）`;
  return [
    `## ${draft.title}`, '', `操作：${operation}`, `分类：${draft.category}`, `适用范围：${draft.scope}`,
    `来源：${draft.source}`, `保存路径：${target}`, '', draft.narrative,
    ...(draft.facts.length ? ['', '### 要点', ...draft.facts.map(fact => `- ${fact}`)] : []),
    '', '### 验证证据', ...draft.evidence.flatMap(item => [
      '', `- ${item.publicSummary}`, `  验证：${item.implementation}`, `  对象：${item.object}`, `  方法：${item.method}`,
      `  范围：${item.coverage}`, `  来源：${item.source}`, `  预期：${item.result.expected}`,
      `  实际结果：${item.result.observed}`, `  比较：${item.result.comparison}`,
    ]),
  ].join('\n');
}

function messageText(message) {
  const parts = typeof message.content === 'string' ? [message.content] : message.content?.filter(part => part.type === 'text').map(part => part.text);
  let size = 0;
  if (!Array.isArray(parts) || parts.length > 32) return undefined;
  for (const part of parts) {
    if (typeof part !== 'string' || (size += Buffer.byteLength(part)) > 65536 || !part.isWellFormed()) return undefined;
  }
  return parts.join('');
}

// 只读取本次起草后的有界祖先链；未找到原输入、被新用户消息打断或发生压缩时，不展示写入确认。
function settledDraft(ctx, request) {
  const manager = ctx.sessionManager;
  let cursor = manager.getLeafId();
  let final;
  for (let i = 0; i < 64 && cursor && cursor !== request.anchor; i++) {
    const entry = manager.getEntry(cursor);
    if (!entry || entry.id !== cursor || entry.type === 'compaction') return undefined;
    if (entry.type === 'message') {
      const message = entry.message;
      if (!final) {
        if (message.role !== 'assistant' || message.stopReason !== 'stop') return undefined;
        final = message;
      }
      if (message.role === 'user') {
        if (messageText(message) !== draftPrompt) return undefined;
        // Pi 可在用户消息之前追加系统上下文记录，但不能跨过另一条会话消息或压缩边界。
        let parent = entry.parentId;
        for (let j = 0; j < 64 && parent !== request.anchor; j++) {
          const bridge = parent && manager.getEntry(parent);
          if (!bridge || bridge.id !== parent || (bridge.type === 'message' && bridge.message.role !== 'system') ||
              bridge.type === 'compaction' || bridge.type === 'branch_summary') return undefined;
          parent = bridge.parentId;
        }
        return parent === request.anchor ? messageText(final) : undefined;
      }
    }
    cursor = entry.parentId;
  }
}

/** 只响应人工起草请求，在原会话当前分支预览，确认后由项目写宿主整批保存。 */
export function installDraftCommand(pi, { readBinding, pause, refresh, start = startProjectDraft } = {}) {
  const reminder = createDraftReminder();
  let pending;
  let reviewing = false;
  let job;
  let closed = false;
  let epoch = 0;
  const reminderContext = ctx => ({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), trusted: ctx.isProjectTrusted() });
  const reset = () => { pending = undefined; epoch++; reminder.reset(); };
  const current = (ctx, request) => !closed && request.epoch === epoch && ctx.isProjectTrusted() && ctx.isIdle() &&
    ctx.cwd === request.cwd && ctx.sessionManager.getSessionId() === request.sessionId;

  async function arm(ctx) {
    if (closed || pending || reviewing || job || !ctx.isProjectTrusted() || !ctx.isIdle()) throw new Error('MEMORY_DRAFT_UNAVAILABLE');
    const request = { ...reminderContext(ctx), epoch, anchor: ctx.sessionManager.getLeafId() ?? null };
    pending = request;
    // 只使用可信宿主读取的项目和发布代，不能从模型输出推导写入目标。
    try { request.binding = ctx.hasUI ? await readBinding(ctx) : null; }
    catch { request.binding = null; }
    if (pending !== request || !current(ctx, request) || (ctx.sessionManager.getLeafId() ?? null) !== request.anchor) {
      if (pending === request) pending = undefined;
      throw new Error('MEMORY_DRAFT_STALE');
    }
  }

  async function review(ctx, request, text) {
    const drafts = draftsFrom(text);
    if (!drafts.length) return;
    if (!request.binding) {
      ctx.ui.notify('草稿未写入：无法确认当前项目或发布版本。', 'warning');
      return;
    }
    const leaf = ctx.sessionManager.getLeafId();
    const stillCurrent = () => current(ctx, request) && ctx.sessionManager.getLeafId() === leaf;
    let selected = drafts;
    if (drafts.length > 1) {
      const labels = drafts.map(draft => `${draft.knowledgeId}：${JSON.stringify(draft.title)}`);
      const choice = await ctx.ui.select('选择要保留的草稿', ['全部', ...labels]);
      if (!stillCurrent()) return;
      if (choice !== '全部') selected = labels.includes(choice) ? [drafts[labels.indexOf(choice)]] : [];
      if (!selected.length) return;
    }
    const project = JSON.stringify(request.binding.project);
    const targets = selected.map(draft => `.project-memory/md/${draft.category}/${draft.knowledgeId}.md`);
    const preview = `目标项目：${project}\n\n${selected.map((draft, index) => renderDraft(draft, targets[index])).join('\n\n---\n\n')}`;
    // Pi 编辑器可完整滚动预览，任何编辑或取消都不能继续确认，也不作为普通会话输入。
    const seen = await ctx.ui.editor('核对定稿（只预览，Esc 取消）', preview);
    if (seen !== preview || !stillCurrent()) return;
    if (await ctx.ui.confirm('确认保存到当前项目？', `共 ${selected.length} 条；将更新 .project-memory 下的公开 SQLite 和 Markdown，不会提交 Git。`) !== true || !stillCurrent()) return;
    let paused = false;
    let result;
    try {
      const binding = await readBinding(ctx);
      if (!stillCurrent() || JSON.stringify(binding) !== JSON.stringify(request.binding)) throw new Error('MEMORY_DRAFT_STALE');
      // 本窗口必须先实际释放读锁，其他窗口由写宿主的独占锁检查。
      await pause(ctx);
      paused = true;
      if (!stillCurrent()) throw new Error('MEMORY_DRAFT_STALE');
      job = start(binding, selected);
      try { result = await job.result; }
      catch { result = { code: 'MEMORY_DRAFT_COMMIT_UNCONFIRMED' }; }
      if (result.code !== 'MEMORY_DRAFT_COMMIT_UNCONFIRMED') job = undefined;
    } catch (error) {
      const code = ['MEMORY_DRAFT_STALE', 'MEMORY_DRAFT_BUSY'].includes(error?.message) ? error.message : 'MEMORY_DRAFT_FAILED';
      result = { code };
    }
    if (!stillCurrent()) return;
    if (result.code === 'MEMORY_DRAFT_COMMIT_UNCONFIRMED' || result.code === 'PROJECT_DRAFT_RECOVERY_REQUIRED') {
      ctx.ui.notify(`无法确认保存结果，保持停读，请勿重复提交：${result.code}。`, 'warning');
      return;
    }
    let refreshed = true;
    if (paused) {
      try { await refresh(ctx); }
      catch { refreshed = false; }
    }
    if (!stillCurrent()) return;
    if (result.code) {
      const hint = {
        PROJECT_DRAFT_BUSY: '请暂停其他 Pi 窗口的项目记忆读取后重试。',
        PROJECT_DRAFT_UNAVAILABLE: '请核对项目目录权限及已有发布完整性。',
        CURATION_CONFLICT: '项目或条目版本已变化，请重新提炼。',
        CURATION_UNCHANGED: '草稿没有实质变化。',
      }[result.code] ?? '';
      ctx.ui.notify(`草稿未保存：${result.code}。${hint}`, 'warning');
    } else {
      ctx.ui.notify(`已保存 ${result.count} 条到 .project-memory。${refreshed ? '' : '文件已写入，但检索未重新加载。'}`, refreshed ? 'info' : 'warning');
    }
  }

  const off = pi.events?.on('local-project-memory.verification-receipt.v1', receipt => reminder.record(receipt));
  pi.on('agent_start', (_event, ctx) => reminder.begin(reminderContext(ctx)));
  pi.on('agent_settled', async (event, ctx) => {
    const notice = reminder.settle({ ...reminderContext(ctx), aborted: event.aborted });
    const request = pending;
    pending = undefined;
    if (!request) {
      if (notice && ctx.hasUI) ctx.ui.notify(notice, 'info');
      return;
    }
    if (event.aborted || !ctx.hasUI || !current(ctx, request)) return;
    reviewing = true;
    try { await review(ctx, request, settledDraft(ctx, request)); }
    catch (error) {
      if (current(ctx, request)) ctx.ui.notify(error?.message === 'MEMORY_DRAFT_SOURCE_LOCATION' ?
        '草稿包含源码定位（文件名、路径或行号），未写入。请去除定位信息后重新提炼。' :
        '没有可安全预览的结构化草稿，未写入。', 'warning');
    }
    finally { reviewing = false; }
  });
  pi.on('session_tree', reset);
  pi.on('session_start', reset);
  pi.on('session_shutdown', async () => { closed = true; reset(); if (typeof off === 'function') off(); await job?.close(); });
  pi.registerCommand('memory-draft', {
    description: '当前模型起草，预览并人工确认后保存到当前项目的 .project-memory。',
    async handler(args, ctx) {
      if (args.trim()) throw new Error('MEMORY_DRAFT_UNAVAILABLE');
      await arm(ctx);
      try { pi.sendUserMessage(draftPrompt); }
      catch (error) { pending = undefined; throw error; }
    },
  });
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'interactive' && event.source !== 'rpc') return { action: 'continue' };
    if (event.text.trim() !== '开始提炼' || event.images?.length) return { action: 'continue' };
    try {
      if (event.streamingBehavior) throw new Error('MEMORY_DRAFT_UNAVAILABLE');
      await arm(ctx);
      return { action: 'transform', text: draftPrompt };
    } catch {
      if (ctx.hasUI) ctx.ui.notify('只能在可信项目空闲时开始提炼草稿。', 'warning');
      return { action: 'handled' };
    }
  });
}
