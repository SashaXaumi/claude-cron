# EMAIL — Claude-Cron

How outgoing email is formatted. Narrowly scoped on purpose: email layout will iterate, and the four core docs (`GUIDE` / `SPEC` / `CLAUDE` / `PLAN`) shouldn't have to move every time it does.

## The separation rule (most important thing here)

**Resolvers return data. The Worker owns presentation.**

- The **watch** resolver returns JSON: `{ resolved, confidence, evidence, summary }`. The `summary` field carries inline `[1]`, `[2]` markers that reference indices in the `evidence` array (1-indexed in the summary; the first source is `[1]` → `evidence[0]`).
- The **digest** resolver returns Markdown — the raw email body, attributed and sourced. No HTML, no JSON wrapper.

The Worker's `src/format.ts` consumes that data and emits the final `{ subject, text, html }` trio. The renderer in `format.ts` is the only place that knows about HTML, inline styles, anchors, or `<sup>`. Prompts in `config` don't reference HTML, and templates don't reference web search.

This separation means prompt edits don't touch templates and template edits don't touch prompts.

## What goes on the wire

`src/email.ts` sends both `text` and `html` to Resend in the same call. Email clients that render HTML pick `html`; clients that don't fall back to `text`. The `messages` table logs the `text` form — `messages` is the substance log, not a presentation log.

## Watch emails

### The inline-citation contract

The watch `summary` must inline-cite each non-trivial claim with `[N]` markers referring to the `evidence` array. Indices are 1-based in the summary (`[1]`, `[2]`, …) and map to 0-based array indices (`evidence[0]`, `evidence[1]`, …). Cite in reading order. Do not list URLs in the summary itself — that's what the Sources block at the bottom is for.

This is enforced by the `watch_default` prompt in `config` version 2. Live installs that pre-date v2 will produce summaries without `[N]` markers; the renderer degrades gracefully (no anchors, but the Sources block still renders).

### HTML shape

```
<h2>Resolved</h2>
<p>{summary with [N] markers → <sup><a href="#sN">[N]</a></sup>}</p>
<p style="color:#888;font-size:13px">Confidence: 0.98</p>
<h3>Sources</h3>
<ol>
  <li id="s1"><a href="{full url}">{domain}</a></li>
  …
</ol>
<hr>
<p style="color:#999;font-size:12px">
  Watch: {nl_request}
  Resolved query: {resolved_query}
</p>
```

Anchor link text shows the **domain** (e.g. `anthropic.com`), `href` is the full URL. Domain extraction: `new URL(url).hostname` with `www.` stripped. Falls back to the raw URL (truncated) on parse failure.

In-document `id`/`href="#sN"` jumps don't work in every email client (some strip `id` attributes). The visual numbering still parses correctly when the link is non-functional: `[1]` sits next to the claim, source `[1]` sits at the bottom, the user reads the connection. Optimize for visual parse, not anchor-jump.

### Plaintext shape

```
{summary, [N] markers left literal}

Confidence: 0.98

Sources:
[1] https://full-url-1
[2] https://full-url-2

—

Watch: {nl_request}
Resolved query: {resolved_query}
```

Blank lines between sections matter — email clients that render plaintext-as-HTML collapse single newlines into spaces. The blank lines force `<br><br>`-style behavior.

## Digest emails

The digest resolver returns Markdown. The Worker passes it through `marked` (default options) to produce HTML. Plaintext fallback is the raw Markdown — already legible.

### HTML shape

```
<h2>Digest: {nl_request}</h2>
<p style="color:#888;font-size:13px">{ISO date}</p>
<div>{marked → HTML body}</div>
<hr>
<p style="color:#999;font-size:12px">
  Digest: {nl_request}
  Schedule: {schedule}
</p>
```

### Why we trust resolver output

`marked` passes raw HTML through by default. The resolver prompt forbids HTML in the digest body, but enforcement is best-effort. We accept the risk: the only recipient is the user themselves (single-recipient model, invariant #4), so there's no XSS surface. Don't bolt on DOMPurify / sanitizer middleware for this.

## What stays out

- **No CSS frameworks, no MJML, no email-template libraries.** One Worker, one cron, two job types. Inline styles in `format.ts` are enough.
- **No images, no logos, no header bars.** Claude-Cron is a personal tool; there's no brand to apply.
- **No dark-mode CSS.** Email-client dark mode handling is a rabbit hole; modern clients do reasonable auto-inversion of light-themed emails. Don't fight it.
- **No HTML in resolver output.** Resolvers return data. If you ever feel tempted to have the resolver emit `<sup>`, stop — that's the renderer's job.

## Where the code lives

- `src/format.ts` — `formatWatchEmail`, `formatDigestEmail`, the escaping/citation/domain utilities.
- `src/email.ts` — Resend POST with `text` + optional `html`.
- `src/index.ts` — calls the formatters, writes the `text` form to `messages`, sends both forms via Resend.

## Migrating an older install

A pre-v2 install will still render fine: watch summaries without `[N]` markers just appear without anchor links, and the Sources block still appears. To get inline citations without redeploying:

```sql
-- Append config v2 by hand (paste the v2 INSERT from schema.sql).
-- INSERT OR IGNORE guarantees no conflict if v2 already exists.
```

Or just re-apply `schema.sql` to the same D1 — `INSERT OR IGNORE` makes it idempotent: v0 and v1 are preserved, v2 is appended.
