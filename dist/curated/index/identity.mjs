import { createHash } from 'node:crypto';

export const DOCUMENT_PROFILE = 'title-subtitle-fragment-v1';
export const MAPPING_VERSION = 'curated-body-v1';
export const MODEL_PROFILE = Object.freeze({
  repo: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  dtype: 'fp32', pooling: 'mean', normalization: 'l2', dims: 384,
  maxTokens: 512, queryPrefix: 'query: ', passagePrefix: 'passage: ',
});
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function text(value) {
  return typeof value === 'string' && value.isWellFormed();
}

/** 模型身份只含固定推理配置与文件摘要，不含可写宿主权限或本机路径。 */
export function modelFingerprint(manifest) {
  if (!manifest || manifest.complete !== true) throw new Error('INDEX_MODEL_MISSING');
  for (const [key, value] of Object.entries(MODEL_PROFILE)) {
    if (manifest[key] !== value) throw new Error('INDEX_MODEL_PROFILE_MISMATCH');
  }
  const required = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model.onnx'];
  if (!Array.isArray(manifest.files) || manifest.files.length !== required.length) throw new Error('INDEX_MODEL_PROFILE_MISMATCH');
  const files = required.map((path) => {
    const matches = manifest.files.filter((file) => file.path === path);
    if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0].sha256) || !Number.isSafeInteger(matches[0].bytes) || matches[0].bytes < 1) throw new Error('INDEX_MODEL_PROFILE_MISMATCH');
    return { path, sha256: matches[0].sha256, bytes: matches[0].bytes };
  });
  return digest({ ...MODEL_PROFILE, files });
}

/** 绑定公开内容身份，来源许可由调用方另行通过运行绑定校验。 */
export function indexIdentity(binding, fingerprint) {
  if (!binding || !text(binding.project) || !binding.project.trim() || !/^[a-f0-9]{64}$/.test(binding.generation) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('INDEX_BINDING_INVALID');
  return Object.freeze({ version: 2, project: binding.project, generation: binding.generation,
    modelFingerprint: fingerprint, documentProfile: DOCUMENT_PROFILE, mappingVersion: MAPPING_VERSION });
}

/** 每条知识固定为一个 fragment，稳定标识不依赖 SQLite rowid。 */
export function stableReference(identity, row) {
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1 || !/^k-[a-z0-9][a-z0-9-]{0,79}$/.test(row.projection?.knowledgeId)) throw new Error('INDEX_ROW_INVALID');
  return { version: 2, project: identity.project, generation: identity.generation,
    knowledgeId: row.projection.knowledgeId, revision: row.revision, fragmentKey: 'body' };
}

/** 输入必须先经过 readCurrentCuration，facts 的合法字符串顺序原样保留，空正文只回退标题，不制造占位知识。 */
export function mapCurrentRows(snapshot, identity) {
  if (!snapshot || snapshot.generation !== identity.generation || !Array.isArray(snapshot.rows)) throw new Error('INDEX_BINDING_INVALID');
  const seen = new Set();
  return snapshot.rows.map((row) => {
    const ref = stableReference(identity, row);
    const p = row.projection;
    if (p.project !== identity.project || seen.has(p.knowledgeId)) throw new Error('INDEX_ROW_INVALID');
    seen.add(p.knowledgeId);
    const facts = p.facts === null ? [] : JSON.parse(p.facts);
    if (!Array.isArray(facts) || facts.some((fact) => !text(fact))) throw new Error('INDEX_ROW_INVALID');
    for (const value of [p.title, p.subtitle, p.narrative]) if (value !== null && !text(value)) throw new Error('INDEX_ROW_INVALID');
    let body = [p.narrative, ...facts].filter((value) => value !== null && value !== '').join('\n');
    if (!body) body = p.title ?? '';
    const parts = [];
    if (p.title && p.title !== 'Untitled') parts.push(`标题：${p.title}`);
    if (p.subtitle) parts.push(`副标题：${p.subtitle}`);
    parts.push(`正文：${body}`);
    return { id: digest(ref), ref, document: parts.join('\n') };
  });
}

/** 整批拒绝多余、重复、过期引用或非有限分数，正文永不来自向量索引。 */
export function validateCandidates(candidates, records, identity, topK) {
  if (!Array.isArray(candidates) || candidates.length > topK) throw new Error('INDEX_INVALID');
  const byId = new Map(records.map((record) => [record.id, record]));
  const seen = new Set();
  return candidates.map((candidate) => {
    const record = byId.get(candidate?.id);
    const ref = candidate?.ref;
    // JSON 对象属性顺序不是协议身份，Python 的稳定序列化可重排键，但缺失、多余或不同值仍须整批拒绝。
    const sameReference = record && ref && !Array.isArray(ref) && Object.keys(ref).length === Object.keys(record.ref).length && Object.entries(record.ref).every(([key, value]) => Object.hasOwn(ref, key) && ref[key] === value);
    if (!record || seen.has(candidate.id) || !Number.isFinite(candidate.score) || !sameReference || ref.project !== identity.project || ref.generation !== identity.generation) throw new Error('INDEX_INVALID');
    seen.add(candidate.id);
    return { ...record.ref, score: candidate.score };
  });
}
