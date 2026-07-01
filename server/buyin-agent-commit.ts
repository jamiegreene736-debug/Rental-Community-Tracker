// ─────────────────────────────────────────────────────────────────────────────
// Cowork buy-in engine — the COMMIT chokepoint (plan §3 propose_attach + §4 guards).
//
// The agent PROPOSES (which listing + price + bedrooms + evidence); the server
// COMMITS. Every commit during an agent run flows through proposeAttach(), which:
//   1. profit gate on the RUNNING committed total (over-loss → record loss, refuse)
//   2. ground-floor requirement → needs a server-verifiable snippet, not a boolean
//   3. coords → SERVER-derived only; the agent's coords are never trusted for the
//      walkability "Geo:" marker the attach proximity gate reads
//   4. photo URLs → format-validated (and best-effort reachability) before they
//      reach the notes marker
//   5. attachPick (the existing chokepoint) → bedroom/verified/dedup + the attach
//      route's proximity gate, all server-enforced and unbypassable.
//
// proposeAttach runs ENTIRELY off the per-run CoworkDeps registered by
// runCoworkAutoFillJob, so it is fully unit-testable with a stub attachPick.
// ─────────────────────────────────────────────────────────────────────────────

import type { AutoFillJob, AttachStage, LiveCandidate } from "./auto-fill-job";
import type { CoworkDeps } from "./auto-fill-cowork";

type CommitContext = { job: AutoFillJob; deps: CoworkDeps };
const commitContexts = new Map<string, CommitContext>();

export function registerCommitContext(jobId: string, ctx: CommitContext): void {
  commitContexts.set(jobId, ctx);
}
export function getCommitContext(jobId: string): CommitContext | null {
  return commitContexts.get(jobId) ?? null;
}
export function unregisterCommitContext(jobId: string): void {
  commitContexts.delete(jobId);
}

// BUYIN_ALLOW_LOSS (operator 2026-06-27): when on, the cowork engine attaches the
// cheapest VALID combo even if it's over the profit cap (a displaced guest must be
// rehoused). Only affects the AGENT path — the legacy ladder's gate is untouched.
// Default off. Read at call time so a Railway env flip takes effect without a deploy.
export function buyInAllowLoss(): boolean {
  const v = String(process.env.BUYIN_ALLOW_LOSS ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// ── pure guard: ground-floor evidence (plan §4) ──────────────────────────────
// A boolean "confirmed" is something the agent could assert. Require a quoted
// listing-text snippet that actually names a ground-floor signal, of non-trivial
// length, so it's spot-checkable (and can be re-fetched against the source later).
const GROUND_FLOOR_RE =
  /\b(ground[- ]?floor|ground[- ]?level|first[- ]?floor|street[- ]?level|garden[- ]?level|single[- ]?(?:level|story|storey)|no\s+stairs|step[- ]?free|walk[- ]?in|lanai[- ]?level)\b/i;

export function validateGroundFloorEvidence(snippet: string | null | undefined): {
  ok: boolean;
  status: "confirmed" | "unconfirmed";
  evidence: string | null;
  reason?: string;
} {
  const s = String(snippet ?? "").trim();
  if (s.length < 12) return { ok: false, status: "unconfirmed", evidence: null, reason: "no ground-floor evidence snippet" };
  if (!GROUND_FLOOR_RE.test(s)) {
    return { ok: false, status: "unconfirmed", evidence: s.slice(0, 200), reason: "snippet does not name a ground-floor signal" };
  }
  return { ok: true, status: "confirmed", evidence: s.slice(0, 200) };
}

// ── pure guard: photo URLs (plan §4) ─────────────────────────────────────────
// Keep only well-formed http(s) URLs (image-ish), deduped + capped, before they
// reach the buy-in notes "Manual photo URLs:" marker. A best-effort reachability
// check (filterReachablePhotoUrls) runs on top in the live path.
export function sanitizePhotoUrls(urls: Array<string | null | undefined>, cap = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls ?? []) {
    const u = String(raw ?? "").trim();
    if (!/^https?:\/\/\S+$/i.test(u)) continue;
    let host = "";
    try { host = new URL(u).hostname.toLowerCase(); } catch { continue; }
    if (!host) continue;
    const key = u.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
    if (out.length >= cap) break;
  }
  return out;
}

// Best-effort HEAD reachability — drops URLs that clearly 404/error; fails OPEN on a
// network blip (keeps the URL) so a transient outage doesn't strip legit photos.
export async function filterReachablePhotoUrls(urls: string[], timeoutMs = 4000): Promise<string[]> {
  const checks = await Promise.all(urls.map(async (u) => {
    try {
      const res = await fetch(u, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
      // Definite 4xx/5xx → drop; anything else (200/redirect/opaque) → keep.
      if (res.status >= 400) return null;
      return u;
    } catch {
      return u; // fail open on network error
    }
  }));
  return checks.filter((u): u is string => !!u);
}

// ── coord resolution (plan §4) ───────────────────────────────────────────────
// SERVER-derived coords only — the agent's coords are never trusted for the
// authoritative "Geo:" walkability marker. The resolver is injectable so tests can
// supply deterministic coords (or none). The default returns null until the sidecar
// re-derivation is wired (Phase 3, for combos — single-unit attaches don't gate on
// walkability anyway).
export type CoordResolver = (url: string) => Promise<{ lat: number; lng: number } | null>;
let coordResolver: CoordResolver = async () => null;
export function setCoordResolver(fn: CoordResolver): void { coordResolver = fn; }
export function __resetCoordResolverForTests(): void { coordResolver = async () => null; }

// ── proposeAttach ────────────────────────────────────────────────────────────
export type AttachProposalPick = {
  unitId: string;
  url: string;
  title: string;
  totalPrice: number;
  bedrooms?: number;
  source?: string; // "vrbo" | "airbnb" | "booking" | "hometogo" | "pm" | ...
  sourceLabel?: string;
  groundFloorEvidence?: string; // snippet (required for a ground-floor slot)
  photos?: string[];
  comboLabel?: string;
  sourceCity?: string;
  stage?: AttachStage;
};

export type ProposeAttachInput = {
  jobId: string;
  picks: AttachProposalPick[];
};

export type ProposeAttachResult = {
  ok: boolean;
  reason?: string;
  // profit verdict for the proposed combo (sum of picks vs running committed total)
  profit?: number;
  acceptable?: boolean;
  // per-pick attach outcomes
  attached: Array<{ unitId: string; attached: boolean; reason?: string }>;
};

export async function proposeAttach(input: ProposeAttachInput): Promise<ProposeAttachResult> {
  const ctx = getCommitContext(input.jobId);
  if (!ctx) return { ok: false, reason: "no live agent run for this job (expired or not registered)", attached: [] };
  const { job, deps } = ctx;
  const picks = Array.isArray(input.picks) ? input.picks : [];
  if (picks.length === 0) return { ok: false, reason: "no picks proposed", attached: [] };

  // Resolve each pick to its slot up front; reject unknown / already-filled slots.
  const resolved: Array<{ pick: AttachProposalPick; slot: AutoFillJob["slots"][number] }> = [];
  for (const pick of picks) {
    const slot = job.slots.find((s) => s.unitId === pick.unitId);
    if (!slot) return { ok: false, reason: `unknown slot ${pick.unitId}`, attached: [] };
    if (job.attached.some((a) => a.unitId === slot.unitId)) {
      return { ok: false, reason: `slot ${pick.unitId} already filled`, attached: [] };
    }
    resolved.push({ pick, slot });
  }

  // 1. PROFIT GATE on the running committed total + the SUM of these picks.
  // Default: an over-loss proposal is recorded as a loss option and REFUSED (never
  // attached) — identical to the legacy gate.
  // BUYIN_ALLOW_LOSS mode (operator 2026-06-27): the engine ATTACHES the cheapest
  // VALID combo even at a loss (a displaced guest must be rehoused), recording the
  // economics so the loss is visible on the booking but NOT refusing. Only the PROFIT
  // rule is dropped — every structural guard below (bedrooms, ground-floor snippet,
  // walkability/proximity, dedup) still applies.
  const comboCost = resolved.reduce((s, r) => s + (Number(r.pick.totalPrice) || 0), 0);
  const verdict = deps.gate(comboCost);
  const label = resolved.map((r) => `${r.slot.bedrooms}BR`).join(" + ");
  if (!verdict.acceptable) {
    if (!buyInAllowLoss()) {
      deps.recordEconomics("home-city", `Agent proposal ${label}`, comboCost, verdict.profit, false, "over the $100 max-loss cap");
      deps.recordLossComboOption(
        `Agent: ${label}`,
        { picks: resolved.map((r) => ({ bedrooms: r.slot.bedrooms, url: r.pick.url, title: r.pick.title, totalPrice: r.pick.totalPrice })) },
        comboCost,
        verdict.profit,
        { scopeCategory: "home" },
      );
      return { ok: true, acceptable: false, profit: verdict.profit, reason: "profit gate: over the $100 max-loss cap", attached: [] };
    }
    // Loss allowed: record the loss for visibility, then fall through to attach.
    deps.recordEconomics("home-city", `Agent proposal ${label} (attached at a loss)`, comboCost, verdict.profit, true, "BUYIN_ALLOW_LOSS: cheapest valid combo attached despite a projected loss");
  }

  // Coords only matter for a multi-unit combo (walkability between picks). A
  // single-unit attach never gates on walkability, so skip the (expensive) server
  // coord re-derivation there.
  const resolveCoords = resolved.length >= 2;

  // Build + attach each pick through the chokepoint.
  const attached: ProposeAttachResult["attached"] = [];
  for (const { pick, slot } of resolved) {
    // 2. GROUND-FLOOR guard (server-verifiable snippet, not a boolean).
    const needsGroundFloor = job.groundFloorBedrooms.has(slot.bedrooms);
    let groundFloorStatus = "unknown";
    let groundFloorEvidence: string | null = null;
    if (needsGroundFloor) {
      const gf = validateGroundFloorEvidence(pick.groundFloorEvidence);
      if (!gf.ok) { attached.push({ unitId: slot.unitId, attached: false, reason: gf.reason }); continue; }
      groundFloorStatus = gf.status;
      groundFloorEvidence = gf.evidence;
    } else if (pick.groundFloorEvidence) {
      const gf = validateGroundFloorEvidence(pick.groundFloorEvidence);
      if (gf.ok) { groundFloorStatus = "confirmed"; groundFloorEvidence = gf.evidence; }
    }

    // 3. COORDS — server-derived only (agent coords ignored for the trusted marker).
    const serverCoords = resolveCoords ? await coordResolver(pick.url).catch(() => null) : null;

    // 4. PHOTOS — format-validate, then best-effort reachability.
    const photos = await filterReachablePhotoUrls(sanitizePhotoUrls(pick.photos ?? []));

    const candidate: LiveCandidate = {
      source: pick.source || "vrbo",
      sourceLabel: pick.sourceLabel || pick.source || "Vrbo",
      title: pick.title || "Buy-in unit",
      url: pick.url,
      nightlyPrice: job.nights > 0 ? Math.round((Number(pick.totalPrice) || 0) / job.nights) : (Number(pick.totalPrice) || 0),
      totalPrice: Number(pick.totalPrice) || 0,
      bedrooms: typeof pick.bedrooms === "number" ? pick.bedrooms : slot.bedrooms,
      lat: serverCoords?.lat ?? null,
      lng: serverCoords?.lng ?? null,
      images: photos,
      // The agent IS the verification (it browsed the priced listing); attachPick's
      // dedup + the attach-route proximity gate are the server-side backstops.
      verified: "yes",
      groundFloorStatus,
      groundFloorEvidence,
    };

    const ok = await deps.attachPick({
      job,
      base: deps.base,
      slot,
      pick: candidate,
      searchedBedrooms: slot.bedrooms,
      used: deps.used,
      stage: pick.stage ?? "home-city",
      comboLabel: pick.comboLabel,
      sourceCity: pick.sourceCity,
    });
    attached.push({ unitId: slot.unitId, attached: ok, reason: ok ? undefined : "attach rejected by server guard (see job.skipped)" });
  }

  // `acceptable` reflects the PROFIT verdict honestly (false in a BUYIN_ALLOW_LOSS
  // attach); `attached` tells whether the picks were committed.
  return { ok: true, acceptable: verdict.acceptable, profit: verdict.profit, attached };
}
