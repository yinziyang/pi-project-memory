const MAX_REQUEST_BYTES = 1024 * 1024;

export function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every(field => Object.hasOwn(value, field));
}

export function text(value) {
  return typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && Boolean(value.trim());
}

export function validDraft(draft, categories) {
  const evidenceFields = ['implementation', 'object', 'method', 'coverage', 'source', 'publicSummary'];
  const resultFields = ['observed', 'expected', 'comparison'];
  return exactFields(draft, ['knowledgeId', 'expectedRevision', 'category', 'scope', 'source', 'title', 'narrative', 'facts', 'evidence'])
    && typeof draft.knowledgeId === 'string' && /^k-[a-z0-9][a-z0-9-]{0,79}$/.test(draft.knowledgeId)
    && Number.isSafeInteger(draft.expectedRevision) && draft.expectedRevision >= 0
    && categories.includes(draft.category)
    && [draft.scope, draft.source, draft.title, draft.narrative].every(text)
    && Array.isArray(draft.facts) && draft.facts.every(text)
    && Array.isArray(draft.evidence) && draft.evidence.length > 0
    && draft.evidence.every(item => exactFields(item, [...evidenceFields, 'result'])
      && evidenceFields.every(field => text(item[field]))
      && exactFields(item.result, resultFields) && resultFields.every(field => text(item.result[field])));
}

export async function readDraftFrame() {
  const chunks = [];
  let size = 0;
  let lineEnded = false;
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      const end = chunk.indexOf(10);
      if (size > MAX_REQUEST_BYTES || lineEnded || (end !== -1 && end !== chunk.length - 1)) {
        throw new Error("DRAFT_FRAME_INVALID");
      }
      lineEnded = end !== -1;
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    throw new Error("DRAFT_FRAME_INVALID");
  }
}
