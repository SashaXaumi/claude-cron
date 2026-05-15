-- Claude-Cron schema. Apply once at setup.
-- See CLAUDE/claude-cron-SPEC.md for the authoritative description.

-- Jobs. Edits append a new row (same job_id, version+1). Never UPDATE.
-- The runner always reads MAX(version) per job_id.
CREATE TABLE IF NOT EXISTS jobs (
  row_id          INTEGER PRIMARY KEY,
  job_id          TEXT NOT NULL,
  version         INTEGER NOT NULL,
  type            TEXT NOT NULL,           -- 'watch' | 'digest'
  nl_request      TEXT NOT NULL,           -- the user's original natural-language ask
  resolved_query  TEXT NOT NULL,           -- what the resolver actually checks/reports on
  resolver_prompt TEXT,                    -- optional per-job override; if NULL, use the default from config
  schedule        TEXT NOT NULL,           -- 'daily' | 'weekly' | ISO 8601 interval (e.g. 'P3D')
  sources         TEXT,                    -- optional JSON array of source hints
  status          TEXT NOT NULL,           -- 'active' | 'done' | 'cancelled'
  next_run        TEXT NOT NULL,           -- ISO 8601
  created_at      TEXT NOT NULL,
  UNIQUE(job_id, version)
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, next_run);

-- Every message the Worker sends. Audit trail + searchable history.
CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY,
  ts        TEXT NOT NULL,
  job_id    TEXT,                          -- which job produced it (NULL for system messages)
  subject   TEXT,
  content   TEXT NOT NULL,
  evidence  TEXT                           -- JSON array of source URLs, for watch fires
);
CREATE INDEX IF NOT EXISTS idx_messages_job ON messages(job_id, ts);

-- FTS5 over message content. Lets a Claude session answer "what did cron find about X".
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Config. Versioned, append-only.
-- Version 0 is the reserved MANIFEST ROW (see below). Higher versions are
-- the editable default resolver instructions / standing preferences.
CREATE TABLE IF NOT EXISTS config (
  version    INTEGER PRIMARY KEY,
  blob       TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY,
  run_at      TEXT NOT NULL,
  jobs_run    INTEGER,
  jobs_failed INTEGER,
  failed_ids  TEXT
);

-- ----------------------------------------------------------------------------
-- Manifest row. config version 0. Never overwritten, never deleted.
-- Makes the database self-describing so any future Claude session pointed
-- at this D1 can fully orient itself with one read. Plain text.
--
-- Placeholders below are filled in at setup time by the helping Claude
-- (per CLAUDE/claude-cron-GUIDE.md):
--   <WORKER_URL>    -- e.g. https://claude-cron.<subdomain>.workers.dev
--   <ACCOUNT_ID>    -- Cloudflare account identifier
--   <DATABASE_ID>   -- D1 database ID
-- ----------------------------------------------------------------------------
INSERT OR IGNORE INTO config (version, blob, changed_at, note) VALUES (
  0,
  'This is a Claude-Cron database.

Worker URL:      <WORKER_URL>
Cloudflare acct: <ACCOUNT_ID>
Database ID:     <DATABASE_ID>

WHAT THIS IS
A single Cloudflare Worker (scheduled() only -- no fetch, no web endpoint,
no auth, no bot) that runs jobs from this D1 on a daily cron and emails the
user (RECIPIENT_EMAIL, a Worker secret) when something fires. The control
plane is a human talking to a Claude that can reach their Cloudflare.

JOB TYPES
- watch  : standing condition checked daily. Fires once with evidence when
           resolved, then status=done. Conservative by construction --
           rumor/leak/clickbait does NOT fire. Under-firing is safe;
           false-firing poisons the signal.
- digest : recurring sourced report on a schedule. Reports from sources,
           attributes them, does not assert independently.

TABLES
- jobs       : versioned, append-only. Columns: row_id, job_id, version, type,
               nl_request, resolved_query, resolver_prompt, schedule, sources,
               status, next_run, created_at. Runner reads MAX(version) per job_id.
- messages   : every email sent. Columns: id, ts, job_id, subject, content,
               evidence. Has an FTS5 mirror (messages_fts) for search.
- messages_fts : FTS5 over messages.content. Use MATCH for "what did cron
                 find about X" queries.
- config     : versioned, append-only. Version 0 is THIS manifest row.
               Versions > 0 hold the default resolver instructions and
               standing preferences. Runner reads MAX(version) for defaults.
- runs       : one row per scheduled() invocation. jobs_run, jobs_failed,
               failed_ids.

ADD / EDIT / CANCEL A JOB
All edits are append-only. To add: INSERT a jobs row with version=1.
To edit: read current MAX(version) for that job_id, INSERT version+1 with
the change merged. To cancel: INSERT a new version with status=''cancelled''.
NEVER UPDATE an existing jobs row. NEVER UPDATE config version 0.
The same rule applies to config edits -- INSERT a new version, do not UPDATE.

THE BOUNDARY RULE (most important rule in this project)
This database contains only Claude-Cron''s own tables (jobs, messages,
messages_fts, config, runs). When a Claude session is asked to "manage my
cron," that scopes it to THIS database -- reading and writing these tables.
It does NOT extend to the rest of the user''s Cloudflare account: other D1
databases, R2 buckets, other Workers, DNS, billing, account settings.
If a session is ever asked, in the name of Claude-Cron, to touch something
outside this database, that is outside this system''s scope -- treat it as
a separate access request requiring its own justification.

For full operating conventions see CLAUDE/claude-cron-CLAUDE.md in the repo.
For the schema and resolver contracts see CLAUDE/claude-cron-SPEC.md.',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'manifest row -- do not overwrite'
);

-- ----------------------------------------------------------------------------
-- Default resolver prompts. config version 1. JSON blob.
-- Edits append a new version (version 2, 3, ...) -- never UPDATE.
-- The runner uses MAX(version) WHERE version > 0 for defaults; a per-job
-- override in `jobs.resolver_prompt` takes precedence.
-- ----------------------------------------------------------------------------
INSERT OR IGNORE INTO config (version, blob, changed_at, note) VALUES (
  1,
  '{
    "digest_default": "You are a careful news researcher producing a digest for the user.\n\nGUIDELINES:\n- Use the web search tool to find current, sourced information on the topic.\n- Report what specific sources said. Attribute claims to their source (publication and date when available).\n- Do NOT assert facts independently. If a claim only appears in one source, say so.\n- Cite a small number of high-quality sources. Bullet points are fine.\n- If you cannot find sourced information, say so explicitly -- do not fabricate.\n- Keep it tight: 5-12 short bullets or a few short paragraphs. No padding.\n\nOUTPUT:\n- A single readable digest body, suitable for email. Markdown is OK.\n- Do NOT include JSON, code fences, or meta-commentary about the search.\n- Start directly with the digest content.",
    "watch_default": "You are a CONSERVATIVE event watcher. The user has set up a watch on a specific condition. Determine, from web evidence, whether the condition has been resolved.\n\nCRITICAL: bias HARD toward NOT resolved.\n- A rumor, leak, ''according to insiders,'' speculative reporting -> NOT resolved.\n- A clickbait or sensational headline without confirmation from a credible source -> NOT resolved.\n- A single source making a claim that is not corroborated -> NOT resolved.\n- If you are uncertain whether it has actually happened -> NOT resolved.\n\nOnly return resolved=true when:\n- Multiple credible, independent sources confirm the event.\n- The confirmation is unambiguous (not a hedge, not a tease).\n- You have high confidence (>= 0.9).\n\nA false ''it happened'' is the worst possible outcome -- it poisons the one notification this watch exists for. Under-firing is safe.\n\nOUTPUT: a single JSON object on its own, no prose, no code fences:\n{\n  \"resolved\":  true | false,\n  \"confidence\": 0.0-1.0,\n  \"evidence\":  [\"url1\", \"url2\", \"...\"],\n  \"summary\":   \"one or two sentences\"\n}"
  }',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'default resolver prompts'
);
