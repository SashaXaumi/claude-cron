// Digest resolver. Anthropic + web_search produces a sourced, attributed
// report body. Per SPEC: report FROM sources, attribute them, do NOT assert
// independently. Output is the email body -- markdown is fine.

import { callAndParse } from "../anthropic";
import type { JobRow } from "../db";

export interface DigestResult {
  body: string;
}

const DEFAULT_DIGEST_PROMPT = `You are a careful news researcher producing a digest for the user.

GUIDELINES:
- Use the web search tool to find current, sourced information on the topic.
- Report what specific sources said. Attribute claims to their source
  (publication and date when available).
- Do NOT assert facts independently. If a claim only appears in one source,
  say so.
- Cite a small number of high-quality sources. Bullet points are fine.
- If you cannot find sourced information, say so explicitly -- do not
  fabricate.
- Keep it tight: 5-12 short bullets or a few short paragraphs. No padding.

OUTPUT:
- A single readable digest body, suitable for email. Markdown is OK.
- Do NOT include JSON, code fences, or meta-commentary about the search.
- Start directly with the digest content.`;

export async function runDigest(
  args: {
    apiKey: string;
    model: string;
    defaultPrompt: string | null;
  },
  job: JobRow,
): Promise<DigestResult> {
  const system = job.resolver_prompt ?? args.defaultPrompt ?? DEFAULT_DIGEST_PROMPT;
  const user = `Topic / query:\n${job.resolved_query}\n\nProduce the digest body now.`;

  const body = await callAndParse(
    {
      apiKey: args.apiKey,
      model: args.model,
      system,
      user,
      maxTokens: 4096,
      maxWebSearches: 5,
    },
    (text) => {
      // Minimal validity check: non-empty after trim, and at least one
      // substantive line. Anything shorter is almost certainly garbage.
      const trimmed = text.trim();
      if (trimmed.length < 50) {
        throw new Error(`digest body too short (${trimmed.length} chars)`);
      }
      return trimmed;
    },
  );

  return { body };
}
