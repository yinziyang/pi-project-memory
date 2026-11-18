// validation/upstream/claude-mem/src/services/sqlite/tool-use-search.ts
import { randomUUID } from "node:crypto";

// validation/upstream/claude-mem/src/services/sqlite/connection.ts
import { Database } from "bun:sqlite";

// src/curated/vendor/search-log-boundary.mjs
function warning() {
  process.stderr.write("SESSION_SEARCH_DIAGNOSTIC\n");
}
var logger = Object.freeze({
  debug() {
  },
  info() {
  },
  warn: warning,
  error: warning
});

// validation/upstream/claude-mem/src/services/sqlite/connection.ts
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

// validation/upstream/claude-mem/src/services/sqlite/search-query.ts
var UNSEGMENTED_SCRIPT_RANGES = "\\p{Script=Han}\\u31F0-\\u31FF\\uFF66-\\uFF9F\\u0E00-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF\\u3040-\\u30FF\\u3100-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF";
var UNSEGMENTED_SCRIPT = new RegExp(`[${UNSEGMENTED_SCRIPT_RANGES}]`, "u");
var UNSEGMENTED_RUN = new RegExp(`[${UNSEGMENTED_SCRIPT_RANGES}]+|[^\\s${UNSEGMENTED_SCRIPT_RANGES}]+`, "gu");
var MAX_SUBSTRING_TERMS = 500;
function substringTerms(query, limit = MAX_SUBSTRING_TERMS) {
  const terms = /* @__PURE__ */ new Set();
  for (const match of query.matchAll(UNSEGMENTED_RUN)) {
    terms.add(match[0]);
    if (limit >= 0 && terms.size >= limit) break;
  }
  return [...terms].slice(0, limit);
}
function buildSubstringClause(query, columns) {
  const terms = substringTerms(query);
  if (terms.length === 0) {
    terms.push(query);
  }
  const params = [];
  const groups = terms.map((term) => {
    const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    for (let i = 0; i < columns.length; i += 1) {
      params.push(pattern);
    }
    return `(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`;
  });
  return { clause: `(${groups.join(" AND ")})`, params };
}
function buildFTSMatchQuery(query) {
  const tokens = (query.match(/\S+/g) ?? []).filter((token) => /[\p{L}\p{N}]/u.test(token));
  if (tokens.length === 0) {
    return `"${query.replace(/"/g, '""')}"`;
  }
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" AND ");
}

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

// validation/upstream/claude-mem/src/services/server/ErrorHandler.ts
var AppError = class extends Error {
  constructor(message, statusCode = 500, code, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.name = "AppError";
  }
  statusCode;
  code;
  details;
};

// validation/upstream/claude-mem/src/shared/date-bounds.ts
var DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
var ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
var EPOCH_MS_PATTERN = /^\d{5,}$/;
var MS_PER_DAY = 24 * 60 * 60 * 1e3;
function resolveDateBound(value, boundary) {
  if (typeof value === "number") return requireValidEpoch(value, value, boundary);
  const normalized = value.trim();
  if (EPOCH_MS_PATTERN.test(normalized)) return requireValidEpoch(Number(normalized), value, boundary);
  const parsed = isCalendarDatePrefix(normalized) ? new Date(normalized).getTime() : Number.NaN;
  const epoch = requireValidEpoch(parsed, value, boundary);
  if (boundary === "end" && DATE_ONLY_PATTERN.test(normalized)) {
    return epoch + MS_PER_DAY - 1;
  }
  return epoch;
}
function isCalendarDatePrefix(value) {
  const match = ISO_DATE_PREFIX.exec(value);
  if (!match) return true;
  const [year, month, day] = match.slice(1).map(Number);
  const date = /* @__PURE__ */ new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function requireValidEpoch(epoch, original, boundary) {
  if (Number.isNaN(new Date(epoch).getTime())) {
    throw new AppError(
      `Invalid date for the ${boundary} of the range: ${JSON.stringify(original)}. Use an ISO date such as 2025-01-31 or 2025-01-31T08:00:00Z.`,
      400,
      "INVALID_DATE"
    );
  }
  return epoch;
}

// validation/upstream/claude-mem/src/services/sqlite/tool-use-search.ts
var VERSION = 1;
var TOOL_USE_FTS_TRIGGERS = ["tool_uses_fts_ai", "tool_uses_fts_ad", "tool_uses_fts_au"];
function emptyDeepResult(status) {
  return { deep: { status, complete: false, count: null, hasMore: null }, toolUses: [] };
}
function exists(db, name) {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
}
function toolUseIndexStatus(db) {
  if (!exists(db, "tool_uses_fts")) return "disabled";
  if (!exists(db, "tool_uses_search_schema")) return "not_ready";
  const version = db.query("SELECT version, state FROM tool_uses_search_schema WHERE id = 1").get();
  if (version?.version !== VERSION || !TOOL_USE_FTS_TRIGGERS.every((name) => exists(db, name))) return "not_ready";
  return version.state === "ready" ? "ready" : "building";
}
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
function prepareToolUseIndex(db, enabled) {
  if (!enabled && !exists(db, "tool_uses_fts") && !exists(db, "tool_uses_search_schema") && !TOOL_USE_FTS_TRIGGERS.some((name) => exists(db, name))) return "disabled";
  if (enabled && toolUseIndexStatus(db) === "ready") return "ready";
  return db.transaction(() => {
    checkAndRaiseSchemaWriterStampInTransaction(db, LATEST_SCHEMA_VERSION);
    const existing = exists(db, "tool_uses_search_schema") ? db.query("SELECT version FROM tool_uses_search_schema WHERE id = 1").get() : null;
    if (existing && existing.version > VERSION) throw new Error("Raw tool search index was created by a newer version");
    const status = toolUseIndexStatus(db);
    if (enabled && (status === "ready" || status === "building")) return status;
    for (const name of TOOL_USE_FTS_TRIGGERS) db.run(`DROP TRIGGER IF EXISTS ${name}`);
    db.run("DROP TABLE IF EXISTS tool_uses_fts");
    db.run("DROP TABLE IF EXISTS tool_uses_search_schema");
    if (!enabled) return "disabled";
    db.run(`CREATE VIRTUAL TABLE tool_uses_fts USING fts5(
      tool_input, tool_response, content='tool_uses', content_rowid='id', tokenize='unicode61'
    )`);
    db.run(`CREATE TABLE tool_uses_search_schema(
      id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('building', 'ready')), cursor INTEGER NOT NULL
    )`);
    db.run("INSERT INTO tool_uses_search_schema VALUES(1, ?, 'building', 0)", [VERSION]);
    db.run(TRIGGERS_SQL);
    return "building";
  }).immediate();
}
function buildToolUseIndexBatch(db) {
  return db.transaction(() => {
    const state = db.query("SELECT state, cursor FROM tool_uses_search_schema WHERE id = 1").get();
    if (state.state === "ready") return false;
    const last = db.query("SELECT max(id) AS id FROM (SELECT id FROM tool_uses WHERE id > ? ORDER BY id LIMIT 64)").get(state.cursor);
    if (last.id === null) {
      db.run("UPDATE tool_uses_search_schema SET state = 'ready' WHERE id = 1");
      return false;
    }
    db.run(`INSERT INTO tool_uses_fts(rowid, tool_input, tool_response)
      SELECT id, tool_input, tool_response FROM tool_uses WHERE id > ? AND id <= ? ORDER BY id`, [state.cursor, last.id]);
    db.run("UPDATE tool_uses_search_schema SET cursor = ? WHERE id = 1", [last.id]);
    return true;
  }).immediate();
}
function configureToolUseIndex(db, enabled) {
  const status = prepareToolUseIndex(db, enabled);
  if (status !== "building") return status;
  while (buildToolUseIndexBatch(db)) {
  }
  return "ready";
}
async function configureToolUseIndexAsync(db, enabled, signal) {
  const status = prepareToolUseIndex(db, enabled);
  if (status !== "building") return status;
  while (!signal?.aborted) {
    if (!buildToolUseIndexBatch(db)) return "ready";
    await new Promise((resolve) => setImmediate(resolve));
  }
  return "building";
}
function matchingSnippet(columns, terms, markers) {
  const matches = /* @__PURE__ */ new Map();
  const fold = (text) => text.replace(/[A-Z]/g, (char) => char.toLowerCase());
  const add = (text, start, length) => {
    const hit = text.slice(start, start + length);
    const key = fold(hit);
    if (matches.has(key) || matches.size >= 10) return;
    matches.set(key, {
      before: Array.from(text.slice(Math.max(0, start - 120), start)).slice(-60),
      hit: Array.from(hit),
      after: Array.from(text.slice(start + length, start + length + 120)).slice(0, 60)
    });
  };
  for (const column of columns) {
    if (markers) {
      const [open, close] = markers;
      const chunks = column.split(open);
      let text = chunks[0];
      const spans = [];
      for (const chunk of chunks.slice(1)) {
        const end = chunk.indexOf(close);
        spans.push([text.length, end]);
        text += chunk.slice(0, end) + chunk.slice(end + close.length);
      }
      for (const [start, length] of spans) add(text, start, length);
    } else {
      const folded = fold(column);
      for (const term of terms) {
        const start = folded.indexOf(fold(term));
        if (start !== -1) add(column, start, term.length);
      }
    }
  }
  const separator = " \u2026 ";
  const budget = Math.floor((480 - separator.length * (matches.size - 1)) / Math.max(1, matches.size));
  return [...matches.values()].map(({ before, hit, after }) => {
    if (hit.length > budget) return hit.slice(0, budget - 1).join("") + "\u2026";
    const context = budget - hit.length;
    const leading = Math.min(before.length, Math.floor(context / 2));
    return [...before.slice(before.length - leading), ...hit, ...after.slice(0, context - leading)].join("");
  }).join(separator);
}
function searchToolUses(db, query, options = {}) {
  const status = toolUseIndexStatus(db);
  if (status !== "ready") return emptyDeepResult(status);
  if (!query.trim() || query.length > 4096 || substringTerms(query, MAX_SUBSTRING_TERMS + 1).length > MAX_SUBSTRING_TERMS) return emptyDeepResult("invalid_query");
  const conditions = [];
  const params = [];
  const projects = scopedProjects(options);
  if (projects.length) {
    const scope = projectScopeSql("t", projects, { includeMerged: false });
    conditions.push(scope.sql);
    params.push(...scope.params);
  }
  if (options.platformSource) {
    conditions.push("t.platform_source = ?");
    params.push(normalizePlatformSource(options.platformSource));
  }
  for (const [bound, operator] of [["start", ">="], ["end", "<="]]) {
    if (options.dateRange?.[bound] != null && options.dateRange[bound] !== "") {
      conditions.push(`t.created_at_epoch ${operator} ?`);
      params.push(resolveDateBound(options.dateRange[bound], bound));
    }
  }
  const cjk = UNSEGMENTED_SCRIPT.test(query);
  const match = cjk ? buildSubstringClause(query, ["t.tool_input", "t.tool_response"]) : { clause: "tool_uses_fts MATCH ?", params: [buildFTSMatchQuery(query)] };
  const limit = Math.min(10, Math.max(1, Math.floor(Number(options.limit) || 5)));
  const order = options.orderBy === "date_asc" ? "t.created_at_epoch ASC, t.id ASC" : options.orderBy === "date_desc" || cjk ? "t.created_at_epoch DESC, t.id DESC" : "tool_uses_fts.rank, t.created_at_epoch DESC, t.id DESC";
  const nonce = randomUUID();
  const markers = [`${nonce}`, `${nonce}`];
  const excerpt = cjk ? "COALESCE(t.tool_input, '') AS input_excerpt, COALESCE(t.tool_response, '') AS response_excerpt" : "snippet(tool_uses_fts, 0, ?, ?, ' \u2026 ', 24) AS input_excerpt, snippet(tool_uses_fts, 1, ?, ?, ' \u2026 ', 24) AS response_excerpt";
  const rows = db.query(`SELECT t.id, t.tool_use_id, t.tool_name, t.project,
    t.content_session_id, t.platform_source, t.created_at_epoch, ${excerpt}
    FROM tool_uses t ${cjk ? "" : "JOIN tool_uses_fts ON tool_uses_fts.rowid = t.id"}
    WHERE ${[...conditions, match.clause].join(" AND ")} ORDER BY ${order} LIMIT ?
  `).all(...cjk ? [] : [...markers, ...markers], ...params, ...match.params, limit + 1);
  const terms = substringTerms(query);
  const toolUses = rows.slice(0, limit).map(({ input_excerpt, response_excerpt, ...row }) => ({
    ...row,
    snippet: matchingSnippet([input_excerpt ?? "", response_excerpt ?? ""], terms, cjk ? void 0 : markers)
  }));
  return { deep: { status: "ok", complete: true, count: toolUses.length, hasMore: rows.length > limit }, toolUses };
}

// validation/upstream/claude-mem/src/services/sqlite/SessionSearch.ts
import { Database as Database2 } from "bun:sqlite";

// src/curated/vendor/search-path-boundary.mjs
var DATA_DIR = "";
var DB_PATH = "";
function ensurePrivateDir() {
  throw new Error("EXPLICIT_PUBLIC_CONNECTION_REQUIRED");
}

// validation/upstream/claude-mem/src/shared/path-utils.ts
function normalizePath(p) {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
}
function isDirectChild(filePath, folderPath) {
  const normFile = normalizePath(filePath);
  const normFolder = normalizePath(folderPath);
  if (normFile.startsWith(normFolder + "/")) {
    const remainder = normFile.slice(normFolder.length + 1);
    return !remainder.includes("/");
  }
  const folderSegments = normFolder.split("/");
  const fileSegments = normFile.split("/");
  if (fileSegments.length < 2) {
    return normFolder === "" || normFolder === ".";
  }
  const fileDir = fileSegments.slice(0, -1).join("/");
  const fileName = fileSegments[fileSegments.length - 1];
  const absolutePath = /^([A-Za-z]:)?\//;
  if (!absolutePath.test(normFolder) && absolutePath.test(normFile) && normFolder !== "" && fileDir.endsWith("/" + normFolder)) {
    return fileName !== "";
  }
  if (normFolder.endsWith("/" + fileDir) || normFolder === fileDir) {
    return !fileName.includes("/");
  }
  for (let i = 0; i < folderSegments.length; i++) {
    const folderSuffix = folderSegments.slice(i).join("/");
    if (folderSuffix === fileDir) {
      return true;
    }
  }
  return false;
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
function pageMatchingRows(statement, params, matches, page) {
  try {
    const limit = Number(page.limit);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("Page limit must be a non-negative integer");
    }
    const offset = Number(page.offset ?? 0);
    if (!Number.isInteger(offset)) {
      throw new Error("Page offset must be an integer");
    }
    const rows = [];
    if (limit === 0) return rows;
    let toSkip = Math.max(0, offset);
    for (const row of streamRows(statement, ...params)) {
      if (!matches(row)) continue;
      if (toSkip > 0) {
        toSkip--;
        continue;
      }
      rows.push(row);
      if (rows.length === limit) break;
    }
    return rows;
  } finally {
    statement.finalize();
  }
}

// validation/upstream/claude-mem/src/services/sqlite/SessionSearch.ts
var OBSERVATIONS_FTS_TRIGGER_NAMES = ["observations_ai", "observations_ad", "observations_au"];
var SESSION_SUMMARIES_FTS_TRIGGER_NAMES = [
  "session_summaries_ai",
  "session_summaries_ad",
  "session_summaries_au"
];
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
var MEMORY_FTS_TOKENIZER = "unicode61";
var SessionSearch = class _SessionSearch {
  db;
  /**
   * `readOnly`: the caller opened `db` read-only and owns its pragmas (the
   * context read worker). Skip the connection pragmas, which include a
   * journal-mode switch, and the FTS table/trigger repair: both write, and the
   * writer connection owns them. Temp-schema tables (the FTS5 probe and the
   * fts5vocab term-frequency tables) still work on a read-only open.
   */
  constructor(dbPathOrDb = DB_PATH, options = {}) {
    if (dbPathOrDb instanceof Database2) {
      this.db = dbPathOrDb;
    } else {
      ensurePrivateDir(DATA_DIR);
      this.db = new Database2(dbPathOrDb);
    }
    assertSchemaWriterCompatible(this.db, LATEST_SCHEMA_VERSION);
    if (!options.readOnly) applySqliteConnectionPragmas(this.db);
    this._fts5Available = this.isFts5Available();
    if (!options.readOnly) this.ensureFTSTables();
    if (!options.readOnly && options.toolUseIndexEnabled !== void 0) {
      if (!this.isFts5Available()) this.rawIndexFailure = "unsupported";
      else {
        try {
          configureToolUseIndex(this.db, options.toolUseIndexEnabled);
        } catch (error) {
          this.rawIndexFailure = "error";
          logger.error("DB", "Raw tool search index initialization failed", {}, error instanceof Error ? error : void 0);
        }
      }
    }
  }
  _fts5Available;
  rawIndexFailure;
  async configureToolUseIndex(enabled, signal) {
    this.rawIndexFailure = void 0;
    if (!this.isFts5Available()) {
      this.rawIndexFailure = "unsupported";
      return;
    }
    try {
      const status = await configureToolUseIndexAsync(this.db, enabled, signal);
      logger.info("DB", "Raw tool search index configured", { status });
    } catch (error) {
      this.rawIndexFailure = "error";
      logger.error("DB", "Raw tool search index initialization failed", {}, error instanceof Error ? error : void 0);
    }
  }
  getToolUseIndexStatus() {
    return this.rawIndexFailure ?? toolUseIndexStatus(this.db);
  }
  searchToolUses(query, options = {}) {
    const status = this.getToolUseIndexStatus();
    return status === "ready" ? searchToolUses(this.db, query, options) : emptyDeepResult(status);
  }
  ensureFTSTables() {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all();
    const hasObservationsFTS = tables.some((t) => t.name === "observations_fts");
    const hasSummariesFTS = tables.some((t) => t.name === "session_summaries_fts");
    if (hasObservationsFTS && hasSummariesFTS && this.hasAllFtsTriggers(OBSERVATIONS_FTS_TRIGGER_NAMES) && this.hasAllFtsTriggers(SESSION_SUMMARIES_FTS_TRIGGER_NAMES)) {
      return;
    }
    if (!this.isFts5Available()) {
      logger.warn("DB", "FTS5 not available on this platform \u2014 skipping FTS table creation (search uses ChromaDB)");
      return;
    }
    const repairingTriggersOnly = hasObservationsFTS && hasSummariesFTS;
    logger.info("DB", repairingTriggersOnly ? "Converging FTS5 indexes and recreating missing sync triggers" : "Creating FTS5 tables");
    try {
      this.db.transaction(() => {
        checkAndRaiseSchemaWriterStampInTransaction(this.db, LATEST_SCHEMA_VERSION);
        const currentTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all();
        const createObservations = !currentTables.some((t) => t.name === "observations_fts");
        const createSummaries = !currentTables.some((t) => t.name === "session_summaries_fts");
        const repairObservations = !createObservations && !this.hasAllFtsTriggers(OBSERVATIONS_FTS_TRIGGER_NAMES);
        const repairSummaries = !createSummaries && !this.hasAllFtsTriggers(SESSION_SUMMARIES_FTS_TRIGGER_NAMES);
        this.createFTSTablesAndTriggers(createObservations, createSummaries);
        if (repairObservations) {
          this.rebuildFtsIndex("observations_fts");
          this.db.run(OBSERVATIONS_FTS_TRIGGERS_SQL);
        }
        if (repairSummaries) {
          this.rebuildFtsIndex("session_summaries_fts");
          this.db.run(SESSION_SUMMARIES_FTS_TRIGGERS_SQL);
        }
      }).immediate();
      logger.info("DB", repairingTriggersOnly ? "FTS5 indexes converged and sync triggers recreated" : "FTS5 tables created successfully");
    } catch (error) {
      if (error instanceof SchemaNewerThanBinaryError) {
        throw error;
      }
      this._fts5Available = false;
      logger.warn("DB", "FTS5 table creation failed \u2014 search will use ChromaDB and LIKE queries", {}, error instanceof Error ? error : void 0);
    }
  }
  /** True when every trigger in `names` exists — presence, not its DDL (v54 owns the shape). */
  hasAllFtsTriggers(names) {
    const placeholders = names.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${placeholders})`).all(...names);
    return rows.length === names.length;
  }
  /**
   * Converge a surviving external-content index with its content table by
   * re-deriving the whole index from the content table. Rows written while the
   * sync triggers were gone (the v7/v9 window, #3609) never reached the index,
   * and the _ad/_au triggers answer every UPDATE/DELETE of such a row with an
   * FTS 'delete' command — for a rowid the index does not hold, FTS5 fails the
   * write with SQLITE_CORRUPT, surfaced by Bun SQLite as "database disk image
   * is malformed". 'rebuild' is the documented, idempotent resync: no drift
   * detection, no per-row backfill bookkeeping, and a fully consistent index
   * converges to itself. One-time cost — the repair only runs while triggers
   * are missing.
   */
  rebuildFtsIndex(ftsTable) {
    this.db.run(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('rebuild')`);
  }
  isFts5Available() {
    try {
      this.db.run("CREATE VIRTUAL TABLE temp._fts5_probe USING fts5(test_column)");
      this.db.run("DROP TABLE temp._fts5_probe");
      return true;
    } catch (error) {
      logger.debug("DB", "FTS5 probe failed \u2014 FTS5 unavailable on this platform", void 0, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }
  /** An existing index can still be read when the writable probe is denied. */
  canReadFtsIndex(table) {
    try {
      this.db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? LIMIT 0`).all('"fts_read_probe"');
      return true;
    } catch {
      return false;
    }
  }
  createFTSTablesAndTriggers(createObservations, createSummaries) {
    if (createObservations) {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
          title,
          subtitle,
          narrative,
          text,
          facts,
          concepts,
          content='observations',
          content_rowid='id',
          tokenize='${MEMORY_FTS_TOKENIZER}'
        );
      `);
      this.db.run(`
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        SELECT id, title, subtitle, narrative, text, facts, concepts
        FROM observations;
      `);
      this.db.run(OBSERVATIONS_FTS_TRIGGERS_SQL);
    }
    if (createSummaries) {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
          request,
          investigated,
          learned,
          completed,
          next_steps,
          notes,
          content='session_summaries',
          content_rowid='id',
          tokenize='${MEMORY_FTS_TOKENIZER}'
        );
      `);
      this.db.run(`
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        SELECT id, request, investigated, learned, completed, next_steps, notes
        FROM session_summaries;
      `);
      this.db.run(SESSION_SUMMARIES_FTS_TRIGGERS_SQL);
    }
  }
  buildFilterClause(filters, params, tableAlias = "o") {
    const conditions = [];
    const projects = scopedProjects(filters);
    if (projects.length > 0) {
      const scope = projectScopeSql(tableAlias, projects, { includeMerged: true });
      conditions.push(scope.sql);
      params.push(...scope.params);
    }
    if (filters.platformSource) {
      conditions.push(
        `COALESCE(NULLIF((SELECT s2.platform_source FROM sdk_sessions s2 WHERE s2.memory_session_id = ${tableAlias}.memory_session_id), ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`
      );
      params.push(normalizePlatformSource(filters.platformSource));
    }
    if (filters.type) {
      if (Array.isArray(filters.type)) {
        const placeholders = filters.type.map(() => "?").join(",");
        conditions.push(`${tableAlias}.type IN (${placeholders})`);
        params.push(...filters.type);
      } else {
        conditions.push(`${tableAlias}.type = ?`);
        params.push(filters.type);
      }
    }
    if (filters.dateRange) {
      const { start, end } = filters.dateRange;
      if (start != null && start !== "") {
        conditions.push(`${tableAlias}.created_at_epoch >= ?`);
        params.push(resolveDateBound(start, "start"));
      }
      if (end != null && end !== "") {
        conditions.push(`${tableAlias}.created_at_epoch <= ?`);
        params.push(resolveDateBound(end, "end"));
      }
    }
    if (filters.concepts) {
      const concepts = Array.isArray(filters.concepts) ? filters.concepts : [filters.concepts];
      const conceptColumn = `${tableAlias}.concepts`;
      const conceptArray = `CASE WHEN json_valid(${conceptColumn}) THEN CASE
        WHEN json_type(${conceptColumn}) = 'array' THEN ${conceptColumn}
        WHEN json_type(${conceptColumn}) = 'text' THEN json_array(json_extract(${conceptColumn}, '$'))
        ELSE json_array(${conceptColumn}) END ELSE json_array(${conceptColumn}) END`;
      const conceptConditions = concepts.map(() => {
        return `EXISTS (SELECT 1 FROM json_each(${conceptArray}) WHERE type = 'text' AND value = ?)`;
      });
      if (conceptConditions.length > 0) {
        conditions.push(`(${conceptConditions.join(" OR ")})`);
        params.push(...concepts);
      }
    }
    if (filters.files) {
      const files = Array.isArray(filters.files) ? filters.files : [filters.files];
      const changedFilesColumn = tableAlias === "s" ? "files_edited" : "files_modified";
      const fileConditions = files.map(() => {
        return `(
          EXISTS (SELECT 1 FROM json_each(${_SessionSearch.fileArrayJson(`${tableAlias}.files_read`)}) WHERE type = 'text' AND replace(value, '\\', '/') LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM json_each(${_SessionSearch.fileArrayJson(`${tableAlias}.${changedFilesColumn}`)}) WHERE type = 'text' AND replace(value, '\\', '/') LIKE ? ESCAPE '\\')
        )`;
      });
      if (fileConditions.length > 0) {
        conditions.push(`(${fileConditions.join(" OR ")})`);
        files.forEach((file) => {
          const literal = file.replace(/\\/g, "/").replace(/[\\%_]/g, "\\$&");
          params.push(`%${literal}%`, `%${literal}%`);
        });
      }
    }
    return conditions.length > 0 ? conditions.join(" AND ") : "";
  }
  /**
   * Scripts whose runs FTS5's unicode61 tokenizer cannot split: Hiragana, Katakana, the CJK
   * ideograph blocks, Bopomofo, and Hangul. unicode61 breaks on Unicode whitespace and
   * punctuation, and these scripts put neither between the characters of a run — so a run
   * folds into a single token and no substring of it can ever match (#3801), which is every
   * query a user types in them.
   *
   * Korean does space its words, so only the sub-word case is affected there — but that is
   * still every partial-word query. Measured directly against `tokenize='unicode61'`:
   *
   *   설정   inside 설정을            -> 0 rows
   *   설정을 as a whole token         -> 1 row
   *   ㄓㄨ   inside ㄓㄨㄛ            -> 0 rows
   *   项目   inside 修改了项目配置    -> 0 rows
   *
   * Bopomofo and Hangul were raised in review on #3810. The blocks are adjacent, so
   * \u3100-\u318F covers Bopomofo together with the Hangul compatibility jamo beside it.
   *
   * Thai, Lao, Myanmar and Khmer write words without spaces too, so a run of them folds
   * into one token the same way (`ภาษาไทย` inside a longer Thai run -> 0 rows).
   */
  static UNSEGMENTED_SCRIPT = UNSEGMENTED_SCRIPT;
  static MAX_SUBSTRING_TERMS = MAX_SUBSTRING_TERMS;
  static buildSubstringClause = buildSubstringClause;
  /** Fewest query terms before an AND query with no match is widened to any term (see buildFTSAnyTermQuery). */
  static MIN_ANY_TERM_TOKENS = 3;
  /**
   * Build an FTS5 query that preserves literal-token safety while allowing multi-word
   * input to behave as an AND of terms instead of an exact phrase.
   *
   * Tokens with no letter or digit (a lone `-`, `&`, `—`) are dropped: unicode61 indexes
   * nothing for them, so each would become an empty phrase that matches no row and, ANDed
   * in, would zero out the whole query.
   */
  static buildFTSMatchQuery = buildFTSMatchQuery;
  /**
   * The same quoted tokens as buildFTSMatchQuery, joined with OR, for a query whose terms never all appear in one
   * row. A natural-language question ("when did we change the retry limit") almost never has every word in one
   * observation, so the AND query matches nothing; OR lets FTS5's bm25 rank the rows that share the most, and the
   * rarest, terms first. Queries of one or two terms stay keyword queries, matched with AND as #4130 intends
   * ("authentication bug" must not widen to every row that mentions "bug"); widening starts at three terms, where
   * a query reads as a question. Null when the query is not widened.
   *
   * The OR is bounded by prompt size (#4804): FTS5 scores every row holding any term before the filters apply, so
   * an OR of every word of a long prompt ran for minutes on a large store. Document frequencies come from an
   * fts5vocab table in this connection's temp schema, looked up one term at a time.
   *
   *   prompt chars | terms kept
   *   < 200        | its tokens, deduplicated, minus those whose rarest word is in >= 30% of rows; at most 40, rarest first
   *   200..600     | the same, at most 60
   *   >= 600       | the first 40 distinct words of >= 3 characters that are in at least one row and in < 2% of rows
   *
   * If the short/medium selection has no positive-frequency token, admit the least frequent excluded tokens within a
   * fixed candidate-document budget. Relative frequency alone can otherwise exclude every matching word in a
   * small or topic-focused store, leaving only absent question words.
   *
   * Without the vocabulary (no FTS5 vocab module, or a connection that cannot create temp tables) the tokens are
   * deduplicated and capped at 40.
   */
  buildFTSAnyTermQuery(query, ftsTable) {
    const tokens = (query.match(/\S+/g) ?? []).filter((token) => /[\p{L}\p{N}]/u.test(token));
    if (tokens.length < _SessionSearch.MIN_ANY_TERM_TOKENS) {
      return null;
    }
    const docFrequency = this.termDocFrequency(ftsTable);
    const length = [...query].length;
    let picked;
    if (!docFrequency) {
      picked = _SessionSearch.dedupeTokens(tokens).slice(0, _SessionSearch.ANY_TERM_LONG_PROMPT_CAP);
    } else if (length < _SessionSearch.ANY_TERM_SHORT_PROMPT_CHARS) {
      picked = _SessionSearch.pickRareTokens(tokens, docFrequency, _SessionSearch.ANY_TERM_SHORT_PROMPT_CAP);
    } else if (length < _SessionSearch.ANY_TERM_MEDIUM_PROMPT_CHARS) {
      picked = _SessionSearch.pickRareTokens(tokens, docFrequency, _SessionSearch.ANY_TERM_MEDIUM_PROMPT_CAP);
    } else {
      const words = this.indexedQueryWords(query);
      picked = words === null ? _SessionSearch.dedupeTokens(tokens).slice(0, _SessionSearch.ANY_TERM_LONG_PROMPT_CAP) : _SessionSearch.pickRareWords(words, docFrequency);
    }
    if (picked.length === 0) {
      return null;
    }
    return picked.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
  }
  static ANY_TERM_SHORT_PROMPT_CHARS = 200;
  static ANY_TERM_MEDIUM_PROMPT_CHARS = 600;
  static ANY_TERM_SHORT_PROMPT_CAP = 40;
  static ANY_TERM_MEDIUM_PROMPT_CAP = 60;
  static ANY_TERM_LONG_PROMPT_CAP = 40;
  /** Short and medium prompts drop a token whose rarest word is in this share of rows or more. */
  static ANY_TERM_COMMON_SHARE = 0.3;
  /** Candidate-document upper bound for new terms admitted when the short/medium selection has no positive frequency. */
  static ANY_TERM_MATCHING_DOCUMENT_BUDGET = 1024;
  /** Long prompts keep only words in less than this share of rows. */
  static ANY_TERM_LONG_PROMPT_MAX_SHARE = 0.02;
  static ANY_TERM_LONG_PROMPT_MIN_WORD_CHARS = 3;
  static ANY_TERM_CONTENT_TABLES = {
    observations_fts: "observations",
    session_summaries_fts: "session_summaries"
  };
  /** Per FTS table: the temp-schema vocabulary lookup, or null once it could not be created on this connection. */
  vocabLookups = /* @__PURE__ */ new Map();
  /**
   * A document-frequency reader for one query: `(word) => rows holding it`, plus the row count. Null when the
   * vocabulary is unavailable. The lookup accepts the exact indexed spelling; JavaScript Unicode folding
   * differs from unicode61 for Greek accents/final sigma, Cyrillic breve and compound Latin accents.
   */
  termDocFrequency(ftsTable) {
    if (!this.vocabLookups.has(ftsTable)) {
      let lookup2 = null;
      try {
        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${ftsTable}_vocab USING fts5vocab(main, '${ftsTable}', 'row')`);
        lookup2 = this.db.prepare(`SELECT doc FROM temp.${ftsTable}_vocab WHERE term = ?`);
      } catch (error) {
        logger.debug("DB", "FTS5 vocabulary unavailable; any-term queries are capped without frequencies", { ftsTable }, error instanceof Error ? error : void 0);
      }
      this.vocabLookups.set(ftsTable, lookup2);
    }
    const lookup = this.vocabLookups.get(ftsTable);
    if (!lookup) {
      return null;
    }
    try {
      const contentTable = _SessionSearch.ANY_TERM_CONTENT_TABLES[ftsTable];
      const total = this.db.prepare(`SELECT count(*) AS n FROM ${contentTable}`).get().n;
      const cache = /* @__PURE__ */ new Map();
      const rows = (term) => {
        let doc = cache.get(term);
        if (doc === void 0) {
          doc = lookup.get(term)?.doc ?? 0;
          cache.set(term, doc);
        }
        return doc;
      };
      return { rows, total };
    } catch (error) {
      logger.debug("DB", "FTS5 vocabulary lookup failed; any-term queries are capped without frequencies", { ftsTable }, error instanceof Error ? error : void 0);
      this.vocabLookups.set(ftsTable, null);
      return null;
    }
  }
  queryWordReader;
  /**
   * Read the words SQLite actually indexes, in their original order. NFD accent stripping is not unicode61:
   * it keeps non-Latin accents, folds final sigma, and preserves compound Latin accents in its default mode.
   * The one-document contentless index lives only in this connection's temp schema, including on read-only
   * database opens. Clear it after every query so neither indexed query words nor content accumulate.
   */
  indexedQueryWords(query) {
    try {
      if (this.queryWordReader === void 0) {
        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS temp._any_term_words
          USING fts5(text, content='', tokenize='${MEMORY_FTS_TOKENIZER}')`);
        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS temp._any_term_words_vocab
          USING fts5vocab(temp, '_any_term_words', 'instance')`);
        this.queryWordReader = {
          clear: this.db.prepare("INSERT INTO temp._any_term_words(_any_term_words) VALUES ('delete-all')"),
          insert: this.db.prepare("INSERT INTO temp._any_term_words(rowid, text) VALUES (1, ?)"),
          read: this.db.prepare("SELECT term FROM temp._any_term_words_vocab ORDER BY offset")
        };
      }
      const reader = this.queryWordReader;
      if (!reader) return null;
      return this.db.transaction(() => {
        reader.insert.run(query);
        const words = reader.read.all().map((row) => row.term);
        reader.clear.run();
        return words;
      })();
    } catch (error) {
      this.queryWordReader = null;
      logger.debug("DB", "FTS5 query tokenizer unavailable; any-term queries are capped without frequencies", {}, error instanceof Error ? error : void 0);
      return null;
    }
  }
  /** A token is as common as its rarest word: FTS splits `qa-hub,` into `qa` and `hub`, and a phrase needs both. */
  static tokenRows(token, docFrequency) {
    const words = token.match(/[\p{L}\p{N}]+/gu) ?? [];
    return words.length === 0 ? 0 : Math.min(...words.map((word) => docFrequency.rows(word.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, ""))));
  }
  /**
   * Rows at or above which a word counts as common. A word in a single row is never common, so a small store
   * still widens: 2% of 30 rows is less than one row.
   */
  static commonRowLimit(total, share) {
    return Math.max(total * share, 2);
  }
  /** Tokens deduplicated case-insensitively, keeping each one's first spelling: `Retry retry RETRY` is one term. */
  static dedupeTokens(tokens) {
    const seen = /* @__PURE__ */ new Set();
    return tokens.filter((token) => {
      const key = token.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
  static pickRareTokens(tokens, docFrequency, cap) {
    const limit = _SessionSearch.commonRowLimit(docFrequency.total, _SessionSearch.ANY_TERM_COMMON_SHARE);
    const distinct = _SessionSearch.dedupeTokens(tokens);
    const kept = distinct.filter((token) => _SessionSearch.tokenRows(token, docFrequency) < limit);
    const picked = kept.length <= cap ? kept : kept.map((token) => ({ token, rows: _SessionSearch.tokenRows(token, docFrequency) })).sort((a, b) => a.rows - b.rows).slice(0, cap).map((entry) => entry.token);
    if (picked.some((token) => _SessionSearch.tokenRows(token, docFrequency) > 0)) {
      return picked;
    }
    const matching = [...picked];
    let documents = 0;
    const excluded = distinct.map((token) => ({ token, rows: _SessionSearch.tokenRows(token, docFrequency) })).filter((entry) => entry.rows >= limit).sort((a, b) => a.rows - b.rows);
    for (const { token, rows } of excluded) {
      if (matching.length === cap) break;
      const candidates = /[^\x00-\x7F]/.test(token) ? docFrequency.total : rows;
      if (documents + candidates > _SessionSearch.ANY_TERM_MATCHING_DOCUMENT_BUDGET) continue;
      matching.push(token);
      documents += candidates;
    }
    return matching;
  }
  static pickRareWords(indexedWords, docFrequency) {
    const limit = _SessionSearch.commonRowLimit(docFrequency.total, _SessionSearch.ANY_TERM_LONG_PROMPT_MAX_SHARE);
    const words = new Set(indexedWords.filter((word) => [...word].length >= _SessionSearch.ANY_TERM_LONG_PROMPT_MIN_WORD_CHARS));
    const kept = [];
    for (const word of words) {
      const rows = docFrequency.rows(word);
      if (rows > 0 && rows < limit) {
        kept.push(word);
        if (kept.length === _SessionSearch.ANY_TERM_LONG_PROMPT_CAP) {
          break;
        }
      }
    }
    return kept;
  }
  buildOrderClause(orderBy = "relevance", hasFTS = true, ftsTable = "observations_fts") {
    switch (orderBy) {
      case "relevance":
        return hasFTS ? `ORDER BY ${ftsTable}.rank ASC` : "ORDER BY o.created_at_epoch DESC";
      case "date_desc":
        return "ORDER BY o.created_at_epoch DESC, o.id DESC";
      case "date_asc":
        return "ORDER BY o.created_at_epoch ASC, o.id ASC";
      default:
        return "ORDER BY o.created_at_epoch DESC";
    }
  }
  searchObservationsBySubstring(query, filters, orderBy, limit, offset) {
    const match = _SessionSearch.buildSubstringClause(query, [
      "o.title",
      "o.subtitle",
      "o.narrative",
      "o.text",
      "o.facts",
      "o.concepts"
    ]);
    const filterParams = [];
    const filterClause = this.buildFilterClause(filters, filterParams, "o");
    const sql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${match.clause}
      ${filterClause ? "AND " + filterClause : ""}
      ${this.buildOrderClause(orderBy, false)}
      LIMIT ? OFFSET ?
    `;
    return this.db.prepare(sql).all(...match.params, ...filterParams, limit, offset);
  }
  searchSessionsBySubstring(query, filters, orderBy, limit, offset) {
    const match = _SessionSearch.buildSubstringClause(query, [
      "s.request",
      "s.investigated",
      "s.learned",
      "s.completed",
      "s.next_steps",
      "s.notes"
    ]);
    const filterOptions = { ...filters };
    delete filterOptions.type;
    const filterParams = [];
    const filterClause = this.buildFilterClause(filterOptions, filterParams, "s");
    const orderClause = orderBy === "date_asc" ? "ORDER BY s.created_at_epoch ASC, s.id ASC" : "ORDER BY s.created_at_epoch DESC, s.id DESC";
    const sql = `
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${match.clause}
      ${filterClause ? "AND " + filterClause : ""}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;
    return this.db.prepare(sql).all(...match.params, ...filterParams, limit, offset);
  }
  searchObservations(query, options = {}) {
    const params = [];
    const { limit = 50, offset = 0, orderBy = "relevance", ...filters } = options;
    if (!query) {
      const filterClause = this.buildFilterClause(filters, params, "o");
      if (!filterClause) {
        return [];
      }
      const orderClause = this.buildOrderClause(orderBy, false);
      const sql = `
        SELECT o.*, o.discovery_tokens
        FROM observations o
        WHERE ${filterClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;
      params.push(limit, offset);
      return this.db.prepare(sql).all(...params);
    }
    if (_SessionSearch.UNSEGMENTED_SCRIPT.test(query)) {
      return this.searchObservationsBySubstring(query, filters, orderBy, limit, offset);
    }
    if (this._fts5Available || this.canReadFtsIndex("observations_fts")) {
      const filterClause = this.buildFilterClause(filters, params, "o");
      const orderClause = this.buildOrderClause(orderBy, true, "observations_fts");
      const sql = `
        SELECT o.*, o.discovery_tokens
        FROM observations o
        JOIN observations_fts ON observations_fts.rowid = o.id
        WHERE observations_fts MATCH ?
        ${filterClause ? "AND " + filterClause : ""}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;
      params.unshift(_SessionSearch.buildFTSMatchQuery(query));
      let rows;
      try {
        rows = this.db.prepare(sql).all(...params, limit, offset);
      } catch (error) {
        logger.warn("DB", "FTS5 observation search failed", {}, error instanceof Error ? error : void 0);
        throw error;
      }
      if (rows.length > 0 || offset > 0 && this.db.prepare(sql).all(...params, 1, 0).length > 0) {
        return rows;
      }
      const substringRows = this.searchObservationsBySubstring(query, filters, orderBy, limit, offset);
      if (substringRows.length > 0 || offset > 0 && this.searchObservationsBySubstring(query, filters, orderBy, 1, 0).length > 0) {
        return substringRows;
      }
      return this.searchFtsAnyTerm(sql, query, params, limit, offset, "observations_fts") ?? substringRows;
    }
    return this.searchObservationsBySubstring(query, filters, orderBy, limit, offset);
  }
  searchSessions(query, options = {}) {
    const params = [];
    const { limit = 50, offset = 0, orderBy = "relevance", ...filters } = options;
    if (!query) {
      const filterOptions = { ...filters };
      delete filterOptions.type;
      const filterClause = this.buildFilterClause(filterOptions, params, "s");
      if (!filterClause) {
        return [];
      }
      const orderClause = orderBy === "date_asc" ? "ORDER BY s.created_at_epoch ASC, s.id ASC" : "ORDER BY s.created_at_epoch DESC, s.id DESC";
      const sql = `
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        WHERE ${filterClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;
      params.push(limit, offset);
      return this.db.prepare(sql).all(...params);
    }
    if (_SessionSearch.UNSEGMENTED_SCRIPT.test(query)) {
      return this.searchSessionsBySubstring(query, filters, orderBy, limit, offset);
    }
    if (this._fts5Available || this.canReadFtsIndex("session_summaries_fts")) {
      const filterOptions = { ...filters };
      delete filterOptions.type;
      const filterClause = this.buildFilterClause(filterOptions, params, "s");
      const orderClause = orderBy === "date_asc" ? "ORDER BY s.created_at_epoch ASC, s.id ASC" : orderBy === "date_desc" ? "ORDER BY s.created_at_epoch DESC, s.id DESC" : "ORDER BY session_summaries_fts.rank ASC";
      const sql = `
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        JOIN session_summaries_fts ON session_summaries_fts.rowid = s.id
        WHERE session_summaries_fts MATCH ?
        ${filterClause ? "AND " + filterClause : ""}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;
      params.unshift(_SessionSearch.buildFTSMatchQuery(query));
      let rows;
      try {
        rows = this.db.prepare(sql).all(...params, limit, offset);
      } catch (error) {
        logger.warn("DB", "FTS5 session search failed", {}, error instanceof Error ? error : void 0);
        throw error;
      }
      if (rows.length > 0 || offset > 0 && this.db.prepare(sql).all(...params, 1, 0).length > 0) {
        return rows;
      }
      const substringRows = this.searchSessionsBySubstring(query, filters, orderBy, limit, offset);
      if (substringRows.length > 0 || offset > 0 && this.searchSessionsBySubstring(query, filters, orderBy, 1, 0).length > 0) {
        return substringRows;
      }
      return this.searchFtsAnyTerm(sql, query, params, limit, offset, "session_summaries_fts") ?? substringRows;
    }
    return this.searchSessionsBySubstring(query, filters, orderBy, limit, offset);
  }
  /**
   * Re-run an FTS search whose AND form, and the substring fallback, matched nothing with the any-term form. `params[0]` is the MATCH
   * argument and the rest are the filter parameters, as built by the callers. Returns null when the query has
   * nothing to widen or the any-term form matches nothing either.
   */
  searchFtsAnyTerm(sql, query, params, limit, offset, ftsTable) {
    const anyTermQuery = this.buildFTSAnyTermQuery(query, ftsTable);
    if (!anyTermQuery) {
      return null;
    }
    const anyTermParams = [anyTermQuery, ...params.slice(1)];
    const rows = this.db.prepare(sql).all(...anyTermParams, limit, offset);
    if (rows.length > 0 || offset > 0 && this.db.prepare(sql).all(...anyTermParams, 1, 0).length > 0) {
      return rows;
    }
    return null;
  }
  findByConcept(concept, options = {}) {
    const params = [];
    const { limit = 50, offset = 0, orderBy = "date_desc", ...filters } = options;
    const conceptFilters = { ...filters, concepts: concept };
    const filterClause = this.buildFilterClause(conceptFilters, params, "o");
    const orderClause = this.buildOrderClause(orderBy, false);
    const sql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);
    return this.db.prepare(sql).all(...params);
  }
  hasDirectChildFile(obs, folderPath) {
    const checkFiles = (filesJson) => {
      if (!filesJson) return false;
      try {
        const files = JSON.parse(filesJson);
        if (Array.isArray(files)) {
          return files.some((f) => typeof f === "string" && isDirectChild(f, folderPath));
        }
      } catch (error) {
        logger.debug("DB", `Failed to parse files JSON for observation ${obs.id}`, void 0, error instanceof Error ? error : void 0);
      }
      return false;
    };
    return checkFiles(obs.files_modified) || checkFiles(obs.files_read);
  }
  hasDirectChildFileSession(session, folderPath) {
    const checkFiles = (filesJson) => {
      if (!filesJson) return false;
      try {
        const files = JSON.parse(filesJson);
        if (Array.isArray(files)) {
          return files.some((f) => typeof f === "string" && isDirectChild(f, folderPath));
        }
      } catch (error) {
        logger.debug("DB", `Failed to parse files JSON for session summary ${session.id}`, void 0, error instanceof Error ? error : void 0);
      }
      return false;
    };
    return checkFiles(session.files_read) || checkFiles(session.files_edited);
  }
  /**
   * LIKE patterns that find a path in a files JSON column.
   *
   * Stored paths come in two forms: absolute when they come from a tool's
   * input (Claude Code's Read/Edit/Write), project-relative when they come
   * from the observer's output or a Codex patch, and neither records the
   * project root. So a folder given as an absolute path also matches paths
   * stored under any trailing part of it, which is the rule isDirectChild
   * applies to the fetched rows. Without these anchored prefixes the
   * project-relative rows never reached that check and folder lookups missed
   * them.
   */
  static filePathPatterns(filePath, isFolder) {
    if (isFolder && normalizePath(filePath) === ".") return ["%"];
    const escape = (value) => value.replace(/[\\%_]/g, "\\$&");
    const variants = [filePath, normalizePath(filePath), normalizePath(filePath).replaceAll("/", "\\")];
    const patterns = [...new Set(variants)].map((value) => `%${escape(value)}%`);
    if (!isFolder || !/^([A-Za-z]:)?[\\/]/.test(filePath)) {
      return patterns;
    }
    const segments = normalizePath(filePath).split("/").filter((segment) => segment.length > 0);
    const firstRelativeSegment = /^[A-Za-z]:$/.test(segments[0] ?? "") ? 1 : 0;
    for (let start = firstRelativeSegment; start < segments.length; start += 1) {
      const trailing = segments.slice(start);
      for (const separator of ["/", "\\"]) {
        const prefix = trailing.join(separator) + separator;
        patterns.push(`${escape(prefix)}%`, `${escape("." + separator + prefix)}%`);
      }
    }
    return patterns;
  }
  /** Invalid persisted file lists are absent evidence, rather than a query-wide JSON error. */
  static fileArrayJson(column) {
    return `CASE WHEN json_valid(${column}) THEN CASE WHEN json_type(${column}) = 'array' THEN ${column} ELSE '[]' END ELSE '[]' END`;
  }
  /** Any of `columns` (JSON arrays) holds a value matching any pattern; bind every pattern once per column. */
  static jsonArrayLikeClause(columns, patternCount) {
    const anyPattern = Array.from({ length: patternCount }, () => "type = 'text' AND value LIKE ? ESCAPE '\\'").join(" OR ");
    return `(${columns.map((column) => `EXISTS (SELECT 1 FROM json_each(${_SessionSearch.fileArrayJson(column)}) WHERE ${anyPattern})`).join(" OR ")})`;
  }
  findByFile(filePath, options = {}) {
    const params = [];
    const { limit = 50, offset = 0, orderBy = "date_desc", isFolder = false, ...filters } = options;
    delete filters.files;
    const paginationSql = isFolder ? "" : "LIMIT ? OFFSET ?";
    const pathPatterns = _SessionSearch.filePathPatterns(filePath, isFolder);
    const filterClause = this.buildFilterClause(filters, params, "o");
    params.push(...pathPatterns, ...pathPatterns);
    const whereClause = [
      filterClause,
      _SessionSearch.jsonArrayLikeClause(["o.files_read", "o.files_modified"], pathPatterns.length)
    ].filter(Boolean).join(" AND ");
    const orderClause = `${this.buildOrderClause(orderBy, false)}, o.id ${orderBy === "date_asc" ? "ASC" : "DESC"}`;
    const observationsSql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${whereClause}
      ${orderClause}
      ${paginationSql}
    `;
    if (!isFolder) params.push(limit, offset);
    const observationStatement = this.db.prepare(observationsSql);
    const observations = isFolder ? pageMatchingRows(
      observationStatement,
      params,
      (obs) => this.hasDirectChildFile(obs, filePath),
      { limit, offset }
    ) : observationStatement.all(...params);
    const sessionParams = [];
    const sessionFilters = { ...filters };
    delete sessionFilters.type;
    const baseConditions = [];
    const sessionProjects = scopedProjects(sessionFilters);
    if (sessionProjects.length > 0) {
      const scope = projectScopeSql("s", sessionProjects, { includeMerged: true });
      baseConditions.push(scope.sql);
      sessionParams.push(...scope.params);
    }
    if (sessionFilters.platformSource) {
      baseConditions.push(
        `COALESCE(NULLIF((SELECT s2.platform_source FROM sdk_sessions s2 WHERE s2.memory_session_id = s.memory_session_id), ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`
      );
      sessionParams.push(normalizePlatformSource(sessionFilters.platformSource));
    }
    if (sessionFilters.dateRange) {
      const { start, end } = sessionFilters.dateRange;
      if (start != null && start !== "") {
        baseConditions.push("s.created_at_epoch >= ?");
        sessionParams.push(resolveDateBound(start, "start"));
      }
      if (end != null && end !== "") {
        baseConditions.push("s.created_at_epoch <= ?");
        sessionParams.push(resolveDateBound(end, "end"));
      }
    }
    baseConditions.push(_SessionSearch.jsonArrayLikeClause(["s.files_read", "s.files_edited"], pathPatterns.length));
    sessionParams.push(...pathPatterns, ...pathPatterns);
    const sessionsSql = `
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${baseConditions.join(" AND ")}
      ORDER BY s.created_at_epoch ${orderBy === "date_asc" ? "ASC" : "DESC"}
      ${paginationSql}
    `;
    if (!isFolder) sessionParams.push(limit, offset);
    const sessionStatement = this.db.prepare(sessionsSql);
    const sessions = isFolder ? pageMatchingRows(
      sessionStatement,
      sessionParams,
      (row) => this.hasDirectChildFileSession(row, filePath),
      { limit, offset }
    ) : sessionStatement.all(...sessionParams);
    return { observations, sessions };
  }
  findByType(type, options = {}) {
    const params = [];
    const { limit = 50, offset = 0, orderBy = "date_desc", ...filters } = options;
    const typeFilters = { ...filters, type };
    const filterClause = this.buildFilterClause(typeFilters, params, "o");
    const orderClause = this.buildOrderClause(orderBy, false);
    const sql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);
    return this.db.prepare(sql).all(...params);
  }
  searchUserPrompts(query, options = {}) {
    const params = [];
    const { limit = 20, offset = 0, orderBy = "relevance", ...filters } = options;
    const baseConditions = [];
    const projects = scopedProjects(filters);
    if (projects.length > 0) {
      const scope = projectScopeSql("s", projects, { includeMerged: false });
      baseConditions.push(scope.sql);
      params.push(...scope.params);
    }
    if (filters.platformSource) {
      baseConditions.push(`COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`);
      params.push(normalizePlatformSource(filters.platformSource));
    }
    if (filters.dateRange) {
      const { start, end } = filters.dateRange;
      if (start != null && start !== "") {
        baseConditions.push("up.created_at_epoch >= ?");
        params.push(resolveDateBound(start, "start"));
      }
      if (end != null && end !== "") {
        baseConditions.push("up.created_at_epoch <= ?");
        params.push(resolveDateBound(end, "end"));
      }
    }
    if (!query) {
      if (baseConditions.length === 0) {
        return [];
      }
      const whereClause2 = `WHERE ${baseConditions.join(" AND ")}`;
      const orderClause2 = orderBy === "date_asc" ? "ORDER BY up.created_at_epoch ASC, up.id ASC" : "ORDER BY up.created_at_epoch DESC, up.id DESC";
      const sql2 = `
        SELECT
          up.*,
          s.project,
          s.memory_session_id,
          COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') as platform_source
        FROM user_prompts up
        JOIN sdk_sessions s ON up.session_db_id = s.id
        ${whereClause2}
        ${orderClause2}
        LIMIT ? OFFSET ?
      `;
      params.push(limit, offset);
      return this.db.prepare(sql2).all(...params);
    }
    const escapedQuery = query.replace(/[\\%_]/g, "\\$&");
    baseConditions.push("up.prompt_text LIKE ? ESCAPE '\\'");
    params.push(`%${escapedQuery}%`);
    const whereClause = `WHERE ${baseConditions.join(" AND ")}`;
    const orderClause = orderBy === "date_asc" ? "ORDER BY up.created_at_epoch ASC, up.id ASC" : "ORDER BY up.created_at_epoch DESC, up.id DESC";
    const sql = `
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);
    return this.db.prepare(sql).all(...params);
  }
  close() {
    this.db.close();
  }
};
export {
  OBSERVATIONS_FTS_TRIGGERS_SQL,
  OBSERVATIONS_FTS_TRIGGER_NAMES,
  SESSION_SUMMARIES_FTS_TRIGGERS_SQL,
  SESSION_SUMMARIES_FTS_TRIGGER_NAMES,
  SessionSearch
};
