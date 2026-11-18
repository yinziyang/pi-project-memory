import { createHash } from "node:crypto";
import { CATEGORIES, FIELDS } from "./knowledge-fields.mjs";
import { readKnowledgeRows, validateKnowledgeProject } from "./sqlite-knowledge.mjs";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function metadata(db, table, shape) {
  return db.query(`SELECT ${Object.keys(shape).map((k) => `typeof(${k}) AS ${k}_type,CAST(${k} AS BLOB) AS ${k}_bytes`).join(",")} FROM ${table}`).all().map((raw) => Object.fromEntries(Object.entries(shape).map(([k, t]) => {
    if (raw[k + "_type"] !== t) throw new Error("MD_METADATA_TYPE");
    const v = decoder.decode(raw[k + "_bytes"]);
    if (t === "integer" && (!/^(0|[1-9][0-9]*)$/.test(v) || !Number.isSafeInteger(Number(v)))) throw new Error("MD_METADATA_INTEGER");
    return [k, t === "integer" ? Number(v) : v];
  })));
}
/** 校验完整公开投影并返回同一内容代，事务、可信路径和连接均由调用方负责。 */
function readCurrentCuration(db, { project }) {
  validateKnowledgeProject(project);
  const manifest = metadata(db, "curation_manifest", { project: "text", kind: "text", count: "integer", version: "integer", snapshot: "text" });
  if (manifest.length !== 1 || manifest[0].version !== 1 || manifest[0].project !== project || manifest[0].kind !== "curated-current") throw new Error("MD_PUBLICATION_REQUIRED");
  const current = metadata(db, "curation_current", { observation_id: "integer", knowledge_id: "text", revision: "integer", category: "text", scope: "text", source: "text", public_evidence: "text", projection_digest: "text" });
  const observations = readKnowledgeRows(db, { project });
  if (current.length !== manifest[0].count || observations.length !== current.length) throw new Error("MD_CARDINALITY");
  const seenObservationIds = new Set();
  for (const c of current) {
    if (c.observation_id < 1 || seenObservationIds.has(c.observation_id) || !observations.some((o) => o.id === c.observation_id)) throw new Error("MD_OBSERVATION_MAPPING");
    seenObservationIds.add(c.observation_id);
  }
  const seen = new Set();
  const rows = current.map((c) => {
    if (!/^k-[a-z0-9][a-z0-9-]{0,79}$/.test(c.knowledge_id) || seen.has(c.knowledge_id) || c.revision < 1 || !CATEGORIES.includes(c.category) || !c.scope.trim() || !c.source.trim()) throw new Error("MD_ID_OR_METADATA");
    seen.add(c.knowledge_id);
    const o = observations.find((o2) => o2.id === c.observation_id);
    if (!o) throw new Error("MD_OBSERVATION");
    const evidence = JSON.parse(c.public_evidence);
    if (!Array.isArray(evidence) || !evidence.length || evidence.some((e) => typeof e !== "string" || !e.isWellFormed() || !e.trim())) throw new Error("MD_EVIDENCE");
    const row = { revision: c.revision, projection: { knowledgeId: c.knowledge_id, category: c.category, scope: c.scope, source: c.source, ...Object.fromEntries(FIELDS.map((k) => [k, o[k]])) }, evidence };
    if (hash(row) !== c.projection_digest) throw new Error("MD_PROJECTION_BINDING");
    return row;
  }).sort((a, b) => a.projection.knowledgeId < b.projection.knowledgeId ? -1 : 1);
  const snapshot = hash({ version: 1, project, rows });
  if (snapshot !== manifest[0].snapshot) throw new Error("MD_SNAPSHOT_BINDING");
  return { rows, generation: snapshot, observations, current };
}
export {
  readCurrentCuration
};
