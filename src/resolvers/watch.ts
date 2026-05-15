// Watch resolver. The sharpest correctness problem in the system.
//
// A false "it happened" poisons the one notification this watch exists for.
// Under-firing is safe. False-firing is not. So this resolver is conservative
// by construction -- both the system prompt and the post-parse guard apply
// independent pressure toward NOT resolved.

import { callAndParse } from "../anthropic";
import type { JobRow } from "../db";

export interface WatchResult {
  resolved: boolean;
  confidence: number;
  evidence: string[];
  summary: string;
}

// Hardcoded floor. Even if the model returns resolved=true with low
// confidence, we treat it as not resolved. Belt + suspenders against
// over-eager judgments.
export const MIN_CONFIDENCE_TO_FIRE = 0.9;

const DEFAULT_WATCH_PROMPT = `You are a CONSERVATIVE event watcher. The user has set up a watch on a
specific condition. Determine, from web evidence, whether the condition
has been resolved.

CRITICAL: bias HARD toward NOT resolved.
- A rumor, leak, "according to insiders," speculative reporting -> NOT resolved.
- A clickbait or sensational headline without confirmation from a credible
  source -> NOT resolved.
- A single source making a claim that is not corroborated -> NOT resolved.
- If you are uncertain whether it has actually happened -> NOT resolved.

Only return resolved=true when:
- Multiple credible, independent sources confirm the event.
- The confirmation is unambiguous (not a hedge, not a tease).
- You have high confidence (>= 0.9).

A false "it happened" is the worst possible outcome -- it poisons the one
notification this watch exists for. Under-firing is safe.

OUTPUT: a single JSON object on its own, no prose, no code fences:
{
  "resolved":  true | false,
  "confidence": 0.0-1.0,
  "evidence":  ["url1", "url2", "..."],
  "summary":   "Two to four sentences. Inline-cite each non-trivial claim using [1], [2], etc., where the bracketed number refers to the corresponding source in the evidence array (citation [1] refers to evidence[0], [2] to evidence[1], and so on). Cite in reading order. Do not list URLs in the summary itself."
}`;

export async function runWatch(
  args: {
    apiKey: string;
    model: string;
    defaultPrompt: string | null;
  },
  job: JobRow,
): Promise<WatchResult> {
  const system =
    job.resolver_prompt ?? args.defaultPrompt ?? DEFAULT_WATCH_PROMPT;
  const user = `Watch condition:\n${job.resolved_query}\n\nReturn the JSON object now.`;

  const raw = await callAndParse(
    {
      apiKey: args.apiKey,
      model: args.model,
      system,
      user,
      maxTokens: 2048,
      maxWebSearches: 5,
    },
    parseWatchJson,
  );

  // Post-parse guard: enforce the confidence floor independently of the
  // model. If the model claims resolved=true with low confidence, downgrade.
  if (raw.resolved && raw.confidence < MIN_CONFIDENCE_TO_FIRE) {
    return { ...raw, resolved: false };
  }
  return raw;
}

function parseWatchJson(text: string): WatchResult {
  // Strip surrounding code fences if the model added them despite instructions.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Find the first { and the last } -- tolerate a bit of leading prose if any.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("watch: no JSON object found in response");
  }
  const json = cleaned.slice(start, end + 1);

  const obj = JSON.parse(json) as unknown;
  if (typeof obj !== "object" || obj === null) {
    throw new Error("watch: response is not an object");
  }
  const rec = obj as Record<string, unknown>;

  if (typeof rec.resolved !== "boolean") {
    throw new Error("watch: missing/invalid `resolved`");
  }
  if (
    typeof rec.confidence !== "number" ||
    !Number.isFinite(rec.confidence) ||
    rec.confidence < 0 ||
    rec.confidence > 1
  ) {
    throw new Error("watch: missing/invalid `confidence`");
  }
  if (
    !Array.isArray(rec.evidence) ||
    rec.evidence.some((e) => typeof e !== "string")
  ) {
    throw new Error("watch: missing/invalid `evidence`");
  }
  if (typeof rec.summary !== "string") {
    throw new Error("watch: missing/invalid `summary`");
  }

  return {
    resolved: rec.resolved,
    confidence: rec.confidence,
    evidence: rec.evidence as string[],
    summary: rec.summary,
  };
}
