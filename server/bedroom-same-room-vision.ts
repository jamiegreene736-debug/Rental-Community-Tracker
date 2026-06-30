// Vision pass: group bedroom cluster representatives by PHYSICAL ROOM, so two
// angles of one bedroom (the bed head-on + the same room's TV/dresser wall) are
// recognised as the same room instead of counting as two bedrooms.
//
// Why this exists: dHash clustering can't tell "different angle of one room" from
// "different room", and the scrape labeler captions each photo independently
// ("King Bedroom", "Bedroom With TV") so the caption merges miss it. A vision
// model reading the actual pixels is the reliable signal — see
// shared/bedroom-same-room-logic.ts for the pure parse/merge glue this wraps.
//
// Conservative by construction: uses Sonnet (Haiku was empirically unreliable on
// fine-grained "same space?" judgements — see server/unit-photo-vision.ts), the
// prompt demands proven shared features before merging, and any malformed/partial
// response folds to "no merge". Returns null (no-op) when disabled or keyless.

import { parseSameRoomGroups } from "../shared/bedroom-same-room-logic";

// Sonnet, not Haiku, on purpose: telling "same room, other angle" from "similar
// but different bedroom" is exactly the fine visual-reasoning task Haiku flaked
// on in unit-photo-vision.ts. A false merge collapses two real bedrooms into one,
// so reliability beats speed for the one call per replace/relabel.
const MODEL = "claude-sonnet-4-6";

// Above this many cluster representatives the single-call grouping is both
// expensive and unreliable (a unit with 12+ distinct bedroom clusters is almost
// never all-the-same-room), so we skip the fold entirely — fail-safe = no merge.
const MAX_REPS = (() => {
  const n = Number(process.env.BEDROOM_SAME_ROOM_MAX_REPS);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 12;
})();

export type SameRoomRep = {
  id: string;
  mime: string;
  base64: string;
  caption?: string;
};

function buildPrompt(ids: string[]): string {
  return [
    "Each numbered slot above is ONE photo. Every photo is a BEDROOM inside a single vacation-rental unit.",
    "Some photos may be the SAME physical bedroom shot from a different angle — e.g. one photo shows the bed head-on, another shows the foot of the same bed with a TV, dresser, or doorway.",
    "",
    "Group the photos by PHYSICAL ROOM.",
    "Put two photos in the SAME group ONLY when you can point to concrete SHARED features proving it is one space — the same headboard/bedding, the same window and the same outside view, the same wall art, the same flooring AND the same furniture layout.",
    "",
    "Be conservative. Two photos sharing the same BED TYPE (two king rooms, two queen rooms) are usually DIFFERENT bedrooms — bed size alone is NOT evidence of the same room. If two photos merely look similar (same bed size, generic resort decor) but you cannot prove they are the same room, put them in SEPARATE groups.",
    "Merging two DIFFERENT bedrooms into one group is a serious error; leaving one room split across two groups is acceptable.",
    "",
    `There are ${ids.length} photos: ${ids.join(", ")}. Every photo id must appear in exactly one group.`,
    "",
    "Respond with ONLY minified JSON, no prose, no code fences:",
    '{"rooms":[{"ids":["' + (ids[0] ?? "BR1") + '"]}]}',
  ].join("\n");
}

/**
 * Ask the vision model which representatives are the same physical bedroom.
 * Returns a partition of the rep ids (arrays of ids) or null on any failure /
 * disabled / keyless / malformed response — callers treat null as "no merge".
 */
export async function groupSameBedroomsViaVision(
  reps: SameRoomRep[],
  opts: { apiKey?: string; model?: string } = {},
): Promise<string[][] | null> {
  if (process.env.BEDROOM_SAME_ROOM_VISION_DISABLED === "1") return null;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey || reps.length < 2) return null;
  if (reps.length > MAX_REPS) {
    console.warn(`[bedroom-same-room] ${reps.length} representatives exceeds cap ${MAX_REPS} — skipping same-room fold`);
    return null;
  }

  // Captions are deliberately NOT sent: the scrape labeler emits bed-type-only
  // captions ("King Bedroom"), so two DISTINCT king rooms carry identical text
  // that would nudge the model toward a false merge. This pass is purely visual.
  const ids = reps.map((r) => r.id);
  const content: any[] = [];
  for (const r of reps) {
    content.push({ type: "text", text: `--- Photo ${r.id} ---` });
    content.push({ type: "image", source: { type: "base64", media_type: r.mime, data: r.base64 } });
  }
  content.push({ type: "text", text: buildPrompt(ids) });

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: opts.model ?? MODEL,
        // Roomy enough to hold an all-separate partition of MAX_REPS ids + a
        // little slack, so a large folder never truncates into invalid JSON.
        max_tokens: 1024,
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn(`[bedroom-same-room] HTTP ${resp.status} ${body.slice(0, 200)}`);
      return null;
    }
    const data = (await resp.json()) as any;
    const text: string = data?.content?.[0]?.text ?? "";
    const parsed = parseSameRoomGroups(text, ids);
    if (parsed == null) {
      // Got a response but it wasn't a clean partition — log so the no-op is
      // observable rather than a silent skip during triage.
      console.warn(`[bedroom-same-room] rejected non-partition response for ${ids.length} reps: ${text.slice(0, 160)}`);
    }
    return parsed;
  } catch (e: any) {
    console.warn(`[bedroom-same-room] ${e?.message ?? e}`);
    return null;
  }
}
