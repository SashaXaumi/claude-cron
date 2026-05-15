# PLAN — Claude-Cron

Build sequence for constructing Claude-Cron itself. Each milestone is independently verifiable; don't advance until the current one is confirmed. This is for the person/agent *building* the project — not for a user setting up their own instance (that's `GUIDE.md`).

## M0 — Scaffold

- `wrangler init`, TypeScript. **Only** the `scheduled()` entry point — no `fetch()` handler, deliberately.
- Create a D1 database for development; apply the full schema from `SPEC.md` — every table, the FTS5 virtual table, the sync trigger, and the reserved manifest row (`config` version 0) with placeholder content.
- `scheduled()` runs locally and logs "ran." Nothing else.

**Done when:** the cron handler fires under `wrangler dev`, the schema is fully applied, the manifest row reads back, and there is provably no `fetch()` handler.

## M1 — Job loading + the runner skeleton

- Implement: load due jobs (`status='active' AND next_run <= now`), read `MAX(version)` per `job_id`.
- Dispatch by `type` to stub resolvers that just log. Per-job try/catch. Advance `next_run` correctly for `daily` and `weekly`; flip `watch` jobs to `done` on a (stubbed) resolve.
- Write a `runs` row each invocation.

**Done when:** seeded test jobs are picked up when due and ignored when not; `next_run` math is correct; one stub job throwing doesn't stop the others; a `runs` row is written.

## M2 — Message log + search

- Implement the `messages` write path and confirm the FTS5 trigger populates `messages_fts`.
- Implement an FTS5 `MATCH` query function (this is what a future Claude session uses for "what did cron find about X").
- Wire it to a hardcoded test query to prove search works end to end.

**Done when:** writing a message populates both tables; a `MATCH` query returns hits. The audit trail and search exist before anything actually sends.

## M3 — The digest resolver

- Implement the digest resolver: Anthropic call with the web search tool, against `resolved_query`, producing a report body.
- News-type framing: report from sources, attribute them, don't assert independently.
- Defensive JSON/output parse — one retry, then skip-this-run-and-log on failure.
- Still logs output instead of emailing.

**Done when:** a real `digest` job produces a sourced, attributed report from live web data; a forced bad response triggers exactly one retry then a clean skip.

## M4 — The watch resolver

- Implement the watch resolver: conservative Anthropic call with web search; output `{resolved, confidence, evidence, summary}`.
- Tune the system prompt hard for conservatism — rumor/leak/clickbait must produce `not resolved`. Test against real queries with known answers (something clearly released, something clearly not, something *rumored but not* — that last case is the one that matters).
- Resolver failure → treated as not resolved.

**Done when:** a watch on a true condition resolves with evidence; a watch on a false condition does not; a watch on a *rumored-but-unconfirmed* condition does **not** resolve. That third test is the real bar — budget iteration for it.

## M5 — Email delivery

- Resend integration. Send to `RECIPIENT_EMAIL`. Watch fires include evidence URLs in the email body.
- Wire delivery into the runner: digest produces → email + log + advance `next_run`; watch resolves → email + log + `status='done'`.
- Every send writes to `messages` first. Resend failure → log, leave state for retry next run.

**Done when:** a digest job emails a real report; a watch job emails on resolve with evidence; both are logged in `messages`; a forced Resend failure is logged and the item is not silently lost.

## M6 — Failure hardening + run logging

- Walk the `SPEC.md` failure table and implement every row. Test the nasty ones: all jobs fail, watch resolver call fails (→ not resolved), digest resolver call fails (→ skip + advance), Resend down, malformed resolver JSON.
- Confirm `runs` rows capture `jobs_run`, `jobs_failed`, `failed_ids`.

**Done when:** every failure-table row behaves exactly as specified; deliberately breaking one job degrades gracefully and is visible in the `runs` log.

## M7 — Finalize the manifest row + the setup story

- Write the real manifest-row content (per `SPEC.md`): "this is a Claude-Cron database," worker URL placeholder, schema summary, how to add/edit/cancel a job, the boundary rule in-band.
- Walk `GUIDE.md` end to end *as if you were the helping Claude* against a clean Cloudflare account — catch every place the steps drift from current Cloudflare/Resend reality and fix the guide. This dry run is the real test of the project, because setup is the fragile part.
- Confirm the post-setup re-entry flow: the populated memory line, the saved-note backup, the manifest row — all three described correctly in `GUIDE.md`.

**Done when:** a clean-account walkthrough following only `GUIDE.md` produces a working deployment, and the three persistence layers are all correctly set up by the end of it.

## M8 — Publish

- Repo hygiene: no secrets anywhere, `wrangler.toml` has a placeholder database ID, README points a visiting Claude at `GUIDE.md` first.
- The four docs (`GUIDE`, `SPEC`, `CLAUDE`, `PLAN`) are the deliverable as much as the code — they are what a helping Claude actually reads.

**Done when:** the repo can be handed to a stranger's Claude and that Claude can take a non-technical user from nothing to a working cron, using only the repo.

## Notes on effort and ordering

- **M4 (the watch resolver) is the hard part** — not the code, the *judgment*. "Conservative enough that rumors don't fire" is a prompt-tuning problem and expect to iterate it against real queries. The rumored-but-unconfirmed test case is the whole game.
- **No `fetch()` handler, ever** — M0 establishes this and nothing later should add one. The lack of an inbound surface is why this version needs zero auth code; that's a feature, don't erode it.
- **M7 is not paperwork** — the guide *is* the product for non-technical users. A dry run as the helping Claude is the only way to catch where Cloudflare's UI has drifted from the written steps.
- R2 is not in this plan. It enters via a `SPEC.md` update when a real file-delivery need shows up — not before.
- This project is the pared-down descendant of a larger design that had a Telegram bot, a chat handler, double-auth, an email allowlist, and a seven-capability agent surface. All of that was dropped on purpose: if the control plane is "a human with a Claude that can reach their Cloudflare," the entire inbound half of the system is dead weight. Don't reintroduce it. If it ever needs to come back, that's a deliberate new design, not a feature creep.
