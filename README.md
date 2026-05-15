# claude-cron

A single Cloudflare Worker (`scheduled()` only — no `fetch()`, no web endpoint, no bot, no auth) plus a D1 database. Runs versioned watch/digest jobs on a daily cron and emails the user when something fires. The control plane is a human talking to a Claude that can reach their Cloudflare.

## For a Claude reading this repo

- **Helping a user set up Claude-Cron in their own Cloudflare account?** Read [CLAUDE/claude-cron-GUIDE.md](CLAUDE/claude-cron-GUIDE.md) first. It is the setup procedure.
- **Helping a user manage an existing Claude-Cron deployment** (add/edit/cancel jobs, answer "what did cron find about X")? Read the manifest row (`config` version 0) in that user's D1 first, then [CLAUDE/claude-cron-CLAUDE.md](CLAUDE/claude-cron-CLAUDE.md) for the operating conventions.
- **Building or modifying Claude-Cron itself?** Read [CLAUDE/claude-cron-SPEC.md](CLAUDE/claude-cron-SPEC.md) (authoritative schema, Worker, resolvers) and [CLAUDE/claude-cron-PLAN.md](CLAUDE/claude-cron-PLAN.md) (build order). [CLAUDE/claude-cron-CLAUDE.md](CLAUDE/claude-cron-CLAUDE.md) governs both audiences and lists the hard invariants.

## For a human

You probably want to point a Claude at this repo and ask it to set it up for you. The setup guide is written to be read by a Claude, not by you.

## Repo layout

```
src/                          Worker source (scheduled only)
schema.sql                    Full D1 schema + manifest row
wrangler.toml                 Worker config (database_id is a placeholder)
CLAUDE/                       The four docs that govern this project
  claude-cron-GUIDE.md          setup procedure (read by a helping Claude)
  claude-cron-SPEC.md           authoritative: schema, Worker, resolvers
  claude-cron-CLAUDE.md         hard rules, invariants, boundary rule
  claude-cron-PLAN.md           build order (for someone implementing this)
```

## The boundary rule

A Claude-Cron D1 database contains **only** Claude-Cron's own tables. Managing Claude-Cron scopes a Claude session to that database — not to the rest of the Cloudflare account. This is the single most important rule in the project.
