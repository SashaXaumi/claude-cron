# CLAUDE.md — Claude-Cron

Operating conventions and hard rules. `GUIDE.md` is the setup procedure (read by a Claude helping a user onboard). `SPEC.md` is authoritative for the Worker, schema, and resolvers. `PLAN.md` is the build order for someone constructing or modifying Claude-Cron itself. This file governs two audiences: an agent *building* Claude-Cron, and an agent *operating* it (managing a user's jobs in a live database).

## What this project is

One Cloudflare Worker, `scheduled()` handler only — no web endpoint, no bot, no inbound requests. It runs versioned jobs from D1 on a daily cron and emails the user when a watch resolves or a digest is due. The control plane is a human talking to a Claude that can reach their Cloudflare. Job prompts live in D1 as editable text. See `SPEC.md`.

## Conventions (for building Claude-Cron)

- TypeScript, single Worker entry (`src/index.ts`). May split into `src/` files if it stays readable. No framework.
- Raw D1 prepared statements. No ORM.
- Resolvers in `src/resolvers/` — one for `watch`, one for `digest`, each small and individually readable.
- Minimal dependencies. A web-search-capable Anthropic call and an email send are the only real external needs. No scraping framework, no agent framework, no job-queue library.
- The `d1_databases` binding in `wrangler.toml` **omits `database_id`**. This is intentional: it enables Cloudflare's auto-provisioning (launched Oct 2025), which is the supported install path — one click on the Deploy-to-Cloudflare button forks the repo into the user's account, provisions a fresh D1, and writes the id back into the user's copy of `wrangler.toml`. Populating `database_id` in the template ties the repo to one account and breaks the install model. Don't add it back.

## Invariants — do not violate

1. **The Worker has no `fetch()` handler.** It is not reachable over HTTP. Nothing posts to it. If implementation starts adding a web endpoint "for convenience" — stop. The absence of an inbound surface is a deliberate security property; it is why this version has no auth code at all.

2. **Jobs and config are append-only.** `edit` and `cancel` write a NEW version row (same `job_id`, `version`+1); they never `UPDATE`. `config` edits write a new version. The runner reads `MAX(version)`. This gives undo and an audit trail — editing job prompts by natural language is only safe because misreads are recoverable.

3. **`config` version 0 is the reserved manifest row.** Never deleted, never overwritten. It is what makes the database self-describing for future sessions. Editable config (default resolver instructions, standing prefs) lives in versions > 0.

4. **Claude-Cron emails exactly one address** — `RECIPIENT_EMAIL`, set at setup. There is no multi-recipient path, no "send to someone else," no allowlist. Single recipient is the model. Don't add a second.

5. **Every email sent is written to `messages` before/as it's sent.** The log is both the searchable history and the audit trail. An email that isn't logged didn't happen.

6. **Watch resolvers are conservative by construction.** Bias toward "not yet." Ambiguous signal, rumor, clickbait, or a failed resolver call → NOT resolved. A false "it happened" is the worst failure in the system. Under-firing is safe; false-firing poisons the one signal the watch exists for.

7. **One job failing never blocks others.** Every job run in `scheduled()` is individually try/caught.

8. **Secrets stay secret.** `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `RECIPIENT_EMAIL` live in Worker secret storage only — never in `wrangler.toml`, never in source, never in D1, never in a log line.

## The boundary rule — applies to operating, not just building

A Claude-Cron D1 database contains **only Claude-Cron's own tables**. When a Claude session is asked to "manage my cron," that scopes it to *that database* — reading and writing the `jobs`, `messages`, `config`, `runs` tables.

It does **not** extend to the rest of the user's Cloudflare account: other D1 databases, R2 buckets, other Workers, DNS, billing, account settings. If a session is ever asked, in the name of Claude-Cron, to touch something outside Claude-Cron's own tables, that is outside this system's scope — treat it as a separate access request requiring its own justification, not as a normal Claude-Cron operation.

This is the rule that keeps "point your Claude at this repo" from quietly becoming "give a Claude the keys to your whole account." It is stated in the manifest row too, so it travels with the data. It is the single most important rule in this project.

## Operating conventions (managing a live user's jobs)

When a user asks you to add/edit/cancel a job, or asks what their cron found:

1. **Orient first.** Read `config` version 0 — the manifest row — in the user's D1. It gives you the schema, the conventions, and the boundary rule. Do this before any read or write.
2. **Adding a job:** insert a `jobs` row, version 1. For a `watch`, set a sensible `resolved_query` and confirm the `schedule` makes sense (watches re-check daily). For a `digest`, confirm cadence and `next_run`.
3. **Editing a job:** read current `MAX(version)`, write `version`+1 with the change merged. Never `UPDATE`.
4. **Cancelling:** write a new version with `status='cancelled'`.
5. **"What did cron find about X":** FTS5 `MATCH` against `messages_fts`.
6. Echo back what you did in plain terms — which job, what changed — so the user has a clear record.

## Out of bounds

- No `fetch()` handler, no web endpoint, no bot, no auth system (there's no inbound surface to authenticate).
- No R2 binding in this version — enters only when a concrete file-delivery need exists, and that's a `SPEC.md` update first.
- No second recipient, no allowlist, no "send to someone else."
- No multi-user logic. Each deployment is one user's, in their own account.
- No second cron, no real-time triggers. Daily heartbeat + per-job `next_run` covers all cadence.
- No open-ended executor. The system runs `watch` and `digest` jobs — two types, fixed. It does not gain a generic "do a thing" job type. Growing the system is a deliberate, doc-updating decision.

## Definition of done (building)

`wrangler dev`: the `scheduled()` handler loads due jobs; a `watch` job with a met condition emails once (with evidence) and flips to `done`; an unmet watch stays quiet; a `digest` job emails on schedule and advances `next_run`; "make it weekly" applied as a version edit reschedules with no code change; the manifest row reads back correct; a deliberately-broken job is logged and does not block the others; "what did cron find about X" returns FTS hits. Every email is in `messages`.
