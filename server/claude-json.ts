// Centralized Anthropic JSON-completion helper.
//
// The codebase has ~15 inline `fetch("https://api.anthropic.com/v1/messages")`
// call sites, each re-implementing headers + response extraction. This is the
// single reusable text/JSON entry point used by the static-rate engine; new
// callers should prefer it over copy-pasting the fetch block.

export type ClaudeJsonResult<T> =
  | { ok: true; data: T; raw: string }
  | { ok: false; error: string; raw?: string };

const ANTHROPIC_VERSION = "2023-06-01";

// Pull the first text block out of an Anthropic messages response.
function extractText(data: any): string | null {
  const content = data?.content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text as string);
  return parts.length ? parts.join("\n") : null;
}

// Strip ```json … ``` fences and grab the outermost JSON object/array so a
// chatty model that wraps its JSON still parses.
export function parseJsonLoose<T = unknown>(text: string): T | null {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s) as T;
  } catch {
    // Fall back to the first {...} or [...] span.
    const objStart = s.indexOf("{");
    const arrStart = s.indexOf("[");
    const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
    if (start === -1) return null;
    const open = s[start];
    const close = open === "{" ? "}" : "]";
    const end = s.lastIndexOf(close);
    if (end <= start) return null;
    try {
      return JSON.parse(s.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

// Web-search-enabled completion. Declares Anthropic's server-side web_search
// tool so Claude actually searches the web (Google/OTAs) before answering, then
// returns its final text. Handles the server-side `pause_turn` (the search loop
// hit its iteration cap) by re-sending the accumulated turn up to `maxRounds`.
// Returns the concatenated text of the FINAL (end_turn) response plus the number
// of searches observed, so callers can confirm research actually happened.
export async function callClaudeWebSearchText(opts: {
  model: string;
  maxTokens: number;
  system?: string;
  prompt: string;
  maxSearches?: number;
  maxRounds?: number;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<{ ok: true; text: string; searchCount: number } | { ok: false; error: string }> {
  const key = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
  const messages: Array<{ role: "user" | "assistant"; content: any }> = [
    { role: "user", content: opts.prompt },
  ];
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: opts.maxSearches ?? 5 }];
  let searchCount = 0;
  const rounds = opts.maxRounds ?? 4;
  for (let round = 0; round < rounds; round += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: opts.maxTokens,
          ...(opts.system ? { system: opts.system } : {}),
          tools,
          messages,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, error: `Anthropic ${resp.status}: ${body.slice(0, 300)}` };
      }
      const data = await resp.json();
      const content = Array.isArray(data?.content) ? data.content : [];
      searchCount += content.filter((b: any) => b?.type === "server_tool_use" && b?.name === "web_search").length;
      if (data?.stop_reason === "pause_turn") {
        // Server-side search loop paused; echo the assistant turn back to resume.
        messages.push({ role: "assistant", content });
        continue;
      }
      const text = extractText(data);
      if (!text) return { ok: false, error: "Web-search response had no text content" };
      return { ok: true, text, searchCount };
    } catch (e: any) {
      return { ok: false, error: e?.name === "AbortError" ? "Web-search request timed out" : (e?.message ?? String(e)) };
    } finally {
      clearTimeout(timeout);
    }
  }
  return { ok: false, error: `Web search did not finish within ${rounds} rounds` };
}

// Web-search completion that returns parsed JSON (loose-parsed).
export async function callClaudeWebSearchJson<T = unknown>(opts: {
  model: string;
  maxTokens: number;
  system?: string;
  prompt: string;
  maxSearches?: number;
  maxRounds?: number;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<(ClaudeJsonResult<T> & { searchCount?: number })> {
  const res = await callClaudeWebSearchText(opts);
  if (!res.ok) return { ok: false, error: res.error };
  const parsed = parseJsonLoose<T>(res.text);
  if (parsed == null) return { ok: false, error: "Could not parse JSON from web-search response", raw: res.text };
  return { ok: true, data: parsed, raw: res.text, searchCount: res.searchCount };
}

export async function callClaudeText(opts: {
  model: string;
  maxTokens: number;
  system?: string;
  prompt: string;
  temperature?: number;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const key = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: "user", content: opts.prompt }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, error: `Anthropic ${resp.status}: ${body.slice(0, 300)}` };
    }
    const data = await resp.json();
    const text = extractText(data);
    if (!text) return { ok: false, error: "Anthropic response had no text content" };
    return { ok: true, text };
  } catch (e: any) {
    return { ok: false, error: e?.name === "AbortError" ? "Anthropic request timed out" : (e?.message ?? String(e)) };
  } finally {
    clearTimeout(timeout);
  }
}

// Text completion that returns parsed JSON (loose-parsed to tolerate fences /
// prose). Returns a discriminated result so callers can fall back cleanly when
// the key is missing, the request errors, or the model returns unparseable text.
export async function callClaudeJson<T = unknown>(opts: {
  model: string;
  maxTokens: number;
  system?: string;
  prompt: string;
  temperature?: number;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<ClaudeJsonResult<T>> {
  const res = await callClaudeText(opts);
  if (!res.ok) return { ok: false, error: res.error };
  const parsed = parseJsonLoose<T>(res.text);
  if (parsed == null) return { ok: false, error: "Could not parse JSON from Anthropic response", raw: res.text };
  return { ok: true, data: parsed, raw: res.text };
}
