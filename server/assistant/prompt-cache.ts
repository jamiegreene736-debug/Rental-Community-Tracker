// Prompt-caching helpers for the assistant (pure — no DB/network imports so the
// test suite can verify the cache structure without a database).
//
// The system prompt + ~17 tool defs are large and identical on every turn within
// a session, so we mark them cache-eligible (ephemeral, ~5min TTL). The cache
// breakpoint goes on the system block AND the last tool def, so both the system
// text and the whole tools array are cached. This cuts input-token cost/latency
// on multi-turn conversations. Set ASSISTANT_PROMPT_CACHE=0 to disable.
// (anthropic-version 2023-06-01 supports prompt caching GA.)

export const PROMPT_CACHE = process.env.ASSISTANT_PROMPT_CACHE !== "0";

export function cacheSystem(text: string): unknown {
  if (!PROMPT_CACHE) return text;
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

export function cacheTools(defs: Record<string, unknown>[]): unknown[] {
  if (!PROMPT_CACHE || defs.length === 0) return defs;
  return defs.map((d, i) => (i === defs.length - 1 ? { ...d, cache_control: { type: "ephemeral" } } : d));
}
