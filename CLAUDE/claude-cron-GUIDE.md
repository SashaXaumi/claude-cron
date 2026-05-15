# Claude-Cron — Setup Guide

**This document is written to be read by Claude, not by a human.**

If you are a Claude instance and a user has pointed you at this repo, your job is to **finish** setting up Claude-Cron after the user has clicked the Deploy-to-Cloudflare button. Cloudflare has already done the heavy lifting — fork, D1 provision, Worker deploy. Your job is the post-deploy phase: applying the schema, walking through prerequisites and secrets, and verifying the first email fires.

Read `SPEC.md` and `CLAUDE.md` in this repo before you begin — they are authoritative for the schema, the Worker, and the hard rules. This file is the *setup procedure*. `PLAN.md` is for someone building/modifying Claude-Cron itself, not for setup — ignore it during onboarding.

---

## What you are setting up

Claude-Cron is a single Cloudflare Worker that runs on a daily schedule (`scheduled()` handler only — no web endpoint) plus a D1 database. It runs **jobs**:

- **watch** — a standing condition checked daily that resolves *once* then retires. ("Email me when Half-Life 3 is released.")
- **digest** — a recurring report on a schedule until cancelled. ("Email me every morning a summary of X.")

Jobs are rows in D1. Job prompts and resolver instructions live in D1 as editable text — nothing requiring a redeploy to change. The Worker emails the user when something fires (via Resend). There is no chat interface, no bot — the user manages jobs by asking a Claude (you, or a future session) to read and write their D1.

**The control plane is: a user, talking to a Claude, that can reach their Cloudflare.** That is the whole product. It is an open-source pattern, not a hosted service.

---

## What's already done before you get involved

If the user is talking to you, they have (or are about to have) clicked the **Deploy to Cloudflare** button on the repo's README. That single click:

- Cloned this repo into the user's own GitHub account as a personal fork (`<their-handle>/claude-cron`).
- Auto-provisioned a fresh D1 database named `claude-cron` in their Cloudflare account.
- Deployed the Worker named `claude-cron` with the D1 binding and the daily cron trigger.
- Wrote the new `database_id` back into the **forked** copy of `wrangler.toml` (the upstream stays unpopulated).

End state when you arrive: the Worker is live, the cron is registered, the D1 exists but is **empty** (no tables, no manifest, no defaults), and no secrets are set. So nothing useful runs yet — that's your job.

If the user hasn't clicked the button yet, walk them to it: open the repo's README, click **Deploy to Cloudflare**, authorize Cloudflare to fork into their GitHub, wait ~60 seconds for the "deployed" screen. Then come back here.

---

## Prerequisites the user must have (check before secrets)

The deploy button doesn't enforce these. The Worker will sit there happily failing every scheduled run until they're handled. Confirm all three with the user **before** sending them to set secrets:

1. **An Anthropic API key.** From console.anthropic.com. This is *their* key; the Worker's resolver calls bill to it. Usage is small (single-digit cents/day for a handful of jobs) but it is real spend — tell them that.
2. **A Resend account and verified sender.** From resend.com. The free tier (3,000 emails/month) far exceeds what this needs. They will need to either verify a sending domain or use Resend's onboarding sender — walk them through whichever Resend currently offers. Capture the resulting **verified sender address** (e.g. `notifications@theirdomain.com` or `onboarding@resend.dev`). You'll need that as `RESEND_FROM` in step 4 below.
3. **The Resend account and the Cloudflare account belong to the same person.** This sounds trivial but on mobile, mid-conversation, it's easy to be signed into the wrong account in one tab. Confirm verbally before any secret-setting.

> **Cloudflare and email:** Cloudflare has no outbound email service. Cloudflare Email Routing is inbound-only. Do not look for a Cloudflare-native send path — there isn't one. Resend is the sending provider. (MailChannels' old free Workers integration is discontinued.)

> **Setup is less fragile than it used to be, but not zero.** The deploy phase is off your plate entirely — Cloudflare does it. What remains is the dashboard UI for secrets and the trigger button (which Cloudflare does occasionally re-skin), plus the user's external prerequisites (Resend, Anthropic). If what the user sees doesn't match what you expect, trust what they see, search current Cloudflare/Resend docs, and adapt — don't force them through stale steps.

---

## Setup procedure

Do these in order. Confirm each step before moving on.

### 1. Orient

You need three pieces of information from the user's Cloudflare account. Use your Cloudflare MCP / tools (or ask them to read these from the dashboard if you don't have direct access):

- The **Worker URL** for the just-deployed worker. Typically `https://claude-cron.<their-subdomain>.workers.dev`.
- The **Cloudflare account ID**. Found in the dashboard sidebar.
- The **D1 database ID** of the auto-provisioned `claude-cron` database. Find it under Workers & Pages → D1 → `claude-cron`.

Save these values — you need them in step 3.

### 2. Apply the schema (Pass 1)

The schema is in `schema.sql` in the repo. It's structured in two passes (the file itself explains this). Apply **Pass 1 only** in this step — everything *above* the "PASS 2" banner. That creates the tables, indexes, the FTS5 trigger, and inserts the default resolver prompts as `config` version 1. None of it depends on the deployed Worker.

Use the D1 MCP `d1_database_query` against the database you identified in step 1. Run each statement (you can run them as a batch if your tooling supports it; otherwise one at a time). Then confirm: there should be five tables (`jobs`, `messages`, `messages_fts` and its shadow tables, `config`, `runs`), the trigger `messages_ai`, and exactly one row in `config` with `version = 1`.

### 3. Insert the manifest row (Pass 2)

This is the **one and only** write to `config` version 0. The row is never overwritten and never deleted — it's the source of truth that makes the database self-describing for future Claude sessions.

Take the second INSERT in `schema.sql` (below the "PASS 2" banner). **Substitute the three placeholders with the real values you captured in step 1:**

- `<WORKER_URL>` → the actual Worker URL
- `<ACCOUNT_ID>` → the Cloudflare account ID
- `<DATABASE_ID>` → the D1 database ID

Then run the substituted INSERT against the D1. Read the row back and confirm no `<ALL_CAPS_PLACEHOLDERS>` remain in the blob — if any do, you forgot a substitution. Fix it now (you can re-run the INSERT only if the previous one didn't actually take; the `INSERT OR IGNORE` makes that safe).

### 4. Set the four secrets in the dashboard

**These are secrets — they live in Worker secret storage only. Never in `wrangler.toml`, never in source, never in D1, never logged.** Make this explicit to the user; a user pasting an API key into the wrong field is a real and damaging mistake.

Walk them through the dashboard path: **Workers & Pages → claude-cron → Settings → Variables and Secrets → add encrypted variable**. They add four entries. Be explicit about which value goes in which variable — `RECIPIENT_EMAIL` and `RESEND_FROM` are both email addresses but they mean different things, and that's where mistakes happen:

- `ANTHROPIC_API_KEY` — their Anthropic key (starts with `sk-ant-…`).
- `RESEND_API_KEY` — their Resend API key (starts with `re_…`).
- `RECIPIENT_EMAIL` — the address Claude-Cron will send TO. **This is the only address it ever emails — their inbox.** Almost always their personal address.
- `RESEND_FROM` — the verified sender address that Resend will send FROM. This is what appears as the sender in their inbox. Use the verified address they set up in the Resend prerequisite (a custom-domain address, or the `onboarding@resend.dev` fallback).

After they save, the Worker should pick up the secrets on the next invocation (no redeploy needed).

> *(Advanced users only: the CLI equivalent is `wrangler secret put ANTHROPIC_API_KEY` and so on, repeated for each. The user will see no benefit going this route on a fresh setup; mention only if they ask.)*

### 5. Verify

End-to-end smoke test. **You drive this — the user just watches.**

1. Insert one test `watch` job into D1 whose condition is already true. The classic is *"watch: has the year 2020 happened"* with `resolved_query: "Has the year 2020 happened?"`, `schedule: "daily"`, `status: "active"`, `next_run` set to the past (e.g. `2020-01-01T00:00:00.000Z`).
2. Trigger the Worker manually from the dashboard: **Workers & Pages → claude-cron → Triggers → "Send scheduled event"** (or whatever the current dashboard wording is). This fires `scheduled()` once, without waiting for the daily cron.
3. Confirm all four things happened:
   - An email lands in `RECIPIENT_EMAIL` with the subject starting `Resolved:` and evidence URLs in the body.
   - The job has flipped: a new version row with `status = 'done'`.
   - A row appears in `messages` with the job_id, subject, content, and JSON evidence.
   - A row appears in `runs` with `jobs_run = 1, jobs_failed = 0`.
4. Delete the test job rows (both versions).

If all four things happened, setup is complete. If any didn't, troubleshoot before moving on — the most common causes are an unverified Resend sender, a typo in `RESEND_FROM` vs `RECIPIENT_EMAIL`, or an Anthropic key with no credit on it.

---

## After setup — set up the user's re-entry (do not skip this)

The user will start *future* conversations with a fresh Claude that knows nothing about their Claude-Cron. Three layers of persistence fix this; set up all three.

### Layer 1 — the D1 manifest row (already done in step 3)

This is the source of truth. It works for anyone, survives everything, and travels with the database. Any future Claude session, pointed at this D1, can read the manifest row and fully orient itself — schema, conventions, the boundary rule.

### Layer 2 — the user's memory

Generate a **populated** memory line with this user's *actual* values and present it to them. Do not give them a generic line — generic facts are useless for re-entry. It should look like:

> *I have a Claude-Cron worker. D1 database ID `<actual-id>`, Cloudflare account `<actual-account>`, Worker at `<actual-url>`. Forked repo at `<their-github-handle>/claude-cron`. To manage cron jobs, read the manifest row (config version 0) in that database first.*

Tell the user: **"Paste that line back to me now and I'll save it to my memory, so future conversations remember your setup."** When they paste it, record it to memory.

Be honest with the user about what this layer is: memory is the *convenient* path — a shortcut so a future session is auto-oriented without pasting anything. It is **not** a guarantee. Memory behavior can change, memory can be cleared, and it does not follow them to a different device or interface. So memory is the convenience; the manifest row is what they actually rely on. Frame it exactly that way — never tell the user "memory will remember for you."

### Layer 3 — the saved note (backup)

Tell the user to also paste that same line into a note they control — a notes app, a pinned message, wherever. This is the backup that works even if memory lapses and works on any device. If they ever talk to a Claude that doesn't know about their setup, they paste this line and that Claude reads the manifest row and is oriented.

Make sure the user understands the *why* behind three layers: the manifest row is authoritative, memory is convenient, the note is portable. A user who gets this won't be confused if memory one day doesn't carry it — they'll just paste the line.

---

## Trade-offs the user should know about

Surface these once, briefly, after setup is working. Don't bury them in fine print:

- **You have a personal fork.** Installing Claude-Cron gave you a copy of the source at `<your-github-handle>/claude-cron`. Upstream changes don't auto-flow to you; if you want them, you pull from upstream or re-fork. Your D1, your secrets, your prompts — all yours, all in your account.
- **Two account bindings.** Your Resend domain verification is in your Resend account. Your Cloudflare D1 / Worker is in your Cloudflare account. If those accounts ever belong to different people, you'll get email from the wrong sender or stop receiving it at all. Keep both tied to the same person.

---

## Managing jobs (what you'll do in future sessions)

Once Claude-Cron exists, a user (this session or a future one) will ask things like "add a watch for X," "change my morning digest to weekly," "what are my jobs," "what did cron find about Y." To handle these:

1. Orient yourself: read the manifest row (config version 0) in the user's D1. It tells you the schema and conventions.
2. Then read/write the relevant tables per `SPEC.md` and `CLAUDE.md`.

The hard rules in `CLAUDE.md` apply to every one of those operations — especially the boundary rule below.

---

## The boundary rule — state this to the user, and never violate it

Claude-Cron's D1 database contains **only Claude-Cron's own tables**. Managing Claude-Cron means reading and writing *that database*. It does **not** mean a Claude session has, or should use, access to the rest of the user's Cloudflare account — other databases, R2 buckets, other Workers, DNS, billing.

When you help a user set this up, tell them this explicitly: pointing a Claude at Claude-Cron scopes it to Claude-Cron. If a future Claude session is ever asked to do something to their Cloudflare account *beyond* Claude-Cron's own tables, that is outside this system's scope and they should treat it with the same caution as any other access request.

This rule is what keeps "point your Claude at this repo" from quietly meaning "hand a Claude the keys to your whole account." It is the most important sentence in this guide.
