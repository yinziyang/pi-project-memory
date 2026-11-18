import { parseDocument } from 'yaml';
import { CATEGORIES } from './knowledge-categories.mjs';
import { createDraftReminder } from './draft-reminder.mjs';
import { startManualDraft } from './manual-draft-owner.mjs';

const draftPrompt = [
  '开始提炼项目记忆。只在本轮回复中展示草稿，不修改文件、不写库、不发布、不调用其他模型或子代理。',
  '只考虑当前项目已经实施且能用独立证据核对的事实，或有明确记录的决定。不得把计划、模型自评、未跑过的检查或无法核验的结论写成事实。',
  '没有可复用且证据充分的内容时，直接说明“本次没有值得提炼的内容”及简短原因。',
  '如果当前项目能查到已发布知识，先查同主题条目。同主题更新沿用已有知识 ID，只有已证实不再适用才建议撤下。',
  '每条展示标题、建议操作、旧结论与变更（如适用）、分类、结论、适用范围、独立证据、必要公开安全代码和拟发布路径 .project-memory/md/<分类>/<knowledgeId>.md。不复制聊天原文、凭据或私有路径。',
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
  return drafts;
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

/** 只响应人工起草请求，在原会话当前分支预览；只有交互确认才能写入已绑定私库。 */
export function installDraftCommand(pi, { readBinding, start = startManualDraft } = {}) {
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
    // 未绑定私库仍允许起草，但不能从模型输出推导一个写入目标。
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
      ctx.ui.notify('草稿未写入：当前项目没有可用的私库绑定。', 'warning');
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
    const project = JSON.stringify(request.binding.binding.project);
    const targets = selected.map(draft => `.project-memory/md/${draft.category}/${draft.knowledgeId}.md`);
    const preview = `目标项目：${project}\n拟发布路径（本次不发布）：\n${targets.join('\n')}\n\n${JSON.stringify(selected, null, 2)}`;
    // Pi 编辑器可完整滚动预览，任何编辑或取消都不能继续确认，也不作为普通会话输入。
    const seen = await ctx.ui.editor('核对定稿（只预览，Esc 取消）', preview);
    if (seen !== preview || !stillCurrent()) return;
    if (await ctx.ui.confirm('确认写入私有审核库？', `共 ${selected.length} 条；不会公开发布。`) !== true || !stillCurrent()) return;
    let committed = 0;
    try {
      for (const draft of selected) {
        const binding = await readBinding(ctx);
        if (!stillCurrent() || JSON.stringify(binding) !== JSON.stringify(request.binding)) throw new Error('MEMORY_DRAFT_STALE');
        job = start(binding, draft);
        const result = await job.result;
        if (result.code !== 'MEMORY_DRAFT_COMMIT_UNCONFIRMED') job = undefined;
        if (result.code) throw new Error(result.code);
        committed++;
      }
    } catch (error) {
      if (stillCurrent()) {
        const code = typeof error?.message === 'string' && /^(MEMORY_DRAFT_[A-Z_]+|MANUAL_DRAFT_[A-Z_]+|CURATION_CONFLICT)$/.test(error.message) ? error.message : 'MEMORY_DRAFT_FAILED';
        ctx.ui.notify(`已确认写入 ${committed}/${selected.length} 条，未发布。已停止后续写入：${code}。`, 'warning');
      }
      return;
    }
    if (stillCurrent()) ctx.ui.notify(`已审核写入私库 ${committed} 条，尚未发布。`, 'info');
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
    catch { if (current(ctx, request)) ctx.ui.notify('没有可安全预览的结构化草稿，未写入。', 'warning'); }
    finally { reviewing = false; }
  });
  pi.on('session_tree', reset);
  pi.on('session_start', reset);
  pi.on('session_shutdown', async () => { closed = true; reset(); if (typeof off === 'function') off(); await job?.close(); });
  pi.registerCommand('memory-draft', {
    description: '当前模型起草，在同一流程预览并人工确认写入，不自动发布。',
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
