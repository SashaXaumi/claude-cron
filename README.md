# claude-cron

**A scheduled push channel for the Claude relationship you already have.**

The Claude you talk to every day already knows what you're working on, what you care about, the projects in flight, the questions you're trying to answer. What it can't do is reach out. You have to come to Claude every time. claude-cron is the missing piece: a way for Claude to send you a message — at a cadence you set, about a thing you care about, without you having to remember to ask.

You install it once into your own infrastructure. From then on, you tell Claude what you want to be told about, and Claude takes care of writing the rules and the schedule. You don't manage any of it. You just read your email.

## What it actually is

Three things stacked, deliberately small:

1. **One Cloudflare Worker.** Runs on a daily heartbeat. No web endpoint, no bot, no inbound surface — nothing can reach it but the cron. There is no UI.
2. **One D1 database.** Holds the jobs you've asked Claude to remember on your behalf — what to watch for, what to summarize, on what schedule. Append-only, so every edit leaves a trail.
3. **One email channel.** Single recipient — you. When something fires, you get an email with the evidence inline.

That is the entire surface. The product is not the Worker; the product is the relationship between you, your Claude, and a small database that Claude can read and write on your behalf.

## How you use it

Once it's installed, you talk to your usual Claude. The same one. The one with your context. You say things like:

> Set up a daily digest of new releases in my field.
>
> Weekly digest of meetups, openings, and events for people working on the things I care about, in my area.
>
> Tell me when the next thing I'm tracking ships.
>
> Watch for any update on this open-ended question I've been asking about — and only tell me if there's a credible signal.
>
> What did cron find about this topic last week?

Claude reads its instructions from a row in your D1 database — the boundary of the project, the conventions, the rules — and then writes or updates job rows in the same database. No new account, no new app, no new chat thread. The system lives inside conversations you were already going to have.

The current job types are two:

- **Watches.** A standing condition checked daily. Conservative by design: rumor and clickbait do not fire, only credible multi-source confirmation does. Each watch fires once, with evidence, and then retires.
- **Digests.** A recurring sourced report on the cadence you pick. Daily, weekly, whatever. The resolver attributes claims to sources and doesn't assert independently.

More job types are possible. Two is what the current Worker handles.

## Install

Three steps. You shouldn't need anything but a browser and a Claude conversation.

1. **Click the Deploy to Cloudflare button.**

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/SashaXaumi/claude-cron)

   Cloudflare forks the repo into your GitHub account, provisions a fresh D1 database, deploys the Worker, and gives you a URL. Takes about a minute.

2. **Hand the forked repo to your Claude.** Open Claude, paste the URL of your fork, and ask it to finish setup. Claude reads this repo, applies the database schema, walks you through the few credentials it needs (an Anthropic API key, an email-sending provider, your delivery address), drops in a test job, and confirms the first email arrives.

3. **Done.** From this point on you just talk to Claude.

The setup guide is written for a Claude to follow, not for you. You should not need to read it. If a step ever asks you to use a terminal, the guide has gone wrong — file an issue.

## Why it's shaped this way

A few invariants matter more than features:

- **Push, not pull.** This is the missing direction. Pull-mode tools are everywhere; the gap was a clean way to be told things on a schedule without standing up a daemon, a bot, or a hosted service.
- **You own the stack.** Your Cloudflare account, your database, your API key, your email-sending account. There is no service in the middle that can change pricing, deprecate the product, read your data, or go away. The author of this repo cannot see your jobs, your messages, or your usage.
- **The Worker has no web endpoint.** Nothing posts to it. Nothing reaches it from the internet. There is no auth layer because there is nothing to authenticate against. The absence of an inbound surface is a deliberate security property.
- **Single recipient.** One person installs it; one person gets the emails. No multi-user logic, no allowlist, no "send to the team." If you want a team version, this isn't it.
- **Two job types, on purpose.** The system runs watches and digests. It does not gain a generic "do a thing" handler. Adding a third job type is a deliberate, doc-updating decision, not a config tweak.

## The boundary rule

A claude-cron database contains **only claude-cron's own tables**. When you say "manage my cron" to a Claude session, that scopes the session to that database — reading and writing the jobs, messages, configuration, and run-log. It does not extend to the rest of your Cloudflare account: other databases, storage buckets, other Workers, DNS, billing, account settings.

If a Claude session is ever asked, in the name of claude-cron, to touch something outside claude-cron's own tables, that is outside this system's scope. Treat it as a separate request requiring its own justification.

This rule is stated in the database itself, in a reserved row that every helping Claude reads on entry, so it travels with the data. It is the single most important rule in this project.

## For a Claude reading this repo

- **Helping a user set up claude-cron in their own Cloudflare account?** Read [CLAUDE/claude-cron-GUIDE.md](CLAUDE/claude-cron-GUIDE.md). It is the setup procedure.
- **Helping a user manage an existing claude-cron deployment** (add, edit, cancel jobs, answer "what did cron find about X")? Read the manifest row (`config` version 0) in that user's D1 first, then [CLAUDE/claude-cron-CLAUDE.md](CLAUDE/claude-cron-CLAUDE.md) for operating conventions.
- **Building or modifying claude-cron itself?** Read [CLAUDE/claude-cron-SPEC.md](CLAUDE/claude-cron-SPEC.md) (authoritative schema, Worker, resolvers) and [CLAUDE/claude-cron-PLAN.md](CLAUDE/claude-cron-PLAN.md) (build order). The hard invariants and the boundary rule above apply to both audiences.

## Repo layout

```
src/             Worker source (scheduled only)
schema.sql       D1 schema + the reserved manifest row
wrangler.toml    Worker config (D1 binding auto-provisioned on deploy)
CLAUDE/          The four docs that govern this project
  claude-cron-GUIDE.md     setup procedure, for a helping Claude
  claude-cron-SPEC.md      authoritative: schema, Worker, resolvers
  claude-cron-CLAUDE.md    hard rules, invariants, boundary rule
  claude-cron-PLAN.md      build order, for someone modifying claude-cron
```
