// Claude-Cron Worker.
//
// IMPORTANT: This Worker exposes ONLY a scheduled() handler. It has no fetch()
// handler by design -- the absence of an inbound surface is a security property
// and is why this version needs no auth code. Do not add a fetch() handler.
// See CLAUDE/claude-cron-CLAUDE.md (invariant #1).

import {
  appendJobVersion,
  computeNextRun,
  loadConfigDefaults,
  loadDueJobs,
  writeMessage,
  writeRun,
  type ConfigDefaults,
  type JobRow,
} from "./db";
import { sendEmail } from "./email";
import { formatDigestEmail, formatWatchEmail } from "./format";
import { runDigest, type DigestResult } from "./resolvers/digest";
import { runWatch, type WatchResult } from "./resolvers/watch";

export interface Env {
  DB: D1Database;
  MODEL: string;
  ANTHROPIC_API_KEY: string;
  RESEND_API_KEY: string;
  RECIPIENT_EMAIL: string;
  RESEND_FROM: string;
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const due = await loadDueJobs(env.DB, nowIso);
    const defaults = await loadConfigDefaults(env.DB);
    console.log(`claude-cron: scheduled() ran, ${due.length} due jobs`);

    let jobsRun = 0;
    let jobsFailed = 0;
    const failedIds: string[] = [];

    // Per-job try/catch -- invariant #7: one failure never blocks the others.
    for (const job of due) {
      try {
        await runJob(env, defaults, job);
        jobsRun++;
      } catch (err) {
        jobsFailed++;
        failedIds.push(job.job_id);
        console.error(`job ${job.job_id} failed:`, err);
      }
    }

    await writeRun(env.DB, jobsRun, jobsFailed, failedIds);
  },
};

async function runJob(
  env: Env,
  defaults: ConfigDefaults,
  job: JobRow,
): Promise<void> {
  if (job.type === "watch") {
    await runWatchJob(env, defaults, job);
    return;
  }
  if (job.type === "digest") {
    await runDigestJob(env, defaults, job);
    return;
  }
  throw new Error(`unknown job type: ${job.type}`);
}

async function runWatchJob(
  env: Env,
  defaults: ConfigDefaults,
  job: JobRow,
): Promise<void> {
  let result: WatchResult;
  try {
    result = await runWatch(
      {
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.MODEL,
        defaultPrompt: defaults.watch_default ?? null,
      },
      job,
    );
  } catch (err) {
    // SPEC: watch resolver call fails -> treat as NOT resolved (safe direction).
    // Log, advance next_run, re-throw for outer accounting.
    const msg = `Watch resolver error (treated as not resolved): ${err instanceof Error ? err.message : String(err)}`;
    await writeMessage(env.DB, {
      jobId: job.job_id,
      subject: `[error] watch resolver failed: ${job.nl_request}`,
      content: msg,
    });
    const next = computeNextRun(job.schedule, job.next_run);
    await appendJobVersion(env.DB, job, { next_run: next });
    throw err;
  }

  if (!result.resolved) {
    // Quiet log + advance. No email.
    await writeMessage(env.DB, {
      jobId: job.job_id,
      subject: null,
      content: `watch check: not resolved (confidence=${result.confidence}). ${result.summary}`,
    });
    const next = computeNextRun(job.schedule, job.next_run);
    await appendJobVersion(env.DB, job, { next_run: next });
    console.log(
      `watch: ${job.job_id} not resolved (confidence=${result.confidence}), next_run=${next}`,
    );
    return;
  }

  // RESOLVED. Log with evidence FIRST, then email, then flip status=done.
  // If email fails, status stays 'active' and the next run retries.
  const { subject, text, html } = formatWatchEmail(job, result);

  await writeMessage(env.DB, {
    jobId: job.job_id,
    subject,
    content: text,
    evidence: result.evidence,
  });

  await sendEmail({
    apiKey: env.RESEND_API_KEY,
    from: env.RESEND_FROM,
    to: env.RECIPIENT_EMAIL,
    subject,
    text,
    html,
  });

  await appendJobVersion(env.DB, job, { status: "done" });
  console.log(
    `watch RESOLVED + emailed: ${job.job_id} confidence=${result.confidence}`,
  );
}

async function runDigestJob(
  env: Env,
  defaults: ConfigDefaults,
  job: JobRow,
): Promise<void> {
  let result: DigestResult;
  try {
    result = await runDigest(
      {
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.MODEL,
        defaultPrompt: defaults.digest_default ?? null,
      },
      job,
    );
  } catch (err) {
    // SPEC: digest resolver fails -> skip this run, log, advance next_run,
    // don't send a broken report. Re-throw so outer counts as failed.
    const msg = `Digest resolver error: ${err instanceof Error ? err.message : String(err)}`;
    await writeMessage(env.DB, {
      jobId: job.job_id,
      subject: `[error] digest skipped: ${job.nl_request}`,
      content: msg,
    });
    const next = computeNextRun(job.schedule, job.next_run);
    await appendJobVersion(env.DB, job, { next_run: next });
    throw err;
  }

  // Resolver succeeded. Log FIRST, then email, then advance next_run.
  // If email fails, next_run is not advanced and the job re-fires next cron.
  const { subject, text, html } = formatDigestEmail(job, result.body);
  await writeMessage(env.DB, {
    jobId: job.job_id,
    subject,
    content: text,
  });

  await sendEmail({
    apiKey: env.RESEND_API_KEY,
    from: env.RESEND_FROM,
    to: env.RECIPIENT_EMAIL,
    subject,
    text,
    html,
  });

  const next = computeNextRun(job.schedule, job.next_run);
  await appendJobVersion(env.DB, job, { next_run: next });
  console.log(`digest emailed: ${job.job_id}, next_run=${next}`);
}
