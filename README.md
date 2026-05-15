# claude-cron

A single Cloudflare Worker (`scheduled()` only — no `fetch()`, no web endpoint, no bot, no auth) plus a D1 database. Runs versioned watch/digest jobs on a daily cron and emails the user when something fires. The control plane is a human talking to a Claude that can reach their Cloudflare.

## Install

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/SashaXaumi/claude-cron)

One click → Cloudflare forks this repo into your GitHub, auto-provisions a fresh D1, and deploys the Worker. Then point a Claude at your forked repo and it will apply the schema, walk you through setting four secrets in the Cloudflare dashboard, and verify the first email fires. **No terminal required.**

## For a Claude reading this repo

- **Helping a user finish setting up Claude-Cron after they clicked the deploy button?** Read [CLAUDE/claude-cron-GUIDE.md](CLAUDE/claude-cron-GUIDE.md) first. It is the setup procedure for the post-deploy phase.
- **Helping a user manage an existing Claude-Cron deployment** (add/edit/cancel jobs, answer "what did cron find about X")? Read the manifest row (`config` version 0) in that user's D1 first, then [CLAUDE/claude-cron-CLAUDE.md](CLAUDE/claude-cron-CLAUDE.md) for the operating conventions.
- **Building or modifying Claude-Cron itself?** Read [CLAUDE/claude-cron-SPEC.md](CLAUDE/claude-cron-SPEC.md) (authoritative schema, Worker, resolvers) and [CLAUDE/claude-cron-PLAN.md](CLAUDE/claude-cron-PLAN.md) (build order). [CLAUDE/claude-cron-CLAUDE.md](CLAUDE/claude-cron-CLAUDE.md) governs both audiences and lists the hard invariants.

## For a human

Click the **Deploy to Cloudflare** button above. It forks this repo into your GitHub, auto-provisions a D1, and deploys the Worker — about 60 seconds. Then open a Claude conversation, paste your forked repo URL, and say *"please finish setting up this Claude-Cron deployment for me."* Claude reads the guide, applies the schema, walks you through Resend/Anthropic prerequisites and the four dashboard secrets, drops a test job, and confirms the first email lands. The setup guide is written to be read by a Claude, not by you — you just talk to it.

Installing creates a personal fork of the source in your GitHub. Upstream changes don't auto-flow to you; if you want them, you pull or re-fork.

## Repo layout

```
src/                          Worker source (scheduled only)
schema.sql                    Full D1 schema + manifest row template (two-pass)
wrangler.toml                 Worker config (D1 binding declared without id -- enables auto-provisioning)
CLAUDE/                       The docs that govern this project
  claude-cron-GUIDE.md          post-deploy setup procedure (read by a helping Claude)
  claude-cron-SPEC.md           authoritative: schema, Worker, resolvers
  claude-cron-CLAUDE.md         hard rules, invariants, boundary rule
  claude-cron-PLAN.md           build order (for someone implementing this)
  claude-cron-EMAIL.md          email body formatting (text + HTML, watch citations, digest Markdown)
```

## The boundary rule

A Claude-Cron D1 database contains **only** Claude-Cron's own tables. Managing Claude-Cron scopes a Claude session to that database — not to the rest of the Cloudflare account. This is the single most important rule in the project.
