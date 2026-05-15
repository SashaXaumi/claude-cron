// Anthropic call wrapper with the web_search server tool.
// Used by both resolvers. Callers decide what counts as a valid response
// and we retry once on parser failure (per SPEC failure table).

import Anthropic from "@anthropic-ai/sdk";

export interface CallArgs {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  maxWebSearches?: number;
}

// Single Anthropic call with the web_search tool. Returns concatenated text
// from all text content blocks in the final response. Throws on any error
// (network, API, empty response).
export async function callWithWebSearch(args: CallArgs): Promise<string> {
  const client = new Anthropic({ apiKey: args.apiKey });

  // web_search is a server-side tool; the SDK 0.40.x types don't model it
  // natively, so we cast. The API accepts this shape.
  const res = await client.messages.create({
    model: args.model,
    max_tokens: args.maxTokens ?? 4096,
    system: args.system,
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: args.maxWebSearches ?? 5,
      } as unknown as Anthropic.Messages.Tool,
    ],
    messages: [{ role: "user", content: args.user }],
  });

  // Pull every text block out of the final assistant message and join.
  // (Other block types -- server_tool_use, web_search_tool_result -- are ignored.)
  const text = res.content
    .filter(
      (b): b is Anthropic.Messages.TextBlock =>
        (b as { type: string }).type === "text",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("anthropic: empty text response");
  }
  return text;
}

// Helper: call + parse with one retry on parser failure.
// Per SPEC failure table: "Malformed resolver JSON -> one retry -> then per
// the rules above" (watch: not resolved; digest: skip).
export async function callAndParse<T>(
  args: CallArgs,
  parse: (text: string) => T,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callWithWebSearch(args);
      return parse(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
