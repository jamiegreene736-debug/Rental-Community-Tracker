// Durable per-tab "last pushed to Guesty" ledger for the unit builder
// (2026-07-12). Before this, the builder tab strip's dot + timestamp came
// ONLY from per-browser localStorage (`nexstay_data_push_*`), so the operator
// lost the history on any other device and there was no summary of WHAT was
// pushed. This module holds the pure pieces:
//
//  • the app_settings `guesty_push_history.v1` store shape + parse/serialize
//    (keyed by Guesty listing id — every push endpoint knows the listing id,
//    while only some know the numeric propertyId),
//  • record/backfill mutations. BACKFILL is the retroactive path: the client
//    uploads its recent localStorage entries so pushes that happened before
//    this ledger existed still show — accepted ONLY inside the
//    GUESTY_PUSH_RETROACTIVE_HOURS window (48h) and NEVER clobbering a
//    same-or-newer server entry (client-supplied data is a trust boundary),
//  • operator-facing summary builders ("81 amenities pushed", "45 photos
//    pushed", …) so the wording is consistent + test-locked across endpoints,
//  • the Guesty-proxy write classifier: bedding + bookable pushes go through
//    the generic PUT /listings/:id proxy, and their body shapes
//    (listingRooms[] / isListed) are the only server-visible signature.
//
// Display-only feature: nothing here may ever block or fail a push.

export const GUESTY_PUSH_TABS = [
  "descriptions",
  "bedding",
  "amenities",
  "photos",
  "pricing",
  "availability",
  "bookable",
] as const;
export type GuestyPushTab = (typeof GUESTY_PUSH_TABS)[number];
export type GuestyPushStatus = "success" | "error";

export type GuestyPushEntry = {
  pushedAt: string; // ISO timestamp
  status: GuestyPushStatus;
  summary: string; // operator-facing, e.g. "81 amenities pushed"
};

export type GuestyPushListingHistory = Partial<Record<GuestyPushTab, GuestyPushEntry>>;

export type GuestyPushHistoryStore = {
  version: 1;
  listings: Record<string, { tabs: GuestyPushListingHistory; updatedAt: string }>;
};

export const GUESTY_PUSH_RETROACTIVE_HOURS = 48;
export const GUESTY_PUSH_SUMMARY_MAX_CHARS = 240;
export const GUESTY_PUSH_HISTORY_LISTING_CAP = 200;
// Small clock-skew allowance so a client whose clock runs slightly ahead can
// still backfill an entry it wrote "just now" — anything further in the
// future is rejected.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const isValidIso = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(new Date(value).getTime());

export function isGuestyPushTab(value: unknown): value is GuestyPushTab {
  return typeof value === "string" && (GUESTY_PUSH_TABS as readonly string[]).includes(value);
}

// Accepts both the server shape ({ summary }) and the builder's legacy
// localStorage shape ({ message }) so backfill candidates need no re-mapping.
export function sanitizeGuestyPushEntry(value: unknown): GuestyPushEntry | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isValidIso(v.pushedAt)) return null;
  const status = v.status === "success" || v.status === "error" ? v.status : null;
  if (!status) return null;
  const summarySource =
    typeof v.summary === "string" ? v.summary : typeof v.message === "string" ? v.message : "";
  return {
    pushedAt: new Date(v.pushedAt as string).toISOString(),
    status,
    summary: summarySource.trim().slice(0, GUESTY_PUSH_SUMMARY_MAX_CHARS),
  };
}

export function parseGuestyPushHistoryStore(raw: string | null | undefined): GuestyPushHistoryStore {
  const empty: GuestyPushHistoryStore = { version: 1, listings: {} };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<GuestyPushHistoryStore> | null;
    if (!parsed || typeof parsed !== "object" || !parsed.listings || typeof parsed.listings !== "object") {
      return empty;
    }
    const listings: GuestyPushHistoryStore["listings"] = {};
    for (const [listingId, rec] of Object.entries(parsed.listings)) {
      if (!listingId || !rec || typeof rec !== "object") continue;
      const tabsIn = (rec as { tabs?: unknown }).tabs;
      if (!tabsIn || typeof tabsIn !== "object") continue;
      const tabs: GuestyPushListingHistory = {};
      for (const [tab, entry] of Object.entries(tabsIn as Record<string, unknown>)) {
        if (!isGuestyPushTab(tab)) continue;
        const clean = sanitizeGuestyPushEntry(entry);
        if (clean) tabs[tab] = clean;
      }
      if (Object.keys(tabs).length === 0) continue;
      const updatedAtRaw = (rec as { updatedAt?: unknown }).updatedAt;
      const updatedAt = isValidIso(updatedAtRaw)
        ? new Date(updatedAtRaw).toISOString()
        : new Date(0).toISOString();
      listings[listingId] = { tabs, updatedAt };
    }
    return { version: 1, listings };
  } catch {
    return empty;
  }
}

// Evicts the least-recently-updated listings past the cap at write time so the
// app_settings blob can't grow unbounded.
export function serializeGuestyPushHistoryStore(store: GuestyPushHistoryStore): string {
  const ids = Object.keys(store.listings);
  if (ids.length > GUESTY_PUSH_HISTORY_LISTING_CAP) {
    ids
      .sort((a, b) => (store.listings[b].updatedAt || "").localeCompare(store.listings[a].updatedAt || ""))
      .slice(GUESTY_PUSH_HISTORY_LISTING_CAP)
      .forEach((id) => {
        delete store.listings[id];
      });
  }
  return JSON.stringify(store);
}

// A live push always overwrites the previous entry for its tab (the newest
// push IS the state). Returns false only for unusable input.
export function applyGuestyPushRecord(
  store: GuestyPushHistoryStore,
  listingId: string,
  tab: GuestyPushTab,
  entry: GuestyPushEntry,
  nowIso: string,
): boolean {
  const id = String(listingId ?? "").trim();
  const clean = sanitizeGuestyPushEntry(entry);
  if (!id || !clean) return false;
  const rec = store.listings[id] ?? { tabs: {}, updatedAt: nowIso };
  rec.tabs[tab] = clean;
  rec.updatedAt = nowIso;
  store.listings[id] = rec;
  return true;
}

export function guestyPushBackfillWindowOk(pushedAtIso: string, nowIso: string): boolean {
  const pushed = new Date(pushedAtIso).getTime();
  const now = new Date(nowIso).getTime();
  if (!Number.isFinite(pushed) || !Number.isFinite(now)) return false;
  if (pushed > now + FUTURE_SKEW_MS) return false;
  return now - pushed <= GUESTY_PUSH_RETROACTIVE_HOURS * 60 * 60 * 1000;
}

// Retroactive client backfill: only in-window entries, only tabs we know,
// and NEVER replacing a same-or-newer server entry.
export function applyGuestyPushBackfill(
  store: GuestyPushHistoryStore,
  listingId: string,
  entries: unknown,
  nowIso: string,
): { applied: number; rejected: number } {
  let applied = 0;
  let rejected = 0;
  const id = String(listingId ?? "").trim();
  if (!id || !entries || typeof entries !== "object") return { applied, rejected };
  for (const [tab, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!isGuestyPushTab(tab)) {
      rejected++;
      continue;
    }
    const clean = sanitizeGuestyPushEntry(value);
    if (!clean || !guestyPushBackfillWindowOk(clean.pushedAt, nowIso)) {
      rejected++;
      continue;
    }
    const existing = store.listings[id]?.tabs[tab];
    if (existing && new Date(existing.pushedAt).getTime() >= new Date(clean.pushedAt).getTime()) {
      rejected++;
      continue;
    }
    if (applyGuestyPushRecord(store, id, tab, clean, nowIso)) applied++;
    else rejected++;
  }
  return { applied, rejected };
}

// Display merge: whichever entry is newer wins; ties keep `a` (the server
// entry) so a just-backfilled duplicate doesn't flap the UI.
export function newestGuestyPushEntry(
  a: GuestyPushEntry | null | undefined,
  b: GuestyPushEntry | null | undefined,
): GuestyPushEntry | null {
  const at = a ? new Date(a.pushedAt).getTime() : NaN;
  const bt = b ? new Date(b.pushedAt).getTime() : NaN;
  const aOk = Number.isFinite(at);
  const bOk = Number.isFinite(bt);
  if (!aOk && !bOk) return null;
  if (!aOk) return b ?? null;
  if (!bOk) return a ?? null;
  return bt > at ? b! : a!;
}

// What THIS browser should upload: local entries that are in-window and
// strictly newer than what the server already has. Same acceptance rules as
// applyGuestyPushBackfill so the client never posts a doomed payload.
export function guestyPushBackfillCandidates(
  local: Record<string, { pushedAt?: unknown; status?: unknown; message?: unknown; summary?: unknown } | undefined> | null | undefined,
  server: GuestyPushListingHistory,
  nowIso: string,
): GuestyPushListingHistory {
  const out: GuestyPushListingHistory = {};
  if (!local || typeof local !== "object") return out;
  for (const [tab, value] of Object.entries(local)) {
    if (!isGuestyPushTab(tab)) continue;
    const clean = sanitizeGuestyPushEntry(value);
    if (!clean || !guestyPushBackfillWindowOk(clean.pushedAt, nowIso)) continue;
    const existing = server[tab];
    if (existing && new Date(existing.pushedAt).getTime() >= new Date(clean.pushedAt).getTime()) continue;
    out[tab] = clean;
  }
  return out;
}

// ── Operator-facing push summaries ──────────────────────────────────────────
// Test-locked wording — the tab strip renders these verbatim.

export function summarizeDescriptionsPush(fieldCount: number): string {
  return `${fieldCount} description field${fieldCount === 1 ? "" : "s"} pushed`;
}

export function summarizeAmenitiesPush(sent: number, saved: number): string {
  const base = `${sent} ${sent === 1 ? "amenity" : "amenities"} pushed`;
  return saved >= sent ? base : `${base} (${saved} confirmed on Guesty)`;
}

export function summarizePhotosPush(pushed: number, verified: number): string {
  const base = `${pushed} photo${pushed === 1 ? "" : "s"} pushed`;
  return verified >= pushed ? base : `${base} (${verified} verified on Guesty)`;
}

export function summarizePricingPush(days: number, verifiedDays: number): string {
  const base = `${days} day${days === 1 ? "" : "s"} of rates pushed`;
  return verifiedDays >= days ? base : `${base} (${verifiedDays} verified)`;
}

export function summarizeBeddingPush(input: {
  bedrooms?: number;
  bathrooms?: number;
  accommodates?: number;
  rooms?: number;
}): string {
  const parts: string[] = [];
  if (typeof input.bedrooms === "number" && Number.isFinite(input.bedrooms)) parts.push(`${input.bedrooms} BR`);
  if (typeof input.bathrooms === "number" && Number.isFinite(input.bathrooms)) parts.push(`${input.bathrooms} bath`);
  if (typeof input.accommodates === "number" && Number.isFinite(input.accommodates)) parts.push(`sleeps ${input.accommodates}`);
  if (parts.length === 0 && typeof input.rooms === "number" && Number.isFinite(input.rooms) && input.rooms > 0) {
    parts.push(`${input.rooms} room${input.rooms === 1 ? "" : "s"}`);
  }
  return parts.length ? `Bedding pushed: ${parts.join(" · ")}` : "Bedding configuration pushed";
}

export function summarizeBookingRulesPush(minNights?: number | null, _maxNights?: number | null): string {
  // Number(null) is 0 — require a real value before coercing.
  const min = minNights != null && Number.isFinite(Number(minNights)) ? Number(minNights) : null;
  return min != null ? `Booking rules pushed (min ${min} night${min === 1 ? "" : "s"})` : "Booking rules pushed";
}

// ── Guesty-proxy write classifier ────────────────────────────────────────────
// Bedding pushes (guestyService.updateListingDetails) and bookable flips
// (listOnChannels / unlistFromChannels) are the two builder pushes that reach
// Guesty through the generic proxy instead of a dedicated route. Their body
// shapes are distinctive: bedding is the ONLY flow that PUTs `listingRooms`,
// and the bookable buttons PUT `{ isListed: boolean }`. Anything else (e.g.
// address/nickname updates, sub-path writes like /availability-settings) is
// deliberately NOT a ledger event.
export type GuestyProxyLedgerWrite =
  | { listingId: string; tab: "bedding"; bedrooms?: number; bathrooms?: number; accommodates?: number; rooms: number }
  | { listingId: string; tab: "bookable"; listed: boolean };

export function classifyGuestyProxyListingWrite(
  method: string,
  path: string,
  body: unknown,
): GuestyProxyLedgerWrite | null {
  if (String(method ?? "").toUpperCase() !== "PUT") return null;
  const match = /^\/listings\/([^/?#]+)$/.exec(String(path ?? ""));
  if (!match) return null;
  let listingId = match[1];
  try {
    listingId = decodeURIComponent(listingId);
  } catch {
    // keep the raw segment
  }
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.listingRooms) && b.listingRooms.length > 0) {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    return {
      listingId,
      tab: "bedding",
      bedrooms: num(b.bedrooms),
      bathrooms: num(b.bathrooms),
      accommodates: num(b.accommodates),
      rooms: b.listingRooms.length,
    };
  }
  if (typeof b.isListed === "boolean") {
    return { listingId, tab: "bookable", listed: b.isListed };
  }
  return null;
}
