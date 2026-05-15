// D1 helpers. Raw prepared statements, no ORM. All writes to `jobs` are
// append-only (new version row per change) -- invariant #2 in CLAUDE.md.

export interface JobRow {
  row_id: number;
  job_id: string;
  version: number;
  type: "watch" | "digest";
  nl_request: string;
  resolved_query: string;
  resolver_prompt: string | null;
  schedule: string;
  sources: string | null;
  status: "active" | "done" | "cancelled";
  next_run: string;
  created_at: string;
}

export type JobPatch = Partial<
  Pick<
    JobRow,
    | "status"
    | "next_run"
    | "schedule"
    | "resolver_prompt"
    | "resolved_query"
    | "nl_request"
    | "sources"
  >
>;

// Latest-version row per job_id where status='active' and next_run <= now.
export async function loadDueJobs(
  db: D1Database,
  nowIso: string,
): Promise<JobRow[]> {
  const sql = `
    WITH latest AS (
      SELECT job_id, MAX(version) AS v FROM jobs GROUP BY job_id
    )
    SELECT j.*
    FROM jobs j
    JOIN latest l ON l.job_id = j.job_id AND l.v = j.version
    WHERE j.status = 'active' AND j.next_run <= ?
    ORDER BY j.next_run ASC
  `;
  const { results } = await db.prepare(sql).bind(nowIso).all<JobRow>();
  return results;
}

export async function latestVersion(
  db: D1Database,
  jobId: string,
): Promise<JobRow | null> {
  const row = await db
    .prepare(`SELECT * FROM jobs WHERE job_id = ? ORDER BY version DESC LIMIT 1`)
    .bind(jobId)
    .first<JobRow>();
  return row ?? null;
}

// Append a new version of a job. Copies the previous row and applies the patch.
// Never UPDATE -- invariant #2.
export async function appendJobVersion(
  db: D1Database,
  prev: JobRow,
  patch: JobPatch,
): Promise<void> {
  const next: JobRow = { ...prev, ...patch, version: prev.version + 1 };
  await db
    .prepare(
      `INSERT INTO jobs (job_id, version, type, nl_request, resolved_query, resolver_prompt,
                         schedule, sources, status, next_run, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      next.job_id,
      next.version,
      next.type,
      next.nl_request,
      next.resolved_query,
      next.resolver_prompt,
      next.schedule,
      next.sources,
      next.status,
      next.next_run,
      next.created_at,
    )
    .run();
}

// Compute the next run timestamp from a schedule string.
//
// Anchored to max(previous next_run, now) so a long downtime doesn't cause
// a backfill stampede -- we jump forward one period from now instead of
// re-firing every missed day.
export function computeNextRun(
  schedule: string,
  fromIso: string,
  now: Date = new Date(),
): string {
  const periodMs = parseSchedule(schedule);
  const anchorMs = Math.max(new Date(fromIso).getTime(), now.getTime());
  return new Date(anchorMs + periodMs).toISOString();
}

function parseSchedule(s: string): number {
  const lc = s.trim().toLowerCase();
  if (lc === "daily") return 86_400_000;
  if (lc === "weekly") return 7 * 86_400_000;
  // Minimal ISO 8601 duration support: PnD, PnW.
  const m = /^p(\d+)([dw])$/i.exec(s.trim());
  if (m) {
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!.toLowerCase();
    return n * (unit === "w" ? 7 : 1) * 86_400_000;
  }
  // Unknown schedule -- default to daily so the job keeps making progress.
  return 86_400_000;
}

// Write a message. The FTS5 trigger `messages_ai` mirrors `content` into
// `messages_fts` automatically. Invariant #5: every email goes here.
// (For watch fires, pass the evidence URL array as `evidence`.)
export async function writeMessage(
  db: D1Database,
  args: {
    jobId: string | null;
    subject: string | null;
    content: string;
    evidence?: string[];
  },
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO messages (ts, job_id, subject, content, evidence)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      new Date().toISOString(),
      args.jobId,
      args.subject,
      args.content,
      args.evidence && args.evidence.length
        ? JSON.stringify(args.evidence)
        : null,
    )
    .run();
  return Number(result.meta.last_row_id);
}

export interface MessageHit {
  id: number;
  ts: string;
  job_id: string | null;
  subject: string | null;
  content: string;
  evidence: string | null;
}

// FTS5 MATCH search over messages. The "what did cron find about X" path.
export async function searchMessages(
  db: D1Database,
  query: string,
  limit = 20,
): Promise<MessageHit[]> {
  const sql = `
    SELECT m.id, m.ts, m.job_id, m.subject, m.content, m.evidence
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    WHERE messages_fts MATCH ?
    ORDER BY m.ts DESC
    LIMIT ?
  `;
  const { results } = await db.prepare(sql).bind(query, limit).all<MessageHit>();
  return results;
}

// Read the latest config defaults (version > 0). The manifest row at
// version 0 is plain text and not parsed here -- only versions > 0 hold the
// JSON defaults. Returns {} if there are no defaults yet.
export interface ConfigDefaults {
  digest_default?: string;
  watch_default?: string;
}

export async function loadConfigDefaults(
  db: D1Database,
): Promise<ConfigDefaults> {
  const row = await db
    .prepare(
      `SELECT blob FROM config WHERE version > 0 ORDER BY version DESC LIMIT 1`,
    )
    .first<{ blob: string }>();
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.blob);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeRun(
  db: D1Database,
  jobsRun: number,
  jobsFailed: number,
  failedIds: string[],
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runs (run_at, jobs_run, jobs_failed, failed_ids) VALUES (?, ?, ?, ?)`,
    )
    .bind(
      new Date().toISOString(),
      jobsRun,
      jobsFailed,
      failedIds.length ? JSON.stringify(failedIds) : null,
    )
    .run();
}
