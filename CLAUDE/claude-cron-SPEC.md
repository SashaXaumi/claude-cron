# SPEC — Claude-Cron

## What this is

A single Cloudflare Worker (`scheduled()` handler only — no `fetch()`, no web endpoint, no bot) plus a D1 database. It runs jobs on a daily cron heartbeat and emails the user when something fires. Jobs and their prompts live in D1 as editable rows. The control plane is a human talking to a Claude that can reach their Cloudflare — there is no UI in this system.

## Stack

- **Cloudflare Worker** — `scheduled()` only. One cron trigger, daily.
- **D1** — all state: jobs (versioned), message log, config (incl. the manifest row).
- **Anthropic API** — runs the watch and digest resolvers. The user's own key.
- **Resend** — outbound email. The only delivery channel. (Cloudflare has no send capability — Email Routing is inbound-only. Do not look for a Cloudflare-native path.)
- **No R2.** Reserved for a future where a job must deliver a file attachment; not in this version, not bound.
- **No `fetch()` handler.** The Worker is not reachable over HTTP. Nothing posts to it. This removes the entire Telegram/webhook/auth surface from the earlier design — there is no inbound request to authenticate because there are no inbound requests.

## Execution model

```
daily cron fires
  └─ load due jobs from D1 (status='active' AND next_run <= now)
  └─ for each job:
       type=watch  → run watch resolver
                       resolved (high confidence) → send email + status='done' + log message
                       not resolved               → advance next_run, send nothing
       type=digest → run digest resolver → send email + advance next_run + log message
       (per-job try/catch — one job failing never blocks the others)
  └─ write a run row
```

The cron is just a heartbeat. Per-job `next_run` controls actual cadence: a daily digest advances `next_run` by a day, a weekly one by a week, a watch re-checks daily until it resolves. Changing a job's schedule = rewriting its `schedule`/`next_run` — a D1 edit, no redeploy.

## Data model (D1)

```sql
-- Jobs. Edits append a new row (same job_id, version+1). Never UPDATE.
-- The runner always reads MAX(version) per job_id.
CREATE TABLE jobs (
  row_id         INTEGER PRIMARY KEY,
  job_id         TEXT NOT NULL,          -- stable across versions
  version        INTEGER NOT NULL,
  type           TEXT NOT NULL,          -- 'watch' | 'digest'
  nl_request     TEXT NOT NULL,          -- the user's original natural-language ask
  resolved_query TEXT NOT NULL,          -- what the resolver actually checks/reports on
  resolver_prompt TEXT,                  -- optional per-job override of the resolver instructions; if NULL, use the default from config
  schedule       TEXT NOT NULL,          -- 'daily' | 'weekly' | ISO interval — human-editable
  sources        TEXT,                   -- optional JSON array of source hints
  status         TEXT NOT NULL,          -- 'active' | 'done' | 'cancelled'
  next_run       TEXT NOT NULL,          -- ISO8601
  created_at     TEXT NOT NULL,
  UNIQUE(job_id, version)
);
CREATE INDEX idx_jobs_due ON jobs(status, next_run);

-- Every message the Worker sends. The audit trail and the searchable history.
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  job_id     TEXT,                       -- which job produced it
  subject    TEXT,
  content    TEXT NOT NULL,
  evidence   TEXT                        -- JSON array of source URLs, for watch fires
);

-- FTS5 over message content — lets a Claude session answer "what did cron find about X".
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Config — versioned, append-only, never overwritten.
-- Version 0 is the reserved MANIFEST ROW (see below). Higher versions are
-- the editable default resolver instructions / standing preferences.
CREATE TABLE config (
  version    INTEGER PRIMARY KEY,
  blob       TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  note       TEXT
);

CREATE TABLE runs (
  id          INTEGER PRIMARY KEY,
  run_at      TEXT NOT NULL,
  jobs_run    INTEGER,
  jobs_failed INTEGER,
  failed_ids  TEXT
);
```

### The manifest row — `config` version 0

Inserted at setup, never deleted. It makes the database **self-describing** so any future Claude session pointed at this D1 can fully orient itself with one read. Its `blob` is plain text containing:

- "This is a Claude-Cron database."
- The Worker URL and the Cloudflare account identifier.
- A summary of the schema and the two job types.
- How to add / edit / cancel a job (append a version row; never UPDATE).
- **The boundary rule, stated in-band:** this database contains only Claude-Cron's tables; managing Claude-Cron does not extend to the rest of the Cloudflare account.

The manifest row is the portable equivalent of what a user's memory does privately — it works for anyone, survives memory loss, and travels with the data. It is the source of truth for re-entry.

`job_runs` is intentionally not a separate table — the `messages` log with `job_id` set already answers "what did this job last send."

## Resolvers

### watch resolver

The sharpest correctness problem in the system. A false "it happened" poisons the one notification the watch exists for.

- Anthropic call with the web search tool, against `resolved_query`.
- System prompt **conservative by construction**: bias hard toward "not yet." Require strong, multiple, credible signal. A rumor, a leak, a "CONFIRMED" clickbait headline → **not resolved**.
- Output: `{ resolved: bool, confidence: float, evidence: [urls], summary: string }`.
- Only `resolved: true` at high confidence fires. The firing email **includes the evidence URLs** so the user sees why.
- Low/medium confidence, or any resolver failure → treated as **not resolved**. The job continues. Under-firing is safe; false-firing is not.

### digest resolver

- Anthropic call with web search, against `resolved_query` over the relevant time window.
- For news-type digests: **report from sources and attribute them; do not assert facts independently.** Accuracy and sourcing matter.
- Output is the report body, emailed via the job's schedule.
- A resolver failure → skip this run, log it, advance `next_run`. Don't send a broken report.

Resolver instructions default from `config` (latest version > 0) and can be overridden per-job via `jobs.resolver_prompt`. All of it is D1 text — editable by asking a Claude, no redeploy.

## Email delivery

- Resend. One recipient: `RECIPIENT_EMAIL` (set as a Worker secret at setup). Claude-Cron only ever emails this one address — there is no multi-recipient path, no allowlist needed, no "send to someone else" capability. Single recipient is the whole model.
- Every email sent is written to `messages` (with `evidence` for watch fires).
- Resend send fails → log it, leave the job/message state such that it retries next run rather than being silently lost.
- **Body formatting (text + HTML) is owned by the Worker, not the resolvers.** Resolvers return data (JSON for watches, Markdown for digests); `src/format.ts` produces the final `{subject, text, html}` for Resend. See [EMAIL.md](claude-cron-EMAIL.md) for the templates, the inline-citation convention for watch summaries, and the design constraints.

## wrangler.toml shape

```toml
name = "claude-cron"
main = "src/index.ts"
compatibility_date = "2026-01-01"

[triggers]
crons = ["0 13 * * *"]   # daily ~05:00-06:00 PT; adjust per user timezone at setup

[[d1_databases]]
binding = "DB"
database_name = "claude-cron"
database_id = "<filled in at setup>"

[vars]
MODEL = "claude-haiku-4-5"   # resolver model; can bump via env if judgments too coarse
```

Secrets via `wrangler secret put` (or dashboard encrypted variables): `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `RECIPIENT_EMAIL`. Never in `wrangler.toml`, never in source, never in D1, never logged.

## Failure posture

| Failure | Behavior |
|---|---|
| One job's resolver/run | log, count in `jobs_failed`, add to `failed_ids`, continue other jobs |
| All jobs fail | run row written, no crash |
| watch resolver call fails | treat as **not resolved** (the safe direction) — job continues |
| digest resolver call fails | skip this run, log, advance `next_run` — don't send a broken report |
| Resend send fails | log; leave state so it retries next run, not silently dropped |
| Malformed resolver JSON | one retry → then treat per the rules above (watch: not resolved; digest: skip) |

Degrade, never crash. For watches specifically, every ambiguous path resolves to "not yet."

## Cost

Daily cron, a handful of jobs, one Anthropic call per active job per run. Single-digit cents per day at most, billed to the user's own key. Resend free tier untouched. D1 + Worker invocations are free-tier noise. The cost ceiling is just the number of jobs and how chatty the resolvers are — both small.

## When R2 would enter

Not this version. The trigger is a job that must deliver a *file* — a generated PDF, an image, an audio clip. At that point: an R2 bucket gets bound, the blob is stored by key, the email carries a link. Until a concrete need exists, no R2 binding — an unused binding is just surface.
