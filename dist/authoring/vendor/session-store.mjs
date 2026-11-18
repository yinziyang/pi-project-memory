// validation/upstream/claude-mem/src/shared/context-invalidation.ts
var listeners = /* @__PURE__ */ new Set();
var generation = 0;
function emitContextInvalidation(scope, reason, kind = "additive", changes) {
  generation++;
  for (const listener of listeners) {
    listener({ scope, reason, kind, ...changes ? { changes } : {} });
  }
}

// validation/upstream/claude-mem/src/services/sqlite/SessionStore.ts
import { Database as Database3 } from "bun:sqlite";
import { createHash as createHash4, randomUUID } from "crypto";

// src/authoring/vendor/store-path-boundary.mjs
var DATA_DIR = "";
var DB_PATH = "";
var USER_SETTINGS_PATH = "";
var OBSERVER_SESSIONS_PROJECT = "__local_memory_observer__";
function ensurePrivateDir() {
  throw new Error("EXPLICIT_AUTHORING_CONNECTION_REQUIRED");
}

// src/authoring/vendor/store-log-boundary.mjs
function warning() {
  process.stderr.write('{"kind":"STORE_DIAGNOSTIC"}\n');
}
var logger = Object.freeze({ debug() {
}, info() {
}, warn: warning, error: warning });

// validation/upstream/claude-mem/src/services/sqlite/project-read-keys.ts
function scopedProjects(filters) {
  const requested = filters.projects?.length ? filters.projects : filters.project ? [filters.project] : [];
  return [...new Set(requested.filter((project) => project.trim().length > 0))];
}
function projectScopeSql(alias, projects, options) {
  const placeholders = projects.map(() => "?").join(",");
  if (!options.includeMerged) {
    return { sql: `${alias}.project COLLATE NOCASE IN (${placeholders})`, params: [...projects] };
  }
  return {
    sql: `(${alias}.project COLLATE NOCASE IN (${placeholders}) OR ${alias}.merged_into_project COLLATE NOCASE IN (${placeholders}))`,
    params: [...projects, ...projects]
  };
}
function projectReadKeys(db, projects) {
  const requested = scopedProjects({ projects });
  if (requested.length === 0) return [];
  return db.transaction(() => {
    const keys = new Set(requested);
    const fold = (key) => key.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    const queried = new Set(requested.map(fold));
    for (; ; ) {
      let expanded = false;
      for (const key of readProjectKeyPass(db, [...keys])) {
        keys.add(key);
        const folded = fold(key);
        if (!queried.has(folded)) {
          queried.add(folded);
          expanded = true;
        }
      }
      if (!expanded) return [...keys];
    }
  })();
}
function readProjectKeyPass(db, requested) {
  const placeholders = requested.map((_, i) => `?${i + 1}`).join(",");
  const lookups = [
    `SELECT project AS key FROM sdk_sessions WHERE project COLLATE NOCASE IN (${placeholders})`,
    `SELECT project FROM observations WHERE project COLLATE NOCASE IN (${placeholders})`,
    `SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${placeholders})`,
    `SELECT project FROM session_summaries WHERE project COLLATE NOCASE IN (${placeholders})`,
    `SELECT merged_into_project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${placeholders})`,
    // Projects whose every stored row is stamped into one of `projects`.
    // Both sides use covering indexes. The row-id membership check can stop
    // at the first unadopted row instead of counting every row in a source.
    // Already-known projects get all their literal spellings from the first
    // lookups, so they need no whole-merge check on later chain passes.
    `SELECT candidates.key FROM (
        SELECT project AS key FROM observations WHERE merged_into_project COLLATE NOCASE IN (${placeholders})
        UNION
        SELECT project AS key FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${placeholders})
      ) candidates
      WHERE candidates.key COLLATE NOCASE NOT IN (${placeholders})
        AND NOT EXISTS (
        SELECT 1 FROM observations
        WHERE project COLLATE NOCASE = candidates.key AND rowid NOT IN (
          SELECT rowid FROM observations WHERE merged_into_project COLLATE NOCASE IN (${placeholders})
        )
      ) AND NOT EXISTS (
        SELECT 1 FROM session_summaries
        WHERE project COLLATE NOCASE = candidates.key AND rowid NOT IN (
          SELECT rowid FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${placeholders})
        )
      )`
  ];
  const statement = db.prepare(lookups.join(" UNION "));
  try {
    const rows = statement.all(...requested);
    return rows.map((row) => row.key);
  } finally {
    statement.finalize();
  }
}

// validation/upstream/claude-mem/src/services/sqlite/observations/store.ts
import { createHash } from "crypto";
function hasStorableTitle(title) {
  return typeof title === "string" && title.trim() !== "";
}
function computeObservationContentHash(memorySessionId, title, narrative) {
  const fields = [memorySessionId || "", title || "", narrative || ""];
  return fields.some((field) => field.includes("\0")) ? "tuple-" + createHash("sha256").update(JSON.stringify(fields)).digest("hex") : computeLegacyObservationContentHash(memorySessionId, title, narrative);
}
function computeLegacyObservationContentHash(memorySessionId, title, narrative) {
  return createHash("sha256").update([memorySessionId || "", title || "", narrative || ""].join("\0")).digest("hex").slice(0, 16);
}
function listValue(value) {
  if (typeof value !== "string") return value ?? [];
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function computeObservationDetailsHash(legacyHash, details) {
  return "details-" + createHash("sha256").update(JSON.stringify([
    legacyHash,
    details.type,
    details.subtitle ?? null,
    listValue(details.facts),
    listValue(details.concepts)
  ])).digest("hex");
}

// validation/upstream/claude-mem/src/services/sqlite/observations/files.ts
function parseFileList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch (error) {
    logger.debug("DB", "File list is not JSON; treating value as a single path", { value }, error instanceof Error ? error : new Error(String(error)));
    return [value];
  }
}
function parseIndexedFilePaths(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}
function replaceObservationFileIndex(db, observationId, filesRead, filesModified) {
  db.prepare("DELETE FROM observation_files WHERE observation_id = ?").run(observationId);
  const paths = /* @__PURE__ */ new Set([...parseIndexedFilePaths(filesRead), ...parseIndexedFilePaths(filesModified)]);
  if (paths.size === 0) return;
  const insert = db.prepare("INSERT OR IGNORE INTO observation_files(path, observation_id) VALUES (?, ?)");
  for (const path of paths) insert.run(path, observationId);
}

// validation/upstream/claude-mem/src/services/reinforcement/strength.ts
var MAX_REINFORCEMENT_HISTORY = 10;
function parseReinforcementDates(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d) => typeof d === "string" && d.length > 0);
  } catch {
    return [];
  }
}
function isoDay(d = /* @__PURE__ */ new Date()) {
  return d.toISOString().slice(0, 10);
}
function appendReinforcement(dates, today = /* @__PURE__ */ new Date(), maxHistory = MAX_REINFORCEMENT_HISTORY) {
  const day = isoDay(today);
  if (dates.includes(day)) return dates;
  const next = [...dates, day];
  return next.length > maxHistory ? next.slice(next.length - maxHistory) : next;
}

// validation/upstream/claude-mem/src/services/reinforcement/persist.ts
function seedReinforcement(epochMs) {
  const day = isoDay(new Date(epochMs));
  return { dates: JSON.stringify([day]), lastReinforced: day };
}
function reinforceObservation(db, id, today = /* @__PURE__ */ new Date()) {
  const row = db.prepare("SELECT reinforcement_dates FROM observations WHERE id = ?").get(id);
  if (!row) return false;
  const current = parseReinforcementDates(row.reinforcement_dates);
  const next = appendReinforcement(current, today);
  if (next === current) return false;
  db.prepare("UPDATE observations SET reinforcement_dates = ?, last_reinforced = ? WHERE id = ?").run(
    JSON.stringify(next),
    next[next.length - 1],
    id
  );
  return true;
}

// validation/upstream/claude-mem/src/services/sqlite/tool-uses.ts
import { createHash as createHash2 } from "crypto";

// validation/upstream/claude-mem/src/shared/platform-source.ts
var DEFAULT_PLATFORM_SOURCE = "claude";
function sanitizeRawSource(value) {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}
function normalizePlatformSource(value) {
  if (!value) return DEFAULT_PLATFORM_SOURCE;
  const source = sanitizeRawSource(value);
  if (!source) return DEFAULT_PLATFORM_SOURCE;
  if (source === "transcript") return "codex";
  if (source.includes("codex")) return "codex";
  if (source.includes("cursor")) return "cursor";
  if (source.includes("claude")) return "claude";
  if (source.includes("kimi")) return "kimi";
  if (source === "pi-mono") return "pi";
  if (source === "agy" || source === "antigravity" || source.startsWith("antigravity-")) return "antigravity-cli";
  return source;
}
function sortPlatformSources(sources) {
  const priority = ["claude", "codex", "antigravity-cli", "cursor", "kimi"];
  return [...sources].sort((a, b) => {
    const aPriority = priority.indexOf(a);
    const bPriority = priority.indexOf(b);
    if (aPriority !== -1 || bPriority !== -1) {
      if (aPriority === -1) return 1;
      if (bPriority === -1) return -1;
      return aPriority - bPriority;
    }
    return a.localeCompare(b);
  });
}

// validation/upstream/claude-mem/src/shared/memory-retrieval-tools.ts
var RETRIEVAL_TOOLS = /* @__PURE__ */ new Set([
  "dumb_search",
  "claude_mem_search",
  "claude_mem_timeline",
  "claude_mem_get_observations",
  "mem_search",
  "search",
  "timeline",
  "get_observations",
  "get_summaries",
  "get_tool_uses",
  "session_start_context",
  "observation_search",
  "observation_context",
  "memory_search",
  "memory_context"
]);
function claudeMemToolName(name) {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  const server = parts[1].toLowerCase();
  if (!server.includes("claude-mem") && !server.includes("claude_mem") && !server.includes("mcp-search") && !server.includes("mcp_search") && !server.includes("cmem")) return null;
  return parts.slice(2).join("__");
}
function isRecursiveMemoryTool(toolName) {
  if (!toolName) return false;
  if (toolName.startsWith("memory_")) return true;
  if (toolName === "claude_mem_search" || toolName === "claude_mem_timeline" || toolName === "claude_mem_get_observations") return true;
  if (toolName === "dumb_search" || toolName === "mem_search" || toolName === "get_summaries") return true;
  const tool = claudeMemToolName(toolName);
  return tool !== null && RETRIEVAL_TOOLS.has(tool);
}

// validation/upstream/claude-mem/src/services/sqlite/tool-uses.ts
var MAX_TOOL_PAYLOAD_BYTES = 64 * 1024;
function truncatePayload(value, maxBytes = MAX_TOOL_PAYLOAD_BYTES) {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength <= maxBytes) return value;
  const buf = Buffer.allocUnsafe(maxBytes);
  const end = buf.write(value, "utf8");
  return `${buf.subarray(0, end).toString("utf8")}\u2026[truncated: ${byteLength} bytes]`;
}
function computeToolUseContentHash(toolName, toolInput, toolResponse) {
  return createHash2("sha256").update(toolName || "").update("\0").update(toolInput || "").update("\0").update(toolResponse || "").digest("hex").slice(0, 16);
}
function createToolUsesSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS tool_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_use_id TEXT NOT NULL,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT,
      session_db_id INTEGER,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT '${DEFAULT_PLATFORM_SOURCE}',
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      prompt_number INTEGER,
      agent_type TEXT,
      agent_id TEXT,
      observation_id INTEGER,
      or_generation_id TEXT,
      or_session_id TEXT,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      UNIQUE(platform_source, content_session_id, tool_use_id)
    )
  `);
  db.transaction(() => {
    const schema = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tool_uses'").get();
    const oldIdentity = /UNIQUE\s*\(\s*content_session_id\s*,\s*tool_use_id\s*\)/i;
    if (!oldIdentity.test(schema.sql)) return;
    const dependents = db.query(`SELECT sql FROM sqlite_master
      WHERE tbl_name = 'tool_uses' AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all();
    const sequence = db.query("SELECT seq FROM sqlite_sequence WHERE name = 'tool_uses'").get();
    db.run(schema.sql.replace(/^CREATE TABLE\s+(?:"tool_uses"|tool_uses)\s*\(/i, "CREATE TABLE tool_uses_platform_new (").replace(oldIdentity, "UNIQUE(platform_source, content_session_id, tool_use_id)"));
    db.run("INSERT INTO tool_uses_platform_new SELECT * FROM tool_uses");
    db.run("DROP TABLE tool_uses");
    db.run("ALTER TABLE tool_uses_platform_new RENAME TO tool_uses");
    for (const dependent of dependents) db.run(dependent.sql);
    if (sequence) db.run("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'tool_uses'", [sequence.seq]);
  }).immediate();
  db.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project ON tool_uses(project)");
  db.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project_nocase_created ON tool_uses(project COLLATE NOCASE, created_at_epoch DESC, id DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_memory_session ON tool_uses(memory_session_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_content_session ON tool_uses(content_session_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_session_db_id ON tool_uses(session_db_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_tool_name ON tool_uses(tool_name)");
  db.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch)");
  db.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_observation_id ON tool_uses(observation_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_or_generation_id ON tool_uses(or_generation_id)");
}
function upsertToolUse(db, input) {
  if (!input.toolUseId || !input.contentSessionId || !input.toolName) return null;
  if (isRecursiveMemoryTool(input.toolName)) return null;
  const createdAtEpoch = input.createdAtEpoch ?? Date.now();
  const createdAt = new Date(createdAtEpoch).toISOString();
  const contentHash = computeToolUseContentHash(input.toolName, input.toolInput, input.toolResponse);
  const toolInput = input.toolInput != null ? truncatePayload(input.toolInput) : null;
  const toolResponse = input.toolResponse != null ? truncatePayload(input.toolResponse) : null;
  const row = db.prepare(`
    INSERT INTO tool_uses (
      tool_use_id, content_session_id, memory_session_id, session_db_id, project,
      platform_source, tool_name, tool_input, tool_response, cwd, prompt_number,
      agent_type, agent_id, or_generation_id, or_session_id, content_hash,
      created_at, created_at_epoch
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform_source, content_session_id, tool_use_id) DO UPDATE SET
      memory_session_id = CASE WHEN tool_uses.observation_id IS NULL
        THEN COALESCE(excluded.memory_session_id, tool_uses.memory_session_id)
        ELSE tool_uses.memory_session_id END,
      session_db_id     = COALESCE(excluded.session_db_id, tool_uses.session_db_id),
      project           = CASE WHEN excluded.project != '' THEN excluded.project ELSE tool_uses.project END,
      platform_source   = excluded.platform_source,
      tool_input        = COALESCE(excluded.tool_input, tool_uses.tool_input),
      tool_response     = COALESCE(excluded.tool_response, tool_uses.tool_response),
      cwd               = COALESCE(excluded.cwd, tool_uses.cwd),
      prompt_number     = COALESCE(excluded.prompt_number, tool_uses.prompt_number),
      agent_type        = COALESCE(excluded.agent_type, tool_uses.agent_type),
      agent_id          = COALESCE(excluded.agent_id, tool_uses.agent_id),
      or_generation_id  = COALESCE(excluded.or_generation_id, tool_uses.or_generation_id),
      or_session_id     = COALESCE(excluded.or_session_id, tool_uses.or_session_id),
      content_hash      = excluded.content_hash
    RETURNING id
  `).all(
    input.toolUseId,
    input.contentSessionId,
    input.memorySessionId ?? null,
    input.sessionDbId ?? null,
    input.project ?? "",
    normalizePlatformSource(input.platformSource),
    input.toolName,
    toolInput,
    toolResponse,
    input.cwd ?? null,
    input.promptNumber ?? null,
    input.agentType ?? null,
    input.agentId ?? null,
    input.orGenerationId ?? null,
    input.orSessionId ?? null,
    contentHash,
    createdAt,
    createdAtEpoch
  )[0] ?? null;
  return row ? row.id : null;
}
function linkToolUsesToObservation(db, params) {
  const ids = params.toolUseIds.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const result = db.prepare(`
    UPDATE tool_uses
    SET observation_id = COALESCE(observation_id, ?),
        memory_session_id = CASE WHEN observation_id IS NULL
          THEN COALESCE(?, memory_session_id)
          ELSE COALESCE(memory_session_id, ?)
        END
    WHERE content_session_id = ?
      AND platform_source = ?
      AND tool_use_id IN (${placeholders})
      AND (observation_id IS NULL OR observation_id = ?)
  `).run(
    params.observationId,
    params.memorySessionId ?? null,
    params.memorySessionId ?? null,
    params.contentSessionId,
    normalizePlatformSource(params.platformSource),
    ...ids,
    params.observationId
  );
  return Number(result.changes ?? 0);
}
function mapPlatformFilter(platformSource) {
  if (!platformSource) return null;
  return {
    clause: `COALESCE(NULLIF(platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`,
    param: normalizePlatformSource(platformSource)
  };
}
var TOOL_USES_BATCH_DEFAULT_ROWS = 100;
function getToolUsesByIds(db, ids, options = {}) {
  const numericIds = [];
  const stringIds = [];
  for (const id of ids) {
    if (typeof id === "number" && Number.isInteger(id)) {
      numericIds.push(id);
      continue;
    }
    if (typeof id === "string" && id.trim().length > 0) {
      const asNumber = Number(id);
      if (Number.isInteger(asNumber) && String(asNumber) === id.trim()) numericIds.push(asNumber);
      stringIds.push(id.trim());
    }
  }
  if (numericIds.length === 0 && stringIds.length === 0) return [];
  const idClauses = [];
  const params = [];
  if (numericIds.length > 0) {
    idClauses.push(`id IN (${numericIds.map(() => "?").join(",")})`);
    params.push(...numericIds);
  }
  if (stringIds.length > 0) {
    idClauses.push(`tool_use_id IN (${stringIds.map(() => "?").join(",")})`);
    params.push(...stringIds);
  }
  const conditions = [`(${idClauses.join(" OR ")})`];
  const projects = scopedProjects(options);
  if (projects.length) {
    const scope = projectScopeSql("tool_uses", projects, { includeMerged: false });
    conditions.push(scope.sql);
    params.push(...scope.params);
  }
  if (options.contentSessionId) {
    conditions.push("content_session_id = ?");
    params.push(options.contentSessionId);
  }
  const platform = mapPlatformFilter(options.platformSource);
  if (platform) {
    conditions.push(platform.clause);
    params.push(platform.param);
  }
  const rowLimit = options.limit && options.limit > 0 ? Math.floor(options.limit) : TOOL_USES_BATCH_DEFAULT_ROWS;
  return db.prepare(`
    SELECT * FROM tool_uses
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at_epoch DESC
    LIMIT ${rowLimit}
  `).all(...params);
}
function queryToolUses(db, filters = {}) {
  return queryToolUseRows(db, filters, "*");
}
function queryToolUseIndex(db, filters = {}) {
  return queryToolUseRows(db, filters, `
    id, tool_use_id, tool_name, project, content_session_id, memory_session_id,
    platform_source, agent_id, agent_type, observation_id, or_generation_id,
    or_session_id, prompt_number, created_at, created_at_epoch,
    COALESCE(length(CAST(tool_input AS BLOB)), 0) AS tool_input_bytes,
    COALESCE(length(CAST(tool_response AS BLOB)), 0) AS tool_response_bytes
  `);
}
function queryToolUseRows(db, filters, projection) {
  const conditions = [];
  const params = [];
  if (filters.project) {
    conditions.push("project COLLATE NOCASE = ?");
    params.push(filters.project);
  }
  if (filters.contentSessionId) {
    conditions.push("content_session_id = ?");
    params.push(filters.contentSessionId);
  }
  if (filters.memorySessionId) {
    conditions.push("memory_session_id = ?");
    params.push(filters.memorySessionId);
  }
  if (typeof filters.sessionDbId === "number") {
    conditions.push("session_db_id = ?");
    params.push(filters.sessionDbId);
  }
  if (filters.toolName) {
    const names = Array.isArray(filters.toolName) ? filters.toolName : [filters.toolName];
    if (names.length > 0) {
      conditions.push(`tool_name IN (${names.map(() => "?").join(",")})`);
      params.push(...names);
    }
  }
  if (filters.agentId) {
    conditions.push("agent_id = ?");
    params.push(filters.agentId);
  }
  const platform = mapPlatformFilter(filters.platformSource);
  if (platform) {
    conditions.push(platform.clause);
    params.push(platform.param);
  }
  if (typeof filters.dateStart === "number") {
    conditions.push("created_at_epoch >= ?");
    params.push(filters.dateStart);
  }
  if (typeof filters.dateEnd === "number") {
    conditions.push("created_at_epoch <= ?");
    params.push(filters.dateEnd);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = filters.orderBy === "date_asc" ? "ASC" : "DESC";
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 50), 1), 500);
  const offset = Math.max(Math.floor(filters.offset ?? 0), 0);
  return db.prepare(`
    SELECT ${projection} FROM tool_uses
    ${whereClause}
    ORDER BY created_at_epoch ${order}, id ${order}
    LIMIT ${limit} OFFSET ${offset}
  `).all(...params);
}
function countToolUses(db, filters = {}) {
  const conditions = [];
  const params = [];
  if (filters.project) {
    conditions.push("project COLLATE NOCASE = ?");
    params.push(filters.project);
  }
  if (filters.contentSessionId) {
    conditions.push("content_session_id = ?");
    params.push(filters.contentSessionId);
  }
  if (filters.agentId) {
    conditions.push("agent_id = ?");
    params.push(filters.agentId);
  }
  if (typeof filters.dateStart === "number") {
    conditions.push("created_at_epoch >= ?");
    params.push(filters.dateStart);
  }
  if (typeof filters.dateEnd === "number") {
    conditions.push("created_at_epoch <= ?");
    params.push(filters.dateEnd);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.prepare(`
    SELECT tool_name, COUNT(DISTINCT tool_use_id) AS uses
    FROM tool_uses
    ${whereClause}
    GROUP BY tool_name
    ORDER BY uses DESC, tool_name ASC
  `).all(...params);
}

// validation/upstream/claude-mem/src/services/sqlite/deliverables.ts
function createDeliverablesSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS deliverables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      content_session_id TEXT NOT NULL,
      platform_source TEXT NOT NULL,
      agent_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_path TEXT NOT NULL,
      bucket_path TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      declared INTEGER NOT NULL DEFAULT 0,
      list_name TEXT,
      field TEXT,
      tool_use_id TEXT,
      occurred_at_epoch INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_deliverables_session_copy ON deliverables(platform_source, content_session_id, bucket_path)");
  db.run("CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project COLLATE NOCASE, created_at_epoch)");
  db.run("CREATE INDEX IF NOT EXISTS idx_deliverables_created ON deliverables(created_at_epoch DESC)");
}
function recordDeliverable(db, input) {
  const createdAtEpoch = input.createdAtEpoch ?? Date.now();
  const result = db.prepare(`
    INSERT OR IGNORE INTO deliverables (
      project, content_session_id, platform_source, agent_id, title, kind, source_path, bucket_path, bytes, sha256,
      declared, list_name, field, tool_use_id, occurred_at_epoch, created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.project,
    input.contentSessionId,
    input.platformSource,
    input.agentId ?? null,
    input.title,
    input.kind,
    input.sourcePath,
    input.bucketPath,
    input.bytes,
    input.sha256,
    input.declared ? 1 : 0,
    input.listName ?? null,
    input.field ?? null,
    input.toolUseId ?? null,
    input.occurredAtEpoch,
    new Date(createdAtEpoch).toISOString(),
    createdAtEpoch
  );
  if (result.changes > 0) {
    const id = Number(result.lastInsertRowid);
    logger.debug("DB", "Deliverable recorded", { id, project: input.project, bucketPath: input.bucketPath });
    return { id, inserted: true };
  }
  if (input.declared) {
    db.prepare(`
      UPDATE deliverables SET declared = 1, title = ?, kind = ?, agent_id = ?,
        source_path = ?, list_name = ?, field = ?, tool_use_id = ?, occurred_at_epoch = ?
      WHERE platform_source = ? AND content_session_id = ? AND bucket_path = ? AND declared = 0
    `).run(
      input.title,
      input.kind,
      input.agentId ?? null,
      input.sourcePath,
      input.listName ?? null,
      input.field ?? null,
      input.toolUseId ?? null,
      input.occurredAtEpoch,
      input.platformSource,
      input.contentSessionId,
      input.bucketPath
    );
  }
  const existing = db.prepare("SELECT id FROM deliverables WHERE platform_source = ? AND content_session_id = ? AND bucket_path = ?").get(input.platformSource, input.contentSessionId, input.bucketPath);
  return { id: existing?.id ?? 0, inserted: false };
}
function getDeliverable(db, id) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return db.prepare("SELECT * FROM deliverables WHERE id = ?").get(id) ?? null;
}

// validation/upstream/claude-mem/src/utils/redaction.ts
import { existsSync, readFileSync } from "fs";

// src/authoring/vendor/store-settings-boundary.mjs
var SettingsDefaultsManager = class {
  static loadFromFile() {
    return { CLAUDE_MEM_DEDUP_ENABLED: "false" };
  }
};

// validation/upstream/claude-mem/src/shared/hook-io.ts
var pendingModelContext = Promise.resolve();

// validation/upstream/claude-mem/src/shared/atomic-json.ts
var IS_WINDOWS_PLATFORM = process.platform === "win32";
function stripUtf8Bom(raw) {
  return raw.replace(/^\uFEFF/, "");
}

// validation/upstream/claude-mem/src/utils/redaction.ts
var GENERIC_VALUE_CLASS = String.raw`[A-Za-z0-9_.\-+/=~@#$%^*!?]`;
var GENERIC_VALUE = `(?=${GENERIC_VALUE_CLASS}{8})${GENERIC_VALUE_CLASS}*[A-Za-z]${GENERIC_VALUE_CLASS}*`;
var OPTIONAL_QUOTE = String.raw`(?:\\{0,3}["'])?`;
var BOUNDED_SPACE = String.raw`\s{0,8}`;
function genericBuiltinRegex(lookbehind) {
  return new RegExp(`${lookbehind}${GENERIC_VALUE}`, "gi");
}
function webhookHost(host) {
  const ci = host.replace(/\\.|[a-z]/g, (c) => c.length === 1 ? `[${c}${c.toUpperCase()}]` : c);
  return String.raw`(?:^|\/\/|@|[^\w.\/@%-])${ci}`;
}
function keyedLookbehind(key) {
  return `(?<=${key}${OPTIONAL_QUOTE}${BOUNDED_SPACE}[=:]${BOUNDED_SPACE}${OPTIONAL_QUOTE})`;
}
var BARE_TOKEN_KEY = String.raw`(?:token|secret|api_key)`;
var ESCAPED_QUOTE = String.raw`\\{0,3}["']`;
var STRING_EDGE = String.raw`(?<!\\)"`;
var ASSIGNMENT_START = String.raw`(?:^|[\s?&]|\\[nrt]|${STRING_EDGE})`;
var LINE_START = String.raw`(?:^|\n|\\n|${STRING_EDGE})[ \t]{0,8}(?:-[ \t]{1,8})?`;
var LINE_END = String.raw`(?:${ESCAPED_QUOTE})?[ \t]{0,8}(?:$|\r?\n|\\{1,3}[rn]|#|${STRING_EDGE})`;
var GENERIC_TOKEN_REGEX = new RegExp([
  `${keyedLookbehind(String.raw`\b\w*_${BARE_TOKEN_KEY}`)}${GENERIC_VALUE}`,
  `(?<=${ESCAPED_QUOTE}${BARE_TOKEN_KEY}${ESCAPED_QUOTE}${BOUNDED_SPACE}:${BOUNDED_SPACE}${ESCAPED_QUOTE})${GENERIC_VALUE}`,
  `(?<=${ASSIGNMENT_START}${BARE_TOKEN_KEY}=${OPTIONAL_QUOTE})${GENERIC_VALUE}(?!\\(|${GENERIC_VALUE_CLASS})`,
  String.raw`(?<=--(?:[a-z0-9]+[-_])*(?:token|secret|api[-_]key)(?:=|[ \t]{1,8})${OPTIONAL_QUOTE})${GENERIC_VALUE}`,
  `(?<=${LINE_START}${BARE_TOKEN_KEY}:[ \\t]{1,8}${OPTIONAL_QUOTE})${GENERIC_VALUE}(?=${LINE_END})`
].join("|"), "gi");
var ESCAPED_WHITESPACE_OR_WORD_BOUNDARY = String.raw`(?:(?<=\\[nrt])|\b)`;
function matchAfterEscapedWhitespace(pattern) {
  const source = pattern.regex.source.replace(/(^|\||\(\?:)\\b/g, `$1${ESCAPED_WHITESPACE_OR_WORD_BOUNDARY}`);
  return { ...pattern, regex: new RegExp(source, pattern.regex.flags) };
}
var COOKIE_VALUE_CHAR = String.raw`[^\\\n\r"'\`<]`;
var BUILTIN_REDACTION_PATTERNS = [
  // A `Cookie`/`Set-Cookie` header value is a session credential whatever the
  // cookie is named (`Cookie: sessionid=...`, `set-cookie: sid=...`), as printed
  // by `curl -v`, a proxy log or a captured response dump. Only the value is
  // replaced, so the key stays readable. The Cowork shim has redacted these
  // since the plugin landed (its COOKIE_RE, #3733), so the same session text
  // was redacted on the way to cmem.ai and stored verbatim by the local worker.
  // keyedLookbehind takes JSON-escaped keys (`\"Cookie\":\"…\"`); an optional
  // `[` takes the first entry of Node's `"set-cookie": ["…"]` array. The value
  // stops at a line end, a quote or a backslash, so in `JSON.stringify` text it
  // ends before an escaped `\n` or `\"` and leaves the rest of the payload and
  // its JSON intact, and at `<`, so it never re-redacts its own marker. The
  // 4-char floor keeps a bare `Cookie: x` placeholder out. First in the list:
  // the whole header value goes before a vendor pattern can split it with its
  // marker and leave a later cookie in the same header readable.
  { name: "cookie_header", regex: new RegExp(`(?<=(?:\\b(?:set-)?cookie)${OPTIONAL_QUOTE}${BOUNDED_SPACE}[=:]${BOUNDED_SPACE}(?:\\[${BOUNDED_SPACE})?${OPTIONAL_QUOTE})(?![ \\t])${COOKIE_VALUE_CHAR}{4,}`, "gi") },
  // The password in a URL's userinfo: `postgres://app:hunter2@db/prod`,
  // `redis://:hunter2@cache:6379/0`, `https://user:pass@host/repo.git` (what
  // `git remote -v` and a DATABASE_URL print). Only the password is replaced,
  // so the scheme, user and host stay readable. The value stops at `/`, `@`,
  // whitespace and quotes; a `<` start keeps an earlier marker and a `$`/`{`
  // start keeps a `${DB_PASS}` placeholder from being taken for a secret.
  // First in the list, so the whole password goes before a vendor pattern can
  // split it with its marker and leave the rest of it behind.
  { name: "url_credentials", regex: /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@'"<>]*:)(?![${<])[^\s\/@'"<>]+(?=@)/gi },
  // `AKIA` is a long-term access key ID; `ASIA` is the temporary one that STS,
  // SSO and instance roles hand out (`aws sts assume-role`, `aws configure
  // export-credentials`), printed next to its secret and session token.
  { name: "aws_access_key", regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  // Anchored to its key names: `AWS_SECRET_ACCESS_KEY=…` in env output,
  // `aws_secret_access_key = …` in ~/.aws/credentials and SDK arguments (any
  // letter case), and `"SecretAccessKey": "…"` in `aws sts` / `aws configure
  // export-credentials` JSON, which prints it beside the ASIA key ID and the
  // session token. keyedLookbehind also takes JSON-style `"KEY": "val"`.
  { name: "aws_secret_key", regex: new RegExp(`${keyedLookbehind(String.raw`(?:aws_secret_access_key|\bSecretAccessKey)`)}[A-Za-z0-9/+=]{40}`, "gi") },
  // The session token of temporary credentials (STS, SSO, `aws configure
  // export-credentials`) grants access together with the key pair, so it is
  // anchored to its key names the same way: `AWS_SESSION_TOKEN=…` in env
  // output, `aws_session_token = …` in ~/.aws/credentials and
  // `"SessionToken": "…"` in `aws sts` JSON. Real tokens run to hundreds of
  // base64 characters; the 100-char floor keeps short placeholders out.
  { name: "aws_session_token", regex: new RegExp(`${keyedLookbehind(String.raw`\b(?:aws_session_token|SessionToken)`)}[A-Za-z0-9/+=]{100,}`, "gi") },
  { name: "github_pat", regex: /\bgh[oprsu]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  // openai_key, anthropic_key, slack_token, jwt and google_api_key end in a
  // class that includes `-`. A closing `\b` after a `-` needs a word character
  // to follow, so a Google key ending in `-` was not redacted at all and the
  // others left their final `-` in the stored text. `(?!\w)` is the same
  // "the token ends here" check without that gap.
  { name: "openai_key", regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}(?!\w)/g },
  { name: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}(?!\w)/g },
  // Slack bot/user/legacy tokens (`xoxb-`, `xoxp-`, …), refresh tokens from
  // token rotation (`xoxe-`) and app-level Socket Mode tokens (`xapp-`).
  { name: "slack_token", regex: /\b(?:xox[abeprs]|xapp)-[A-Za-z0-9-]{10,}(?!\w)/g },
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?!\w)/g },
  // A PGP secret key is armored as `PRIVATE KEY BLOCK`, and an encrypted
  // PKCS#8 key as `ENCRYPTED PRIVATE KEY`.
  { name: "private_key_pem", regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  // API keys (`sk_`/`pk_`/`rk_`) and webhook signing secrets (`whsec_`, what
  // `stripe listen` prints and STRIPE_WEBHOOK_SECRET holds), which forge events.
  { name: "stripe_key", regex: /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}|whsec_[A-Za-z0-9]{32,})\b/g },
  { name: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}(?!\w)/g },
  // Google OAuth 2.0 access tokens: `ya29.` + a base64url body, plus the
  // `ya29.c.` form the GCE metadata server hands out. `gcloud auth
  // print-access-token`, `curl -H "Authorization: Bearer …"` lines and token
  // JSON print them; each grants an hour of the account's API access.
  { name: "google_oauth_token", regex: /\bya29\.(?:c\.)?[0-9A-Za-z_-]{20,}(?!\w)/g },
  // GitLab personal/project/group access tokens (`glpat-`), deploy tokens (`gldt-`),
  // and runner authentication tokens (`glrt-` + 20 chars; newer routable tokens
  // add dot-separated segments), Hugging Face user access tokens (`hf_` + 34 chars),
  // npm access tokens (`npm_` + 36 chars) and Docker Hub personal access tokens
  // (`dckr_pat_` + 27 chars): credentials printed in config files, CLI commands
  // (`glab`, `huggingface-cli`, `npm`, `docker login`), and env dumps.
  { name: "gitlab_token", regex: /\bgl(?:pat|dt|rt)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*(?!\w)/g },
  { name: "huggingface_token", regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: "npm_token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "docker_pat", regex: /\bdckr_pat_[A-Za-z0-9_-]{27,}(?!\w)/g },
  // Linear personal API keys (`lin_api_` + 40 alphanumerics) and Notion
  // integration tokens (`ntn_` + 46 alphanumerics, and the older `secret_` +
  // 43): what `LINEAR_API_KEY=…` / `NOTION_TOKEN=…` lines, MCP server configs
  // and `curl -H "Authorization: …"` commands print. Fixed lengths keep
  // `secret_` words and short look-alikes out.
  { name: "linear_key", regex: /\blin_api_[A-Za-z0-9]{40}(?!\w)/g },
  { name: "notion_token", regex: /\b(?:ntn_[A-Za-z0-9]{46}|secret_[A-Za-z0-9]{43})(?!\w)/g },
  // SendGrid API keys (`SG.` + 22 + `.` + 43 base64url chars), DigitalOcean
  // personal access, OAuth and refresh tokens (`dop_v1_`/`doo_v1_`/`dor_v1_` +
  // 64 hex) and Shopify Admin API, app and shared-secret tokens (`shpat_`,
  // `shpca_`, `shppa_`, `shpss_` + 32 hex): what `doctl`, the Shopify CLI and
  // `.env` dumps print.
  { name: "sendgrid_key", regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![\w-])/g },
  { name: "digitalocean_token", regex: /\bdo[opr]_v1_[a-f0-9]{64}\b/g },
  { name: "shopify_token", regex: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
  // PyPI API tokens: `pypi-` + a base64url macaroon whose header always
  // starts `AgE` (pypi.org and test.pypi.org alike), printed by `twine`,
  // `uv publish` and `~/.pypirc` dumps. Real tokens run past 150 characters.
  { name: "pypi_token", regex: /\bpypi-AgE[A-Za-z0-9_-]{50,}(?!\w)/g },
  // Databricks personal access tokens (`dapi` + 32 hex, sometimes with a
  // `-<digit>` suffix) that DATABRICKS_TOKEN, `~/.databrickscfg` and
  // `databricks tokens create` print, and HashiCorp Vault service and batch
  // tokens (`hvs.` + 90-120 and `hvb.` + 138-300 base64url chars) that
  // VAULT_TOKEN, `~/.vault-token` and `vault login` / `vault token create`
  // print.
  { name: "databricks_token", regex: /\bdapi[a-f0-9]{32}(?:-\d)?(?!\w)/g },
  { name: "vault_token", regex: /\b(?:hvs\.[\w-]{90,120}|hvb\.[\w-]{138,300})(?![\w-])/g },
  // Two OpenAI-compatible providers this project onboards users for
  // (src/shared/openai-compat-presets.ts): NVIDIA NIM issues `nvapi-` keys and
  // Runcrate issues `rc_live_` keys. Both presets tell the user the prefix in
  // their installer hint, and neither was claimed by openai_key (`sk-`), so a
  // key pasted into a session (or printed by a `curl`/`.env` dump) was stored
  // verbatim. 32+ trailing chars keeps short placeholders out.
  { name: "nvidia_nim_key", regex: /\bnvapi-[A-Za-z0-9_-]{32,}(?!\w)/g },
  { name: "runcrate_key", regex: /\brc_live_[A-Za-z0-9_-]{24,}(?!\w)/g },
  // Groq API keys (`gsk_` + 52 alphanumerics) and xAI API keys (`xai-` + 80
  // chars): LLM provider keys that `.env` files, `export GROQ_API_KEY=…` /
  // `XAI_API_KEY=…` lines and `curl -H "Authorization: Bearer …"` commands
  // print. Neither prefix is claimed by openai_key, so they stayed in the text.
  { name: "groq_key", regex: /\bgsk_[A-Za-z0-9]{52}(?!\w)/g },
  { name: "xai_key", regex: /\bxai-[A-Za-z0-9_]{80}(?!\w)/g },
  // Perplexity API keys (`pplx-` + 48 alphanumerics): an LLM provider key
  // that `.env` files, `export PERPLEXITY_API_KEY=…` lines and `curl -H
  // "Authorization: Bearer …"` commands print. The prefix is not claimed by
  // openai_key, and Perplexity model ids share it (`pplx-embed-v1-4b`), so
  // the fixed 48-char alphanumeric body keeps the model ids out.
  { name: "perplexity_key", regex: /\bpplx-[A-Za-z0-9]{48}(?!\w)/g },
  // Supabase personal access tokens (`sbp_` + 40 hex, what `supabase login`
  // stores and SUPABASE_ACCESS_TOKEN holds) and Sentry auth tokens: personal
  // ones (`sntryu_` + 64 hex) and organization ones (`sntrys_` + a base64
  // payload + `_` + a 43-char base64 secret), which SENTRY_AUTH_TOKEN lines,
  // `.sentryclirc` dumps and source-map upload commands print.
  { name: "supabase_token", regex: /\bsbp_[a-f0-9]{40}(?!\w)/g },
  { name: "sentry_token", regex: /\b(?:sntryu_[a-f0-9]{64}(?!\w)|sntrys_[A-Za-z0-9+\/]{20,}={0,2}_[A-Za-z0-9+\/]{43}(?![\w+\/]))/g },
  // Grafana tokens: service account tokens (`glsa_` + 32 alphanumerics + `_`
  // + an 8-hex checksum) and Grafana Cloud access policy / API tokens (`glc_`
  // + a base64 payload), which GRAFANA_TOKEN / GRAFANA_SERVICE_ACCOUNT_TOKEN
  // lines, Terraform provider configs and `curl -H "Authorization: Bearer …"`
  // commands print. Postman API keys (`PMAK-` + 24 hex + `-` + 34 hex), which
  // POSTMAN_API_KEY lines and `newman` / `postman` CLI commands print.
  { name: "grafana_token", regex: /\b(?:glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}(?!\w)|glc_[A-Za-z0-9+\/]{32,400}={0,2}(?![\w+\/=]))/g },
  { name: "postman_key", regex: /\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}(?!\w)/g },
  // Pulumi access tokens (`pul-` + 40 hex), which PULUMI_ACCESS_TOKEN lines,
  // `pulumi login` output and CI configs print. Doppler personal tokens
  // (`dp.pt.` + 43 alphanumerics), which DOPPLER_TOKEN lines and
  // `doppler configure` dumps print.
  { name: "pulumi_token", regex: /\bpul-[a-f0-9]{40}(?!\w)/g },
  { name: "doppler_token", regex: /\bdp\.pt\.[A-Za-z0-9]{43}(?!\w)/g },
  // Heroku API keys in the current format (`HRKU-AA` + 58 characters), which
  // HEROKU_API_KEY lines, `heroku auth:token` output and ~/.netrc dumps print.
  // Atlassian API tokens (`ATATT3` + 186 characters), which JIRA_API_TOKEN /
  // CONFLUENCE_API_TOKEN lines and `acli` / `curl -u user:token` commands print.
  { name: "heroku_key", regex: /\bHRKU-AA[0-9A-Za-z_-]{58}(?![\w-])/g },
  { name: "atlassian_token", regex: /\bATATT3[A-Za-z0-9_=-]{186}(?![\w=-])/g },
  // Incoming webhook URLs carry their secret in the path, so anyone holding
  // one can post to the channel: Slack (`hooks.slack.com/services/T…/B…/…`,
  // plus workflow and trigger URLs) and Discord (`discord.com/api/webhooks/
  // <id>/<token>`, discordapp.com and the ptb/canary hosts too), as printed by
  // `.env` dumps, CI configs and `curl -X POST` commands. Only the last path
  // segment is replaced, so the host and the workspace/channel ids stay
  // readable. The host must start the URL's host part (after `//`, `@`, or a
  // non-URL character), so `example.com/hooks.slack.com/…` keeps its path, and
  // it matches in any letter case, as DNS does; the path stays case-sensitive.
  { name: "slack_webhook", regex: new RegExp(String.raw`(?<=${webhookHost(String.raw`hooks\.slack\.com`)}\/(?:services|workflows|triggers)\/T[A-Z0-9]+\/[A-Z0-9]+\/(?:[0-9]+\/)?)[A-Za-z0-9]{20,}(?!\w)`, "g") },
  { name: "discord_webhook", regex: new RegExp(String.raw`(?<=${webhookHost(String.raw`(?:(?:ptb|canary)\.)?discord(?:app)?\.com`)}\/api\/(?:v\d+\/)?webhooks\/[0-9]{17,20}\/)[A-Za-z0-9_-]{60,}(?![\w-])`, "g") },
  // claude-mem's own credentials: server API keys (`cmem_` + 43 base64url
  // chars, server-bootstrap.ts createRawApiKey) and cmem.ai Pro memory keys.
  { name: "claude_mem_key", regex: /\bcmem_[A-Za-z0-9_-]{32,}|\bcm_pro_[A-Za-z0-9_-]{8,}/g }
].map(matchAfterEscapedWhitespace);
var GENERIC_REDACTION_PATTERNS = [
  // `pwd` only as a suffix (`DB_PWD`, `MYSQL_PWD`): the bare `PWD` and
  // `OLDPWD` environment variables hold a working directory, not a secret.
  { name: "generic_password", regex: genericBuiltinRegex(keyedLookbehind(String.raw`\b(?:\w*_?(?:password|passwd)|\w+_pwd)`)) },
  { name: "generic_token", regex: GENERIC_TOKEN_REGEX },
  { name: "bearer_token", regex: genericBuiltinRegex(`(?<=\\bAuthorization${OPTIONAL_QUOTE}${BOUNDED_SPACE}:${BOUNDED_SPACE}${OPTIONAL_QUOTE}Bearer${BOUNDED_SPACE})`) },
  // `Authorization: Basic …` carries base64(user:password), a password anyone
  // can decode, as in `curl -H "Authorization: Basic dXNlcjpodW50ZXIy"`.
  { name: "basic_auth", regex: genericBuiltinRegex(`(?<=\\bAuthorization${OPTIONAL_QUOTE}${BOUNDED_SPACE}:${BOUNDED_SPACE}${OPTIONAL_QUOTE}Basic${BOUNDED_SPACE})`) }
];
var MAX_INPUT_CHARS = 1024 * 1024;
var OVERSIZE_MARKER = "<redacted type='oversize'/>";
function redactSensitive(input, config) {
  if (!config.enabled || input.length === 0) {
    return { redacted: input, counts: {}, oversize: false };
  }
  if (input.length > MAX_INPUT_CHARS) {
    logger.warn("REDACT", "field exceeds the 1M-char redaction cap; replaced by an oversize marker", void 0, {
      inputLength: input.length
    });
    return { redacted: OVERSIZE_MARKER, counts: { oversize: 1 }, oversize: true };
  }
  const disabled = new Set(config.disabledBuiltinPatterns ?? []);
  const counts = {};
  let working = input;
  const compiledCustom = [];
  for (const cp of config.customPatterns ?? []) {
    if (!cp.name || cp.name.length === 0) {
      logger.warn("REDACT", "custom pattern skipped: missing name", void 0, { pattern: cp });
      continue;
    }
    try {
      compiledCustom.push({ name: cp.name, regex: new RegExp(cp.regex, "g") });
    } catch (error) {
      logger.warn("REDACT", "custom pattern skipped: invalid regex", { name: cp.name }, error instanceof Error ? error : new Error(String(error)));
    }
  }
  const allPatterns = [
    ...compiledCustom,
    ...BUILTIN_REDACTION_PATTERNS,
    ...config.genericEnabled ? GENERIC_REDACTION_PATTERNS : []
  ];
  for (const pattern of allPatterns) {
    if (disabled.has(pattern.name)) continue;
    pattern.regex.lastIndex = 0;
    working = working.replace(pattern.regex, () => {
      counts[pattern.name] = (counts[pattern.name] ?? 0) + 1;
      return `<redacted type='${pattern.name}'/>`;
    });
  }
  if (config.logMatches && Object.keys(counts).length > 0) {
    logger.debug("REDACT", "patterns matched", void 0, { counts });
  }
  return { redacted: working, counts, oversize: false };
}
function safeParseCustomPatterns(raw) {
  if (!raw || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn("REDACT", "CLAUDE_MEM_REDACT_CUSTOM_PATTERNS is not a JSON array, ignoring");
      return [];
    }
    return parsed.filter((p) => p && typeof p.name === "string" && typeof p.regex === "string");
  } catch (error) {
    logger.warn(
      "REDACT",
      "failed to parse CLAUDE_MEM_REDACT_CUSTOM_PATTERNS as JSON",
      void 0,
      error instanceof Error ? error : new Error(String(error))
    );
    return [];
  }
}
function loadRedactionConfig(settings) {
  return {
    enabled: settings.CLAUDE_MEM_REDACT_ENABLED === "true",
    disabledBuiltinPatterns: (settings.CLAUDE_MEM_REDACT_DISABLED_BUILTINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    customPatterns: safeParseCustomPatterns(settings.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS ?? "[]"),
    logMatches: settings.CLAUDE_MEM_REDACT_LOG_MATCHES === "true",
    genericEnabled: settings.CLAUDE_MEM_REDACT_GENERIC_ENABLED === "true"
  };
}
var cachedConfig = null;
var cacheStamp = 0;
var CACHE_TTL_MS = 5e3;
var lastLoadedConfig = null;
var warnedUnreadableSettings = false;
var BUILTINS_ONLY = { enabled: true, disabledBuiltinPatterns: [], customPatterns: [], logMatches: false };
var REDACTION_REQUESTED_IN_RAW = /"CLAUDE_MEM_REDACT_ENABLED"\s*:\s*"true"/;
function readSettingsText(settingsPath) {
  if (!existsSync(settingsPath)) return null;
  try {
    return readFileSync(settingsPath, "utf-8");
  } catch {
    return "";
  }
}
function isUnreadableSettings(text) {
  if (text === null) return false;
  try {
    const parsed = JSON.parse(stripUtf8Bom(text));
    return parsed === null || typeof parsed !== "object" || Array.isArray(parsed);
  } catch {
    return true;
  }
}
function configForUnreadableSettings(settingsPath, text, loaded) {
  if (process.env.CLAUDE_MEM_REDACT_ENABLED === "false") return loaded;
  const requested = lastLoadedConfig?.enabled === true || REDACTION_REQUESTED_IN_RAW.test(text);
  if (!requested) return loaded;
  if (!warnedUnreadableSettings) {
    warnedUnreadableSettings = true;
    logger.warn("REDACT", "settings.json could not be read; secret redaction stays on until it is repaired", {
      settingsPath,
      using: lastLoadedConfig?.enabled ? "the last configuration that loaded" : "the built-in patterns"
    });
  }
  return lastLoadedConfig?.enabled ? lastLoadedConfig : BUILTINS_ONLY;
}
function getRedactionConfig(settingsPath = USER_SETTINGS_PATH) {
  const now = Date.now();
  if (cachedConfig && now - cacheStamp < CACHE_TTL_MS) {
    return cachedConfig;
  }
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const loaded = loadRedactionConfig(settings);
  const text = loaded.enabled ? null : readSettingsText(settingsPath);
  if (isUnreadableSettings(text)) {
    cachedConfig = configForUnreadableSettings(settingsPath, text, loaded);
  } else {
    cachedConfig = loaded;
    lastLoadedConfig = loaded;
  }
  cacheStamp = now;
  return cachedConfig;
}
var GENERIC_PASSWORD_KEY = /(?:password|passwd)$|\w_pwd$/i;
var GENERIC_TOKEN_KEY = /(?:^|_)(?:secret|token|api_key)$/i;
var WHOLE_GENERIC_VALUE = new RegExp(`^${GENERIC_VALUE_CLASS}{8,}$`);
function genericMarkerForKeyedValue(key, value, config) {
  if (!config.genericEnabled) return null;
  const name = GENERIC_PASSWORD_KEY.test(key) ? "generic_password" : GENERIC_TOKEN_KEY.test(key) ? "generic_token" : null;
  if (!name) return null;
  if (config.disabledBuiltinPatterns?.includes(name)) return null;
  if (!WHOLE_GENERIC_VALUE.test(value) || !/[A-Za-z]/.test(value)) return null;
  return `<redacted type='${name}'/>`;
}
var AUTHORIZATION_KEY = /^(?:proxy-)?authorization$/i;
var KEYED_BEARER_VALUE = new RegExp(`^(${BOUNDED_SPACE}Bearer${BOUNDED_SPACE})${GENERIC_VALUE}`, "i");
function bearerMarkerForKeyedValue(key, value, config) {
  if (!config.genericEnabled || config.disabledBuiltinPatterns?.includes("bearer_token")) return null;
  if (!AUTHORIZATION_KEY.test(key)) return null;
  const match = KEYED_BEARER_VALUE.exec(value);
  return match ? `${match[1]}<redacted type='bearer_token'/>${value.slice(match[0].length)}` : null;
}
var KEYED_BASIC_VALUE = new RegExp(`^(${BOUNDED_SPACE}Basic${BOUNDED_SPACE})${GENERIC_VALUE}`, "i");
function basicMarkerForKeyedValue(key, value, config) {
  if (!config.genericEnabled || config.disabledBuiltinPatterns?.includes("basic_auth")) return null;
  if (!AUTHORIZATION_KEY.test(key)) return null;
  const match = KEYED_BASIC_VALUE.exec(value);
  return match ? `${match[1]}<redacted type='basic_auth'/>${value.slice(match[0].length)}` : null;
}
var AWS_SESSION_TOKEN_KEY = /^(?:aws_session_token|SessionToken)$/i;
var WHOLE_AWS_SESSION_TOKEN_VALUE = /^[A-Za-z0-9/+=]{100,}$/;
function awsSessionTokenMarkerForKeyedValue(key, value, config) {
  if (config.disabledBuiltinPatterns?.includes("aws_session_token")) return null;
  if (!AWS_SESSION_TOKEN_KEY.test(key) || !WHOLE_AWS_SESSION_TOKEN_VALUE.test(value)) return null;
  return "<redacted type='aws_session_token'/>";
}
var AWS_SECRET_KEY_KEY = /^(?:aws_secret_access_key|SecretAccessKey)$/i;
var WHOLE_AWS_SECRET_KEY_VALUE = /^[A-Za-z0-9/+=]{40}$/;
function awsSecretKeyMarkerForKeyedValue(key, value, config) {
  if (config.disabledBuiltinPatterns?.includes("aws_secret_key")) return null;
  if (!AWS_SECRET_KEY_KEY.test(key) || !WHOLE_AWS_SECRET_KEY_VALUE.test(value)) return null;
  return "<redacted type='aws_secret_key'/>";
}
var COOKIE_KEY = /^(?:set-)?cookie$/i;
function cookieMarkerForKeyedValue(key, value, config) {
  if (config.disabledBuiltinPatterns?.includes("cookie_header")) return null;
  if (!COOKIE_KEY.test(key) || value.trim().length < 4) return null;
  return "<redacted type='cookie_header'/>";
}
function redactJsonStrings(value, config = getRedactionConfig()) {
  if (!config.enabled) return value;
  const walk = (node, key) => {
    if (typeof node === "string") {
      const cookieMarker = key === void 0 ? null : cookieMarkerForKeyedValue(key, node, config);
      if (cookieMarker) return cookieMarker;
      const result = redactSensitive(node, config);
      if (key === void 0 || Object.keys(result.counts).length > 0) return result.redacted;
      return awsSessionTokenMarkerForKeyedValue(key, node, config) ?? awsSecretKeyMarkerForKeyedValue(key, node, config) ?? bearerMarkerForKeyedValue(key, node, config) ?? basicMarkerForKeyedValue(key, node, config) ?? genericMarkerForKeyedValue(key, node, config) ?? result.redacted;
    }
    if (Array.isArray(node)) return node.map((child) => walk(child, key !== void 0 && COOKIE_KEY.test(key) ? key : void 0));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([childKey, child]) => [childKey, walk(child, childKey)]));
    }
    return node;
  };
  return walk(value);
}

// validation/upstream/claude-mem/src/services/sync/diagnostic-redaction.ts
var MAX_DIAGNOSTIC_CHARS = 1024 * 1024;
var BUDGET_MARKER = "<redacted type='diagnostic_budget'/>";
function redactSyncDiagnostic(value, config = getRedactionConfig()) {
  if (!config.enabled) return value;
  let remainingNodes = 5e4;
  const text = (input, keys = []) => {
    if (!keys.length) return redactSensitive(input, config).redacted;
    for (const key of keys) {
      const redacted = redactJsonStrings({ [key]: input }, config)[key];
      if (redacted !== input) return redacted;
    }
    return input;
  };
  const walk = (input, depth, keys = []) => {
    if (depth > 32 || --remainingNodes < 0) return BUDGET_MARKER;
    if (typeof input === "string") {
      if (input.length > MAX_DIAGNOSTIC_CHARS) return redactSensitive(input, config).redacted;
      try {
        const parsed = JSON.parse(input);
        if (parsed !== null && (typeof parsed === "object" || typeof parsed === "string")) {
          const sanitized = walk(parsed, depth + 1, keys);
          const serialized = JSON.stringify(sanitized);
          if (serialized !== JSON.stringify(parsed)) return serialized;
        }
      } catch {
      }
      return text(input, keys);
    }
    if (Array.isArray(input)) return input.length > remainingNodes ? BUDGET_MARKER : input.map((item) => walk(item, depth + 1, keys));
    if (input && typeof input === "object") {
      const entries = Object.entries(input);
      if (entries.length > remainingNodes) return BUDGET_MARKER;
      return Object.fromEntries(entries.map(([name, item]) => [text(name, keys), walk(item, depth + 1, [name, ...keys])]));
    }
    return input;
  };
  return walk(value, 0);
}

// validation/upstream/claude-mem/src/shared/media-contract.ts
var MEDIA_LIMITS = Object.freeze({
  // Abuse protection: caps one event at 4 stored images (about 13 MiB) and one
  // observer turn at 4 derivatives (maxGatewayImageBytes).
  maxImagesPerEvent: 4,
  // Provider maximum: Vercel Functions take request bodies up to 4.5 MB; this
  // plus maxUploadBodyBytes' multipart overhead (3.06 MiB, 3.2 MB) fits.
  maxSourceBytes: 3 * 1024 * 1024,
  // Same bound for the stored full-size copy: a lossless re-encode of an accepted
  // source must still fit, and a stored copy is served back in one Vercel
  // response, also limited to 4.5 MB.
  maxCanonicalBytes: 3 * 1024 * 1024,
  // Owner's rule, 2026-11-05/06: no stored copy is multiple megabytes, and every
  // copy is lossy WebP. Both converters fit each canonical they encode into this.
  // maxCanonicalBytes stays the bound for an accepted upload and for reading a
  // copy stored before this rule (lossless, up to 3 MiB). Measured 2026-11-06 at
  // quality 80: the largest of 29 real screenshots is 406 KiB, and a 2800x23880
  // full-page screenshot fitted to 8192 px is 528 KiB, so all keep full
  // resolution with about 2 times headroom.
  maxEncodedCanonicalBytes: 1024 * 1024,
  // Abuse protection (decompression bombs): a decode holds about 4 bytes per
  // pixel, so at most about 96 MB. A 6016x3384 display (20.4 million px) fits.
  maxPixels: 24e6,
  // Abuse protection: bounds long thin images that pass maxPixels. An 8K
  // display (7680 px wide) fits.
  maxDimension: 8192,
  // Abuse protection: one conversion holds a shared instance's CPU. The upload
  // route's 59 s maxDuration fits this plus two 20 s Storage writes.
  conversionTimeoutSeconds: 5,
  // Abuse protection: instances serve concurrent requests, so one decode of up
  // to about 96 MB runs at a time; others fail fast as conversion_busy and retry.
  maxConcurrentConversions: 1,
  // Abuse protection on what a model is sent: 4 of these make the 1 MiB
  // maxGatewayImageBytes.
  maxDerivativeBytes: 256 * 1024,
  // Provider maximum: Anthropic downscales images whose long edge is above
  // 1,568 px (standard tier, platform.claude.com/docs/en/build-with-claude/vision),
  // so pixels beyond that cost tokens and add nothing.
  maxDerivativeDimension: 1536,
  // One largest source as base64 (3 MiB x 4/3 = 4 MiB), so the local event JSON
  // stays under its existing 5 MB cap.
  maxInlineEncodedBytes: 4 * 1024 * 1024,
  // Abuse protection: metadata.cmem_media_v1 syncs to every device; 32 refs of
  // about 120 bytes each stay inside maxManifestBytes.
  maxObservationRefs: 32,
  // Abuse protection: labels are generated (event1_image1); 64 leaves room and
  // keeps a ref small.
  maxLabelChars: 64,
  // Abuse protection: bounds one manifest; 32 refs need about 4 KiB.
  maxManifestBytes: 8192,
  // Abuse protection: bounds the private provenance row; its largest part is
  // the 4096-character locator.
  maxProvenanceBytes: 8192,
  // Operating-system maximum: PATH_MAX is 4096 on Linux (1024 on macOS).
  maxSourceLocatorChars: 4096,
  // maxImagesPerEvent x maxDerivativeBytes: the most one observer turn can send.
  maxGatewayImageBytes: 4 * 256 * 1024,
  // maxSourceBytes plus 64 KiB for the manifest (8 KiB at most) and multipart
  // headers; still under Vercel's 4.5 MB request body maximum.
  maxUploadBodyBytes: 3 * 1024 * 1024 + 64 * 1024,
  // Abuse protection, sized so a paying user's images are not refused (owner,
  // 2026-11-05: "dont throw away images, on cloud they'll be PAYING me").
  // Measured 2026-11-05: the median converted pair (canonical plus derivative)
  // of 27 real screenshots is 321 KiB, so 100 screenshots a day is about
  // 11.2 GiB a year. Past the Pro plan's 100 GB, Supabase Storage costs $0.0213
  // per GB a month (supabase.com/docs/guides/platform/manage-your-usage/
  // storage-size, read 2026-11-05), so a full owner (26.8 GB) costs about $0.57
  // a month. Pro enforces it: uploads past it answer 413 quota_exceeded and the
  // image stays on the computer.
  ownerQuotaBytes: 25 * 1024 * 1024 * 1024
});

// validation/upstream/claude-mem/src/services/sync/CanonicalContent.ts
var MUTATION_FIELD_MAX_BYTES = 4096;
var MUTATION_OPS = /* @__PURE__ */ new Set(["set_title", "set_prompt_session", "remap_project"]);
var CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
var UINT64_MAX = 18446744073709551615n;
function jsonError(message) {
  const reason = redactSyncDiagnostic(message);
  logger.debug("CLOUD_SYNC", "Rejected invalid canonical content", { reason });
  throw new Error(`canonical content: ${reason}`);
}
function assertCanonicalDecimal(value, options = {}) {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) {
    return jsonError("decimal values must be unsigned base-10 strings without leading zeroes");
  }
  if (BigInt(value) > UINT64_MAX) jsonError("decimal value exceeds uint64");
  if (options.positive && value === "0") jsonError("decimal value must be positive");
  return value;
}
function incrementCanonicalDecimal(value) {
  const canonical = assertCanonicalDecimal(value);
  if (BigInt(canonical) === UINT64_MAX) jsonError("uint64 sequence overflow");
  return (BigInt(canonical) + 1n).toString(10);
}
function validateMutation(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) jsonError("mutation must be an object");
  const mutation = value;
  if (typeof mutation.op !== "string" || !MUTATION_OPS.has(mutation.op)) jsonError("unsupported mutation op");
  if (mutation.op === "set_title") {
    const record2 = exactObject(mutation, ["fields", "op", "target"], "set_title");
    const target = exactSubsetObject(record2.target, ["content_session_id", "memory_session_id", "platform_source"], "set_title.target");
    if (target.memory_session_id === void 0 && target.content_session_id === void 0) {
      jsonError("set_title target requires a session identifier");
    }
    for (const key of ["memory_session_id", "content_session_id", "platform_source"]) {
      if (target[key] !== void 0) nonEmptyString(target[key], key);
    }
    const fields2 = exactObject(record2.fields, ["custom_title"], "set_title.fields");
    nonEmptyString(fields2.custom_title, "custom_title");
    return;
  }
  if (mutation.op === "set_prompt_session") {
    const record2 = exactObject(mutation, ["fields", "op", "target"], "set_prompt_session");
    const target = exactObject(record2.target, ["origin_device_id", "origin_local_id"], "set_prompt_session.target");
    assertDeviceId(target.origin_device_id);
    assertCanonicalDecimal(target.origin_local_id);
    const fields2 = exactSubsetObject(
      record2.fields,
      ["content_session_id", "memory_session_id", "platform_source", "project"],
      "set_prompt_session.fields"
    );
    nonEmptyString(fields2.memory_session_id, "memory_session_id");
    for (const key of ["content_session_id", "platform_source", "project"]) {
      if (fields2[key] !== void 0) nonEmptyString(fields2[key], key);
    }
    return;
  }
  const record = exactObject(mutation, ["fields", "op", "where"], "remap_project");
  const where = exactSubsetObject(
    record.where,
    ["memory_session_id", "merged_into_project_is_null", "project"],
    "remap_project.where"
  );
  if (where.project !== void 0) nonEmptyString(where.project, "project");
  if (where.memory_session_id !== void 0) nonEmptyString(where.memory_session_id, "memory_session_id");
  if (where.merged_into_project_is_null !== void 0 && where.merged_into_project_is_null !== true) {
    jsonError("merged_into_project_is_null may only be true");
  }
  if (Object.keys(where).length === 0) jsonError("remap_project where is empty");
  const fields = exactSubsetObject(record.fields, ["merged_into_project", "project"], "remap_project.fields");
  if (fields.project !== void 0) nonEmptyString(fields.project, "project");
  if (fields.merged_into_project !== void 0) nonEmptyString(fields.merged_into_project, "merged_into_project");
  if (Object.keys(fields).length === 0) jsonError("remap_project fields are empty");
}
function validateCanonicalMutation(value) {
  validateMutation(value);
}
function assertDeviceId(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 128) {
    return jsonError("origin_device_id must be a non-empty string of at most 128 UTF-8 bytes");
  }
  return value;
}
function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > MUTATION_FIELD_MAX_BYTES) {
    return jsonError(`${name} must be a non-blank string of at most ${MUTATION_FIELD_MAX_BYTES} UTF-8 bytes`);
  }
  return value;
}
function exactObject(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return jsonError(`${name} must be an object`);
  const record = value;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    jsonError(`${name} must contain exactly: ${expected.join(", ")}`);
  }
  return record;
}
function exactSubsetObject(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return jsonError(`${name} must be an object`);
  const record = value;
  const allowed = new Set(keys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) jsonError(`${name} contains unknown field ${unknown}`);
  return record;
}

// validation/upstream/claude-mem/src/services/work-view/shared-records.mjs
var isSharedWorkList = (value) => typeof value === "string" && /^__my_work_v\d+:/.test(value);
var sharedWorkListSql = (expression) => `(COALESCE(${expression}, '') GLOB '__my_work_v[0-9]*:*'
  AND substr(${expression}, 12, instr(substr(${expression}, 12), ':') - 1) NOT GLOB '*[^0-9]*')`;

// validation/upstream/claude-mem/src/services/sqlite/work-state.ts
function scopeWorkStateEntries(entries, projects) {
  const foldKey = (key) => key.replace(/[A-Z]/g, (character) => character.toLowerCase());
  const aliases = new Set(projects.map(foldKey));
  const primary = projects.at(-1);
  return entries.map((entry) => primary && aliases.has(foldKey(entry.project)) ? { ...entry, scope_project: primary } : entry);
}
function createWorkStateSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS work_state_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      list_name TEXT NOT NULL,
      fields TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_work_state_entries_project ON work_state_entries(project COLLATE NOCASE, list_name, id)");
  ensureWorkStateSyncColumns(db);
}
function ensureWorkStateSyncColumns(db) {
  const columns = new Set(
    db.query("PRAGMA table_info(work_state_entries)").all().map((column) => column.name)
  );
  if (!columns.has("synced_at")) db.run("ALTER TABLE work_state_entries ADD COLUMN synced_at INTEGER");
  if (!columns.has("origin_device_id")) db.run("ALTER TABLE work_state_entries ADD COLUMN origin_device_id TEXT");
  if (!columns.has("origin_local_id")) db.run("ALTER TABLE work_state_entries ADD COLUMN origin_local_id TEXT");
  if (!columns.has("sync_rev")) db.run("ALTER TABLE work_state_entries ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'");
  db.run("CREATE INDEX IF NOT EXISTS idx_work_state_entries_unsynced ON work_state_entries(id) WHERE synced_at IS NULL");
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_work_state_entries_origin
    ON work_state_entries(origin_device_id, origin_local_id)
    WHERE origin_device_id IS NOT NULL
  `);
}
function appendWorkStateEntry(db, entry) {
  const createdAtEpoch = entry.createdAtEpoch ?? Date.now();
  const result = db.prepare(`
    INSERT INTO work_state_entries (project, list_name, fields, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(entry.project, entry.listName, JSON.stringify(entry.fields), new Date(createdAtEpoch).toISOString(), createdAtEpoch);
  const id = Number(result.lastInsertRowid);
  logger.debug("DB", "Work state entry appended", { id, project: entry.project, listName: entry.listName });
  return id;
}
function getWorkStateEntries(db, projects, listName, localDeviceId = "") {
  if (projects.length === 0 || isSharedWorkList(listName)) return [];
  const placeholders = projects.map(() => "?").join(", ");
  const listFilter = listName === void 0 ? "" : " AND list_name = ?";
  const statement = db.prepare(`
    SELECT id, project, list_name, fields, created_at_epoch
    FROM work_state_entries
    WHERE project COLLATE NOCASE IN (${placeholders})${listFilter}
      AND NOT (
        list_name GLOB '__my_work_v[0-9]*:*'
        AND substr(list_name, 12, instr(substr(list_name, 12), ':') - 1) NOT GLOB '*[^0-9]*'
      )
    ORDER BY created_at_epoch, COALESCE(origin_device_id, ?), COALESCE(CAST(origin_local_id AS INTEGER), id)
  `);
  try {
    const rows = statement.all(...projects, ...listName === void 0 ? [] : [listName], localDeviceId);
    return rows.map((row) => ({ ...row, fields: JSON.parse(row.fields) }));
  } finally {
    statement.finalize();
  }
}

// validation/upstream/claude-mem/src/services/sqlite/dedup-store.ts
import { createHash as createHash3 } from "crypto";

// validation/upstream/claude-mem/src/services/dedup/normalize.ts
function normalizeTitle(s) {
  const normalized = (s ?? "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(normalized) ? normalized : "";
}
function exactTitleMatch(a, b) {
  const norm = normalizeTitle(a);
  if (!norm || norm !== normalizeTitle(b)) return false;
  const identifiers = (value) => ((value ?? "").normalize("NFC").toLowerCase().trim().replace(/^__([\s\S]*\s[\s\S]*)__$/u, "$1").match(/[\p{L}\p{N}\p{M}._/\\:@#=<>+~-]+/gu) ?? []).map((token) => /^(?:\.+)$|[/\\]\.+$/u.test(token) ? token : token.replace(/\.+$/u, "")).filter((token) => /^\.+$/u.test(token) || /[/\\]/.test(token) || /[\p{L}\p{N}]/u.test(token) && (/[._@#=<>+~]/.test(token) || /[\p{L}\p{N}\p{M}]:+[\p{L}\p{N}\p{M}]/u.test(token) || /^[a-z]:$/u.test(token)));
  return JSON.stringify(identifiers(a)) === JSON.stringify(identifiers(b));
}
function tokenizeWs(s) {
  return (s ?? "").toLowerCase().trim().split(/\s+/).filter(Boolean);
}

// validation/upstream/claude-mem/src/services/sqlite/stream-rows.ts
var warnedMissingIterate = false;
function streamRows(statement, ...params) {
  if (typeof statement.iterate === "function") return statement.iterate(...params);
  if (!warnedMissingIterate) {
    warnedMissingIterate = true;
    logger.warn("DB", "bun:sqlite lacks Statement.iterate(); falling back to .all()", {
      bunVersion: typeof Bun !== "undefined" ? Bun.version : "unknown",
      requiredBunVersion: ">=1.1.31",
      impact: "rows are materialized in memory; upgrade Bun to restore streaming"
    });
  }
  return statement.all(...params);
}

// validation/upstream/claude-mem/src/services/dedup/idf.ts
function idf(df, n) {
  return Math.log(1 + n / (df + 0.5));
}
function buildIdfFn(dfLookup, n) {
  return (token) => idf(dfLookup(token), n);
}

// validation/upstream/claude-mem/src/services/dedup/tfidfCosine.ts
function idfVector(tokens, idfFn) {
  const v = /* @__PURE__ */ new Map();
  for (const t of new Set(tokens)) v.set(t, idfFn(t));
  return v;
}
function tfidfCosine(a, b, idfFn) {
  const va = idfVector(a, idfFn);
  const vb = idfVector(b, idfFn);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [t, w] of va) {
    normA += w * w;
    const wb = vb.get(t);
    if (wb !== void 0) dot += w * wb;
  }
  for (const [, w] of vb) normB += w * w;
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

// validation/upstream/claude-mem/src/services/dedup/idfVeto.ts
function vetoFires(a, b, idfFn, thetaIdf) {
  const setA = new Set(a);
  const setB = new Set(b);
  for (const t of setA) if (!setB.has(t) && idfFn(t) > thetaIdf) return true;
  for (const t of setB) if (!setA.has(t) && idfFn(t) > thetaIdf) return true;
  return false;
}

// validation/upstream/claude-mem/src/services/dedup/nearDuplicate.ts
function classifyPair(a, b, idfFn, thresholds) {
  if (exactTitleMatch(a, b)) {
    return { tier: "exact", method: "exact", score: 1 };
  }
  const ta = tokenizeWs(a);
  const tb = tokenizeWs(b);
  const minShared = thresholds.minSharedTokens ?? 2;
  const setB = new Set(tb);
  let shared = 0;
  for (const t of new Set(ta)) if (setB.has(t)) shared++;
  if (shared < minShared) return { tier: "none", method: "none", score: 0 };
  const score = tfidfCosine(ta, tb, idfFn);
  if (score >= thresholds.cosineThreshold && !vetoFires(ta, tb, idfFn, thresholds.vetoThetaIdf)) {
    return { tier: "candidate", method: "idf_cosine", score };
  }
  return { tier: "none", method: "none", score };
}

// validation/upstream/claude-mem/src/shared/subagent-predicate.ts
function isSubagentEvent(agentId, agentType) {
  return Boolean(agentId) && Boolean(agentType);
}

// validation/upstream/claude-mem/src/services/sqlite/dedup-store.ts
function computeTitleNormKey(project, platformSource, title, fromSubagent = false) {
  const norm = normalizeTitle(title);
  if (norm === "") return null;
  const platform = normalizePlatformSource(platformSource);
  const agentScope = fromSubagent ? "subagent" : "main";
  return createHash3("sha256").update(`${project}\0${platform}\0${agentScope}\0${norm}`).digest("hex").slice(0, 32);
}
function findTier0Canonical(db, project, normKey, title) {
  if (normKey === null) return null;
  const statement = db.prepare(
    "SELECT id, title, occurrence_count, created_at_epoch FROM observations WHERE project = ? AND title_norm_key = ? ORDER BY created_at_epoch ASC, id ASC"
  );
  try {
    for (const value of streamRows(statement, project, normKey)) {
      const row = value;
      if (exactTitleMatch(title, row.title)) {
        return { id: row.id, occurrence_count: row.occurrence_count, created_at_epoch: row.created_at_epoch };
      }
    }
    return null;
  } finally {
    statement.finalize();
  }
}
function bumpTokenDf(db, project, title) {
  const tokens = [...new Set(tokenizeWs(title))];
  const dfStmt = db.prepare(
    "INSERT INTO token_df (project, token, df) VALUES (?, ?, 1) ON CONFLICT(project, token) DO UPDATE SET df = df + 1"
  );
  for (const t of tokens) dfStmt.run(project, t);
  db.prepare(
    "INSERT INTO dedup_meta (project, doc_count) VALUES (?, 1) ON CONFLICT(project) DO UPDATE SET doc_count = doc_count + 1"
  ).run(project);
}
function vetoThetaFor(idfVetoDf, docCount) {
  return idf(idfVetoDf + 1, docCount);
}
function getProjectDocCount(db, project) {
  const row = db.prepare("SELECT doc_count FROM dedup_meta WHERE project = ?").get(project);
  return row?.doc_count ?? 0;
}
function buildProjectIdf(db, project, tokens) {
  const docCount = getProjectDocCount(db, project);
  const dfRows = tokens === void 0 ? db.prepare("SELECT token, df FROM token_df WHERE project = ?").all(project) : db.prepare("SELECT token, df FROM token_df WHERE project = ? AND token IN (SELECT value FROM json_each(?))").all(project, JSON.stringify([...new Set(tokens)]));
  const dfMap = new Map(dfRows.map((r) => [r.token, r.df]));
  return { idfFn: buildIdfFn((token) => dfMap.get(token) ?? 0, docCount), docCount };
}
function candidateInsert(db) {
  return db.prepare(
    "INSERT OR IGNORE INTO observation_dedup_candidates (observation_id, duplicate_of_id, project, method, score, status, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
}
function isFuzzyReady(db, project, minDocs) {
  return getProjectDocCount(db, project) >= minDocs;
}
function backfillProjectDedup(db, project, maxRows = Number.POSITIVE_INFINITY) {
  return db.transaction(() => {
    const total = db.prepare("SELECT COUNT(*) c FROM observations WHERE project = ?").get(project).c;
    if (total > maxRows) {
      logger.warn("DEDUP", `Skipping dedup backfill for project ${project}: ${total} rows exceeds cap ${maxRows} (CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS)`);
      return 0;
    }
    const rows = db.prepare(
      "SELECT o.id, o.title, o.agent_id, o.agent_type, s.platform_source FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id WHERE o.project = ?"
    ).all(project);
    const updKey = db.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?");
    const insDf = db.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, ?)");
    const dfMap = /* @__PURE__ */ new Map();
    for (const r of rows) {
      updKey.run(computeTitleNormKey(project, r.platform_source, r.title, isSubagentEvent(r.agent_id, r.agent_type)), r.id);
      for (const t of new Set(tokenizeWs(r.title))) dfMap.set(t, (dfMap.get(t) ?? 0) + 1);
    }
    db.prepare("DELETE FROM token_df WHERE project = ?").run(project);
    for (const [t, df] of dfMap) insDf.run(project, t, df);
    db.prepare(
      "INSERT INTO dedup_meta (project, doc_count, last_rebuild_doc_count, deleted_since_rebuild) VALUES (?, ?, ?, 0) ON CONFLICT(project) DO UPDATE SET doc_count = excluded.doc_count, last_rebuild_doc_count = excluded.last_rebuild_doc_count, deleted_since_rebuild = 0"
    ).run(project, rows.length, rows.length);
    return rows.length;
  }).immediate();
}
function sweepProjectCandidates(db, project, cfg) {
  const cap = Math.trunc(cfg.maxBackfillRows);
  const rowLimit = Number.isSafeInteger(cap) && cap < Number.MAX_SAFE_INTEGER ? Math.max(0, cap) + 1 : -1;
  const rows = db.prepare(
    "SELECT id, title FROM observations WHERE project = ? AND title IS NOT NULL ORDER BY id ASC LIMIT ?"
  ).all(project, rowLimit);
  if (rows.length < 2) return 0;
  if (rows.length > cfg.maxBackfillRows) {
    logger.warn("DEDUP", `Skipping dedup sweep for project ${project}: more than ${cfg.maxBackfillRows} rows`);
    return 0;
  }
  const { idfFn, docCount } = buildProjectIdf(db, project);
  const thresholds = {
    cosineThreshold: cfg.cosineThreshold,
    vetoThetaIdf: vetoThetaFor(cfg.idfVetoDf, docCount),
    minSharedTokens: cfg.minSharedTokens
  };
  const tokensPerRow = rows.map((r) => new Set(tokenizeWs(r.title)));
  const df = /* @__PURE__ */ new Map();
  for (const set of tokensPerRow) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const maxPostingDf = Math.max(2, Math.ceil(Math.sqrt(rows.length)) * 4);
  const postings = /* @__PURE__ */ new Map();
  tokensPerRow.forEach((set, i) => {
    for (const t of set) {
      const d = df.get(t);
      if (d < 2 || d > maxPostingDf) continue;
      let list = postings.get(t);
      if (!list) {
        list = [];
        postings.set(t, list);
      }
      list.push(i);
    }
  });
  const ins = candidateInsert(db);
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  const nowEpoch = Date.now();
  let count = 0;
  const shared = /* @__PURE__ */ new Map();
  for (let i = 0; i < rows.length; i++) {
    shared.clear();
    for (const token of tokensPerRow[i]) {
      const ids = postings.get(token);
      if (!ids) continue;
      for (const j of ids) {
        if (j > i) shared.set(j, (shared.get(j) ?? 0) + 1);
      }
    }
    for (const [j, sh] of shared) {
      if (sh < cfg.minSharedTokens) continue;
      const c = classifyPair(rows[i].title, rows[j].title, idfFn, thresholds);
      if (c.tier === "candidate") {
        count += ins.run(rows[j].id, rows[i].id, project, c.method, c.score, "pending", nowIso, nowEpoch).changes;
      }
    }
  }
  return count;
}
function runDedupScan(db, cfg) {
  const projects = db.prepare("SELECT DISTINCT project FROM observations").all().map((r) => r.project);
  return projects.map((project) => {
    const docs = backfillProjectDedup(db, project, cfg.maxBackfillRows);
    const candidates = sweepProjectCandidates(db, project, cfg);
    return { project, docs, candidates };
  });
}
function recordTier1Candidates(db, project, newObsId, title, cfg) {
  if (!title) return 0;
  const rows = db.prepare(
    "SELECT id, title FROM observations WHERE project = ? AND id != ? AND title IS NOT NULL ORDER BY created_at_epoch DESC, id DESC LIMIT ?"
  ).all(project, newObsId, cfg.maxScan);
  if (rows.length === 0) return 0;
  const tokens = new Set(tokenizeWs(title));
  for (const row of rows) for (const token of tokenizeWs(row.title)) tokens.add(token);
  const { idfFn, docCount } = buildProjectIdf(db, project, tokens);
  const thresholds = {
    cosineThreshold: cfg.cosineThreshold,
    vetoThetaIdf: vetoThetaFor(cfg.idfVetoDf, docCount),
    minSharedTokens: cfg.minSharedTokens
  };
  if (rows.length === cfg.maxScan) {
    logger.debug("DEDUP", `Tier-1 scan hit MAX_SCAN=${cfg.maxScan} for project ${project}; older rows covered by dedup-scan`);
  }
  const ins = candidateInsert(db);
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  const nowEpoch = Date.now();
  let count = 0;
  for (const r of rows) {
    const c = classifyPair(title, r.title, idfFn, thresholds);
    if (c.tier === "candidate") {
      count += ins.run(newObsId, r.id, project, c.method, c.score, "pending", nowIso, nowEpoch).changes;
    }
  }
  return count;
}

// validation/upstream/claude-mem/src/services/sqlite/prompts/get.ts
function findRecentDuplicateUserPrompt(db, contentSessionId, promptText, windowMs, sessionDbId) {
  const cutoffEpoch = Date.now() - windowMs;
  const whereClause = sessionDbId !== void 0 ? "up.session_db_id = ?" : "up.content_session_id = ?";
  const sessionParam = sessionDbId ?? contentSessionId;
  const stmt = db.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.session_db_id = s.id
    WHERE ${whereClause}
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `);
  return stmt.get(sessionParam, promptText, cutoffEpoch) ?? void 0;
}

// validation/upstream/claude-mem/src/utils/tag-stripping.ts
var TAG_NAMES = [
  "private",
  "claude-mem-context",
  "system_instruction",
  "system-instruction",
  "persisted-output",
  "system-reminder"
];
var MEMORY_TAG_NAMES = new Set(TAG_NAMES);
var OPEN_TAG_NAME_RE = /<([A-Za-z_][A-Za-z0-9_-]*)/y;
var CLOSE_TAG_RE = /<\/([A-Za-z_][A-Za-z0-9_-]*)\s*>/y;
function stripBalancedMemoryTags(input) {
  const counts = Object.fromEntries(
    TAG_NAMES.map((name) => [name, 0])
  );
  if (!input.includes("<")) {
    return { text: input, counts, total: 0 };
  }
  const len = input.length;
  const nextGt = new Int32Array(len + 1);
  nextGt[len] = len;
  for (let j = len - 1; j >= 0; j--) {
    nextGt[j] = input.charCodeAt(j) === 62 ? j : nextGt[j + 1];
  }
  const opens = /* @__PURE__ */ new Map();
  const removed = [];
  let total = 0;
  let i = 0;
  while (i < len) {
    if (input.charCodeAt(i) !== 60) {
      i += 1;
      continue;
    }
    CLOSE_TAG_RE.lastIndex = i;
    const close = CLOSE_TAG_RE.exec(input);
    if (close) {
      const name = close[1];
      const entry = opens.get(name);
      const open2 = entry && entry.head < entry.items.length ? entry.items[entry.head] : void 0;
      if (open2 && i >= open2.attrEnd) {
        entry.head += 1;
        removed.push([open2.start, i + close[0].length]);
        counts[name] += 1;
        total += 1;
      }
      i += close[0].length;
      continue;
    }
    OPEN_TAG_NAME_RE.lastIndex = i;
    const open = OPEN_TAG_NAME_RE.exec(input);
    if (open && MEMORY_TAG_NAMES.has(open[1])) {
      const name = open[1];
      const nameEnd = i + open[0].length;
      const item = { start: i, attrEnd: nextGt[nameEnd] };
      const entry = opens.get(name);
      if (entry) {
        entry.items.push(item);
      } else {
        opens.set(name, { items: [item], head: 0 });
      }
      i = nameEnd;
      continue;
    }
    i += 1;
  }
  removed.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of removed) {
    if (start > cursor) out += input.slice(cursor, start);
    if (end > cursor) cursor = end;
  }
  out += input.slice(cursor);
  return { text: out, counts, total };
}
var MAX_TAG_COUNT = 100;
function stripTags(input) {
  return finishStrippedTags(input, stripBalancedMemoryTags(input));
}
function finishStrippedTags(input, { text: stripped, counts, total }) {
  if (total > MAX_TAG_COUNT) {
    logger.warn("SYSTEM", "tag count exceeds limit", void 0, {
      tagCount: total,
      maxAllowed: MAX_TAG_COUNT,
      contentLength: input.length
    });
  }
  const redacted = redactSensitive(stripped.trim(), getRedactionConfig()).redacted;
  return { stripped: redacted, counts };
}
function stripMemoryTags(content) {
  return stripTags(content).stripped;
}
var PROTOCOL_ONLY_TAGS = ["task-notification"];
var PROTOCOL_ONLY_REGEX = new RegExp(
  `^\\s*<(${PROTOCOL_ONLY_TAGS.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`
);
var MAX_PROTOCOL_PAYLOAD_BYTES = 256 * 1024;

// validation/upstream/claude-mem/src/shared/text-truncation.ts
function retainTextHeadTail(text, headChars, tailChars) {
  let headEnd = Math.min(text.length, Math.max(0, Math.floor(headChars)));
  let tailStart = Math.max(headEnd, text.length - Math.max(0, Math.floor(tailChars)));
  const splitsPair = (offset) => {
    const before = text.charCodeAt(offset - 1);
    const after = text.charCodeAt(offset);
    return before >= 55296 && before <= 56319 && after >= 56320 && after <= 57343;
  };
  if (splitsPair(headEnd)) headEnd--;
  if (splitsPair(tailStart)) tailStart++;
  return { head: text.slice(0, headEnd), tail: text.slice(tailStart) };
}

// validation/upstream/claude-mem/src/services/sqlite/prompt-storage.ts
var MAX_STORED_PROMPT_CHARS = 4e3;
var MEDIA_PROMPT_PLACEHOLDER = "[media prompt]";
function normalizeStoredPromptText(promptText) {
  const preferredPrompt = stripMemoryTags(promptText).trim();
  if (preferredPrompt.length <= MAX_STORED_PROMPT_CHARS) {
    return preferredPrompt;
  }
  logger.debug("DB", "Truncated stored prompt text to the configured cap", {
    originalLength: preferredPrompt.length,
    storedLength: MAX_STORED_PROMPT_CHARS
  });
  return `${retainTextHeadTail(preferredPrompt, MAX_STORED_PROMPT_CHARS - 1, 0).head}\u2026`;
}

// validation/upstream/claude-mem/src/services/sqlite/connection.ts
import { Database } from "bun:sqlite";
var SQLITE_BUSY_TIMEOUT_MS = 5e3;
var SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 4194304;
var LATEST_SCHEMA_VERSION = 75;
function readSchemaWriterStamp(db) {
  const statement = db.prepare("PRAGMA user_version");
  try {
    return statement.get().user_version;
  } finally {
    statement.finalize();
  }
}
var SchemaNewerThanBinaryError = class extends Error {
  reason = "schema_newer_than_binary";
  constructor(message) {
    super(message);
    this.name = "SchemaNewerThanBinaryError";
  }
};
function assertSchemaWriterCompatible(db, latestKnownSchemaVersion) {
  db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  const stamp = readSchemaWriterStamp(db);
  if (stamp <= latestKnownSchemaVersion) {
    return;
  }
  throw new SchemaNewerThanBinaryError(
    `SQLite database has schema v${stamp}; this claude-mem knows up to schema v${latestKnownSchemaVersion}. Upgrade claude-mem before opening this database.`
  );
}
function checkAndRaiseSchemaWriterStampInTransaction(db, latestKnownSchemaVersion) {
  assertSchemaWriterCompatible(db, latestKnownSchemaVersion);
  if (readSchemaWriterStamp(db) < latestKnownSchemaVersion) {
    db.run(`PRAGMA user_version = ${latestKnownSchemaVersion}`);
  }
}
function claimSchemaWriter(db, latestKnownSchemaVersion) {
  db.transaction(() => checkAndRaiseSchemaWriterStampInTransaction(db, latestKnownSchemaVersion)).immediate();
}
function hasUserTables(db) {
  const statement = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `);
  try {
    return statement.get() != null;
  } finally {
    statement.finalize();
  }
}
function runRequiredPragma(db, sql, name) {
  try {
    db.run(sql);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn("DB", `Failed to apply SQLite pragma ${name}`, { sql }, err);
    throw error;
  }
}
function applySqliteConnectionPragmas(db, options = {}) {
  const {
    enableWal = true,
    enableIncrementalAutoVacuum = true
  } = options;
  runRequiredPragma(db, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`, "busy_timeout");
  runRequiredPragma(db, "PRAGMA foreign_keys = ON", "foreign_keys");
  runRequiredPragma(db, "PRAGMA synchronous = NORMAL", "synchronous");
  runRequiredPragma(db, `PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES}`, "journal_size_limit");
  if (enableIncrementalAutoVacuum && !hasUserTables(db)) {
    runRequiredPragma(db, "PRAGMA auto_vacuum = INCREMENTAL", "auto_vacuum");
  }
  if (enableWal) {
    runRequiredPragma(db, "PRAGMA journal_mode = WAL", "journal_mode");
  }
}

// validation/upstream/claude-mem/src/services/sqlite/media.ts
function queueCleanupForUnreferencedAttachmentsSql(scope) {
  const unreferencedCandidate = `a.id IN (${scope.candidateAttachmentIdsSql})
      AND a.state!='deleted'
      AND NOT EXISTS (SELECT 1 FROM media_event_refs r
        WHERE r.attachment_id=a.id AND NOT (${scope.eventRefsBeingRemovedSql}))
      AND NOT EXISTS (SELECT 1 FROM observation_media_links l
        WHERE l.attachment_id=a.id AND NOT (${scope.observationLinksBeingRemovedSql}))`;
  return [
    `INSERT OR IGNORE INTO media_cleanup_jobs (attachment_id, directory, queued_at)
      SELECT a.id, a.id, CAST(strftime('%s','now') AS INTEGER)*1000 FROM media_attachments a
      WHERE ${unreferencedCandidate}`,
    // v71: an attachment that already reached the owner's cloud media plane
    // gets a durable cloud deletion. Any attempted native upload counts too,
    // whatever its current state (pending, failed): its response may have been
    // lost after the cloud committed it. Queued before
    // upload_state is overwritten below; replica rows are never attempted or
    // 'uploaded', so a replica deletion never deletes the owner's cloud copy.
    `INSERT OR IGNORE INTO media_cloud_deletions (attachment_id, queued_at)
      SELECT a.id, CAST(strftime('%s','now') AS INTEGER)*1000 FROM media_attachments a
      WHERE ${unreferencedCandidate}
        AND a.origin='native' AND (a.upload_state='uploaded' OR a.upload_attempts>0)`,
    `UPDATE media_attachments SET state='deleted', upload_state='cancelled'
      WHERE id IN (SELECT a.id FROM media_attachments a WHERE ${unreferencedCandidate})`
  ];
}
var SESSION_EVENT_KEYS_SQL = "SELECT event_key FROM media_events WHERE session_db_id=OLD.id";
var QUEUE_CLEANUP_FOR_DELETED_OBSERVATION = queueCleanupForUnreferencedAttachmentsSql({
  candidateAttachmentIdsSql: "SELECT attachment_id FROM observation_media_links WHERE observation_id=OLD.id",
  eventRefsBeingRemovedSql: "0",
  observationLinksBeingRemovedSql: "l.observation_id=OLD.id"
});
var QUEUE_CLEANUP_FOR_DELETED_SESSION = queueCleanupForUnreferencedAttachmentsSql({
  candidateAttachmentIdsSql: `SELECT attachment_id FROM media_event_refs WHERE event_key IN (${SESSION_EVENT_KEYS_SQL})`,
  eventRefsBeingRemovedSql: `r.event_key IN (${SESSION_EVENT_KEYS_SQL})`,
  observationLinksBeingRemovedSql: "0"
});
var QUEUE_CLEANUP_FOR_DELETED_EVENT = queueCleanupForUnreferencedAttachmentsSql({
  candidateAttachmentIdsSql: "SELECT attachment_id FROM media_event_refs WHERE event_key=$eventKey",
  eventRefsBeingRemovedSql: "r.event_key=$eventKey",
  observationLinksBeingRemovedSql: "0"
});
function ensureMediaSchema(db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_events (
        event_key TEXT PRIMARY KEY, session_db_id INTEGER NOT NULL,
        platform TEXT NOT NULL, event_identity TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'retained' CHECK(state IN ('retained','deleted')),
        result_state TEXT NOT NULL DEFAULT 'unprocessed' CHECK(result_state IN ('unprocessed','stored','skipped')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_events_session ON media_events(session_db_id);
      CREATE TABLE IF NOT EXISTS media_attachments (
        id TEXT PRIMARY KEY, replay_key TEXT NOT NULL UNIQUE, provenance TEXT NOT NULL,
        recipe TEXT NOT NULL CHECK(recipe IN ('screenshot-v1','photo-v1')),
        state TEXT NOT NULL CHECK(state IN ('converting','ready','failed','deleted')),
        failure_code TEXT, encoder_version TEXT, variants TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        upload_state TEXT NOT NULL DEFAULT 'pending' CHECK(upload_state IN ('pending','uploaded','failed','cancelled')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_event_refs (
        event_key TEXT NOT NULL, attachment_id TEXT NOT NULL, label TEXT NOT NULL,
        PRIMARY KEY(event_key,attachment_id), UNIQUE(event_key,label),
        FOREIGN KEY(event_key) REFERENCES media_events(event_key),
        FOREIGN KEY(attachment_id) REFERENCES media_attachments(id)
      );
      CREATE TABLE IF NOT EXISTS observation_media_links (
        observation_id INTEGER NOT NULL, attachment_id TEXT NOT NULL, event_key TEXT NOT NULL,
        label TEXT NOT NULL, inspection TEXT NOT NULL DEFAULT 'uninspected'
          CHECK(inspection IN ('inspected','uninspected')),
        PRIMARY KEY(observation_id,attachment_id),
        FOREIGN KEY(attachment_id) REFERENCES media_attachments(id)
      );
      CREATE INDEX IF NOT EXISTS idx_media_links_attachment ON observation_media_links(attachment_id);
      CREATE TABLE IF NOT EXISTS media_cleanup_jobs (
        attachment_id TEXT PRIMARY KEY, directory TEXT NOT NULL,
        queued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_media_event_refs_attachment ON media_event_refs(attachment_id);
      -- v70: durable source-event -> observation result mapping, written in the
      -- storeObservations transaction so a replayed event recovers its committed
      -- result without another model call.
      CREATE TABLE IF NOT EXISTS media_event_results (
        event_key TEXT NOT NULL, observation_id INTEGER NOT NULL,
        PRIMARY KEY(event_key, observation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_media_event_results_observation ON media_event_results(observation_id);
      -- v71: durable cloud media deletions (offline-safe). Drained by
      -- MediaCloudSync; a row survives restarts and reconnects.
      CREATE TABLE IF NOT EXISTS media_cloud_deletions (
        attachment_id TEXT PRIMARY KEY, queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
    `);
    addMediaColumn(db, "media_attachments", "origin", `TEXT NOT NULL DEFAULT 'native'`);
    addMediaColumn(db, "media_attachments", "upload_attempts", "INTEGER NOT NULL DEFAULT 0");
    addMediaColumn(db, "media_attachments", "upload_retry_at", "INTEGER NOT NULL DEFAULT 0");
    addMediaColumn(db, "media_attachments", "upload_error", "TEXT");
    db.exec(`CREATE INDEX IF NOT EXISTS idx_media_attachments_upload ON media_attachments(upload_state, upload_retry_at)`);
    addMediaColumn(db, "media_events", "carry_prompt_number", "INTEGER");
    db.exec(`CREATE INDEX IF NOT EXISTS idx_media_events_carry ON media_events(session_db_id, carry_prompt_number)
      WHERE carry_prompt_number IS NOT NULL`);
    db.exec(`
      -- Recreated every startup so an older trigger definition never lingers.
      DROP TRIGGER IF EXISTS media_observation_delete;
      CREATE TRIGGER media_observation_delete AFTER DELETE ON observations BEGIN
        ${QUEUE_CLEANUP_FOR_DELETED_OBSERVATION.join(";\n        ")};
        DELETE FROM observation_media_links WHERE observation_id=OLD.id;
        DELETE FROM media_event_results WHERE observation_id=OLD.id;
      END;
      DROP TRIGGER IF EXISTS media_session_delete;
      CREATE TRIGGER media_session_delete BEFORE DELETE ON sdk_sessions BEGIN
        ${QUEUE_CLEANUP_FOR_DELETED_SESSION.join(";\n        ")};
        DELETE FROM media_event_refs WHERE event_key IN (${SESSION_EVENT_KEYS_SQL});
        DELETE FROM media_event_results WHERE event_key IN (${SESSION_EVENT_KEYS_SQL});
        UPDATE media_events SET state='deleted' WHERE session_db_id=OLD.id;
      END;
    `);
    const appliedAt = (/* @__PURE__ */ new Date()).toISOString();
    db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(69, appliedAt);
    db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(70, appliedAt);
    db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(71, appliedAt);
    db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(72, appliedAt);
  })();
}
function addMediaColumn(db, tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

// validation/upstream/claude-mem/src/services/sqlite/search-query.ts
var UNSEGMENTED_SCRIPT_RANGES = "\\p{Script=Han}\\u31F0-\\u31FF\\uFF66-\\uFF9F\\u0E00-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF\\u3040-\\u30FF\\u3100-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF";
var UNSEGMENTED_SCRIPT = new RegExp(`[${UNSEGMENTED_SCRIPT_RANGES}]`, "u");
var UNSEGMENTED_RUN = new RegExp(`[${UNSEGMENTED_SCRIPT_RANGES}]+|[^\\s${UNSEGMENTED_SCRIPT_RANGES}]+`, "gu");

// validation/upstream/claude-mem/src/shared/date-bounds.ts
var MS_PER_DAY = 24 * 60 * 60 * 1e3;

// validation/upstream/claude-mem/src/services/sqlite/tool-use-search.ts
var indexed = (row) => `(SELECT state = 'ready' OR ${row}.id <= cursor FROM tool_uses_search_schema WHERE id = 1)`;
var TRIGGERS_SQL = `
CREATE TRIGGER tool_uses_fts_ai AFTER INSERT ON tool_uses WHEN ${indexed("new")} BEGIN
  INSERT INTO tool_uses_fts(rowid, tool_input, tool_response) VALUES(new.id, new.tool_input, new.tool_response);
END;
CREATE TRIGGER tool_uses_fts_ad AFTER DELETE ON tool_uses WHEN ${indexed("old")} BEGIN
  INSERT INTO tool_uses_fts(tool_uses_fts, rowid, tool_input, tool_response)
    VALUES('delete', old.id, old.tool_input, old.tool_response);
END;
CREATE TRIGGER tool_uses_fts_au AFTER UPDATE OF id, tool_input, tool_response ON tool_uses
WHEN old.id IS NOT new.id OR old.tool_input IS NOT new.tool_input OR old.tool_response IS NOT new.tool_response BEGIN
  INSERT INTO tool_uses_fts(tool_uses_fts, rowid, tool_input, tool_response)
    SELECT 'delete', old.id, old.tool_input, old.tool_response WHERE ${indexed("old")};
  INSERT INTO tool_uses_fts(rowid, tool_input, tool_response)
    SELECT new.id, new.tool_input, new.tool_response WHERE ${indexed("new")};
END;`;

// validation/upstream/claude-mem/src/services/sqlite/SessionSearch.ts
import { Database as Database2 } from "bun:sqlite";
var OBSERVATIONS_FTS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
  END;

  CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
  END;

  CREATE TRIGGER IF NOT EXISTS observations_au
  AFTER UPDATE OF title, subtitle, narrative, text, facts, concepts ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
    INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
  END;
`;
var SESSION_SUMMARIES_FTS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
    INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
  END;

  CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
    INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
  END;

  CREATE TRIGGER IF NOT EXISTS session_summaries_au
  AFTER UPDATE OF request, investigated, learned, completed, next_steps, notes ON session_summaries BEGIN
    INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
    INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
  END;
`;

// validation/upstream/claude-mem/src/services/sync/SyncScheduling.ts
var PENDING_MUTATIONS_SQL = `(SELECT id, rev,
  CASE WHEN json_type(candidate, '$.fields') = 'object' AND CASE json_extract(candidate, '$.op')
    WHEN 'set_title' THEN json_type(candidate, '$.target') = 'object'
    WHEN 'set_prompt_session' THEN json_type(candidate, '$.target') = 'object'
    WHEN 'remap_project' THEN json_type(candidate, '$.where') = 'object'
    ELSE 0 END THEN candidate ELSE NULL END AS mutation
  FROM (SELECT id, CAST(rev AS TEXT) AS rev,
    CASE WHEN canonical_body IS NOT NULL THEN CASE WHEN json_valid(canonical_body) THEN
      CASE WHEN json_type(canonical_body, '$.mutation') = 'object'
        THEN json_extract(canonical_body, '$.mutation') END END
      ELSE CASE WHEN json_valid(body) THEN
        CASE WHEN json_type(body) = 'object' THEN body END END
      END AS candidate FROM sync_outbox))`;
var HEAD_MUTATION_SQL = `(SELECT * FROM ${PENDING_MUTATIONS_SQL} ORDER BY id LIMIT 1)`;
var frozenField = (key) => `CASE WHEN json_valid(o.body) THEN json_extract(o.body, '$.payload.${key}') END`;
var FROZEN_SCOPE = {
  kind: "o.kind",
  localId: "o.origin_local_id",
  rev: "o.entity_rev",
  deleted: "o.deleted",
  project: frozenField("project"),
  memory: frozenField("memory_session_id"),
  content: frozenField("content_session_id"),
  merged: frozenField("merged_into_project")
};

// validation/upstream/claude-mem/src/services/sync/SyncQueueEvidence.ts
var SHARED_LIST = sharedWorkListSql("list_name");

// validation/upstream/claude-mem/src/services/sync/SyncRecovery.ts
function ensureSyncRecoverySchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS sync_recovery_jobs (
    id TEXT PRIMARY KEY, preview_token TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL,
    scope_json TEXT NOT NULL, epoch TEXT, status TEXT NOT NULL, pause_reason TEXT,
    created_at_epoch INTEGER NOT NULL, updated_at_epoch INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS sync_recovery_items (
    job_id TEXT NOT NULL, kind TEXT NOT NULL, origin_local_id TEXT NOT NULL, entity_id TEXT NOT NULL,
    selected_rev TEXT NOT NULL, selected_sha256 TEXT NOT NULL, estimated_bytes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'selected', queued_rev TEXT, queued_sha256 TEXT, queued_epoch TEXT,
    acknowledged_epoch TEXT, detail TEXT, updated_at_epoch INTEGER NOT NULL,
    PRIMARY KEY(job_id, kind, origin_local_id))`);
  const itemColumns = db.query("PRAGMA table_info(sync_recovery_items)").all();
  if (!itemColumns.some((column) => column.name === "queued_epoch")) db.run("ALTER TABLE sync_recovery_items ADD COLUMN queued_epoch TEXT");
  db.run("CREATE INDEX IF NOT EXISTS idx_sync_recovery_selection ON sync_recovery_items(job_id, status, kind, origin_local_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sync_recovery_entity_revision ON sync_recovery_items(entity_id, queued_rev, queued_sha256)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sync_recovery_jobs_active ON sync_recovery_jobs(device_id, status, created_at_epoch)");
  db.run(`CREATE TABLE IF NOT EXISTS sync_recovery_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, entity_id TEXT NOT NULL,
    entity_rev TEXT NOT NULL, operation_sha256 TEXT NOT NULL, epoch TEXT, event TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL)`);
}

// validation/upstream/claude-mem/src/services/sqlite/SessionStore.ts
var TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS = 5 * 6e4;
var SYNC_ENTITY_HEADS_DDL = `
  CREATE TABLE IF NOT EXISTS sync_entity_heads (
    entity_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
    origin_device_id TEXT NOT NULL,
    origin_local_id TEXT NOT NULL,
    entity_rev TEXT NOT NULL,
    operation_sha256 TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    updated_at_epoch INTEGER NOT NULL
  )`;
var SYNC_CONTENT_OUTBOX_DDL = `
  CREATE TABLE IF NOT EXISTS sync_content_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
    origin_local_id TEXT NOT NULL,
    entity_rev TEXT NOT NULL,
    body TEXT NOT NULL,
    operation_sha256 TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    created_at_epoch INTEGER NOT NULL,
    UNIQUE(entity_id, entity_rev)
  )`;
var SYNC_LAUNCH_EXCLUSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS sync_launch_exclusions (
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
    origin_local_id TEXT NOT NULL,
    through_rev TEXT NOT NULL,
    PRIMARY KEY (kind, origin_local_id)
  )`;
var coerceBindValue = (value) => typeof value === "object" && value !== null ? JSON.stringify(value) : value ?? null;
function rollupObservationFileLists(observations) {
  const filesRead = [];
  const filesEdited = [];
  const seenRead = /* @__PURE__ */ new Set();
  const seenEdited = /* @__PURE__ */ new Set();
  for (const observation of observations) {
    for (const filePath of observation.files_read ?? []) {
      if (!filePath || seenRead.has(filePath)) continue;
      seenRead.add(filePath);
      filesRead.push(filePath);
    }
    for (const filePath of observation.files_modified ?? []) {
      if (!filePath || seenEdited.has(filePath)) continue;
      seenEdited.add(filePath);
      filesEdited.push(filePath);
    }
  }
  return { files_read: filesRead, files_edited: filesEdited };
}
var SESSION_CATALOG_DEFAULT_LIMIT = 200;
var SESSION_CATALOG_MAX_LIMIT = 1e3;
var DEDUP_SCHEMA_VERSION = 56;
var REINFORCEMENT_SCHEMA_VERSION = 57;
function positiveIntegerRowLimit(limit) {
  const parsedLimit = Number(limit);
  return Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : void 0;
}
function importedRowProjects(row) {
  return typeof row.merged_into_project === "string" && row.merged_into_project ? [row.project, row.merged_into_project] : [row.project];
}
var SessionStore = class {
  db;
  syncOpsEnabled;
  /** See cachedStatement. Keyed by SQL text; only fixed SQL ever goes in. */
  statementCache = /* @__PURE__ */ new Map();
  /** This device's sync id; native work-state rows fold as its writes (setLocalSyncDeviceId). */
  localSyncDeviceId = "";
  constructor(dbPathOrDb = DB_PATH, options = {}) {
    this.syncOpsEnabled = options.syncOpsEnabled ?? true;
    if (dbPathOrDb instanceof Database3) {
      this.db = dbPathOrDb;
    } else {
      if (dbPathOrDb !== ":memory:") {
        ensurePrivateDir(DATA_DIR);
      }
      this.db = new Database3(dbPathOrDb);
    }
    assertSchemaWriterCompatible(this.db, LATEST_SCHEMA_VERSION);
    applySqliteConnectionPragmas(this.db);
    claimSchemaWriter(this.db, LATEST_SCHEMA_VERSION);
    this.initializeSchema();
    this.ensureWorkerPortColumn();
    this.ensurePromptTrackingColumns();
    this.removeSessionSummariesUniqueConstraint();
    this.addObservationHierarchicalFields();
    this.makeObservationsTextNullable();
    this.createUserPromptsTable();
    this.ensureDiscoveryTokensColumn();
    this.createPendingMessagesTable();
    this.renameSessionIdColumns();
    this.addFailedAtEpochColumn();
    this.addOnUpdateCascadeToForeignKeys();
    this.addObservationContentHashColumn();
    this.addSessionCustomTitleColumn();
    this.addSessionPlatformSourceColumn();
    this.addObservationModelColumns();
    this.ensureMergedIntoProjectColumns();
    this.addObservationSubagentColumns();
    this.addObservationsUniqueContentHashIndex();
    this.addObservationsMetadataColumn();
    this.dropDeadPendingMessagesColumns();
    this.ensurePendingMessagesToolUseIdColumn();
    this.dropWorkerPidColumn();
    this.ensureSDKSessionsPlatformContentIdentity();
    this.ensureUserPromptsSessionDbId();
    this.ensurePendingMessagesSessionToolUniqueIndex();
    this.ensureSyncedAtColumns();
    this.ensureSyncOriginColumns();
    this.ensureSyncOutbox();
    this.ensureSyncEntityLedger();
    this.ensureSyncRevisionTextAffinity();
    this.initializeSyncHubLaunchBaseline();
    this.normalizeConceptTags();
    this.ensureSDKSessionsObservedColumns();
    this.ensureToolUsesTable();
    this.ensureCommittedToolUsesTable();
    this.ensureDeletedSessionCutoffTriggers();
    this.ensureTelegramWrapupsTable();
    this.addDedupTables();
    this.refreshUnicodeTitleNormKeys();
    this.ensureReinforcementColumns();
    this.ensureSessionCwdColumn();
    this.dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers();
    this.ensureProjectNocaseIndexes();
    this.ensureAdvisorCallsTable();
    this.ensureSessionProjectKeySourceColumn();
    this.requeuePromptsDeadLetteredForSize();
    this.ensureWorkStateTable();
    this.ensureDeliverablesTable();
    this.ensureHookSpoolConsumedTable();
    this.ensureProjectRecencyIndexes();
    this.ensureSessionCatalogRecencyIndex();
    this.ensureMergedIntoProjectCoveringIndexes();
    this.ensureNativePromptIdentity();
    this.ensureObservationFileIndex();
    ensureMediaSchema(this.db);
  }
  /**
   * v68: file-context looks observations up by file path. json_each over
   * files_read/files_modified scanned the whole table on the one shared
   * connection, so concurrent lookups queued past the hook budget. Index each
   * path instead and answer the lookup from it.
   */
  ensureObservationFileIndex() {
    this.db.transaction(() => {
      if (this.db.query("SELECT version FROM schema_versions WHERE version = 68").get()) return;
      this.db.run(`CREATE TABLE IF NOT EXISTS observation_files (
        path TEXT NOT NULL,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        PRIMARY KEY (path, observation_id)
      )`);
      this.db.run("CREATE INDEX IF NOT EXISTS idx_observation_files_observation ON observation_files(observation_id)");
      const expand = (column) => `SELECT o.id, je.value FROM observations o, json_each(o.${column}) je
         WHERE json_valid(o.${column}) AND json_type(o.${column}) = 'array' AND je.type = 'text'`;
      this.db.run(`INSERT OR IGNORE INTO observation_files(observation_id, path)
        ${expand("files_read")} UNION ${expand("files_modified")}`);
      this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(68, (/* @__PURE__ */ new Date()).toISOString());
    }).immediate();
  }
  /** Record the file paths an observation touches so by-file lookup is an index seek. */
  indexObservationFiles(observationId, filesRead, filesModified) {
    const paths = /* @__PURE__ */ new Set();
    for (const filePath of [...filesRead, ...filesModified]) {
      if (typeof filePath === "string" && filePath.length > 0) paths.add(filePath);
    }
    if (paths.size === 0) return;
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO observation_files(path, observation_id) VALUES (?, ?)"
    );
    for (const filePath of paths) insert.run(filePath, observationId);
  }
  /** Local host retry identity. Runs after every legacy user_prompts rebuild. */
  ensureNativePromptIdentity() {
    this.db.transaction(() => {
      const columns = this.db.query("PRAGMA table_info(user_prompts)").all();
      for (const column of ["native_prompt_id", "native_prompt_hash"]) {
        if (!columns.some((existing) => existing.name === column)) this.db.run(`ALTER TABLE user_prompts ADD COLUMN ${column} TEXT`);
      }
      this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_prompts_native_identity
        ON user_prompts(session_db_id, native_prompt_id) WHERE native_prompt_id IS NOT NULL`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_user_prompts_legacy_window
        ON user_prompts(session_db_id, created_at_epoch) WHERE native_prompt_id IS NULL`);
    }).immediate();
  }
  /** v65: normalization now retains meaningful Unicode marks and canonicalizes NFC. */
  refreshUnicodeTitleNormKeys() {
    this.db.transaction(() => {
      if (this.db.query("SELECT version FROM schema_versions WHERE version = 65").get()) return;
      const rows = this.db.prepare(`SELECT o.id, o.project, o.title, o.agent_id, o.agent_type,
        s.platform_source FROM observations o LEFT JOIN sdk_sessions s
        ON s.memory_session_id = o.memory_session_id ORDER BY o.id`);
      const update = this.db.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?");
      try {
        for (const value of streamRows(rows)) {
          const row = value;
          update.run(computeTitleNormKey(
            row.project,
            row.platform_source,
            row.title,
            isSubagentEvent(row.agent_id, row.agent_type)
          ), row.id);
        }
        this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(65, (/* @__PURE__ */ new Date()).toISOString());
      } finally {
        rows.finalize();
        update.finalize();
      }
    }).immediate();
  }
  getIndexColumns(indexName) {
    return this.db.query(`PRAGMA index_info(${JSON.stringify(indexName)})`).all().map((col) => col.name);
  }
  hasUniqueIndexOnColumns(table, columns) {
    const indexes = this.db.query(`PRAGMA index_list(${table})`).all();
    return indexes.some((index) => {
      if (index.unique !== 1) return false;
      const indexColumns = this.getIndexColumns(index.name);
      return indexColumns.length === columns.length && indexColumns.every((column, i) => column === columns[i]);
    });
  }
  resolvePromptSessionDbId(contentSessionId, sessionDbId, platformSource) {
    if (sessionDbId !== void 0) return sessionDbId;
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : void 0;
    if (normalizedPlatformSource) {
      const row2 = this.db.prepare(`
        SELECT id
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
        LIMIT 1
      `).get(DEFAULT_PLATFORM_SOURCE, normalizedPlatformSource, contentSessionId);
      return row2?.id ?? null;
    }
    const row = this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE content_session_id = ?
      ORDER BY CASE COALESCE(NULLIF(platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}')
        WHEN '${DEFAULT_PLATFORM_SOURCE}' THEN 0
        ELSE 1
      END, id
      LIMIT 1
    `).get(contentSessionId);
    return row?.id ?? null;
  }
  // #3038 near-duplicate dedup: occurrence_count (Tier-0 merge bump), per-project
  // token document-frequency (IDF model), dedup bookkeeping, and the Tier-1
  // review-only candidates table. Pure DDL; the IDF model is filled forward on
  // insert and (re)built by the opt-in dedup-scan, never a JS backfill here.
  addDedupTables() {
    const obsCols = this.db.query("PRAGMA table_info(observations)").all();
    if (!obsCols.some((c) => c.name === "occurrence_count")) {
      this.db.run("ALTER TABLE observations ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1");
    }
    if (!obsCols.some((c) => c.name === "title_norm_key")) {
      this.db.run("ALTER TABLE observations ADD COLUMN title_norm_key TEXT");
    }
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_title_norm ON observations(project, title_norm_key)");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS token_df (
        project TEXT    NOT NULL,
        token   TEXT    NOT NULL,
        df      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project, token)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS dedup_meta (
        project                TEXT    PRIMARY KEY,
        doc_count              INTEGER NOT NULL DEFAULT 0,
        last_rebuild_doc_count INTEGER NOT NULL DEFAULT 0,
        deleted_since_rebuild  INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS observation_dedup_candidates (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id   INTEGER NOT NULL,
        duplicate_of_id  INTEGER NOT NULL,
        project          TEXT    NOT NULL,
        method           TEXT    NOT NULL CHECK(method IN ('exact', 'idf_cosine')),
        score            REAL    NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'pending'
                                 CHECK(status IN ('pending', 'merged', 'distinct', 'dismissed')),
        created_at       TEXT    NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        metadata         TEXT,
        FOREIGN KEY (observation_id)  REFERENCES observations(id) ON DELETE CASCADE,
        FOREIGN KEY (duplicate_of_id) REFERENCES observations(id) ON DELETE CASCADE,
        UNIQUE(observation_id, duplicate_of_id)
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_token_df_project ON token_df(project)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_project ON observation_dedup_candidates(project, status)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_obs ON observation_dedup_candidates(observation_id)");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(DEDUP_SCHEMA_VERSION, (/* @__PURE__ */ new Date()).toISOString());
  }
  dropWorkerPidColumn() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32);
    const cols = this.db.query("PRAGMA table_info(pending_messages)").all();
    const hasColumn = cols.some((c) => c.name === "worker_pid");
    if (applied && !hasColumn) return;
    if (hasColumn) {
      try {
        this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid");
        this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid");
        logger.debug("DB", "Dropped worker_pid column and its index from pending_messages");
      } catch (error) {
        logger.warn("DB", "Failed to drop worker_pid column from pending_messages", {}, error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    if (!applied) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32, (/* @__PURE__ */ new Date()).toISOString());
    }
  }
  ensureSDKSessionsPlatformContentIdentity() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33);
    const hasGlobalContentUnique = this.hasUniqueIndexOnColumns("sdk_sessions", ["content_session_id"]);
    const hasCompositeUnique = this.hasUniqueIndexOnColumns("sdk_sessions", ["platform_source", "content_session_id"]);
    const columns = this.db.query("PRAGMA table_info(sdk_sessions)").all();
    const hasPlatformSource = columns.some((col) => col.name === "platform_source");
    if (applied && !hasGlobalContentUnique && hasCompositeUnique && hasPlatformSource) return;
    if (!hasPlatformSource) {
      this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${DEFAULT_PLATFORM_SOURCE}'`);
    }
    this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${DEFAULT_PLATFORM_SOURCE}'
      WHERE platform_source IS NULL OR platform_source = ''
    `);
    if (hasGlobalContentUnique) {
      this.db.run("PRAGMA foreign_keys = OFF");
      this.db.run("BEGIN TRANSACTION");
      try {
        this.rebuildSdkSessionsWithCompositeIdentity(applied);
        this.db.run("COMMIT");
      } catch (error) {
        this.db.run("ROLLBACK");
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error("DB", "Failed to rebuild sdk_sessions with composite identity, rolled back", {}, err);
        throw error;
      } finally {
        this.db.run("PRAGMA foreign_keys = ON");
      }
      return;
    }
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)");
    if (!applied) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33, (/* @__PURE__ */ new Date()).toISOString());
    }
  }
  rebuildSdkSessionsWithCompositeIdentity(applied) {
    this.db.run("DROP TABLE IF EXISTS sdk_sessions_new");
    this.db.run(`
      CREATE TABLE sdk_sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT '${DEFAULT_PLATFORM_SOURCE}',
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed')),
        worker_port INTEGER,
        prompt_counter INTEGER DEFAULT 0,
        custom_title TEXT
      )
    `);
    this.db.run(`
      INSERT INTO sdk_sessions_new (
        id, content_session_id, memory_session_id, project, platform_source,
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      )
      SELECT
        id, content_session_id, memory_session_id, project,
        COALESCE(NULLIF(platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}'),
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      FROM sdk_sessions
    `);
    this.db.run("DROP TABLE sdk_sessions");
    this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)");
    if (!applied) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33, (/* @__PURE__ */ new Date()).toISOString());
    }
  }
  ensureUserPromptsSessionDbId() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all();
    if (tables.length === 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    const cols = this.db.query("PRAGMA table_info(user_prompts)").all();
    const hasSessionDbId = cols.some((col) => col.name === "session_db_id");
    const fks = this.db.query("PRAGMA foreign_key_list(user_prompts)").all();
    const hasContentSessionFk = fks.some((fk) => fk.table === "sdk_sessions" && fk.from === "content_session_id");
    if (applied && hasSessionDbId && !hasContentSessionFk) return;
    const sessionDbIdSelect = hasSessionDbId ? `COALESCE(up.session_db_id, (
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}')
            WHEN '${DEFAULT_PLATFORM_SOURCE}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        ))` : `(
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}')
            WHEN '${DEFAULT_PLATFORM_SOURCE}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        )`;
    this.db.run("PRAGMA foreign_keys = OFF");
    this.db.run("BEGIN TRANSACTION");
    try {
      this.rebuildUserPromptsWithSessionDbId(applied, sessionDbIdSelect);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("DB", "Failed to rebuild user_prompts with session_db_id, rolled back", {}, err);
      throw error;
    } finally {
      this.db.run("PRAGMA foreign_keys = ON");
    }
  }
  rebuildUserPromptsWithSessionDbId(applied, sessionDbIdSelect) {
    this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai");
    this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad");
    this.db.run("DROP TRIGGER IF EXISTS user_prompts_au");
    this.db.run("DROP TABLE IF EXISTS user_prompts_new");
    this.db.run(`
      CREATE TABLE user_prompts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`
      INSERT INTO user_prompts_new (
        id, session_db_id, content_session_id, prompt_number,
        prompt_text, created_at, created_at_epoch
      )
      SELECT
        up.id,
        ${sessionDbIdSelect},
        up.content_session_id,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
    `);
    this.db.run("DROP TABLE user_prompts");
    this.db.run("ALTER TABLE user_prompts_new RENAME TO user_prompts");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number)");
    if (!applied) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34, (/* @__PURE__ */ new Date()).toISOString());
    }
  }
  ensurePendingMessagesSessionToolUniqueIndex() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all();
    if (tables.length === 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    const hasExpectedIndex = this.hasUniqueIndexOnColumns("pending_messages", ["session_db_id", "tool_use_id"]);
    if (applied && hasExpectedIndex) return;
    this.db.run("BEGIN TRANSACTION");
    try {
      this.recreatePendingSessionToolUniqueIndex(applied);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("DB", "Failed to recreate ux_pending_session_tool index, rolled back", {}, err);
      throw error;
    }
  }
  recreatePendingSessionToolUniqueIndex(applied) {
    this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool");
    this.db.run(`
      DELETE FROM pending_messages
       WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_db_id, tool_use_id
                      ORDER BY CASE status
                        WHEN 'processing' THEN 0
                        WHEN 'pending' THEN 1
                        ELSE 2
                      END, id
                    ) AS duplicate_rank
               FROM pending_messages
              WHERE tool_use_id IS NOT NULL
           )
          WHERE duplicate_rank > 1
         )
    `);
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
      ON pending_messages(session_db_id, tool_use_id)
      WHERE tool_use_id IS NOT NULL
    `);
    if (!applied) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35, (/* @__PURE__ */ new Date()).toISOString());
    }
  }
  ensureSyncedAtColumns() {
    for (const table of ["observations", "session_summaries", "user_prompts"]) {
      const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all();
      const hasSyncedAt = tableInfo.some((col) => col.name === "synced_at");
      if (!hasSyncedAt) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN synced_at INTEGER`);
        logger.debug("DB", `Added synced_at column to ${table} table`);
      }
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_${table}_unsynced ON ${table}(id) WHERE synced_at IS NULL`);
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(39, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Two-lane sync origins (version 41): every synced table learns where a row
   * came from. Native rows keep the origin columns NULL (NULL = this device);
   * rows applied from the sync hub carry the origin device's id and that
   * device's local rowid, and the partial unique index makes re-applying the
   * same remote op an upsert instead of a duplicate (kind is implicit per
   * table, so the index needs only the device/local pair). `sync_rev` is the
   * entity revision used by the mutation-op rev guard (SyncApply); it starts
   * at 1 for every existing and native row. `sync_state` is the pull cursor
   * store (`cursor`, `epoch`) — advanced inside the same transaction as row
   * application for crash-safe exactly-once (see SyncApply.applyOps).
   *
   * Same shape as ensureSyncedAtColumns: the PRAGMA checks are the real
   * guard; version 41 is recorded for bookkeeping only.
   */
  ensureSyncOriginColumns() {
    for (const table of ["observations", "session_summaries", "user_prompts"]) {
      const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all();
      const columnNames = new Set(tableInfo.map((col) => col.name));
      if (!columnNames.has("origin_device_id")) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN origin_device_id TEXT`);
        logger.debug("DB", `Added origin_device_id column to ${table} table`);
      }
      if (!columnNames.has("origin_local_id")) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN origin_local_id TEXT`);
        logger.debug("DB", `Added origin_local_id column to ${table} table`);
      }
      if (!columnNames.has("sync_rev")) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'`);
        logger.debug("DB", `Added sync_rev column to ${table} table`);
      }
      this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_origin
        ON ${table}(origin_device_id, origin_local_id)
        WHERE origin_device_id IS NOT NULL
      `);
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_state (
        k TEXT PRIMARY KEY,
        v TEXT
      )
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(41, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Mutation outbox (version 42): durable queue for the four mutation sites
   * (custom title, prompt→session repair, the two project remaps). Each row
   * is one `kind='mutation'` op for the sync hub: `op_uuid` is the op's
   * origin_id — minted ONCE at enqueue time and reused on every push retry
   * (the hub dedupes on (origin_device, kind, origin_id, rev)); `rev` follows
   * the REV MINTING RULES in SyncApply.ts; `body` is the mutation envelope
   * JSON. The push drain (CloudSync.drainMutations) DELETEs rows on ack —
   * unlike the row tables, outbox rows are pure queue entries, not data.
   *
   * Same shape as ensureSyncOriginColumns: CREATE IF NOT EXISTS is the real
   * guard; version 42 is recorded for bookkeeping only.
   */
  ensureSyncOutbox() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_uuid TEXT NOT NULL UNIQUE,
        rev TEXT NOT NULL DEFAULT '1',
        body TEXT NOT NULL,
        canonical_body TEXT,
        operation_sha256 TEXT,
        created_at_epoch INTEGER NOT NULL
      )
    `);
    const columns = new Set(
      this.db.query("PRAGMA table_info(sync_outbox)").all().map((column) => column.name)
    );
    if (!columns.has("canonical_body")) {
      this.db.run("ALTER TABLE sync_outbox ADD COLUMN canonical_body TEXT");
    }
    if (!columns.has("operation_sha256")) {
      this.db.run("ALTER TABLE sync_outbox ADD COLUMN operation_sha256 TEXT");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(42, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Canonical uint64 revision storage (version 46). SQLite INTEGER tops out
   * at signed int64, so INTEGER affinity silently converts larger decimal
   * strings to REAL and destroys their exact value. Keep every row/content
   * revision as canonical decimal TEXT instead.
   *
   * v41 and the original v42 created INTEGER-affinity columns. SQLite cannot
   * alter a column's declared type in place, so each affected column is
   * replaced transactionally with ADD/COPY/DROP/RENAME. This leaves the
   * tables themselves (and therefore their indexes, triggers, and foreign
   * keys) intact. The PRAGMA affinity checks are the real idempotency guard;
   * the version row is bookkeeping only.
   *
   * A legacy REAL value is already rounded and cannot be recovered. Refuse
   * the upgrade loudly instead of freezing scientific notation as a fake
   * revision. Every copied INTEGER/TEXT value is also validated as a
   * positive canonical uint64 before any schema change commits.
   */
  ensureSyncRevisionTextAffinity() {
    const targets = [
      { table: "observations", column: "sync_rev", temporary: "sync_rev_text_v46" },
      { table: "session_summaries", column: "sync_rev", temporary: "sync_rev_text_v46" },
      { table: "user_prompts", column: "sync_rev", temporary: "sync_rev_text_v46" },
      { table: "sync_outbox", column: "rev", temporary: "rev_text_v46" }
    ];
    const columnInfo = (table, column) => this.db.query(`PRAGMA table_info(${table})`).all().find((info) => info.name === column);
    const isText = (info) => info?.type.trim().toUpperCase() === "TEXT";
    const applied = this.db.prepare(
      "SELECT version FROM schema_versions WHERE version = ?"
    ).get(46);
    if (applied && targets.every((target) => isText(columnInfo(target.table, target.column)))) {
      return;
    }
    const tx = this.db.transaction(() => {
      for (const target of targets) {
        const columns = this.db.query(`PRAGMA table_info(${target.table})`).all();
        const source = columns.find((info) => info.name === target.column);
        if (!source) {
          throw new Error(`schema v46: missing ${target.table}.${target.column}`);
        }
        for (const raw of streamRows(this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${target.column}) AS storage_type,
                 CAST(${target.column} AS TEXT) AS revision
          FROM ${target.table}
        `))) {
          const row = raw;
          if (row.storage_type === "real") {
            throw new Error(
              `schema v46: ${target.table}.${target.column} row ${row.row_id} is REAL and unrecoverably rounded`
            );
          }
          if (row.storage_type !== "integer" && row.storage_type !== "text") {
            throw new Error(
              `schema v46: ${target.table}.${target.column} row ${row.row_id} has unsupported ${row.storage_type} storage`
            );
          }
          try {
            assertCanonicalDecimal(row.revision, { positive: true });
          } catch {
            throw new Error(
              `schema v46: ${target.table}.${target.column} row ${row.row_id} is not a positive canonical uint64 revision`
            );
          }
        }
        if (isText(source)) continue;
        if (columns.some((info) => info.name === target.temporary)) {
          throw new Error(`schema v46: unexpected temporary column ${target.table}.${target.temporary}`);
        }
        this.db.run(
          `ALTER TABLE ${target.table} ADD COLUMN ${target.temporary} TEXT NOT NULL DEFAULT '1'`
        );
        this.db.run(
          `UPDATE ${target.table} SET ${target.temporary} = CAST(${target.column} AS TEXT)`
        );
        const mismatch = this.db.prepare(`
          SELECT CAST(id AS TEXT) AS row_id
          FROM ${target.table}
          WHERE ${target.temporary} <> CAST(${target.column} AS TEXT)
          LIMIT 1
        `).get();
        if (mismatch) {
          throw new Error(
            `schema v46: failed to copy ${target.table}.${target.column} row ${mismatch.row_id} exactly`
          );
        }
        this.db.run(`ALTER TABLE ${target.table} DROP COLUMN ${target.column}`);
        this.db.run(
          `ALTER TABLE ${target.table} RENAME COLUMN ${target.temporary} TO ${target.column}`
        );
      }
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(46, (/* @__PURE__ */ new Date()).toISOString());
    });
    tx();
  }
  /**
   * Canonical-v2 entity heads and durable tombstone queue. Revisions remain
   * decimal TEXT so a remote value is never rounded through a JS number.
   */
  ensureSyncEntityLedger() {
    ensureSyncRecoverySchema(this.db);
    this.db.run(SYNC_ENTITY_HEADS_DDL);
    this.widenSyncKindCheck("sync_entity_heads", SYNC_ENTITY_HEADS_DDL);
    this.db.run(SYNC_CONTENT_OUTBOX_DDL);
    const contentColumns = new Set(
      this.db.query("PRAGMA table_info(sync_content_outbox)").all().map((column) => column.name)
    );
    if (!contentColumns.has("deleted")) {
      this.db.run("ALTER TABLE sync_content_outbox ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
      this.db.run(`
        UPDATE sync_content_outbox
        SET deleted = CASE WHEN json_extract(body, '$.deleted') = 1 THEN 1 ELSE 0 END
      `);
    }
    this.widenSyncKindCheck("sync_content_outbox", SYNC_CONTENT_OUTBOX_DDL);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sync_content_outbox_kind_pending ON sync_content_outbox(kind, deleted DESC, id)");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_dead_letter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lane TEXT NOT NULL CHECK (lane IN ('content', 'mutation')),
        queue_key TEXT NOT NULL,
        kind TEXT,
        origin_local_id TEXT,
        entity_rev TEXT,
        reason TEXT NOT NULL,
        raw_body TEXT,
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(lane, queue_key, entity_rev, reason)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_pull_quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch TEXT NOT NULL,
        seq TEXT NOT NULL,
        kind TEXT,
        entity_id TEXT,
        origin_device_id TEXT,
        origin_local_id TEXT,
        entity_rev TEXT,
        operation_sha256 TEXT,
        reason TEXT NOT NULL,
        raw_body TEXT NOT NULL,
        retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(epoch, seq)
      )
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(44, (/* @__PURE__ */ new Date()).toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(45, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * v67 — a sync ledger's CHECK on `kind` was written for the three launch
   * kinds; work_state joined later (work-state.ts). SQLite cannot alter a
   * CHECK, so a table whose stored DDL predates the kind is rebuilt in place
   * from the current DDL, its rows copied by column name. Idempotent: the
   * rebuilt table's DDL names the kind, so later boots skip it.
   */
  widenSyncKindCheck(table, createSql) {
    const stored = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`
    ).get(table);
    if (!stored || stored.sql.includes("'work_state'")) return;
    const columns = this.db.query(`PRAGMA table_info(${table})`).all().map((column) => column.name).join(", ");
    const previous = `${table}_pre_work_state`;
    this.db.transaction(() => {
      this.db.run(`DROP TABLE IF EXISTS ${previous}`);
      this.db.run(`ALTER TABLE ${table} RENAME TO ${previous}`);
      this.db.run(createSql);
      this.db.run(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${previous}`);
      this.db.run(`DROP TABLE ${previous}`);
    }).immediate();
    logger.info("DB", `Rebuilt ${table} to admit the work_state sync kind`);
  }
  /**
   * One-time launch boundary (v47) plus its durable revision exclusions
   * (v48). This product line has no released cloud corpus to migrate, so the
   * exact native revisions present at launch are a local-only baseline. The
   * exclusion ledger survives Hub epoch changes; if one of those rows is
   * edited later, its higher revision is eligible for ordinary sync/rebuild.
   * Fresh databases run this while empty.
   */
  initializeSyncHubLaunchBaseline() {
    const tables = [
      { table: "observations", kind: "observation" },
      { table: "session_summaries", kind: "summary" },
      { table: "user_prompts", kind: "prompt" }
    ];
    const exclusionTableExisted = this.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'sync_launch_exclusions'
    `).get() != null;
    this.db.run(SYNC_LAUNCH_EXCLUSIONS_DDL);
    this.widenSyncKindCheck("sync_launch_exclusions", SYNC_LAUNCH_EXCLUSIONS_DDL);
    const applied = this.db.prepare(
      "SELECT version, applied_at FROM schema_versions WHERE version = ?"
    ).get(47);
    if (!applied) {
      const now = Date.now();
      const tx = this.db.transaction(() => {
        this.db.run("DELETE FROM sync_launch_exclusions");
        for (const { table, kind } of tables) {
          this.db.prepare(`
            INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
            SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
            FROM ${table}
            WHERE origin_device_id IS NULL
          `).run(kind);
          this.db.prepare(`
            UPDATE ${table} SET synced_at = ?
            WHERE synced_at IS NULL AND origin_device_id IS NULL
          `).run(now);
        }
        this.db.run("DELETE FROM sync_outbox");
        this.db.run("DELETE FROM sync_content_outbox");
        this.db.run("DELETE FROM sync_dead_letter");
        this.db.run("DELETE FROM sync_state");
        const appliedAt = new Date(now).toISOString();
        this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(47, appliedAt);
        this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48, appliedAt);
      });
      tx();
      return;
    }
    const exclusionsApplied = this.db.prepare(
      "SELECT version FROM schema_versions WHERE version = ?"
    ).get(48);
    if (exclusionsApplied && exclusionTableExisted) return;
    const boundaryMs = Date.parse(applied.applied_at);
    if (!Number.isSafeInteger(boundaryMs) || boundaryMs < 0) {
      throw new Error(`schema v48: invalid v47 applied_at ${applied.applied_at}`);
    }
    const repair = this.db.transaction(() => {
      for (const { table, kind } of tables) {
        this.db.prepare(`
          INSERT OR IGNORE INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
          SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
          FROM ${table}
          WHERE origin_device_id IS NULL
            AND synced_at > 0
            AND synced_at <= ?
        `).run(kind, boundaryMs);
      }
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48, (/* @__PURE__ */ new Date()).toISOString());
    });
    repair();
  }
  // v49 (#3379): the context-injection query matches concepts exactly
  // (ObservationCompiler `WHERE value IN (...)`), so historical rows written
  // as "keyword: description" never matched. Truncate each stored concept at
  // the first ':' and trim; the parser now enforces the same shape on write.
  //
  // `json_valid` guard: a non-JSON concepts value containing ':' would make
  // json_each throw and abort the whole constructor migration chain (worker
  // never initializes — the #3378 failure class). Invalid-JSON rows are
  // equally unreadable before and after v49 for every json_each reader, so
  // skipping them changes no behavior; this is an explicit domain-state
  // check, not error swallowing.
  //
  // Corrected NATIVE rows must re-sync: the row body changed, so bump
  // sync_rev and re-null synced_at (mirroring requeuePromptSync) — the next
  // drain re-pushes the corrected body at the higher rev and replicas apply
  // it via the rev guard. Replica rows (origin_device_id NOT NULL) are
  // normalized locally only; their repair travels from THEIR origin device.
  normalizeConceptTags() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(49);
    if (applied) return;
    let changedCount = 0;
    const tx = this.db.transaction(() => {
      const affected = this.db.prepare(`
        SELECT CAST(id AS TEXT) AS id, origin_device_id, CAST(sync_rev AS TEXT) AS sync_rev
        FROM observations
        WHERE concepts LIKE '%:%' AND json_valid(concepts)
      `).all();
      changedCount = affected.length;
      this.db.run(`
        UPDATE observations
        SET concepts = (
          SELECT json_group_array(
            CASE WHEN instr(value, ':') > 0
                 THEN trim(substr(value, 1, instr(value, ':') - 1))
                 ELSE value END)
          FROM json_each(observations.concepts))
        WHERE concepts LIKE '%:%' AND json_valid(concepts)
      `);
      for (const row of affected) {
        if (row.origin_device_id !== null) continue;
        const nextRev = incrementCanonicalDecimal(row.sync_rev);
        this.db.prepare(`
          UPDATE observations SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(nextRev, row.id);
      }
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(49, (/* @__PURE__ */ new Date()).toISOString());
    });
    tx();
    logger.debug("DB", `Normalized prefixed concept tags in ${changedCount} observations (v49)`);
  }
  dropDeadPendingMessagesColumns() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31);
    const cols = this.db.query("PRAGMA table_info(pending_messages)").all();
    const colNames = new Set(cols.map((c) => c.name));
    const deadColumns = ["retry_count", "failed_at_epoch", "completed_at_epoch"];
    const toDrop = deadColumns.filter((name) => colNames.has(name));
    if (applied && toDrop.length === 0) return;
    if (toDrop.length > 0) {
      this.db.run("BEGIN TRANSACTION");
      try {
        this.db.run(`DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')`);
        for (const colName of toDrop) {
          this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${colName}`);
          logger.debug("DB", `Dropped dead column ${colName} from pending_messages`);
        }
        if (!applied) {
          this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31, (/* @__PURE__ */ new Date()).toISOString());
        }
        this.db.run("COMMIT");
      } catch (error) {
        this.db.run("ROLLBACK");
        logger.warn("DB", "Failed to drop dead columns from pending_messages", {}, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      return;
    }
    if (!applied) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31, (/* @__PURE__ */ new Date()).toISOString());
    }
  }
  initializeSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT 'claude',
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
      );

      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4, (/* @__PURE__ */ new Date()).toISOString());
  }
  ensureWorkerPortColumn() {
    const tableInfo = this.db.query("PRAGMA table_info(sdk_sessions)").all();
    const hasWorkerPort = tableInfo.some((col) => col.name === "worker_port");
    if (!hasWorkerPort) {
      this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER");
      logger.debug("DB", "Added worker_port column to sdk_sessions table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5, (/* @__PURE__ */ new Date()).toISOString());
  }
  ensurePromptTrackingColumns() {
    const sessionsInfo = this.db.query("PRAGMA table_info(sdk_sessions)").all();
    const hasPromptCounter = sessionsInfo.some((col) => col.name === "prompt_counter");
    if (!hasPromptCounter) {
      this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0");
      logger.debug("DB", "Added prompt_counter column to sdk_sessions table");
    }
    const observationsInfo = this.db.query("PRAGMA table_info(observations)").all();
    const obsHasPromptNumber = observationsInfo.some((col) => col.name === "prompt_number");
    if (!obsHasPromptNumber) {
      this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER");
      logger.debug("DB", "Added prompt_number column to observations table");
    }
    const summariesInfo = this.db.query("PRAGMA table_info(session_summaries)").all();
    const sumHasPromptNumber = summariesInfo.some((col) => col.name === "prompt_number");
    if (!sumHasPromptNumber) {
      this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER");
      logger.debug("DB", "Added prompt_number column to session_summaries table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6, (/* @__PURE__ */ new Date()).toISOString());
  }
  // #3378: legacy DBs contain child rows whose memory_session_id has no
  // sdk_sessions parent (written historically while foreign_keys was OFF).
  // The v7/v9 rebuilds copy those children into a freshly created table via
  // INSERT ... SELECT with foreign_keys = ON (the connection pragma; these
  // rebuilds, unlike v21/v33/v34, never disable it), so a single orphan
  // aborts the whole constructor migration chain with 'FOREIGN KEY
  // constraint failed' and the worker never reports ready. Orphaned children
  // are live user data served by context injection — the missing side is the
  // parent, so create a minimal completed stub session per orphaned
  // memory_session_id immediately before the copy, mirroring
  // SyncApply.ensureSessionForMemoryId (INSERT ... ON CONFLICT DO NOTHING;
  // content_session_id falls back to the memory id). COUNT-then-INSERT for
  // the log figure, per the bun:sqlite `.run().changes` trap documented in
  // SyncApply.ts.
  repairOrphanedSessionParents(childTable) {
    const orphaned = this.db.prepare(`
      SELECT COUNT(DISTINCT c.memory_session_id) AS n
      FROM ${childTable} c
      WHERE c.memory_session_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sdk_sessions s WHERE s.memory_session_id = c.memory_session_id)
    `).get().n;
    if (orphaned === 0) return;
    this.db.run(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      SELECT
        c.memory_session_id,
        c.memory_session_id,
        MIN(c.project),
        MIN(c.created_at),
        MIN(c.created_at_epoch),
        'completed'
      FROM ${childTable} c
      WHERE c.memory_session_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sdk_sessions s WHERE s.memory_session_id = c.memory_session_id)
      GROUP BY c.memory_session_id
      ON CONFLICT DO NOTHING
    `);
    logger.warn("DB", `Created ${orphaned} stub sdk_sessions parent(s) for orphaned ${childTable} rows before rebuild (#3378)`);
  }
  /**
   * Live FK clause, not the schema_versions row: a later table rebuild can
   * strip ON UPDATE CASCADE after v21 was already stamped (#3849).
   */
  hasMemorySessionIdOnUpdateCascade(table) {
    const fks = this.db.query(`PRAGMA foreign_key_list(${table})`).all();
    return fks.some(
      (fk) => fk.table === "sdk_sessions" && fk.from === "memory_session_id" && fk.on_update === "CASCADE"
    );
  }
  /**
   * After CREATE TABLE <newTable> from a fixed historical column list, add
   * every live source column that list omitted (type and DEFAULT included)
   * and return the full copy order. Same discipline as the v7 rebuild (#3890)
   * so a repair of an already-migrated database cannot drop later columns.
   */
  carryLiveColumnsOntoNewTable(sourceTable, newTable, knownColumns) {
    const liveColumns = this.db.query(`PRAGMA table_info(${sourceTable})`).all();
    const extraColumns = liveColumns.filter((col) => !knownColumns.includes(col.name));
    for (const col of extraColumns) {
      const type = col.type ? ` ${col.type}` : "";
      const dflt = col.dflt_value === null || col.dflt_value === void 0 ? "" : ` DEFAULT ${col.dflt_value}`;
      this.db.run(`ALTER TABLE ${newTable} ADD COLUMN "${col.name}"${type}${dflt}`);
      logger.debug("DB", `Carried ${col.name} over the ${sourceTable} rebuild (#3849)`);
    }
    return liveColumns.map((col) => col.name);
  }
  removeSessionSummariesUniqueConstraint() {
    const summariesIndexes = this.db.query("PRAGMA index_list(session_summaries)").all();
    const hasUniqueConstraint = summariesIndexes.some((idx) => idx.unique === 1 && idx.origin === "u");
    if (!hasUniqueConstraint) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Removing UNIQUE constraint from session_summaries.memory_session_id");
    this.db.run("BEGIN TRANSACTION");
    this.repairOrphanedSessionParents("session_summaries");
    const v7Columns = [
      "id",
      "memory_session_id",
      "project",
      "request",
      "investigated",
      "learned",
      "completed",
      "next_steps",
      "files_read",
      "files_edited",
      "notes",
      "prompt_number",
      "created_at",
      "created_at_epoch"
    ];
    const liveColumns = this.db.query("PRAGMA table_info(session_summaries)").all();
    const extraColumns = liveColumns.filter((col) => !v7Columns.includes(col.name));
    this.db.run("DROP TABLE IF EXISTS session_summaries_new");
    this.db.run(`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    for (const col of extraColumns) {
      const type = col.type ? ` ${col.type}` : "";
      const dflt = col.dflt_value === null || col.dflt_value === void 0 ? "" : ` DEFAULT ${col.dflt_value}`;
      this.db.run(`ALTER TABLE session_summaries_new ADD COLUMN "${col.name}"${type}${dflt}`);
      logger.debug("DB", `Carried ${col.name} over the session_summaries UNIQUE-constraint rebuild (#3890)`);
    }
    const copyColumns = [...v7Columns, ...extraColumns.map((col) => col.name)].map((name) => `"${name}"`).join(", ");
    this.db.run(`
      INSERT INTO session_summaries_new (${copyColumns})
      SELECT ${copyColumns}
      FROM session_summaries
    `);
    this.db.run("DROP TABLE session_summaries");
    this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries");
    this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);
    this.recreateFtsTriggersIfIndexed("session_summaries");
    this.db.run("COMMIT");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "Successfully removed UNIQUE constraint from session_summaries.memory_session_id");
  }
  addObservationHierarchicalFields() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(observations)").all();
    const hasTitle = tableInfo.some((col) => col.name === "title");
    if (hasTitle) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Adding hierarchical fields to observations table");
    this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "Successfully added hierarchical fields to observations table");
  }
  makeObservationsTextNullable() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(observations)").all();
    const textColumn = tableInfo.find((col) => col.name === "text");
    if (!textColumn || textColumn.notnull === 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Making observations.text nullable");
    this.db.run("BEGIN TRANSACTION");
    this.repairOrphanedSessionParents("observations");
    this.db.run("DROP TABLE IF EXISTS observations_new");
    this.db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `);
    this.db.run("DROP TABLE observations");
    this.db.run("ALTER TABLE observations_new RENAME TO observations");
    this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `);
    this.recreateFtsTriggersIfIndexed("observations");
    this.db.run("COMMIT");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "Successfully made observations.text nullable");
  }
  /**
   * DROP TABLE removes every trigger attached to the table, so a rebuild that
   * keeps its FTS5 index (external content: the index tables survive the base
   * table rebuild untouched) would otherwise leave every later write unindexed
   * with no error — MATCH searches silently miss them forever (#3609). Re-run
   * the sync-trigger SQL whenever the index is still present; the SQL is
   * CREATE TRIGGER IF NOT EXISTS, so this is idempotent. The index is rebuilt
   * from the content table first (same convergence as
   * SessionSearch.ensureFTSTables): a database can arrive at a rebuild with
   * rows that an earlier triggerless window never indexed, and once the
   * triggers re-attach, the _ad/_au FTS 'delete' commands for those rowids
   * fail every UPDATE/DELETE with "database disk image is malformed".
   */
  recreateFtsTriggersIfIndexed(table) {
    const ftsTable = `${table}_fts`;
    const hasFTS = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").all(ftsTable).length > 0;
    if (!hasFTS) return;
    this.db.run(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('rebuild')`);
    this.db.run(table === "observations" ? OBSERVATIONS_FTS_TRIGGERS_SQL : SESSION_SUMMARIES_FTS_TRIGGERS_SQL);
  }
  createUserPromptsTable() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(user_prompts)").all();
    if (tableInfo.length > 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Creating user_prompts table");
    this.db.run("BEGIN TRANSACTION");
    this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_session ON user_prompts(session_db_id);
      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number);
      CREATE INDEX idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number);
    `);
    this.db.run("COMMIT");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "Successfully created user_prompts table");
  }
  ensureDiscoveryTokensColumn() {
    const observationsInfo = this.db.query("PRAGMA table_info(observations)").all();
    const obsHasDiscoveryTokens = observationsInfo.some((col) => col.name === "discovery_tokens");
    if (!obsHasDiscoveryTokens) {
      this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0");
      logger.debug("DB", "Added discovery_tokens column to observations table");
    }
    const summariesInfo = this.db.query("PRAGMA table_info(session_summaries)").all();
    const sumHasDiscoveryTokens = summariesInfo.some((col) => col.name === "discovery_tokens");
    if (!sumHasDiscoveryTokens) {
      this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0");
      logger.debug("DB", "Added discovery_tokens column to session_summaries table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11, (/* @__PURE__ */ new Date()).toISOString());
  }
  createPendingMessagesTable() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16);
    if (applied) return;
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all();
    if (tables.length > 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Creating pending_messages table");
    this.db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16, (/* @__PURE__ */ new Date()).toISOString());
    logger.debug("DB", "pending_messages table created successfully");
  }
  renameSessionIdColumns() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17);
    if (applied) return;
    logger.debug("DB", "Checking session ID columns for semantic clarity rename");
    let renamesPerformed = 0;
    const safeRenameColumn = (table, oldCol, newCol) => {
      const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all();
      const hasOldCol = tableInfo.some((col) => col.name === oldCol);
      const hasNewCol = tableInfo.some((col) => col.name === newCol);
      if (hasNewCol) {
        return false;
      }
      if (hasOldCol) {
        this.db.run(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
        logger.debug("DB", `Renamed ${table}.${oldCol} to ${newCol}`);
        return true;
      }
      logger.warn("DB", `Column ${oldCol} not found in ${table}, skipping rename`);
      return false;
    };
    if (safeRenameColumn("sdk_sessions", "claude_session_id", "content_session_id")) renamesPerformed++;
    if (safeRenameColumn("sdk_sessions", "sdk_session_id", "memory_session_id")) renamesPerformed++;
    if (safeRenameColumn("pending_messages", "claude_session_id", "content_session_id")) renamesPerformed++;
    if (safeRenameColumn("observations", "sdk_session_id", "memory_session_id")) renamesPerformed++;
    if (safeRenameColumn("session_summaries", "sdk_session_id", "memory_session_id")) renamesPerformed++;
    if (safeRenameColumn("user_prompts", "claude_session_id", "content_session_id")) renamesPerformed++;
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17, (/* @__PURE__ */ new Date()).toISOString());
    if (renamesPerformed > 0) {
      logger.debug("DB", `Successfully renamed ${renamesPerformed} session ID columns`);
    } else {
      logger.debug("DB", "No session ID column renames needed (already up to date)");
    }
  }
  addFailedAtEpochColumn() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20);
    if (applied) return;
    const tableInfo = this.db.query("PRAGMA table_info(pending_messages)").all();
    const hasColumn = tableInfo.some((col) => col.name === "failed_at_epoch");
    if (!hasColumn) {
      this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER");
      logger.debug("DB", "Added failed_at_epoch column to pending_messages table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20, (/* @__PURE__ */ new Date()).toISOString());
  }
  addOnUpdateCascadeToForeignKeys() {
    const observationsNeedsCascade = !this.hasMemorySessionIdOnUpdateCascade("observations");
    const summariesNeedsCascade = !this.hasMemorySessionIdOnUpdateCascade("session_summaries");
    if (!observationsNeedsCascade && !summariesNeedsCascade) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    logger.debug("DB", "Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries");
    this.db.run("PRAGMA foreign_keys = OFF");
    this.db.run("BEGIN TRANSACTION");
    const observationsKnownColumns = [
      "id",
      "memory_session_id",
      "project",
      "text",
      "type",
      "title",
      "subtitle",
      "facts",
      "narrative",
      "concepts",
      "files_read",
      "files_modified",
      "prompt_number",
      "discovery_tokens",
      "created_at",
      "created_at_epoch"
    ];
    const observationsNewSQL = `
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `;
    const observationsIndexesSQL = `
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `;
    const summariesKnownColumns = [
      "id",
      "memory_session_id",
      "project",
      "request",
      "investigated",
      "learned",
      "completed",
      "next_steps",
      "files_read",
      "files_edited",
      "notes",
      "prompt_number",
      "discovery_tokens",
      "created_at",
      "created_at_epoch"
    ];
    const summariesNewSQL = `
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `;
    const summariesIndexesSQL = `
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `;
    try {
      if (observationsNeedsCascade) {
        this.db.run("DROP TRIGGER IF EXISTS observations_ai");
        this.db.run("DROP TRIGGER IF EXISTS observations_ad");
        this.db.run("DROP TRIGGER IF EXISTS observations_au");
        this.db.run("DROP TABLE IF EXISTS observations_new");
        this.recreateObservationsWithCascade(observationsNewSQL, observationsKnownColumns, observationsIndexesSQL);
      }
      if (summariesNeedsCascade) {
        this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai");
        this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad");
        this.db.run("DROP TRIGGER IF EXISTS session_summaries_au");
        this.db.run("DROP TABLE IF EXISTS session_summaries_new");
        this.recreateSessionSummariesWithCascade(summariesNewSQL, summariesKnownColumns, summariesIndexesSQL);
      }
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21, (/* @__PURE__ */ new Date()).toISOString());
      this.db.run("COMMIT");
      this.db.run("PRAGMA foreign_keys = ON");
      logger.debug("DB", "Successfully added ON UPDATE CASCADE to FK constraints");
    } catch (error) {
      this.db.run("ROLLBACK");
      this.db.run("PRAGMA foreign_keys = ON");
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }
  }
  recreateObservationsWithCascade(createSQL, knownColumns, indexesSQL) {
    this.db.run(createSQL);
    const copyColumns = this.carryLiveColumnsOntoNewTable("observations", "observations_new", knownColumns);
    const quoted = copyColumns.map((name) => `"${name}"`).join(", ");
    this.db.run(`INSERT INTO observations_new (${quoted}) SELECT ${quoted} FROM observations`);
    this.db.run("DROP TABLE observations");
    this.db.run("ALTER TABLE observations_new RENAME TO observations");
    this.db.run(indexesSQL);
    this.recreateFtsTriggersIfIndexed("observations");
  }
  recreateSessionSummariesWithCascade(createSQL, knownColumns, indexesSQL) {
    this.db.run(createSQL);
    const copyColumns = this.carryLiveColumnsOntoNewTable("session_summaries", "session_summaries_new", knownColumns);
    const quoted = copyColumns.map((name) => `"${name}"`).join(", ");
    this.db.run(`INSERT INTO session_summaries_new (${quoted}) SELECT ${quoted} FROM session_summaries`);
    this.db.run("DROP TABLE session_summaries");
    this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries");
    this.db.run(indexesSQL);
    this.recreateFtsTriggersIfIndexed("session_summaries");
  }
  addObservationContentHashColumn() {
    const tableInfo = this.db.query("PRAGMA table_info(observations)").all();
    const hasColumn = tableInfo.some((col) => col.name === "content_hash");
    if (hasColumn) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT");
    this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)");
    logger.debug("DB", "Added content_hash column to observations table with backfill and index");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22, (/* @__PURE__ */ new Date()).toISOString());
  }
  addSessionCustomTitleColumn() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23);
    const tableInfo = this.db.query("PRAGMA table_info(sdk_sessions)").all();
    const hasColumn = tableInfo.some((col) => col.name === "custom_title");
    if (applied && hasColumn) return;
    if (!hasColumn) {
      this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT");
      logger.debug("DB", "Added custom_title column to sdk_sessions table");
    }
    if (!applied) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23, (/* @__PURE__ */ new Date()).toISOString());
    }
  }
  addSessionPlatformSourceColumn() {
    const tableInfo = this.db.query("PRAGMA table_info(sdk_sessions)").all();
    const hasColumn = tableInfo.some((col) => col.name === "platform_source");
    const indexInfo = this.db.query("PRAGMA index_list(sdk_sessions)").all();
    const hasIndex = indexInfo.some((index) => index.name === "idx_sdk_sessions_platform_source");
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24);
    if (applied && hasColumn && hasIndex) return;
    if (!hasColumn) {
      this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${DEFAULT_PLATFORM_SOURCE}'`);
      logger.debug("DB", "Added platform_source column to sdk_sessions table");
    }
    this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${DEFAULT_PLATFORM_SOURCE}'
      WHERE platform_source IS NULL OR platform_source = ''
    `);
    if (!hasIndex) {
      this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24, (/* @__PURE__ */ new Date()).toISOString());
  }
  addObservationModelColumns() {
    const columns = this.db.query("PRAGMA table_info(observations)").all();
    const hasGeneratedByModel = columns.some((col) => col.name === "generated_by_model");
    const hasRelevanceCount = columns.some((col) => col.name === "relevance_count");
    if (hasGeneratedByModel && hasRelevanceCount) return;
    if (!hasGeneratedByModel) {
      this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT");
    }
    if (!hasRelevanceCount) {
      this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26, (/* @__PURE__ */ new Date()).toISOString());
  }
  // Identity of the OBSERVED IDE session (the model the user ran and its
  // billing posture), reported by the Stop hook. Distinct from
  // observations.generated_by_model, which is the observer model.
  ensureSDKSessionsObservedColumns() {
    const columns = this.db.query("PRAGMA table_info(sdk_sessions)").all();
    const hasObservedModel = columns.some((col) => col.name === "observed_model");
    const hasObservedBilling = columns.some((col) => col.name === "observed_billing");
    if (hasObservedModel && hasObservedBilling) return;
    if (!hasObservedModel) {
      this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_model TEXT");
    }
    if (!hasObservedBilling) {
      this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_billing TEXT");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(50, (/* @__PURE__ */ new Date()).toISOString());
  }
  // v51 — durable `tool_uses` backup index for raw tool I/O.
  //
  // `pending_messages` stays exactly what it is (the generation queue, drained
  // and deleted); this table is the side index that survives it, so mem-search
  // can disclose a tool body by reference and Receipt can COUNT usages without
  // re-parsing transcripts. Not gated on the version row alone: the DDL is
  // idempotent, so a DB that was created fresh (table already present) and one
  // migrating up both converge, and a fixture that deliberately drops the row
  // re-runs harmlessly.
  ensureToolUsesTable() {
    createToolUsesSchema(this.db);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(51, (/* @__PURE__ */ new Date()).toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(75, (/* @__PURE__ */ new Date()).toISOString());
  }
  // v61 — the agent's to-do lists and working state (./work-state.ts). Idempotent
  // DDL like v51, so fresh and migrating databases converge.
  /** The deliverables bucket's records (deliverables.ts): CREATE IF NOT EXISTS, no version row, so an older worker sharing the database is unaffected. */
  ensureDeliverablesTable() {
    createDeliverablesSchema(this.db);
  }
  recordDeliverable(input) {
    return recordDeliverable(this.db, input);
  }
  getDeliverable(id) {
    return getDeliverable(this.db, id);
  }
  ensureWorkStateTable() {
    createWorkStateSchema(this.db);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(61, (/* @__PURE__ */ new Date()).toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(66, (/* @__PURE__ */ new Date()).toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(67, (/* @__PURE__ */ new Date()).toISOString());
  }
  // v63 — SessionStart reads the newest N rows per project key. Ordered
  // (key COLLATE NOCASE, created_at_epoch DESC) indexes let each key's scan stop
  // after N rows; the single-column v55 indexes made SQLite fetch every row of
  // the project and sort them (~21k rows / 63 MB per SessionStart on a large db).
  ensureProjectRecencyIndexes() {
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_project_nocase_recent ON observations(project COLLATE NOCASE, created_at_epoch DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_recent ON observations(merged_into_project COLLATE NOCASE, created_at_epoch DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_project_nocase_recent ON session_summaries(project COLLATE NOCASE, created_at_epoch DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_recent ON session_summaries(merged_into_project COLLATE NOCASE, created_at_epoch DESC)");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(63, (/* @__PURE__ */ new Date()).toISOString());
  }
  // A project-filtered viewer catalog needs only its next page. Include both
  // ordering keys so SQLite can stop in index order instead of sorting every
  // session in the project, including sessions tied at the same millisecond.
  ensureSessionCatalogRecencyIndex() {
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project_nocase_recent
      ON sdk_sessions(project COLLATE NOCASE, started_at_epoch DESC, id DESC)`);
  }
  // v64 — projectReadKeys (context cache, every SessionStart render) reads
  // `project` for rows whose merged_into_project matches. With only the
  // single-column v55 index SQLite loaded every merged row from the table to
  // read one column (~9k rows / 7.5k pages per call on a large db); these
  // covering indexes answer it from the index alone.
  ensureMergedIntoProjectCoveringIndexes() {
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_project ON observations(merged_into_project COLLATE NOCASE, project)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_project ON session_summaries(merged_into_project COLLATE NOCASE, project)");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(64, (/* @__PURE__ */ new Date()).toISOString());
  }
  // v62 — exactly-once hand-off marker for hook spool entries (HookSpool.drain):
  // written the moment ingest irrevocably accepts an entry, cleared once its file is gone.
  ensureHookSpoolConsumedTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS hook_spool_consumed (
        entry_key TEXT PRIMARY KEY,
        consumed_at_epoch_ms INTEGER NOT NULL
      )
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(62, (/* @__PURE__ */ new Date()).toISOString());
  }
  // v73: terminal capture and explicit deletion must both survive transcript replay.
  ensureCommittedToolUsesTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS committed_observation_tool_uses (
        platform_source TEXT NOT NULL,
        content_session_id TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        committed_at_epoch_ms INTEGER NOT NULL,
        PRIMARY KEY (platform_source, content_session_id, tool_use_id)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS deleted_content_sessions (
        platform_source TEXT NOT NULL,
        content_session_id TEXT NOT NULL,
        deleted_at_epoch_ms INTEGER NOT NULL,
        PRIMARY KEY (platform_source, content_session_id)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS deleted_memory_sessions (
        memory_session_id TEXT PRIMARY KEY,
        deleted_at_epoch_ms INTEGER NOT NULL
      )
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(73, (/* @__PURE__ */ new Date()).toISOString());
  }
  // v74: a deleted session's tombstone is a cutoff, not a permanent block.
  // Content from before the deletion stays out; new work in the same
  // conversation (a resumed Claude Code session) recreates the session.
  // Replaces v73's triggers, which blocked the content session id forever.
  ensureDeletedSessionCutoffTriggers() {
    this.db.transaction(() => {
      for (const v73Trigger of [
        "prevent_deleted_sdk_session_insert",
        "prevent_deleted_sdk_session_update",
        "prevent_deleted_tool_use_insert",
        "prevent_deleted_tool_use_update"
      ]) {
        this.db.run(`DROP TRIGGER IF EXISTS ${v73Trigger}`);
      }
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS block_pre_deletion_sdk_session_insert
        BEFORE INSERT ON sdk_sessions
        WHEN EXISTS (
          SELECT 1 FROM deleted_content_sessions
          WHERE platform_source = NEW.platform_source
            AND content_session_id = NEW.content_session_id
            AND NEW.started_at_epoch <= deleted_at_epoch_ms
        ) OR EXISTS (
          SELECT 1 FROM deleted_memory_sessions
          WHERE memory_session_id = NEW.memory_session_id
        )
        BEGIN SELECT RAISE(ABORT, 'session_deleted'); END
      `);
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS block_deleted_sdk_session_rekey
        BEFORE UPDATE OF memory_session_id, content_session_id, platform_source ON sdk_sessions
        WHEN EXISTS (
          SELECT 1 FROM deleted_memory_sessions
          WHERE memory_session_id = NEW.memory_session_id
        ) OR (
          (NEW.content_session_id IS NOT OLD.content_session_id OR NEW.platform_source IS NOT OLD.platform_source)
          AND EXISTS (
            SELECT 1 FROM deleted_content_sessions
            WHERE platform_source = NEW.platform_source
              AND content_session_id = NEW.content_session_id
          )
        )
        BEGIN SELECT RAISE(ABORT, 'session_deleted'); END
      `);
      for (const [name, event] of [
        ["block_pre_deletion_tool_use_insert", "INSERT"],
        ["block_pre_deletion_tool_use_update", "UPDATE"]
      ]) {
        this.db.run(`
          CREATE TRIGGER IF NOT EXISTS ${name}
          BEFORE ${event} ON tool_uses
          WHEN EXISTS (
            SELECT 1 FROM deleted_content_sessions
            WHERE platform_source = NEW.platform_source
              AND content_session_id = NEW.content_session_id
          ) AND NOT EXISTS (
            SELECT 1 FROM sdk_sessions
            WHERE id = NEW.session_db_id
              AND platform_source = NEW.platform_source
              AND content_session_id = NEW.content_session_id
          )
          BEGIN SELECT RAISE(ABORT, 'session_deleted'); END
        `);
      }
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(74, (/* @__PURE__ */ new Date()).toISOString());
    })();
  }
  hasCommittedToolUse(platformSource, contentSessionId, toolUseId) {
    if (!contentSessionId || !toolUseId) return false;
    return this.db.prepare(`
      SELECT 1 FROM committed_observation_tool_uses
      WHERE platform_source = ? AND content_session_id = ? AND tool_use_id = ?
    `).get(normalizePlatformSource(platformSource), contentSessionId, toolUseId) != null;
  }
  markSessionDeleted(platformSource, contentSessionId, memorySessionId) {
    const deletedAtEpochMs = Date.now();
    this.db.prepare(`
      INSERT INTO deleted_content_sessions
        (platform_source, content_session_id, deleted_at_epoch_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(platform_source, content_session_id)
      DO UPDATE SET deleted_at_epoch_ms = MAX(deleted_at_epoch_ms, excluded.deleted_at_epoch_ms)
    `).run(normalizePlatformSource(platformSource), contentSessionId, deletedAtEpochMs);
    if (memorySessionId) {
      this.db.prepare(`
        INSERT OR IGNORE INTO deleted_memory_sessions
          (memory_session_id, deleted_at_epoch_ms)
        VALUES (?, ?)
      `).run(memorySessionId, deletedAtEpochMs);
    }
  }
  isSessionDeleted(platformSource, contentSessionId) {
    return this.getSessionDeletedAtEpochMs(platformSource, contentSessionId) !== null;
  }
  /** When the user last deleted this session, or null if they never did. */
  getSessionDeletedAtEpochMs(platformSource, contentSessionId) {
    const row = this.db.prepare(`
      SELECT deleted_at_epoch_ms FROM deleted_content_sessions
      WHERE platform_source = ? AND content_session_id = ?
    `).get(normalizePlatformSource(platformSource), contentSessionId);
    return row?.deleted_at_epoch_ms ?? null;
  }
  /**
   * True when this event belongs to a deleted session and cannot prove it
   * happened after the deletion: content that existed when the user deleted
   * the session must never come back. Only a source time (the hook's clock,
   * a transcript line's timestamp) later than the deletion marks new work in
   * the same conversation. An event without one stays out.
   */
  isBeforeSessionDeletion(platformSource, contentSessionId, eventOccurredAtEpochMs) {
    const deletedAtEpochMs = this.getSessionDeletedAtEpochMs(platformSource, contentSessionId);
    if (deletedAtEpochMs === null) return false;
    return !(typeof eventOccurredAtEpochMs === "number" && Number.isFinite(eventOccurredAtEpochMs) && eventOccurredAtEpochMs > deletedAtEpochMs);
  }
  /**
   * Its own transaction, which nests as a savepoint inside the result
   * transaction: a failure there rolls back the stored result too.
   */
  markCommittedToolUses(input) {
    if (!input.contentSessionId) throw new Error("Committed tool uses require a content session");
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO committed_observation_tool_uses
      (platform_source, content_session_id, tool_use_id, committed_at_epoch_ms)
      VALUES (?, ?, ?, ?)
    `);
    const platformSource = normalizePlatformSource(input.platformSource);
    const now = Date.now();
    this.db.transaction(() => {
      for (const toolUseId of new Set(input.toolUseIds)) {
        if (!toolUseId) continue;
        insert.run(platformSource, input.contentSessionId, toolUseId, now);
      }
    })();
  }
  isHookSpoolEntryConsumed(entryKey) {
    return this.db.prepare("SELECT 1 FROM hook_spool_consumed WHERE entry_key = ?").get(entryKey) != null;
  }
  markHookSpoolEntryConsumed(entryKey, consumedAtEpochMs) {
    this.db.prepare(
      "INSERT INTO hook_spool_consumed (entry_key, consumed_at_epoch_ms) VALUES (?, ?) ON CONFLICT(entry_key) DO UPDATE SET consumed_at_epoch_ms = excluded.consumed_at_epoch_ms"
    ).run(entryKey, consumedAtEpochMs);
  }
  clearHookSpoolEntryConsumed(entryKey) {
    this.db.prepare("DELETE FROM hook_spool_consumed WHERE entry_key = ?").run(entryKey);
  }
  pruneHookSpoolConsumedMarkersBefore(epochMs) {
    this.db.prepare("DELETE FROM hook_spool_consumed WHERE consumed_at_epoch_ms < ?").run(epochMs);
  }
  // v52 — durable claim ledger for one Telegram session wrap-up per route.
  // The DDL is intentionally idempotent so fresh installs and existing DBs
  // converge even if a fixture has an incomplete schema_versions ledger.
  ensureTelegramWrapupsTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS telegram_wrapups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform_source TEXT NOT NULL,
        content_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        route_key TEXT NOT NULL,
        summary_created_at_epoch INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('claimed', 'sent')),
        claimed_at_epoch INTEGER NOT NULL,
        sent_at_epoch INTEGER,
        UNIQUE(platform_source, content_session_id, project, route_key)
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_telegram_wrapups_platform_content ON telegram_wrapups(platform_source, content_session_id)"
    );
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(52, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * ACT-R reinforcement history for observations (opt-in ranking, see
   * src/services/reinforcement):
   *   - reinforcement_dates: JSON array of ISO `YYYY-MM-DD` days the
   *     observation was (re-)confirmed, seeded with its creation day
   *   - last_reinforced: the most recent of those days
   * Device-local, like relevance_count. No backfill: a NULL history ranks on
   * its creation time alone. The PRAGMA checks are the guard; the version row
   * is bookkeeping, so a DB that already recorded it still gets the columns.
   */
  ensureReinforcementColumns() {
    const columns = this.db.query("PRAGMA table_info(observations)").all();
    if (!columns.some((col) => col.name === "reinforcement_dates")) {
      this.db.run("ALTER TABLE observations ADD COLUMN reinforcement_dates TEXT");
    }
    if (!columns.some((col) => col.name === "last_reinforced")) {
      this.db.run("ALTER TABLE observations ADD COLUMN last_reinforced TEXT");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(REINFORCEMENT_SCHEMA_VERSION, (/* @__PURE__ */ new Date()).toISOString());
  }
  // v54 — stop FTS5 shadow-index bloat at the source (plan-21, #2793).
  //
  // 1. observations_au / session_summaries_au become column-scoped (AFTER UPDATE OF the
  //    indexed columns). Unscoped, every bookkeeping update (sync_rev, merged_into_project,
  //    content_hash, session_db_id, ...) appended a delete marker plus a full re-insert of the
  //    row's text to the index.
  // 2. user_prompts_fts and its three triggers are dropped: prompt search uses LIKE and nothing
  //    reads the index, yet every prompt write grew it (the 12 GB table in #2793).
  //
  // Introspection-driven and idempotent, like v51/v52, so a later table rebuild that recreated
  // an old-style trigger converges again on the next start.
  dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers() {
    const unscopedUpdateTriggers = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN ('observations_au', 'session_summaries_au')
        AND sql NOT LIKE '%UPDATE OF%'
    `).all().map((row) => row.name);
    const userPromptsFtsObjects = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE name IN ('user_prompts_fts', 'user_prompts_ai', 'user_prompts_ad', 'user_prompts_au')
    `).all();
    if (unscopedUpdateTriggers.length > 0 || userPromptsFtsObjects.length > 0) {
      this.db.run("BEGIN TRANSACTION");
      try {
        if (unscopedUpdateTriggers.includes("observations_au")) {
          this.db.run("DROP TRIGGER observations_au");
          this.db.run(OBSERVATIONS_FTS_TRIGGERS_SQL);
        }
        if (unscopedUpdateTriggers.includes("session_summaries_au")) {
          this.db.run("DROP TRIGGER session_summaries_au");
          this.db.run(SESSION_SUMMARIES_FTS_TRIGGERS_SQL);
        }
        this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai");
        this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad");
        this.db.run("DROP TRIGGER IF EXISTS user_prompts_au");
        this.db.run("DROP TABLE IF EXISTS user_prompts_fts");
        this.db.run("COMMIT");
      } catch (error) {
        this.db.run("ROLLBACK");
        logger.error("DB", "Failed to scope FTS update triggers / drop user_prompts_fts, rolled back", {}, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      logger.info("DB", "Scoped FTS update triggers to indexed columns and dropped the write-only user_prompts_fts", {
        rescopedTriggers: unscopedUpdateTriggers,
        droppedUserPromptsFts: userPromptsFtsObjects.length > 0
      });
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(54, (/* @__PURE__ */ new Date()).toISOString());
  }
  ensureMergedIntoProjectColumns() {
    const obsCols = this.db.query("PRAGMA table_info(observations)").all();
    if (!obsCols.some((c) => c.name === "merged_into_project")) {
      this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT");
    }
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"
    );
    const sumCols = this.db.query("PRAGMA table_info(session_summaries)").all();
    if (!sumCols.some((c) => c.name === "merged_into_project")) {
      this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT");
    }
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)"
    );
  }
  // v60 — re-queue prompts dead-lettered for size before #3537's clamp. A
  // prompt whose canonical body passed CONTENT_BODY_MAX_BYTES was quarantined
  // (synced_at = -1 plus a sync_dead_letter row), and the drain reads
  // synced_at IS NULL only, so it never synced again. The drain now bounds
  // prompt_text (prompt-text-clamp.ts), so those prompts fit: re-null them
  // and drop their size dead-letter rows, once. Native rows only; a prompt
  // quarantined for any other reason keeps its quarantine.
  requeuePromptsDeadLetteredForSize() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(60);
    if (applied) return;
    const sizeReason = "canonical content: body exceeds % UTF-8 bytes";
    this.db.transaction(() => {
      const requeued = this.db.prepare(`
        UPDATE user_prompts SET synced_at = NULL
        WHERE synced_at = -1 AND origin_device_id IS NULL
          AND CAST(id AS TEXT) IN (
            SELECT origin_local_id FROM sync_dead_letter
            WHERE lane = 'content' AND kind = 'prompt' AND reason LIKE ?
          )
      `).run(sizeReason);
      this.db.prepare(`
        DELETE FROM sync_dead_letter WHERE lane = 'content' AND kind = 'prompt' AND reason LIKE ?
      `).run(sizeReason);
      if (requeued.changes > 0) {
        logger.info("DB", "Re-queued prompts quarantined for size before the cloud-sync prompt clamp", {
          prompts: requeued.changes
        });
      }
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(60, (/* @__PURE__ */ new Date()).toISOString());
    })();
  }
  // v59 — sdk_sessions.project_key_source: how the session's project key was
  // derived ('path' | 'git-remote' | 'environment'), recorded with its checkout
  // (cwd). Worktree adoption treats a checkout that no longer exists as a
  // deleted worktree only for a folder-derived key: a slug or an environment
  // name is not tied to one folder (gate P1-2). Local-only, like cwd. Runs last,
  // after v33's sdk_sessions rebuild, for the reason given at v53 below.
  ensureSessionProjectKeySourceColumn() {
    const cols = this.db.query("PRAGMA table_info(sdk_sessions)").all();
    if (!cols.some((c) => c.name === "project_key_source")) {
      this.db.run("ALTER TABLE sdk_sessions ADD COLUMN project_key_source TEXT");
      logger.debug("DB", "Added project_key_source column to sdk_sessions table");
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(59, (/* @__PURE__ */ new Date()).toISOString());
  }
  // v53 — sdk_sessions.cwd. Worktree adoption discovers repos from this;
  // sdk_sessions is local-only, so no sync-lane plumbing (#2864).
  //
  // Runs LAST in the constructor, after every migration that rebuilds
  // sdk_sessions from a fixed column list (v33's composite-identity rebuild):
  // added any earlier, a pre-v33 database would lose the column in that
  // rebuild and every ingest would then fail on setSessionCwd.
  ensureSessionCwdColumn() {
    const cols = this.db.query("PRAGMA table_info(sdk_sessions)").all();
    if (!cols.some((c) => c.name === "cwd")) {
      this.db.run("ALTER TABLE sdk_sessions ADD COLUMN cwd TEXT");
      logger.debug("DB", "Added cwd column to sdk_sessions table (#2864)");
    }
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_sdk_sessions_cwd ON sdk_sessions(cwd)"
    );
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(53, (/* @__PURE__ */ new Date()).toISOString());
  }
  // v55 — #3531: retrieval compares `project`/`merged_into_project` with COLLATE
  // NOCASE, so checkouts whose directory names differ only in case read one
  // bucket. Stored keys are NOT rewritten (no re-key, nothing to remap for
  // cloud sync). The BINARY indexes cannot serve a NOCASE predicate, so these
  // keep the hot read paths on an index seek. Runs last: v33 rebuilds
  // sdk_sessions and would drop an index created on the old table.
  ensureProjectNocaseIndexes() {
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_project_nocase ON observations(project COLLATE NOCASE)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase ON observations(merged_into_project COLLATE NOCASE)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_project_nocase ON session_summaries(project COLLATE NOCASE)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase ON session_summaries(merged_into_project COLLATE NOCASE)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project_nocase ON sdk_sessions(project COLLATE NOCASE)");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(55, (/* @__PURE__ */ new Date()).toISOString());
  }
  // v58 — advisor_calls: a durable, verbatim record of every `advisor` tool
  // call. The advisor is a server-side tool (server_tool_use in the
  // transcript): it never fires PostToolUse and never enters the observation
  // pipeline, so rows come from the Stop hook's transcript scan (see
  // shared/advisor-transcript.ts) via POST /api/advisor-calls, and only when
  // CLAUDE_MEM_CAPTURE_ADVISOR_CALLS is on. The advice is stored in full; the
  // forwarded context is not (it already lives in the transcript), only a
  // pointer to it (transcript path + byte offset) and the turn's user message.
  // tool_use_id is UNIQUE so replayed scans are no-ops. Local only: not synced.
  //
  // Guarded by introspection (CREATE ... IF NOT EXISTS) like the other late
  // migrations, and runs last so no older sdk_sessions rebuild can drop it.
  ensureAdvisorCallsTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS advisor_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        advisor_model TEXT,
        cwd TEXT,
        last_user_message TEXT,
        transcript_path TEXT,
        transcript_byte_offset INTEGER,
        advice TEXT NOT NULL,
        occurred_at_epoch INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_calls_tool_use ON advisor_calls(tool_use_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_session ON advisor_calls(session_db_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_project ON advisor_calls(project)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_project_nocase ON advisor_calls(project COLLATE NOCASE)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_occurred ON advisor_calls(occurred_at_epoch DESC)");
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(58, (/* @__PURE__ */ new Date()).toISOString());
  }
  /**
   * Insert an advisor call; a duplicate tool_use_id (replayed transcript
   * scan, re-fired Stop hook) is ignored. Returns the row id and whether
   * this call actually inserted it.
   */
  recordAdvisorCall(input) {
    const now = /* @__PURE__ */ new Date();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO advisor_calls
      (session_db_id, content_session_id, project, platform_source, tool_use_id, advisor_model, cwd, last_user_message, transcript_path, transcript_byte_offset, advice, occurred_at_epoch, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionDbId,
      input.contentSessionId,
      input.project,
      input.platformSource,
      input.toolUseId,
      input.advisorModel ?? null,
      input.cwd ?? null,
      input.lastUserMessage ?? null,
      input.transcriptPath ?? null,
      input.transcriptByteOffset ?? null,
      input.advice,
      input.occurredAtEpoch,
      now.toISOString(),
      now.getTime()
    );
    if (result.changes > 0) {
      return { id: Number(result.lastInsertRowid), inserted: true };
    }
    const existing = this.db.prepare("SELECT id FROM advisor_calls WHERE tool_use_id = ?").get(input.toolUseId);
    return { id: existing?.id ?? 0, inserted: false };
  }
  getAdvisorCalls(offset, limit, project, platformSource) {
    let query = "SELECT * FROM advisor_calls";
    const params = [];
    const conditions = [];
    if (project) {
      conditions.push("project COLLATE NOCASE = ?");
      params.push(project);
    } else {
      conditions.push("project != ?");
      params.push(OBSERVER_SESSIONS_PROJECT);
    }
    if (platformSource) {
      conditions.push("platform_source = ?");
      params.push(platformSource);
    }
    query += ` WHERE ${conditions.join(" AND ")}`;
    query += " ORDER BY occurred_at_epoch DESC LIMIT ? OFFSET ?";
    params.push(limit + 1, offset);
    const results = this.db.prepare(query).all(...params);
    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }
  getAdvisorCallById(id) {
    const row = this.db.prepare("SELECT * FROM advisor_calls WHERE id = ?").get(id);
    return row ?? null;
  }
  addObservationSubagentColumns() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27);
    const obsCols = this.db.query("PRAGMA table_info(observations)").all();
    const obsHasAgentType = obsCols.some((col) => col.name === "agent_type");
    const obsHasAgentId = obsCols.some((col) => col.name === "agent_id");
    if (!obsHasAgentType) {
      this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT");
    }
    if (!obsHasAgentId) {
      this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT");
    }
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");
    const pendingCols = this.db.query("PRAGMA table_info(pending_messages)").all();
    if (pendingCols.length > 0) {
      const pendingHasAgentType = pendingCols.some((col) => col.name === "agent_type");
      const pendingHasAgentId = pendingCols.some((col) => col.name === "agent_id");
      if (!pendingHasAgentType) {
        this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT");
      }
      if (!pendingHasAgentId) {
        this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT");
      }
    }
    if (!applied) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27, (/* @__PURE__ */ new Date()).toISOString());
    }
  }
  ensurePendingMessagesToolUseIdColumn() {
    const tables = this.db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'"
    ).all();
    if (tables.length === 0) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    const cols = this.db.query("PRAGMA table_info(pending_messages)").all();
    const hasToolUseId = cols.some((c) => c.name === "tool_use_id");
    if (!hasToolUseId) {
      this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT");
    }
    this.db.run("BEGIN TRANSACTION");
    try {
      this.dedupePendingMessagesByToolUseId();
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("DB", "Failed to de-dupe pending_messages by tool_use_id, rolled back", {}, err);
      throw error;
    }
  }
  dedupePendingMessagesByToolUseId() {
    this.db.run(`
      DELETE FROM pending_messages
       WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_db_id, tool_use_id
                      ORDER BY CASE status
                        WHEN 'processing' THEN 0
                        WHEN 'pending' THEN 1
                        ELSE 2
                      END, id
                    ) AS duplicate_rank
               FROM pending_messages
              WHERE tool_use_id IS NOT NULL
           )
          WHERE duplicate_rank > 1
         )
    `);
    this.db.run(`
      -- tool_use_id is optional for summaries and legacy rows; enforce de-dupe
      -- only for rows that came from a concrete tool-use event.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
      ON pending_messages(session_db_id, tool_use_id)
      WHERE tool_use_id IS NOT NULL
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28, (/* @__PURE__ */ new Date()).toISOString());
  }
  addObservationsUniqueContentHashIndex() {
    const applied = this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29);
    if (applied) return;
    const obsCols = this.db.query("PRAGMA table_info(observations)").all();
    const hasMem = obsCols.some((c) => c.name === "memory_session_id");
    const hasHash = obsCols.some((c) => c.name === "content_hash");
    if (!hasMem || !hasHash) {
      this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29, (/* @__PURE__ */ new Date()).toISOString());
      return;
    }
    this.db.run("BEGIN TRANSACTION");
    try {
      this.dedupeObservationsByContentHash();
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("DB", "Failed to de-dupe observations by content_hash, rolled back", {}, err);
      throw error;
    }
  }
  dedupeObservationsByContentHash() {
    this.db.run(`
      UPDATE observations
         SET content_hash = '__null_migration_' || id || '__'
       WHERE content_hash IS NULL
    `);
    this.db.run(`
      DELETE FROM observations
       WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY memory_session_id, content_hash
                      ORDER BY id
                    ) AS duplicate_rank
               FROM observations
           )
          WHERE duplicate_rank > 1
       )
    `);
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_session_hash
      ON observations(memory_session_id, content_hash)
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29, (/* @__PURE__ */ new Date()).toISOString());
  }
  addObservationsMetadataColumn() {
    const cols = this.db.query("PRAGMA table_info(observations)").all();
    const hasColumn = cols.some((c) => c.name === "metadata");
    if (!hasColumn) {
      this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT");
      logger.debug("DB", "Added metadata column to observations table (#2116)");
    }
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_observations_source_fingerprint ON observations(
        project,
        CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.sourceFingerprint') END,
        id DESC
      ) WHERE CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.sourceFingerprint') END IS NOT NULL
    `);
    this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30, (/* @__PURE__ */ new Date()).toISOString());
  }
  updateMemorySessionId(sessionDbId, memorySessionId) {
    const current = this.db.prepare(`
      SELECT memory_session_id
      FROM sdk_sessions
      WHERE id = ?
    `).get(sessionDbId);
    if (!current || current.memory_session_id === memorySessionId) return;
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE sdk_sessions
        SET memory_session_id = ?
        WHERE id = ?
      `).run(memorySessionId, sessionDbId);
      this.db.prepare(`
        UPDATE tool_uses
        SET memory_session_id = ?
        WHERE session_db_id = ?
      `).run(memorySessionId, sessionDbId);
      if (memorySessionId) this.requeuePromptSync(sessionDbId);
    })();
  }
  /**
   * Enqueue one mutation op for the sync hub (kind='mutation'). The op UUID
   * is minted HERE, once, and stored with the queued op — CloudSync's drain
   * reuses it on every push retry so the hub's
   * (origin_device, kind, origin_id, rev) index dedupes replays (REV MINTING
   * RULES, SyncApply.ts). Pure SQL, no notify(): callers on the worker
   * connection nudge CloudSync themselves; the startup drain catches the
   * rest.
   *
   * Producer gate: acked ops are DELETEd by CloudSync's drain — the queue's
   * ONLY retention path — and CloudSync exists iff cloud sync is fully
   * credentialed. With syncOpsEnabled false (unconfigured install) this
   * no-ops instead of growing sync_outbox forever.
   *
   * Supersede, don't append (set_prompt_session): every session
   * re-registration re-emits the repair for EVERY prompt in the session
   * (requeuePromptSync), and the mutation site bumps the prompt's sync_rev
   * before each enqueue — so per target the newest op always carries the
   * complete field set at the highest rev, and a still-queued older op is
   * dead weight. Replicas apply by the op.rev >= row sync_rev guard, so
   * dropping an unsent superseded op cannot regress them; one already pushed
   * (ack lost mid-flight) is ordered before the newer op in the hub log and
   * converges the same way. This bounds the outbox at one
   * set_prompt_session row per prompt regardless of re-registration count.
   *
   * Its statements are cached (cachedStatement): requeuePromptSync calls this
   * once per prompt.
   */
  enqueueMutationOp(rev, body) {
    if (!this.syncOpsEnabled) return;
    const candidate = JSON.parse(JSON.stringify(body));
    if (candidate.op === "set_prompt_session") {
      const target = candidate.target;
      if (target?.origin_device_id === null) target.origin_device_id = "self";
    }
    validateCanonicalMutation(candidate);
    if (body.op === "set_prompt_session") {
      this.cachedStatement(`
        DELETE FROM sync_outbox
        WHERE json_valid(body)
          AND json_extract(body, '$.op') = 'set_prompt_session'
          AND json_extract(body, '$.target.origin_device_id') IS ?
          AND json_extract(body, '$.target.origin_local_id') = ?
      `).run(
        body.target?.origin_device_id ?? null,
        String(body.target?.origin_local_id ?? "")
      );
    }
    this.cachedStatement(`
      INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), String(rev), JSON.stringify(body), Date.now());
  }
  /**
   * Prompt→session repair as an ordered sync op (plan Phase 3 task 2):
   * prompts are captured (and pushed) before the SDK session registers its
   * memory_session_id, so their first push carries NULL join fields. Once
   * the mapping lands, each affected NATIVE prompt row gets sync_rev bumped
   * by 1 with synced_at re-nulled — the next flush re-pushes the corrected
   * row body at the higher rev (replicas apply it via the row-op rev guard),
   * and a set_prompt_session mutation op is enqueued at that same post-bump
   * rev (SyncApply REV MINTING RULES) so replicas that already hold the
   * rev-1 row link it to the session even before the corrected row op lands.
   * target.origin_device_id is stored as NULL ("this device") — CloudSync's
   * drain substitutes its resolved device id at push time, keeping device
   * identity single-sourced (see DEVICE IDENTITY in SyncApply.ts).
   *
   * Replica prompt rows (origin_device_id NOT NULL) are untouched: their
   * repair travels through the log from THEIR origin device.
   *
   * This bump-then-repush ordering is also what made CloudSync's old
   * stampGuard unnecessary: the drain stamps synced_at only where the acked
   * rev still equals the row's sync_rev, so a registration landing while a
   * POST is in flight leaves the row unsynced and it re-pushes corrected.
   *
   * With sync ops disabled the whole repair is skipped: the bump + re-null
   * exist only so already-pushed rows re-push corrected, nothing pushes
   * without CloudSync, and a prompt that first syncs after a later
   * enablement resolves its session join fields at snapshot time anyway
   * (the drain SELECT joins sdk_sessions). Skipping also keeps v47
   * launch-baseline rows excluded instead of promoting them into sync
   * eligibility via the rev bump.
   */
  requeuePromptSync(sessionDbId) {
    if (!this.syncOpsEnabled) return;
    const session = this.cachedStatement(`
      SELECT memory_session_id, project, content_session_id, platform_source
      FROM sdk_sessions WHERE id = ?
    `).get(sessionDbId);
    if (!session?.memory_session_id) return;
    const tx = this.db.transaction(() => {
      const prompts = this.cachedStatement(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(sessionDbId);
      if (prompts.length === 0) return;
      const bumpPromptRev = this.cachedStatement(`
        UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
        WHERE id = ? AND origin_device_id IS NULL
      `);
      for (const prompt of prompts) {
        const nextRev = incrementCanonicalDecimal(prompt.sync_rev);
        bumpPromptRev.run(nextRev, prompt.id);
        this.enqueueMutationOp(nextRev, {
          op: "set_prompt_session",
          target: { origin_device_id: null, origin_local_id: prompt.id },
          fields: {
            memory_session_id: session.memory_session_id,
            project: session.project,
            content_session_id: session.content_session_id,
            platform_source: session.platform_source
          }
        });
      }
    });
    tx();
  }
  markSessionCompleted(sessionDbId) {
    const nowEpoch = Date.now();
    const nowIso = new Date(nowEpoch).toISOString();
    this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(nowIso, nowEpoch, sessionDbId);
  }
  /**
   * Put a completed row back to 'active' because the session it labels carried
   * on (#4080).
   *
   * `markSessionCompleted` above is the only writer of `status`, and it only
   * ever writes 'completed'; `finalizeSession` returns early on every later
   * end once it reads that. So a session that continues after a finalize — a
   * `claude --resume`, or one finalized while it was still live — keeps the
   * FIRST end's `completed_at` for the rest of its life while new prompts land
   * under the same row. Every reader of `status` is then wrong about it:
   * SearchManager prints **In Progress** only for 'active', and anything
   * counting sessions by status counts this one at an end it has already
   * passed.
   *
   * Guarded on `status = 'completed'`, so it is a no-op for a row that is
   * already active, and it clears BOTH completion stamps — leaving the row
   * active with a stale `completed_at` would trade one wrong label for
   * another. sdk_sessions rows do not sync, so there is no op to enqueue.
   */
  reopenCompletedSession(sessionDbId) {
    this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', completed_at = NULL, completed_at_epoch = NULL
      WHERE id = ? AND status = 'completed'
    `).run(sessionDbId);
  }
  ensureMemorySessionIdRegistered(sessionDbId, memorySessionId, workerPort) {
    const session = this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found in sdk_sessions`);
    }
    if (session.memory_session_id === null) {
      this.db.transaction(() => {
        this.db.prepare(`
          UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
        `).run(memorySessionId, sessionDbId);
        this.requeuePromptSync(sessionDbId);
      })();
      logger.info("DB", "Registered memory_session_id before storage (FK fix)", {
        sessionDbId,
        newId: memorySessionId
      });
    } else if (session.memory_session_id !== memorySessionId) {
      logger.debug("DB", "Keeping the registered memory_session_id", {
        sessionDbId,
        registered: session.memory_session_id,
        offered: memorySessionId
      });
    }
    if (typeof workerPort === "number" && session.worker_port !== workerPort) {
      this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(workerPort, sessionDbId);
    }
    return session.memory_session_id ?? memorySessionId;
  }
  /**
   * Every stored key a read of `projects` has to match: their stored spellings
   * (#3531) and the projects merged into them, one hop (gate P2-4). Search
   * hands these to Chroma, which compares metadata exactly, and to SQLite.
   */
  getProjectReadKeys(projects) {
    return projectReadKeys(this.db, projects);
  }
  getAllProjects(platformSource) {
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : void 0;
    let query = `
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `;
    const params = [OBSERVER_SESSIONS_PROJECT];
    if (normalizedPlatformSource) {
      query += " AND COALESCE(platform_source, ?) = ?";
      params.push(DEFAULT_PLATFORM_SOURCE, normalizedPlatformSource);
    }
    query += " ORDER BY project ASC";
    const rows = this.db.prepare(query).all(...params);
    return rows.map((row) => row.project);
  }
  getProjectCatalog() {
    const rows = this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}'), project
      ORDER BY latest_epoch DESC
    `).all(OBSERVER_SESSIONS_PROJECT);
    const projects = [];
    const seenProjects = /* @__PURE__ */ new Set();
    const projectsBySource = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const source = normalizePlatformSource(row.platform_source);
      let sourceProjects = projectsBySource.get(source);
      if (!sourceProjects) projectsBySource.set(source, sourceProjects = /* @__PURE__ */ new Set());
      sourceProjects.add(row.project);
      if (!seenProjects.has(row.project)) {
        seenProjects.add(row.project);
        projects.push(row.project);
      }
    }
    const sources = sortPlatformSources([...projectsBySource.keys()]);
    return {
      projects,
      sources,
      projectsBySource: Object.fromEntries(
        sources.map((source) => [source, [...projectsBySource.get(source) ?? []]])
      )
    };
  }
  /**
   * Session catalog for the viewer's Sessions view: newest first, one row per
   * (platform_source, content_session_id), with the session's combined
   * observation + summary + prompt count. Paged by `limit`/`offset` and
   * filterable by project and platform so the payload stays small on large
   * databases; `hasMore` says whether older sessions follow this page.
   */
  getSessionCatalog(options = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? SESSION_CATALOG_DEFAULT_LIMIT), 1), SESSION_CATALOG_MAX_LIMIT);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
    let query = `
      SELECT
        s.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        s.custom_title,
        s.started_at_epoch,
        (
          (SELECT COUNT(*) FROM observations o WHERE o.memory_session_id = s.memory_session_id)
          + (SELECT COUNT(*) FROM session_summaries ss WHERE ss.memory_session_id = s.memory_session_id)
          + (SELECT COUNT(*) FROM user_prompts up WHERE up.session_db_id = s.id)
        ) as item_count
      FROM sdk_sessions s
      WHERE s.project IS NOT NULL AND s.project != ''
        AND s.project != ?
    `;
    const params = [OBSERVER_SESSIONS_PROJECT];
    if (options.project) {
      query += " AND s.project COLLATE NOCASE = ?";
      params.push(options.project);
    }
    if (options.platformSource) {
      query += ` AND COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') = ?`;
      params.push(normalizePlatformSource(options.platformSource));
    }
    query += " ORDER BY s.started_at_epoch DESC, s.id DESC LIMIT ? OFFSET ?";
    params.push(limit + 1, offset);
    const rows = this.db.prepare(query).all(...params);
    return { sessions: rows.slice(0, limit), hasMore: rows.length > limit };
  }
  /** One saved prompt with its session's fields, by the row id its save returned. */
  getUserPromptById(userPromptId) {
    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id = ?
    `);
    return stmt.get(userPromptId);
  }
  findRecentDuplicateUserPrompt(contentSessionId, promptText, windowMs, sessionDbId) {
    return findRecentDuplicateUserPrompt(
      this.db,
      contentSessionId,
      normalizeStoredPromptText(promptText),
      windowMs,
      this.resolvePromptSessionDbId(contentSessionId, sessionDbId) ?? void 0
    );
  }
  getRecentSessionsWithStatus(project, limit = 3, platformSource) {
    const params = [project];
    let platformClause = "";
    if (platformSource) {
      platformClause = `AND COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`;
      params.push(normalizePlatformSource(platformSource));
    }
    params.push(limit);
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          EXISTS (SELECT 1 FROM session_summaries sum
            WHERE sum.memory_session_id = s.memory_session_id) as has_summary
        FROM sdk_sessions s
        WHERE s.project COLLATE NOCASE = ? AND s.memory_session_id IS NOT NULL
        ${platformClause}
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `);
    return stmt.all(...params);
  }
  getObservationsForSession(memorySessionId, platformSource) {
    const params = [memorySessionId];
    let platformClause = "";
    if (platformSource) {
      platformClause = `
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?
        )
      `;
      params.push(normalizePlatformSource(platformSource));
    }
    const stmt = this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ${platformClause}
      ORDER BY created_at_epoch ASC
    `);
    return stmt.all(...params);
  }
  getObservationById(id, platformSource) {
    if (!platformSource) {
      const stmt2 = this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `);
      return stmt2.get(id) || null;
    }
    const stmt = this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE o.id = ?
        AND COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?
    `);
    return stmt.get(id, normalizePlatformSource(platformSource)) || null;
  }
  // ---------------------------------------------------------------------
  // tool_uses (v51) — durable raw tool I/O side index. See ./tool-uses.ts for
  // why this is separate from pending_messages and why no cost column exists.
  // ---------------------------------------------------------------------
  upsertToolUse(input) {
    return upsertToolUse(this.db, input);
  }
  linkToolUsesToObservation(params) {
    return linkToolUsesToObservation(this.db, params);
  }
  getToolUsesByIds(ids, options = {}) {
    return getToolUsesByIds(this.db, ids, options);
  }
  queryToolUses(filters = {}) {
    return queryToolUses(this.db, filters);
  }
  queryToolUseIndex(filters = {}) {
    return queryToolUseIndex(this.db, filters);
  }
  appendWorkStateEntry(entry) {
    const entryId = appendWorkStateEntry(this.db, entry);
    emitContextInvalidation({ projects: [entry.project] }, "appendWorkStateEntry", "additive", { kinds: ["work_state"], workStateLists: [entry.listName] });
    return entryId;
  }
  /**
   * The id CloudSync syncs this device under, once it is resolved: work-state
   * reads order native rows as this device's writes, the way other devices
   * and cmem.ai order them. Empty (the default) when sync has no device id.
   */
  setLocalSyncDeviceId(deviceId) {
    this.localSyncDeviceId = deviceId;
  }
  getLocalSyncDeviceId() {
    return this.localSyncDeviceId;
  }
  getWorkStateEntries(projects, listName) {
    return scopeWorkStateEntries(
      getWorkStateEntries(this.db, this.getProjectReadKeys(projects), listName, this.localSyncDeviceId),
      projects
    );
  }
  countToolUses(filters = {}) {
    return countToolUses(this.db, filters);
  }
  getObservationsByIds(ids, options = {}) {
    if (ids.length === 0) return [];
    const { orderBy = "date_desc", platformSource, type, concepts, files } = options;
    const limit = positiveIntegerRowLimit(options.limit);
    const projects = scopedProjects(options);
    const preserveIdOrder = orderBy === "relevance";
    const direction = orderBy === "date_asc" ? "ASC" : "DESC";
    const orderClause = preserveIdOrder ? "" : `ORDER BY o.created_at_epoch ${direction}, o.id ${direction}`;
    const limitClause = limit && !preserveIdOrder ? "LIMIT ?" : "";
    const placeholders = ids.map(() => "?").join(",");
    const params = [...ids];
    const additionalConditions = [];
    if (projects.length > 0) {
      const scope = projectScopeSql("o", projects, { includeMerged: true });
      additionalConditions.push(scope.sql);
      params.push(...scope.params);
    }
    if (platformSource) {
      additionalConditions.push(`COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`);
      params.push(normalizePlatformSource(platformSource));
    }
    if (type) {
      if (Array.isArray(type)) {
        const typePlaceholders = type.map(() => "?").join(",");
        additionalConditions.push(`o.type IN (${typePlaceholders})`);
        params.push(...type);
      } else {
        additionalConditions.push("o.type = ?");
        params.push(type);
      }
    }
    if (concepts) {
      const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
      const conceptArray = `CASE WHEN json_valid(o.concepts) THEN CASE
        WHEN json_type(o.concepts) = 'array' THEN o.concepts
        WHEN json_type(o.concepts) = 'text' THEN json_array(json_extract(o.concepts, '$'))
        ELSE json_array(o.concepts) END ELSE json_array(o.concepts) END`;
      const conceptConditions = conceptsList.map(
        () => `EXISTS (SELECT 1 FROM json_each(${conceptArray}) WHERE type = 'text' AND value = ?)`
      );
      if (conceptConditions.length > 0) {
        params.push(...conceptsList);
        additionalConditions.push(`(${conceptConditions.join(" OR ")})`);
      }
    }
    if (files) {
      const filesList = Array.isArray(files) ? files : [files];
      const fileArrayJson = (column) => `CASE WHEN json_valid(${column}) THEN CASE WHEN json_type(${column}) = 'array' THEN ${column} ELSE '[]' END ELSE '[]' END`;
      const fileConditions = filesList.map(() => {
        return `(EXISTS (SELECT 1 FROM json_each(${fileArrayJson("o.files_read")}) WHERE type = 'text' AND replace(value, '\\', '/') LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM json_each(${fileArrayJson("o.files_modified")}) WHERE type = 'text' AND replace(value, '\\', '/') LIKE ? ESCAPE '\\'))`;
      });
      if (fileConditions.length > 0) {
        filesList.forEach((file) => {
          const literal = file.replace(/\\/g, "/").replace(/[\\%_]/g, "\\$&");
          params.push(`%${literal}%`, `%${literal}%`);
        });
        additionalConditions.push(`(${fileConditions.join(" OR ")})`);
      }
    }
    const whereClause = additionalConditions.length > 0 ? `WHERE o.id IN (${placeholders}) AND ${additionalConditions.join(" AND ")}` : `WHERE o.id IN (${placeholders})`;
    if (limitClause) params.push(limit);
    const stmt = this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${whereClause}
      ${orderClause}
      ${limitClause}
    `);
    const rows = stmt.all(...params);
    if (!preserveIdOrder) return rows;
    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.map((id) => rowMap.get(id)).filter((r) => !!r);
    return limit ? ordered.slice(0, limit) : ordered;
  }
  getSummaryForSession(memorySessionId, platformSource) {
    const params = [memorySessionId];
    let platformClause = "";
    if (platformSource) {
      platformClause = `
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?
        )
      `;
      params.push(normalizePlatformSource(platformSource));
    }
    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ${platformClause}
      ORDER BY created_at_epoch DESC, id DESC
      LIMIT 1
    `);
    return stmt.get(...params) || null;
  }
  getSessionById(id) {
    const stmt = this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
             user_prompt, custom_title, status,
             observed_model, observed_billing
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);
    return stmt.get(id) || null;
  }
  findSessionDbIdByContentSessionId(contentSessionId, platformSource) {
    const row = this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
      LIMIT 1
    `).get(
      DEFAULT_PLATFORM_SOURCE,
      normalizePlatformSource(platformSource),
      contentSessionId
    );
    return row?.id ?? null;
  }
  claimTelegramWrapup({
    platformSource,
    contentSessionId,
    project,
    routeKey,
    summaryCreatedAtEpoch
  }) {
    const claimedAtEpoch = Date.now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO telegram_wrapups
      (platform_source, content_session_id, project, route_key, summary_created_at_epoch, status, claimed_at_epoch, sent_at_epoch)
      VALUES (?, ?, ?, ?, ?, 'claimed', ?, NULL)
    `).run(
      normalizePlatformSource(platformSource),
      contentSessionId,
      project,
      routeKey,
      summaryCreatedAtEpoch,
      claimedAtEpoch
    );
    if (result.changes === 1) return true;
    const reclaim = this.db.prepare(`
      UPDATE telegram_wrapups
      SET summary_created_at_epoch = ?, claimed_at_epoch = ?, sent_at_epoch = NULL
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
        AND claimed_at_epoch <= ?
    `).run(
      summaryCreatedAtEpoch,
      claimedAtEpoch,
      normalizePlatformSource(platformSource),
      contentSessionId,
      project,
      routeKey,
      claimedAtEpoch - TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS
    );
    return reclaim.changes === 1;
  }
  markTelegramWrapupSent({
    platformSource,
    contentSessionId,
    project,
    routeKey
  }) {
    this.db.prepare(`
      UPDATE telegram_wrapups
      SET status = 'sent', sent_at_epoch = ?
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(
      Date.now(),
      normalizePlatformSource(platformSource),
      contentSessionId,
      project,
      routeKey
    );
  }
  releaseTelegramWrapupClaim({
    platformSource,
    contentSessionId,
    project,
    routeKey
  }) {
    this.db.prepare(`
      DELETE FROM telegram_wrapups
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(
      normalizePlatformSource(platformSource),
      contentSessionId,
      project,
      routeKey
    );
  }
  /**
   * Record the observed IDE session's model id and billing posture (from the
   * Stop hook). Each field only overwrites when supplied, so a turn that could
   * not determine one of them keeps the previously stored value.
   */
  setSessionObservedMetadata(sessionDbId, observedModel, observedBilling) {
    this.db.prepare(`
      UPDATE sdk_sessions
      SET observed_model = COALESCE(?, observed_model),
          observed_billing = COALESCE(?, observed_billing)
      WHERE id = ?
    `).run(observedModel || null, observedBilling || null, sessionDbId);
  }
  getSdkSessionsBySessionIds(memorySessionIds, promptIds = []) {
    if (memorySessionIds.length === 0 && promptIds.length === 0) return [];
    const references = [...new Set(memorySessionIds), ...new Set(promptIds)];
    const sessions = /* @__PURE__ */ new Map();
    for (let offset = 0; offset < references.length; offset += 500) {
      const batch = references.slice(offset, offset + 500);
      const memoryIds = batch.filter((id) => typeof id === "string");
      const prompts = batch.filter((id) => typeof id === "number");
      const conditions = [];
      if (memoryIds.length) conditions.push(`memory_session_id IN (${memoryIds.map(() => "?").join(",")})`);
      if (prompts.length) conditions.push(`id IN (SELECT session_db_id FROM user_prompts WHERE id IN (${prompts.map(() => "?").join(",")}))`);
      const stmt = this.db.prepare(`
        SELECT id, content_session_id, memory_session_id, project,
               COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
               user_prompt, custom_title,
               started_at, started_at_epoch, completed_at, completed_at_epoch, status
        FROM sdk_sessions
        WHERE ${conditions.join(" OR ")}
        ORDER BY started_at_epoch DESC
      `);
      for (const row of stmt.all(...batch)) sessions.set(row.id, row);
    }
    return [...sessions.values()].sort((a, b) => b.started_at_epoch - a.started_at_epoch);
  }
  /**
   * The session's current persisted prompt number, including gaps from partial imports.
   * `createdAtOrBeforeEpochMs` answers "which prompt was current at that
   * moment" instead — for an event that happened earlier than it is being
   * ingested (a hook spool entry drained after an outage).
   */
  getPromptNumberFromUserPrompts(contentSessionId, sessionDbId, createdAtOrBeforeEpochMs) {
    const resolvedSessionDbId = this.resolvePromptSessionDbId(contentSessionId, sessionDbId);
    const sessionClause = resolvedSessionDbId !== null ? "session_db_id = ?" : "content_session_id = ?";
    const sessionParam = resolvedSessionDbId !== null ? resolvedSessionDbId : contentSessionId;
    if (createdAtOrBeforeEpochMs !== void 0) {
      const result2 = this.db.prepare(`
        SELECT COALESCE(MAX(prompt_number), 0) as count FROM user_prompts WHERE ${sessionClause} AND created_at_epoch <= ?
      `).get(sessionParam, createdAtOrBeforeEpochMs);
      return result2.count;
    }
    const result = this.db.prepare(`
      SELECT COALESCE(MAX(prompt_number), 0) as count FROM user_prompts WHERE ${sessionClause}
    `).get(sessionParam);
    return result.count;
  }
  getLatestPromptTextFromUserPrompts(contentSessionId, sessionDbId) {
    const resolvedSessionDbId = this.resolvePromptSessionDbId(contentSessionId, sessionDbId);
    const whereClause = resolvedSessionDbId !== null ? "session_db_id = ?" : "content_session_id = ?";
    const param = resolvedSessionDbId !== null ? resolvedSessionDbId : contentSessionId;
    const result = this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE ${whereClause}
        AND prompt_text IS NOT NULL
        AND length(trim(prompt_text)) > 0
      ORDER BY prompt_number DESC, created_at_epoch DESC
      LIMIT 1
    `).get(param);
    return result?.prompt_text ?? null;
  }
  /**
   * Epoch ms of this device's newest user prompt or captured tool use, or null
   * when the database holds neither. It is the auto-updater's durable "quiet"
   * signal (src/services/auto-update/auto-update-check.ts
   * isWorkerQuietBySignals): every host's prompts are saved to user_prompts
   * (SessionRoutes) and every captured tool use to tool_uses (the one
   * choke point in http/shared.ts), and unlike the in-memory session map it
   * survives a worker restart.
   *
   * Prompts synced from another device (origin_device_id set by SyncApply) are
   * activity on that device, so they are left out; tool_uses is never synced.
   * Each half reads its created_at_epoch index from the newest end
   * (idx_user_prompts_created, idx_tool_uses_created_at_epoch), and the prompt
   * half stops at the first local row. So it is quick when the newest prompt is
   * local, and otherwise steps past every synced prompt newer than the newest
   * local one: the cost grows with that count, with no fixed worst case.
   * Measured 2026-11-08 with bun:sqlite on an in-memory database holding
   * 200,000 tool uses: 0.01 ms when the newest prompt is local; 35 ms past
   * 200,000 synced prompts, 90 ms past 500,000 and 176 ms past 1,000,000 (a
   * second measurement of 1,000,000 synced prompts and no local one: 256 ms).
   * The auto-updater calls it at most twice per hourly tick.
   */
  getNewestCapturedActivityEpoch() {
    const row = this.db.prepare(`
      SELECT MAX(newest) AS newest FROM (
        SELECT MAX(created_at_epoch) AS newest FROM user_prompts WHERE origin_device_id IS NULL
        UNION ALL
        SELECT MAX(created_at_epoch) AS newest FROM tool_uses
      )
    `).get();
    return row?.newest ?? null;
  }
  createSDKSession(contentSessionId, project, userPrompt, customTitle, platformSource, eventOccurredAtEpochMs) {
    const now = /* @__PURE__ */ new Date();
    const nowEpoch = now.getTime();
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : DEFAULT_PLATFORM_SOURCE;
    if (this.isBeforeSessionDeletion(normalizedPlatformSource, contentSessionId, eventOccurredAtEpochMs)) {
      throw new Error("session_deleted");
    }
    const storedUserPrompt = normalizeStoredPromptText(userPrompt);
    if (customTitle) {
      this.validateSetTitleMutation(contentSessionId, normalizedPlatformSource, customTitle);
    }
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT id, platform_source
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
      `).get(DEFAULT_PLATFORM_SOURCE, normalizedPlatformSource, contentSessionId);
      if (existing) {
        if (project) {
          this.db.prepare(`
            UPDATE sdk_sessions SET project = ?
            WHERE id = ? AND (project IS NULL OR project = '' OR (project = 'unknown' AND cwd IS NULL))
          `).run(project, existing.id);
        }
        if (storedUserPrompt && storedUserPrompt !== MEDIA_PROMPT_PLACEHOLDER) {
          this.db.prepare(`
            UPDATE sdk_sessions SET user_prompt = ?
            WHERE id = ? AND (user_prompt IS NULL OR user_prompt = '' OR user_prompt = ?)
          `).run(storedUserPrompt, existing.id, MEDIA_PROMPT_PLACEHOLDER);
        }
        if (customTitle) {
          const current = this.db.prepare(
            "SELECT custom_title FROM sdk_sessions WHERE id = ?"
          ).get(existing.id);
          if (current && current.custom_title === null) {
            this.db.prepare(`
              UPDATE sdk_sessions SET custom_title = ?
              WHERE id = ? AND custom_title IS NULL
            `).run(customTitle, existing.id);
            this.enqueueSetTitleOp(contentSessionId, normalizedPlatformSource, customTitle);
          }
        }
        return existing.id;
      }
      const result = this.db.prepare(`
        INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
      `).run(contentSessionId, project, normalizedPlatformSource, storedUserPrompt, customTitle || null, now.toISOString(), nowEpoch);
      if (customTitle) {
        this.enqueueSetTitleOp(contentSessionId, normalizedPlatformSource, customTitle);
      }
      return Number(result.lastInsertRowid);
    }).immediate();
  }
  // First write wins: cwd drifts when the agent `cd`s into a subdirectory, and
  // the launch directory is the one that identifies the repo. The key source
  // (how the session's project key was derived from that checkout) is recorded
  // in the same write, so the two always describe the same resolution.
  setSessionCwd(sessionDbId, cwd, projectKeySource) {
    if (!cwd.trim()) return;
    this.db.prepare(
      "UPDATE sdk_sessions SET cwd = ?, project_key_source = ? WHERE id = ? AND cwd IS NULL"
    ).run(cwd, projectKeySource ?? null, sessionDbId);
  }
  /** The checkout the session was launched in, or null when none was recorded. */
  getSessionCwd(sessionDbId) {
    const row = this.db.prepare("SELECT cwd FROM sdk_sessions WHERE id = ?").get(sessionDbId);
    return row?.cwd ?? null;
  }
  /**
   * Whether this computer recorded the conversation a work-view conversation key names, and the checkout it was
   * launched in (null when none was recorded). Served by the unique index ux_sdk_sessions_platform_content.
   */
  getRecordedFolderForConversation(platformSource, contentSessionId) {
    const row = this.db.prepare("SELECT cwd FROM sdk_sessions WHERE platform_source = ? AND content_session_id = ?").get(platformSource, contentSessionId);
    if (!row) return { sessionIsRecorded: false, recordedFolder: null };
    return { sessionIsRecorded: true, recordedFolder: row.cwd ?? null };
  }
  /**
   * Custom-title mutation op (plan Phase 3 task 2). sdk_sessions rows do not
   * sync, so there is no sync_rev to bump and no synced_at to null — the
   * title travels ONLY as a set_title mutation op. Per the SyncApply REV
   * MINTING RULES, set_title always emits rev 1 (rev is not consulted on
   * apply; titles converge by hub-log order plus parking), and the target is
   * the (platform_source, content_session_id) identity because no
   * memory_session_id is registered at session-creation time.
   */
  enqueueSetTitleOp(contentSessionId, platformSource, customTitle) {
    const mutation = this.validateSetTitleMutation(contentSessionId, platformSource, customTitle);
    this.enqueueMutationOp("1", mutation);
  }
  validateSetTitleMutation(contentSessionId, platformSource, customTitle) {
    const mutation = {
      op: "set_title",
      target: { content_session_id: contentSessionId, platform_source: platformSource },
      fields: { custom_title: customTitle }
    };
    validateCanonicalMutation(mutation);
    return mutation;
  }
  /** Notify only at an owned commit boundary. A caller already inside a
   * transaction must announce its whole committed operation after it returns;
   * publishing here could otherwise expose a prompt that later rolls back. */
  promptCommitted(reason, sessionDbId) {
    if (this.db.inTransaction) return;
    const session = sessionDbId === null ? null : this.db.prepare("SELECT project FROM sdk_sessions WHERE id = ?").get(sessionDbId);
    emitContextInvalidation(session ? { projects: [session.project] } : "all", reason, "additive", { kinds: ["prompt"] });
  }
  saveUserPrompt(contentSessionId, promptNumber, promptText, sessionDbId, nativePromptId, nativePromptHash, createdAtEpoch) {
    const now = new Date(createdAtEpoch ?? Date.now());
    const nowEpoch = now.getTime();
    const storedPromptText = normalizeStoredPromptText(promptText);
    const resolvedSessionDbId = this.resolvePromptSessionDbId(contentSessionId, sessionDbId);
    const stmt = this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, native_prompt_id, native_prompt_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(resolvedSessionDbId, contentSessionId, promptNumber, storedPromptText, now.toISOString(), nowEpoch, nativePromptId ?? null, nativePromptHash ?? null);
    this.promptCommitted("saveUserPrompt", resolvedSessionDbId);
    return result.lastInsertRowid;
  }
  /** The native key claims one prompt atomically, including across worker restarts.
   * Equal text with a different key is a new real turn. No time window applies.
   * It is scoped by the DB session (platform_source + content_session_id).
   */
  saveNativeUserPrompt(contentSessionId, sessionDbId, nativePromptId, promptText, identityPromptText = promptText, options = {}) {
    if (!nativePromptId || nativePromptId.length > 256 || /[\s\x00-\x1f\x7f]/.test(nativePromptId)) {
      throw new Error("Invalid native prompt identity");
    }
    const text = normalizeStoredPromptText(promptText);
    const promptHash = createHash4("sha256").update(stripMemoryTags(identityPromptText).trim()).digest("hex");
    const result = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT id, prompt_number, native_prompt_hash FROM user_prompts
        WHERE session_db_id = ? AND native_prompt_id = ?`).get(sessionDbId, nativePromptId);
      if (existing) {
        if (existing.native_prompt_hash !== promptHash) throw new Error("Native prompt identity was reused with different text");
        return { id: existing.id, promptNumber: existing.prompt_number, duplicate: true };
      }
      const promptNumber = this.getPromptNumberFromUserPrompts(contentSessionId, sessionDbId) + 1;
      if (options.reopenSession !== false) this.reopenCompletedSession(sessionDbId);
      const id = this.saveUserPrompt(contentSessionId, promptNumber, text, sessionDbId, nativePromptId, promptHash, options.createdAtEpoch);
      return { id, promptNumber, duplicate: false };
    }).immediate();
    if (!result.duplicate) this.promptCommitted("saveNativeUserPrompt", sessionDbId);
    return result;
  }
  /**
   * A prompt read back from an agent's own transcript (setup prompt import).
   * It joins the session claude-mem's hooks recorded for the same conversation,
   * keeps the transcript's time, and never reopens a finished session.
   *
   * Two copies of one prompt count once:
   * - a re-scan finds the transcript's native key (`transcript:` prefix + the
   *   agent's message id, compared with its SHA-256 by saveNativeUserPrompt);
   * - a hook-recorded row carries no native key, so it is matched by session,
   *   stored text (or one of `hookTextVariants`, e.g. a slash command's short
   *   form) and the nearest time within `hookMatchWindowMs`. Each hook row is
   *   claimed by one transcript prompt at most (`claimedHookRowIds`), so a
   *   prompt typed twice is still two prompts.
   * A prompt that is entirely private stores nothing.
   */
  importTranscriptUserPrompt(prompt) {
    const text = normalizeStoredPromptText(prompt.promptText);
    if (!text) return { reason: "private" };
    const platformSource = normalizePlatformSource(prompt.platformSource);
    if (this.isBeforeSessionDeletion(platformSource, prompt.contentSessionId, prompt.createdAtEpoch)) {
      return { reason: "deleted" };
    }
    const session = this.db.prepare(`SELECT id FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ? AND content_session_id = ?`).get(DEFAULT_PLATFORM_SOURCE, platformSource, prompt.contentSessionId);
    let sessionDbId = session?.id;
    const nativePromptId = `transcript:${prompt.nativePromptId}`;
    const alreadyImported = sessionDbId !== void 0 && this.db.prepare(`SELECT 1 FROM user_prompts
      WHERE session_db_id = ? AND native_prompt_id = ?`).get(sessionDbId, nativePromptId);
    if (sessionDbId !== void 0 && !alreadyImported) {
      const texts = [text, ...(prompt.hookTextVariants ?? []).map(normalizeStoredPromptText).filter(Boolean)];
      const hookRows = this.db.prepare(`SELECT id, created_at_epoch FROM user_prompts
        WHERE session_db_id = ? AND native_prompt_id IS NULL
          AND prompt_text IN (${texts.map(() => "?").join(", ")})
          AND ABS(created_at_epoch - ?) <= ?
        ORDER BY ABS(created_at_epoch - ?), id`).all(sessionDbId, ...texts, prompt.createdAtEpoch, prompt.hookMatchWindowMs, prompt.createdAtEpoch);
      const hookRow = hookRows.find((row) => !prompt.claimedHookRowIds.has(row.id));
      if (hookRow) {
        prompt.claimedHookRowIds.add(hookRow.id);
        return { reason: "recorded-by-hook", hookRowId: hookRow.id };
      }
    } else if (sessionDbId === void 0) {
      const at = new Date(prompt.createdAtEpoch).toISOString();
      const inserted = this.db.prepare(`INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch, status)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'completed')`).run(prompt.contentSessionId, prompt.project, platformSource, text, at, prompt.createdAtEpoch, at, prompt.createdAtEpoch);
      sessionDbId = Number(inserted.lastInsertRowid);
    }
    const result = this.saveNativeUserPrompt(
      prompt.contentSessionId,
      sessionDbId,
      nativePromptId,
      prompt.promptText,
      prompt.promptText,
      { createdAtEpoch: prompt.createdAtEpoch, reopenSession: false }
    );
    return { reason: result.duplicate ? "already-imported" : "new" };
  }
  /** Prompts claude-mem's hooks recorded since `sinceEpochMs` (everything the transcript import did not write). */
  listHookRecordedPrompts(sinceEpochMs) {
    return this.db.prepare(`SELECT up.id, COALESCE(NULLIF(s.platform_source, ''), ?) AS platformSource,
        s.content_session_id AS contentSessionId, s.project, s.cwd, up.prompt_text AS promptText, up.created_at_epoch AS createdAtEpoch
      FROM user_prompts up JOIN sdk_sessions s ON s.id = up.session_db_id
      WHERE up.created_at_epoch >= ? AND s.project != ?
        AND (up.native_prompt_id IS NULL OR up.native_prompt_id NOT LIKE 'transcript:%')
      ORDER BY up.created_at_epoch, up.id`).all(DEFAULT_PLATFORM_SOURCE, sinceEpochMs, OBSERVER_SESSIONS_PROJECT);
  }
  /** Every observation's token fields, streamed in id order (setup Token Savings feeds them to calculateTokenEconomics). */
  streamObservationTokenFields() {
    return streamRows(this.db.prepare(`SELECT title, subtitle, narrative, facts, discovery_tokens FROM observations ORDER BY id`));
  }
  getUserPrompt(contentSessionId, promptNumber, sessionDbId) {
    const resolvedSessionDbId = this.resolvePromptSessionDbId(contentSessionId, sessionDbId);
    if (resolvedSessionDbId !== null) {
      const result2 = this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(resolvedSessionDbId, promptNumber);
      return result2?.prompt_text ?? null;
    }
    const stmt = this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `);
    const result = stmt.get(contentSessionId, promptNumber);
    return result?.prompt_text ?? null;
  }
  // #3038 — resolve the dedup knobs from settings.json (env overrides apply);
  // off by default. SettingsDefaultsManager.get() would read env/defaults only.
  // Garbage/NaN values fall back to the safe defaults rather than disabling guards.
  dedupConfig() {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const num = (key, fallback) => {
      const v = Number(settings[key]);
      return Number.isFinite(v) ? v : fallback;
    };
    const int = (key, fallback) => Math.trunc(num(key, fallback));
    return {
      enabled: settings.CLAUDE_MEM_DEDUP_ENABLED === "true",
      cosineThreshold: num("CLAUDE_MEM_DEDUP_COSINE_THRESHOLD", 0.8),
      idfVetoDf: int("CLAUDE_MEM_DEDUP_IDF_VETO_DF", 10),
      minSharedTokens: int("CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS", 2),
      maxScan: int("CLAUDE_MEM_DEDUP_MAX_SCAN", 2e3),
      maxBackfillRows: int("CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS", 5e4),
      minProjectDocs: int("CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS", 10)
    };
  }
  // #3038 — read-only listing of Tier-1 near-duplicate candidates (joined to both titles).
  listDedupCandidates(project, limit = 100, status) {
    const select = "SELECT c.id, c.project, c.method, c.score, c.status, c.created_at_epoch, c.observation_id, o1.title AS observation_title, c.duplicate_of_id, o2.title AS duplicate_of_title FROM observation_dedup_candidates c JOIN observations o1 ON o1.id = c.observation_id JOIN observations o2 ON o2.id = c.duplicate_of_id ";
    const statusFilter = "(? IS NULL OR c.status = ?) ";
    const order = "ORDER BY c.score DESC, c.id DESC LIMIT ?";
    const statusArg = status ?? null;
    return project ? this.db.prepare(`${select}WHERE c.project = ? AND ${statusFilter}${order}`).all(project, statusArg, statusArg, limit) : this.db.prepare(`${select}WHERE ${statusFilter}${order}`).all(statusArg, statusArg, limit);
  }
  // #3038 — record a reviewer's verdict on a candidate. `merged` is not accepted here:
  // merging rewrites observation rows and needs its own path. Returns false for an unknown id.
  resolveDedupCandidate(id, status) {
    return this.db.prepare("UPDATE observation_dedup_candidates SET status = ? WHERE id = ?").run(status, id).changes > 0;
  }
  /** #3038 — whether CLAUDE_MEM_DEDUP_ENABLED is on (settings.json or env). */
  isDedupEnabled() {
    return this.dedupConfig().enabled;
  }
  // #3038 — opt-in dedup-scan: backfill the IDF model + sweep all projects for candidates.
  runDedupScan() {
    return runDedupScan(this.db, this.dedupConfig());
  }
  // Forward IDF maintenance + Tier-1 candidate scan for a freshly-inserted observation.
  maintainDedupOnInsert(project, obsId, title, dedup) {
    bumpTokenDf(this.db, project, title);
    if (isFuzzyReady(this.db, project, dedup.minProjectDocs)) {
      recordTier1Candidates(this.db, project, obsId, title, dedup);
    }
  }
  storeObservation(memorySessionId, project, observation, promptNumber, discoveryTokens = 0, overrideTimestampEpoch, generatedByModel, options = {}) {
    if (!hasStorableTitle(observation.title)) {
      throw new Error("storeObservation requires a non-empty title");
    }
    const result = this.storeObservations(
      memorySessionId,
      project,
      [observation],
      null,
      promptNumber,
      discoveryTokens,
      overrideTimestampEpoch,
      generatedByModel,
      options
    );
    return {
      id: result.observationIds[0],
      createdAtEpoch: result.createdAtEpoch,
      mergedIntoExisting: result.mergedIntoExisting[0] ?? false
    };
  }
  storeSummary(memorySessionId, project, summary, promptNumber, discoveryTokens = 0, overrideTimestampEpoch) {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      memorySessionId,
      project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      JSON.stringify(summary.files_read ?? []),
      JSON.stringify(summary.files_edited ?? []),
      summary.notes,
      promptNumber || null,
      discoveryTokens,
      timestampIso,
      timestampEpoch
    );
    emitContextInvalidation({ projects: [project] }, "storeSummary");
    return {
      id: Number(result.lastInsertRowid),
      createdAtEpoch: timestampEpoch
    };
  }
  storeObservations(memorySessionId, project, observations, summary, promptNumber, discoveryTokens = 0, overrideTimestampEpoch, generatedByModel, options = {}) {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();
    const reinforcementSeed = seedReinforcement(timestampEpoch);
    const reconfirmedOn = new Date(timestampEpoch);
    const dedup = this.dedupConfig();
    const sessionPlatform = normalizePlatformSource(
      this.db.prepare("SELECT platform_source FROM sdk_sessions WHERE memory_session_id = ? LIMIT 1").get(memorySessionId)?.platform_source
    );
    const storeTx = this.db.transaction(() => {
      const observationIds = [];
      const mergedIntoExisting = [];
      const insertedObservationIds = [];
      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata, title_norm_key, reinforcement_dates, last_reinforced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `);
      const lookupExistingStmt = this.db.prepare(
        "SELECT id, type, subtitle, facts, concepts FROM observations WHERE memory_session_id = ? AND content_hash = ?"
      );
      for (const observation of observations) {
        if (!hasStorableTitle(observation.title)) {
          logger.debug("DB", "Skipping observation with empty title");
          continue;
        }
        const legacyHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        if (legacyHash.startsWith("tuple-")) {
          const previousHash = computeLegacyObservationContentHash(memorySessionId, observation.title, observation.narrative);
          const previousDetailsHash = computeObservationDetailsHash(previousHash, observation);
          const previous = this.db.prepare(`SELECT id, type, subtitle, facts, concepts FROM observations
            WHERE memory_session_id = ? AND content_hash IN (?, ?)
              AND title IS ? AND COALESCE(narrative, '') = ?
            ORDER BY content_hash = ? DESC`).all(
            memorySessionId,
            previousHash,
            previousDetailsHash,
            observation.title,
            observation.narrative ?? "",
            previousDetailsHash
          ).find((row) => computeObservationDetailsHash(previousHash, row) === previousDetailsHash);
          if (previous) {
            reinforceObservation(this.db, previous.id, reconfirmedOn);
            observationIds.push(previous.id);
            mergedIntoExisting.push(false);
            continue;
          }
        }
        const detailsHash = computeObservationDetailsHash(legacyHash, observation);
        let contentHash = legacyHash;
        const detailedRetry = lookupExistingStmt.get(memorySessionId, detailsHash);
        if (detailedRetry) {
          reinforceObservation(this.db, detailedRetry.id, reconfirmedOn);
          observationIds.push(detailedRetry.id);
          mergedIntoExisting.push(false);
          continue;
        }
        const titleNormKey = computeTitleNormKey(
          project,
          sessionPlatform,
          observation.title,
          isSubagentEvent(observation.agent_id, observation.agent_type)
        );
        if (dedup.enabled) {
          let retry = lookupExistingStmt.get(memorySessionId, contentHash);
          if (retry && computeObservationDetailsHash(legacyHash, retry) !== detailsHash) {
            contentHash = detailsHash;
            retry = null;
          }
          if (retry) {
            reinforceObservation(this.db, retry.id, reconfirmedOn);
            observationIds.push(retry.id);
            mergedIntoExisting.push(false);
            continue;
          }
          const canonical = options.skipTitleDedup ? null : findTier0Canonical(this.db, project, titleNormKey, observation.title);
          if (canonical) {
            this.db.prepare("UPDATE observations SET occurrence_count = occurrence_count + 1 WHERE id = ?").run(canonical.id);
            reinforceObservation(this.db, canonical.id, reconfirmedOn);
            observationIds.push(canonical.id);
            mergedIntoExisting.push(true);
            continue;
          }
        }
        const insertObservation = () => obsStmt.all(
          memorySessionId,
          project,
          observation.type,
          observation.title,
          observation.subtitle,
          JSON.stringify(observation.facts),
          observation.narrative,
          JSON.stringify(observation.concepts),
          JSON.stringify(observation.files_read),
          JSON.stringify(observation.files_modified),
          promptNumber || null,
          discoveryTokens,
          observation.agent_type ?? null,
          observation.agent_id ?? null,
          contentHash,
          timestampIso,
          timestampEpoch,
          generatedByModel || null,
          observation.metadata ?? null,
          titleNormKey,
          reinforcementSeed.dates,
          reinforcementSeed.lastReinforced
        )[0] ?? null;
        let inserted = insertObservation();
        let existing = inserted ? null : lookupExistingStmt.get(memorySessionId, contentHash);
        if (existing && contentHash === legacyHash && computeObservationDetailsHash(legacyHash, existing) !== detailsHash) {
          contentHash = detailsHash;
          inserted = insertObservation();
          existing = inserted ? null : lookupExistingStmt.get(memorySessionId, contentHash);
        }
        if (inserted) {
          if (dedup.enabled) this.maintainDedupOnInsert(project, inserted.id, observation.title, dedup);
          this.indexObservationFiles(inserted.id, observation.files_read, observation.files_modified);
          observationIds.push(inserted.id);
          mergedIntoExisting.push(false);
          insertedObservationIds.push(inserted.id);
          continue;
        }
        if (!existing) {
          throw new Error(
            `storeObservations: ON CONFLICT without existing row for content_hash=${contentHash}`
          );
        }
        reinforceObservation(this.db, existing.id, reconfirmedOn);
        observationIds.push(existing.id);
        mergedIntoExisting.push(false);
      }
      let summaryId = null;
      let summaryUpdated = false;
      if (summary) {
        const rolledUp = rollupObservationFileLists(observations);
        const filesRead = summary.files_read ?? rolledUp.files_read;
        const filesEdited = summary.files_edited ?? rolledUp.files_edited;
        const existingSummary = promptNumber ? this.db.prepare(
          `SELECT id, request, investigated, learned, completed, next_steps,
                      files_read, files_edited, notes, discovery_tokens, sync_rev
               FROM session_summaries
               WHERE memory_session_id = ? AND prompt_number = ? AND origin_device_id IS NULL
               ORDER BY id DESC LIMIT 1`
        ).get(memorySessionId, promptNumber) : void 0;
        if (existingSummary) {
          const mergedRequest = summary.request && summary.request.trim() ? summary.request : existingSummary.request ?? "";
          const mergedInvestigated = summary.investigated && summary.investigated.trim() ? summary.investigated : existingSummary.investigated ?? "";
          const mergedLearned = summary.learned && summary.learned.trim() ? summary.learned : existingSummary.learned ?? "";
          const mergedCompleted = summary.completed && summary.completed.trim() ? summary.completed : existingSummary.completed ?? "";
          const mergedNextSteps = summary.next_steps ?? "";
          const mergedNotes = summary.notes && summary.notes.trim() ? summary.notes : existingSummary.notes;
          const mergedFilesRead = [.../* @__PURE__ */ new Set([...parseFileList(existingSummary.files_read), ...filesRead])];
          const mergedFilesEdited = [.../* @__PURE__ */ new Set([...parseFileList(existingSummary.files_edited), ...filesEdited])];
          const mergedTokens = Math.max(existingSummary.discovery_tokens ?? 0, discoveryTokens);
          const nextRev = incrementCanonicalDecimal(existingSummary.sync_rev || "0");
          this.db.prepare(`
            UPDATE session_summaries SET
              request = ?, investigated = ?, learned = ?, completed = ?, next_steps = ?,
              files_read = ?, files_edited = ?, notes = ?, discovery_tokens = ?,
              created_at = ?, created_at_epoch = ?,
              sync_rev = ?, synced_at = NULL
            WHERE id = ?
          `).run(
            mergedRequest,
            mergedInvestigated,
            mergedLearned,
            mergedCompleted,
            mergedNextSteps,
            JSON.stringify(mergedFilesRead),
            JSON.stringify(mergedFilesEdited),
            mergedNotes,
            mergedTokens,
            timestampIso,
            timestampEpoch,
            nextRev,
            existingSummary.id
          );
          summary.request = mergedRequest;
          summary.investigated = mergedInvestigated;
          summary.learned = mergedLearned;
          summary.completed = mergedCompleted;
          summary.next_steps = mergedNextSteps;
          summary.notes = mergedNotes;
          summary.files_read = mergedFilesRead;
          summary.files_edited = mergedFilesEdited;
          summaryId = existingSummary.id;
          summaryUpdated = true;
        } else {
          const summaryStmt = this.db.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed,
             next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const result = summaryStmt.run(
            memorySessionId,
            project,
            summary.request,
            summary.investigated,
            summary.learned,
            summary.completed,
            summary.next_steps,
            JSON.stringify(filesRead),
            JSON.stringify(filesEdited),
            summary.notes,
            promptNumber || null,
            discoveryTokens,
            timestampIso,
            timestampEpoch
          );
          summaryId = Number(result.lastInsertRowid);
        }
      }
      if (options.committedToolUses?.toolUseIds.length) {
        this.markCommittedToolUses(options.committedToolUses);
      }
      return { observationIds, mergedIntoExisting, insertedObservationIds, summaryId, createdAtEpoch: timestampEpoch, summaryUpdated };
    });
    const stored = storeTx.immediate();
    emitContextInvalidation({ projects: [project] }, "storeObservations", stored.summaryUpdated ? "removal" : "additive");
    return stored;
  }
  /**
   * Set discovery_tokens on rows a turn stored, after the fact. The Claude path
   * derives it from the turn's streamed assistant frames, which a gateway that
   * synthesizes streaming reports with zero input tokens (#3664); the turn's
   * result message carries the real usage. Callers pass only rows the turn
   * inserted, never ones it merged into from earlier turns.
   */
  updateDiscoveryTokens(observationIds, summaryId, discoveryTokens) {
    if (observationIds.length === 0 && summaryId === null) return;
    const projects = /* @__PURE__ */ new Set();
    this.db.transaction(() => {
      const observationStmt = this.db.prepare(`UPDATE observations SET discovery_tokens = ?,
        synced_at = CASE WHEN discovery_tokens IS NOT ? THEN NULL ELSE synced_at END
        WHERE id = ? AND discovery_tokens IS NOT ? RETURNING project, merged_into_project`);
      for (const id of observationIds) {
        const changed = observationStmt.all(discoveryTokens, discoveryTokens, id, discoveryTokens);
        for (const row of changed) for (const project of importedRowProjects(row)) projects.add(project);
      }
      if (summaryId !== null) {
        this.db.prepare(`UPDATE session_summaries SET discovery_tokens = MAX(COALESCE(discovery_tokens, 0), ?),
          synced_at = CASE WHEN COALESCE(discovery_tokens, 0) < ? THEN NULL ELSE synced_at END WHERE id = ?`).run(discoveryTokens, discoveryTokens, summaryId);
      }
    })();
    if (projects.size > 0) emitContextInvalidation({ projects: [...projects] }, "updateDiscoveryTokens");
  }
  getSessionSummariesByIds(ids, options = {}) {
    if (ids.length === 0) return [];
    const { orderBy = "date_desc", platformSource } = options;
    const limit = positiveIntegerRowLimit(options.limit);
    const projects = scopedProjects(options);
    const preserveIdOrder = orderBy === "relevance";
    const direction = orderBy === "date_asc" ? "ASC" : "DESC";
    const orderClause = preserveIdOrder ? "" : `ORDER BY ss.created_at_epoch ${direction}, ss.id ${direction}`;
    const limitClause = limit && !preserveIdOrder ? "LIMIT ?" : "";
    const placeholders = ids.map(() => "?").join(",");
    const params = [...ids];
    const additionalConditions = [];
    if (projects.length > 0) {
      const scope = projectScopeSql("ss", projects, { includeMerged: true });
      additionalConditions.push(scope.sql);
      params.push(...scope.params);
    }
    if (platformSource) {
      additionalConditions.push(`COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`);
      params.push(normalizePlatformSource(platformSource));
    }
    const additionalFilter = additionalConditions.length > 0 ? `AND ${additionalConditions.join(" AND ")}` : "";
    if (limitClause) params.push(limit);
    const stmt = this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${placeholders}) ${additionalFilter}
      ${orderClause}
      ${limitClause}
    `);
    const rows = stmt.all(...params);
    if (!preserveIdOrder) return rows;
    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.map((id) => rowMap.get(id)).filter((r) => !!r);
    return limit ? ordered.slice(0, limit) : ordered;
  }
  getUserPromptsByIds(ids, options = {}) {
    if (ids.length === 0) return [];
    const { orderBy = "date_desc", platformSource } = options;
    const limit = positiveIntegerRowLimit(options.limit);
    const projects = scopedProjects(options);
    const preserveIdOrder = orderBy === "relevance";
    const direction = orderBy === "date_asc" ? "ASC" : "DESC";
    const orderClause = preserveIdOrder ? "" : `ORDER BY up.created_at_epoch ${direction}, up.id ${direction}`;
    const limitClause = limit && !preserveIdOrder ? "LIMIT ?" : "";
    const placeholders = ids.map(() => "?").join(",");
    const params = [...ids];
    const additionalConditions = [];
    if (projects.length > 0) {
      const scope = projectScopeSql("s", projects, { includeMerged: false });
      additionalConditions.push(scope.sql);
      params.push(...scope.params);
    }
    if (platformSource) {
      additionalConditions.push(`COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`);
      params.push(normalizePlatformSource(platformSource));
    }
    const additionalFilter = additionalConditions.length > 0 ? `AND ${additionalConditions.join(" AND ")}` : "";
    if (limitClause) params.push(limit);
    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${placeholders}) ${additionalFilter}
      ${orderClause}
      ${limitClause}
    `);
    const rows = stmt.all(...params);
    if (!preserveIdOrder) return rows;
    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.map((id) => rowMap.get(id)).filter((r) => !!r);
    return limit ? ordered.slice(0, limit) : ordered;
  }
  /**
   * The ids of every row a semantic search with this scope can return, for
   * ChromaSync's narrowed filtered fallback (#5091). Each category uses the
   * joins, project scope and platform clause of its get*ByIds hydration, so no
   * row the hydration would keep is missing. Chroma's `sqlite_id` repeats
   * across doc types, so the categories share one list. Null when more than
   * `maxIds` rows match.
   */
  getSearchScopeRowIds(categories, options, maxIds) {
    const projects = scopedProjects(options);
    const platformSource = options.platformSource ? normalizePlatformSource(options.platformSource) : void 0;
    const sources = [
      categories.observations && {
        alias: "o",
        includeMerged: true,
        from: "SELECT o.id FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id"
      },
      categories.sessions && {
        alias: "ss",
        includeMerged: true,
        from: "SELECT ss.id FROM session_summaries ss LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id"
      },
      categories.prompts && {
        alias: "s",
        includeMerged: false,
        from: "SELECT up.id FROM user_prompts up JOIN sdk_sessions s ON up.session_db_id = s.id"
      }
    ].filter((source) => !!source);
    const ids = /* @__PURE__ */ new Set();
    for (const source of sources) {
      const conditions = [];
      const params = [];
      if (projects.length > 0) {
        const scope = projectScopeSql(source.alias, projects, { includeMerged: source.includeMerged });
        conditions.push(scope.sql);
        params.push(...scope.params);
      }
      if (platformSource) {
        conditions.push(`COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`);
        params.push(platformSource);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const statement = this.db.prepare(`${source.from} ${where} LIMIT ?`);
      let rows;
      try {
        rows = statement.all(...params, maxIds + 1);
      } finally {
        statement.finalize();
      }
      for (const row of rows) ids.add(row.id);
      if (ids.size > maxIds) return null;
    }
    return [...ids];
  }
  getTimelineAroundTimestamp(anchorEpoch, depthBefore = 10, depthAfter = 10, project, platformSource, projects) {
    return this.getTimelineAroundObservation(null, anchorEpoch, depthBefore, depthAfter, project, platformSource, projects);
  }
  getTimelineAroundObservation(anchorObservationId, anchorEpoch, depthBefore = 10, depthAfter = 10, project, platformSource, projects) {
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : void 0;
    const readProjects = scopedProjects({ project, projects });
    const buildScope = (rowAlias, sessionAlias, includeMergedProject = false) => {
      const conditions = [];
      const params = [];
      if (readProjects.length > 0) {
        const scope = projectScopeSql(rowAlias, readProjects, { includeMerged: includeMergedProject });
        conditions.push(scope.sql);
        params.push(...scope.params);
      }
      if (normalizedPlatformSource) {
        conditions.push(`COALESCE(NULLIF(${sessionAlias}.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`);
        params.push(normalizedPlatformSource);
      }
      return {
        clause: conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "",
        params
      };
    };
    const observationScope = buildScope("o", "src", true);
    const summaryScope = buildScope("ss", "src", true);
    const promptScope = buildScope("s", "s");
    let startEpoch;
    let endEpoch;
    if (anchorObservationId !== null) {
      const beforeQuery = `
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE (o.created_at_epoch, o.id) <= (?, ?) ${observationScope.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE (o.created_at_epoch, o.id) >= (?, ?) ${observationScope.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;
      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorEpoch, anchorObservationId, ...observationScope.params, depthBefore + 1);
        const afterRecords = this.db.prepare(afterQuery).all(anchorEpoch, anchorObservationId, ...observationScope.params, depthAfter + 1);
        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }
        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err) {
        if (err instanceof Error) {
          logger.error("DB", "Error getting boundary observations", { project }, err);
        } else {
          logger.error("DB", "Error getting boundary observations with non-Error", {}, new Error(String(err)));
        }
        return { observations: [], sessions: [], prompts: [] };
      }
    } else {
      const beforeQuery = `
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch < ? ${observationScope.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch > ? ${observationScope.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;
      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorEpoch, ...observationScope.params, depthBefore);
        const afterRecords = this.db.prepare(afterQuery).all(anchorEpoch, ...observationScope.params, depthAfter);
        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err) {
        if (err instanceof Error) {
          logger.error("DB", "Error getting boundary timestamps", { project }, err);
        } else {
          logger.error("DB", "Error getting boundary timestamps with non-Error", {}, new Error(String(err)));
        }
        return { observations: [], sessions: [], prompts: [] };
      }
    }
    for (const source of [
      { alias: "ss", from: "session_summaries ss LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id", scope: summaryScope },
      { alias: "up", from: "user_prompts up JOIN sdk_sessions s ON up.session_db_id = s.id", scope: promptScope }
    ]) {
      for (const side of [
        { comparison: "<", order: "DESC", depth: depthBefore },
        { comparison: ">", order: "ASC", depth: depthAfter }
      ]) {
        if (side.depth === 0) continue;
        const rows = this.db.prepare(`
          SELECT ${source.alias}.created_at_epoch
          FROM ${source.from}
          WHERE ${source.alias}.created_at_epoch ${side.comparison} ? ${source.scope.clause}
          ORDER BY ${source.alias}.created_at_epoch ${side.order}
          LIMIT ?
        `).all(anchorEpoch, ...source.scope.params, side.depth);
        const boundary = rows.at(-1)?.created_at_epoch ?? anchorEpoch;
        startEpoch = Math.min(startEpoch, boundary);
        endEpoch = Math.max(endEpoch, boundary);
      }
    }
    const readCandidates = (select, from, alias, scope) => this.db.prepare(`
      SELECT * FROM (
        SELECT ${select} FROM ${from}
        WHERE ${alias}.created_at_epoch >= ? AND ${alias}.created_at_epoch < ? ${scope.clause}
        ORDER BY ${alias}.created_at_epoch DESC, ${alias}.id DESC LIMIT ?
      )
      UNION ALL
      SELECT ${select} FROM ${from}
      WHERE ${alias}.created_at_epoch = ? ${scope.clause}
      UNION ALL
      SELECT * FROM (
        SELECT ${select} FROM ${from}
        WHERE ${alias}.created_at_epoch > ? AND ${alias}.created_at_epoch <= ? ${scope.clause}
        ORDER BY ${alias}.created_at_epoch ASC, ${alias}.id ASC LIMIT ?
      )
      ORDER BY created_at_epoch ASC, id ASC
    `).all(
      startEpoch,
      anchorEpoch,
      ...scope.params,
      depthBefore,
      anchorEpoch,
      ...scope.params,
      anchorEpoch,
      endEpoch,
      ...scope.params,
      depthAfter
    );
    const observations = readCandidates(
      "o.*",
      "observations o LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id",
      "o",
      observationScope
    );
    const sessions = readCandidates(
      "ss.*",
      "session_summaries ss LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id",
      "ss",
      summaryScope
    );
    const prompts = readCandidates(
      `up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') as platform_source`,
      "user_prompts up JOIN sdk_sessions s ON up.session_db_id = s.id",
      "up",
      promptScope
    );
    return {
      observations,
      sessions: sessions.map((s) => ({
        id: s.id,
        memory_session_id: s.memory_session_id,
        project: s.project,
        request: s.request,
        completed: s.completed,
        next_steps: s.next_steps,
        created_at: s.created_at,
        created_at_epoch: s.created_at_epoch
      })),
      prompts: prompts.map((p) => ({
        id: p.id,
        content_session_id: p.content_session_id,
        prompt_number: p.prompt_number,
        prompt_text: p.prompt_text,
        project: p.project,
        platform_source: p.platform_source,
        created_at: p.created_at,
        created_at_epoch: p.created_at_epoch
      }))
    };
  }
  getOrCreateManualSession(project, platformSource = DEFAULT_PLATFORM_SOURCE) {
    return this.db.transaction(() => {
      const normalizedPlatformSource = normalizePlatformSource(platformSource);
      const baseMemorySessionId = `manual-${project}-${normalizedPlatformSource}`;
      const contentSessionId = `manual-content-${project}-${normalizedPlatformSource}`;
      const existing = this.db.prepare(`
        SELECT memory_session_id FROM sdk_sessions WHERE platform_source = ? AND content_session_id = ?
      `).get(normalizedPlatformSource, contentSessionId);
      if (existing) return existing.memory_session_id;
      const existingByMemoryId = this.db.prepare(
        "SELECT memory_session_id, project, platform_source FROM sdk_sessions WHERE memory_session_id = ?"
      ).get(baseMemorySessionId);
      if (existingByMemoryId?.project === project && normalizePlatformSource(existingByMemoryId.platform_source) === normalizedPlatformSource) {
        return existingByMemoryId.memory_session_id;
      }
      const wasDeleted = this.db.prepare(
        "SELECT 1 FROM deleted_memory_sessions WHERE memory_session_id = ?"
      ).get(baseMemorySessionId);
      const memorySessionId = wasDeleted || existingByMemoryId ? `${baseMemorySessionId}-${randomUUID()}` : baseMemorySessionId;
      const deletedAt = this.getSessionDeletedAtEpochMs(normalizedPlatformSource, contentSessionId);
      const now = new Date(Math.max(Date.now(), (deletedAt ?? -1) + 1));
      this.db.prepare(`
        INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
      `).run(memorySessionId, contentSessionId, project, normalizedPlatformSource, now.toISOString(), now.getTime());
      logger.info("SESSION", "Created manual session", { memorySessionId, project, platformSource: normalizedPlatformSource });
      return memorySessionId;
    }).immediate();
  }
  close() {
    for (const statement of this.statementCache.values()) statement.finalize();
    this.statementCache.clear();
    try {
      this.db.close(true);
    } catch (error) {
      logger.warn("DB", "Strict close refused (statements outstanding on this Bun); falling back to lazy close", {}, error);
      this.db.close(false);
    }
  }
  /**
   * One prepared statement per SQL text, for this store's hot write paths.
   *
   * requeuePromptSync bumps and enqueues once per prompt of a session on every
   * registration. A fresh `prepare()` per call made a native statement that
   * lived until GC finalized it, and on long sessions they piled up until
   * prepare() itself ran out of memory (#3537). bun's own `db.query()` cache is
   * shared by every caller on the connection and bounded
   * (Database.MAX_QUERY_CACHE_SIZE, 20 by default), so whether a statement
   * stays cached there depends on what else ran.
   */
  cachedStatement(sql) {
    let statement = this.statementCache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statementCache.set(sql, statement);
    }
    return statement;
  }
  importSdkSession(session) {
    const normalizedPlatformSource = normalizePlatformSource(session.platform_source);
    const existing = this.db.prepare(
      `SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`
    ).get(normalizedPlatformSource, session.content_session_id);
    if (existing) {
      return { imported: false, id: existing.id };
    }
    const customTitle = session.custom_title ?? null;
    if (customTitle !== null && typeof customTitle !== "string") {
      throw new TypeError("Imported custom_title must be a string or null");
    }
    const stmt = this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return this.db.transaction(() => {
      const result = stmt.run(
        session.content_session_id,
        session.memory_session_id,
        session.project,
        normalizedPlatformSource,
        session.user_prompt,
        customTitle,
        session.started_at,
        session.started_at_epoch,
        session.completed_at,
        session.completed_at_epoch,
        session.status
      );
      return { imported: true, id: result.lastInsertRowid };
    })();
  }
  importSessionSummary(summary) {
    if (typeof summary?.memory_session_id !== "string" || summary.memory_session_id.trim() === "") {
      logger.warn("DB", "Skipping imported session summary without memory_session_id", {
        project: typeof summary?.project === "string" ? summary.project : null
      });
      return { imported: false, id: 0 };
    }
    const existing = this.db.prepare(
      `SELECT id FROM session_summaries WHERE memory_session_id = ?
        AND request IS ? AND investigated IS ? AND learned IS ? AND completed IS ?
        AND next_steps IS ? AND files_read IS ? AND files_edited IS ? AND notes IS ?
        AND prompt_number IS ? AND created_at_epoch = ?`
    ).get(
      summary.memory_session_id,
      coerceBindValue(summary.request),
      coerceBindValue(summary.investigated),
      coerceBindValue(summary.learned),
      coerceBindValue(summary.completed),
      coerceBindValue(summary.next_steps),
      coerceBindValue(summary.files_read),
      coerceBindValue(summary.files_edited),
      coerceBindValue(summary.notes),
      summary.prompt_number ?? null,
      summary.created_at_epoch
    );
    if (existing) {
      return { imported: false, id: existing.id };
    }
    const stmt = this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch, merged_into_project
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      summary.memory_session_id,
      summary.project,
      coerceBindValue(summary.request),
      coerceBindValue(summary.investigated),
      coerceBindValue(summary.learned),
      coerceBindValue(summary.completed),
      coerceBindValue(summary.next_steps),
      coerceBindValue(summary.files_read),
      coerceBindValue(summary.files_edited),
      coerceBindValue(summary.notes),
      summary.prompt_number,
      summary.discovery_tokens || 0,
      summary.created_at,
      summary.created_at_epoch,
      typeof summary.merged_into_project === "string" ? summary.merged_into_project : null
    );
    emitContextInvalidation({ projects: importedRowProjects(summary) }, "importSessionSummary");
    return { imported: true, id: result.lastInsertRowid };
  }
  importObservation(obs) {
    if (typeof obs?.memory_session_id !== "string" || obs.memory_session_id.trim() === "") {
      logger.warn("DB", "Skipping imported observation without memory_session_id", {
        title: typeof obs?.title === "string" ? obs.title : null,
        type: typeof obs?.type === "string" ? obs.type : null
      });
      return { imported: false, id: 0 };
    }
    const existing = this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND text IS ? AND type = ?
        AND title IS ? AND subtitle IS ? AND facts IS ? AND narrative IS ?
        AND concepts IS ? AND files_read IS ? AND files_modified IS ?
        AND prompt_number IS ? AND agent_type IS ?
        AND agent_id IS ? AND created_at_epoch = ?
    `).get(
      obs.memory_session_id,
      coerceBindValue(obs.text),
      obs.type,
      coerceBindValue(obs.title),
      coerceBindValue(obs.subtitle),
      coerceBindValue(obs.facts),
      coerceBindValue(obs.narrative),
      coerceBindValue(obs.concepts),
      coerceBindValue(obs.files_read),
      coerceBindValue(obs.files_modified),
      obs.prompt_number ?? null,
      obs.agent_type ?? null,
      obs.agent_id ?? null,
      obs.created_at_epoch
    );
    if (existing) {
      return { imported: false, id: existing.id };
    }
    for (const field of ["metadata", "generated_by_model", "reinforcement_dates", "last_reinforced"]) {
      if (obs[field] != null && typeof obs[field] !== "string") {
        throw new TypeError(`Imported ${field} must be a string or null`);
      }
    }
    const occurrenceCount = obs.occurrence_count ?? 1;
    if (!Number.isSafeInteger(occurrenceCount) || occurrenceCount < 1) {
      throw new TypeError("Imported occurrence_count must be a positive safe integer");
    }
    const stmt = this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch, merged_into_project,
        metadata, generated_by_model, occurrence_count, reinforcement_dates, last_reinforced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const importedId = this.db.transaction(() => {
      const result = stmt.run(
        obs.memory_session_id,
        obs.project,
        coerceBindValue(obs.text),
        obs.type,
        coerceBindValue(obs.title),
        coerceBindValue(obs.subtitle),
        coerceBindValue(obs.facts),
        coerceBindValue(obs.narrative),
        coerceBindValue(obs.concepts),
        coerceBindValue(obs.files_read),
        coerceBindValue(obs.files_modified),
        obs.prompt_number,
        obs.discovery_tokens || 0,
        obs.agent_type ?? null,
        obs.agent_id ?? null,
        obs.created_at,
        obs.created_at_epoch,
        typeof obs.merged_into_project === "string" ? obs.merged_into_project : null,
        obs.metadata ?? null,
        obs.generated_by_model ?? null,
        occurrenceCount,
        obs.reinforcement_dates ?? null,
        obs.last_reinforced ?? null
      );
      const id = result.lastInsertRowid;
      replaceObservationFileIndex(this.db, id, obs.files_read, obs.files_modified);
      return id;
    })();
    emitContextInvalidation({ projects: importedRowProjects(obs) }, "importObservation");
    return { imported: true, id: importedId };
  }
  rebuildObservationsFTSIndex() {
    const hasFTS = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
    ).all().length > 0;
    if (!hasFTS) {
      return;
    }
    this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
  }
  importUserPrompt(prompt) {
    let sessionDbId = null;
    const normalizedPlatformSource = prompt.platform_source ? normalizePlatformSource(prompt.platform_source) : void 0;
    if (typeof prompt.session_db_id === "number") {
      const explicitSession = this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(prompt.session_db_id);
      if (explicitSession && explicitSession.content_session_id === prompt.content_session_id && (!normalizedPlatformSource || normalizePlatformSource(explicitSession.platform_source) === normalizedPlatformSource)) {
        sessionDbId = explicitSession.id;
      }
    }
    if (sessionDbId === null) {
      sessionDbId = this.resolvePromptSessionDbId(
        prompt.content_session_id,
        void 0,
        normalizedPlatformSource
      );
    }
    const sessionClause = sessionDbId !== null ? "session_db_id = ?" : "content_session_id = ?";
    const sessionKey = sessionDbId ?? prompt.content_session_id;
    const nativePromptId = prompt.native_prompt_id ?? null;
    const existingByReceipt = nativePromptId === null ? void 0 : this.db.prepare(`
      SELECT id FROM user_prompts WHERE ${sessionClause} AND native_prompt_id = ?
    `).get(sessionKey, nativePromptId);
    const existing = existingByReceipt ?? this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${sessionClause} AND prompt_number = ? AND prompt_text IS ? AND created_at_epoch = ?
        ${nativePromptId === null ? "" : "AND native_prompt_id IS NULL"}
    `).get(
      sessionKey,
      prompt.prompt_number,
      coerceBindValue(prompt.prompt_text),
      prompt.created_at_epoch
    );
    if (existing) {
      return { imported: false, id: existing.id };
    }
    const stmt = this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch, native_prompt_id, native_prompt_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      sessionDbId,
      prompt.content_session_id,
      prompt.prompt_number,
      coerceBindValue(prompt.prompt_text),
      prompt.created_at,
      prompt.created_at_epoch,
      prompt.native_prompt_id ?? null,
      prompt.native_prompt_hash ?? null
    );
    this.promptCommitted("importUserPrompt", sessionDbId);
    return { imported: true, id: result.lastInsertRowid };
  }
};
export {
  SessionStore,
  TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS,
  rollupObservationFileLists
};
