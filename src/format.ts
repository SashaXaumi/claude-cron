// Email body formatting. Resolvers return data (JSON for watches, Markdown
// for digests); this module owns presentation.
//
// See CLAUDE/claude-cron-EMAIL.md for the formatting contract, including
// the inline-citation convention for watch summaries and the
// Markdown-as-source-of-truth rule for digests.

import { marked } from "marked";
import type { JobRow } from "./db";
import type { WatchResult } from "./resolvers/watch";

export interface EmailBodies {
  subject: string;
  text: string;
  html: string;
}

// --------- watch ----------------------------------------------------------

export function formatWatchEmail(
  job: JobRow,
  result: WatchResult,
): EmailBodies {
  const subject = `Resolved: ${job.nl_request}`;
  const text = buildWatchText(job, result);
  const html = buildWatchHtml(job, result);
  return { subject, text, html };
}

function buildWatchText(job: JobRow, result: WatchResult): string {
  // Plain-text fallback: blank lines between sections so even clients that
  // collapse single newlines stay legible.
  const sourcesLines =
    result.evidence.length === 0
      ? ["(no sources)"]
      : result.evidence.map((url, i) => `[${i + 1}] ${url}`);

  return [
    result.summary.trim(),
    "",
    `Confidence: ${result.confidence}`,
    "",
    "Sources:",
    ...sourcesLines,
    "",
    "—",
    "",
    `Watch: ${job.nl_request}`,
    `Resolved query: ${job.resolved_query}`,
  ].join("\n");
}

function buildWatchHtml(job: JobRow, result: WatchResult): string {
  const citedSummary = renderInlineCitations(result.summary, result.evidence.length);
  const sources =
    result.evidence.length === 0
      ? '<li style="color:#888">(no sources provided)</li>'
      : result.evidence
          .map(
            (url, i) =>
              `<li id="s${i + 1}"><a href="${escapeAttr(url)}" style="color:#0366d6;text-decoration:none">${escapeText(
                domainOf(url),
              )}</a></li>`,
          )
          .join("\n      ");

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#222;max-width:640px;margin:24px auto;padding:0 16px">
  <h2 style="font-size:20px;margin:0 0 16px">Resolved</h2>
  <p style="font-size:17px;line-height:1.55;margin:0 0 16px">${citedSummary}</p>
  <p style="color:#888;font-size:13px;margin:0 0 24px">Confidence: ${escapeText(String(result.confidence))}</p>
  <h3 style="font-size:14px;color:#444;margin:24px 0 8px;font-weight:600">Sources</h3>
  <ol style="font-size:14px;line-height:1.6;margin:0;padding-left:20px">
    ${sources}
  </ol>
  <hr style="border:0;border-top:1px solid #eee;margin:32px 0">
  <p style="color:#999;font-size:12px;margin:0">
    Watch: ${escapeText(job.nl_request)}<br>
    Resolved query: ${escapeText(job.resolved_query)}
  </p>
</body></html>`;
}

// Turn `[1]`, `[2]` markers in the (HTML-escaped) summary into superscript
// anchor links. If the index is out of range for the evidence array, leave
// the literal `[N]` in place rather than producing a broken link.
//
// Permissive on legacy summaries that don't contain markers: the result is
// just the escaped summary with no anchors, which still renders correctly.
function renderInlineCitations(summary: string, evidenceCount: number): string {
  const escaped = escapeText(summary.trim());
  return escaped.replace(/\[(\d+)\]/g, (match, n: string) => {
    const idx = parseInt(n, 10);
    if (idx < 1 || idx > evidenceCount) return match;
    return `<sup><a href="#s${idx}" style="color:#0366d6;text-decoration:none">[${idx}]</a></sup>`;
  });
}

// --------- digest ---------------------------------------------------------

export function formatDigestEmail(job: JobRow, body: string): EmailBodies {
  const subject = `Digest: ${job.nl_request}`;
  // Text fallback: the raw Markdown is already readable as plaintext.
  const text = body.trim();
  const html = buildDigestHtml(job, body);
  return { subject, text, html };
}

function buildDigestHtml(job: JobRow, body: string): string {
  // marked is configured with defaults (GFM-ish, no breaks). The resolver
  // prompt forbids JSON / code fences / raw HTML, but if any slips through
  // we still let marked handle it -- the recipient is the user themselves,
  // so there's no XSS surface to worry about.
  const rendered = marked.parse(body, { async: false }) as string;
  const dateLabel = new Date().toISOString().slice(0, 10);

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#222;max-width:640px;margin:24px auto;padding:0 16px">
  <h2 style="font-size:20px;margin:0 0 4px">Digest: ${escapeText(job.nl_request)}</h2>
  <p style="color:#888;font-size:13px;margin:0 0 20px">${escapeText(dateLabel)}</p>
  <div style="font-size:16px;line-height:1.6">${rendered}</div>
  <hr style="border:0;border-top:1px solid #eee;margin:32px 0">
  <p style="color:#999;font-size:12px;margin:0">
    Digest: ${escapeText(job.nl_request)}<br>
    Schedule: ${escapeText(job.schedule)}
  </p>
</body></html>`;
}

// --------- utilities ------------------------------------------------------

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  // Same as escapeText for our purposes -- URLs in href attributes need
  // angle brackets and quotes escaped.
  return escapeText(s);
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // If it's not a parseable URL, show the raw string (truncated).
    return url.slice(0, 60);
  }
}
