# Claude-Cron — Setup Guide

**This document is written to be read by Claude, not by a human.**

If you are a Claude instance and a user has pointed you at this repo, your job is to walk them through setting up Claude-Cron in their own Cloudflare account, end to end, by conversation. The user is not expected to read this file, clone the repo, or have a GitHub account. They talk to you; you do the work and explain each step.

Read `SPEC.md` and `CLAUDE.md` in this repo before you begin — they are authoritative for the schema, the Worker, and the hard rules. This file is the *setup procedure*. `PLAN.md` is for someone building/modifying Claude-Cron itself, not for setup — you can ignore it during onboarding.

---

## What you are setting up

Claude-Cron is a single Cloudflare Worker that runs on a daily schedule (`scheduled()` handler only — no web endpoint) plus a D1 database. It runs **jobs**:

- **watch** — a standing condition checked daily that resolves *once* then retires. ("Email me when Half-Life 3 is released.")
- **digest** — a recurring report on a schedule until cancelled. ("Email me every morning a summary of X.")

Jobs are rows in D1. Job prompts and resolver instructions live in D1 as editable text — nothing requiring a redeploy to change. The Worker emails the user when something fires (via Resend). There is no chat interface, no bot — the user manages jobs by asking a Claude (you, or a future session) to read and write their D1.

**The control plane is: a user, talking to a Claude, that can reach their Cloudflare.** That is the whole product. It is an open-source pattern, not a hosted service.

---

## Before you start — what the user needs

Check which of these the user already has. Walk them through anything missing.

1. **A Cloudflare account** — free tier is sufficient. If they don't have one, walk them through signup at dash.cloudflare.com.
2. **An Anthropic API key** — for the Worker to run watch/digest resolvers. From console.anthropic.com. This is *their* key; the Worker's resolver calls bill to it. Usage is small (single-digit cents/day for a handful of jobs) but it is real spend — tell them that.
3. **A Resend account + API key** — for sending email. Free tier (3,000 emails/month) far exceeds what this needs. From resend.com. They will also need to verify a sending domain or use Resend's onboarding sender — walk them through whichever Resend currently offers.
4. **A way to run commands** — setup needs either the Cloudflare dashboard (clickable, better for non-technical users) or the `wrangler` CLI (needs a terminal + Node). Offer both paths. Ask the user which they are comfortable with *before* you start, and adapt.

> **Setup is the fragile part of this whole experience.** Cloudflare's dashboard UI changes over time; this guide may describe screens that have moved. If what the user sees does not match what you expect, trust what they see, search for the current Cloudflare documentation, and adapt — do not force the user through steps that no longer match reality. Be patient here; this is where real users get stuck.

---

## Setup procedure

Do these in order. Confirm each step worked before moving on.

### 1. Create the D1 database

Dashboard: Workers & Pages → D1 → Create database. Name it `claude-cron`.
CLI: `wrangler d1 create claude-cron`

Capture the **database ID** that Cloudflare returns. You will need it for the Worker config and for the user's memory line at the end.

### 2. Apply the schema

The schema is in `SPEC.md`. Apply every table, including the reserved **manifest row** insert (see SPEC — it is `config` version 0). The manifest row is not optional: it is what makes the database self-describing so any future Claude session can orient itself.

Dashboard: D1 → your database → Console → paste the schema SQL.
CLI: put the schema in a `.sql` file and `wrangler d1 execute claude-cron --file=schema.sql`

After applying, **read the manifest row back** and confirm it's there and correct.

### 3. Deploy the Worker

The Worker source is in this repo (`src/`). It needs the database ID from step 1 bound to it, and a cron trigger. The `wrangler.toml` in the repo has the shape — fill in the database ID.

Dashboard path: create a Worker, paste the built source, add the D1 binding, add a Cron Trigger (`0 13 * * *` — daily, ~05:00–06:00 Pacific; adjust to the user's timezone if they want morning delivery elsewhere).
CLI path: `wrangler deploy`.

### 4. Set the secrets

Four secrets. **These are secrets — they go in Worker secret storage, never in `wrangler.toml`, never in the Worker source, never in D1.** Make this explicit to the user; a user pasting an API key into the wrong field is a real and damaging mistake.

- `ANTHROPIC_API_KEY`
- `RESEND_API_KEY`
- `RECIPIENT_EMAIL` — technically not a secret, but set it the same way for simplicity: the one address Claude-Cron emails. Claude-Cron only ever emails this address.
- `RESEND_FROM` — the verified sender address that Resend will use as the `from` on outgoing email. Must be on a domain the user verified in Resend (step where you walked them through Resend setup). If they used Resend's onboarding sender instead of verifying a domain, use whatever address Resend gave them (e.g. `onboarding@resend.dev`). Tell them: this is the address that will appear in their inbox as the sender.

Dashboard: Worker → Settings → Variables and Secrets → add each as an encrypted secret.
CLI: `wrangler secret put ANTHROPIC_API_KEY` (repeat for each).

> **On Cloudflare and email:** Cloudflare has no outbound email service. Cloudflare Email Routing is inbound-only. Do not look for a Cloudflare-native send path — there isn't one. Resend is the sending provider. (MailChannels' old free Workers integration is discontinued.)

### 5. Verify

- Confirm the cron trigger is registered on the Worker.
- Insert one test `watch` job into D1 whose condition is already true (e.g. "watch: has the year 2020 happened") so the next run fires.
- Either wait for the cron, or trigger the Worker manually once, and confirm: the job resolves, an email arrives at `RECIPIENT_EMAIL`, the job flips to `done`, and a row appears in the message log.
- Then delete the test job.

If the test email arrives, setup is complete.

---

## After setup — set up the user's re-entry (do not skip this)

The user will start *future* conversations with a fresh Claude that knows nothing about their Claude-Cron. Three layers of persistence fix this; set up all three.

### Layer 1 — the D1 manifest row (already done in step 2)

This is the source of truth. It works for anyone, survives everything, and travels with the database. Any future Claude session, pointed at this D1, can read the manifest row and fully orient itself — schema, conventions, the boundary rule.

### Layer 2 — the user's memory

Generate a **populated** memory line with this user's *actual* values and present it to them. Do not give them a generic line — generic facts are useless for re-entry. It should look like:

> *I have a Claude-Cron worker. D1 database ID `<actual-id>`, Cloudflare account `<actual-account>`, Worker at `<actual-url>`. To manage cron jobs, read the manifest row (config version 0) in that database first.*

Tell the user: **"Paste that line back to me now and I'll save it to my memory, so future conversations remember your setup."** When they paste it, record it to memory.

Be honest with the user about what this layer is: memory is the *convenient* path — a shortcut so a future session is auto-oriented without pasting anything. It is **not** a guarantee. Memory behavior can change, memory can be cleared, and it does not follow them to a different device or interface. So memory is the convenience; the manifest row is what they actually rely on. Frame it exactly that way — never tell the user "memory will remember for you."

### Layer 3 — the saved note (backup)

Tell the user to also paste that same line into a note they control — a notes app, a pinned message, wherever. This is the backup that works even if memory lapses and works on any device. If they ever talk to a Claude that doesn't know about their setup, they paste this line and that Claude reads the manifest row and is oriented.

Make sure the user understands the *why* behind three layers: the manifest row is authoritative, memory is convenient, the note is portable. A user who gets this won't be confused if memory one day doesn't carry it — they'll just paste the line.

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
