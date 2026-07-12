// Network-free unit tests for shared/guesty-push-history.ts — the per-tab
// "last pushed to Guesty" ledger behind the builder tab strip (2026-07-12):
// store parse/serialize + cap, record/backfill semantics (48h retroactive
// window, never-clobber-newer), display merge, summary wording locks, the
// Guesty-proxy bedding/bookable classifier, and source guards on the server +
// client wiring.
import { readFileSync } from "node:fs";
import {
  GUESTY_PUSH_HISTORY_LISTING_CAP,
  GUESTY_PUSH_RETROACTIVE_HOURS,
  GUESTY_PUSH_SUMMARY_MAX_CHARS,
  applyGuestyPushBackfill,
  applyGuestyPushRecord,
  classifyGuestyProxyListingWrite,
  guestyPushBackfillCandidates,
  guestyPushBackfillWindowOk,
  newestGuestyPushEntry,
  parseGuestyPushHistoryStore,
  sanitizeGuestyPushEntry,
  serializeGuestyPushHistoryStore,
  summarizeAmenitiesPush,
  summarizeBeddingPush,
  summarizeBookingRulesPush,
  summarizeCoverCollagePush,
  summarizeDescriptionsPush,
  summarizePhotosPush,
  summarizePricingPush,
  type GuestyPushEntry,
  type GuestyPushHistoryStore,
} from "../shared/guesty-push-history";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

const NOW = "2026-07-12T12:00:00.000Z";
const hoursAgo = (h: number) => new Date(new Date(NOW).getTime() - h * 60 * 60 * 1000).toISOString();
const entry = (pushedAt: string, summary = "81 amenities pushed", status: GuestyPushEntry["status"] = "success"): GuestyPushEntry =>
  ({ pushedAt, status, summary });

console.log("guesty-push-history: sanitize + parse/serialize");

check("sanitize accepts server shape", sanitizeGuestyPushEntry(entry(NOW))?.summary === "81 amenities pushed");
check(
  "sanitize accepts legacy localStorage `message` shape",
  sanitizeGuestyPushEntry({ pushedAt: NOW, status: "success", message: "45 photos pushed" })?.summary === "45 photos pushed",
);
check("sanitize rejects bad date", sanitizeGuestyPushEntry({ pushedAt: "junk", status: "success", summary: "x" }) === null);
check("sanitize rejects bad status", sanitizeGuestyPushEntry({ pushedAt: NOW, status: "pending", summary: "x" }) === null);
check(
  "sanitize caps summary length",
  (sanitizeGuestyPushEntry({ pushedAt: NOW, status: "error", summary: "x".repeat(999) })?.summary.length ?? 0) === GUESTY_PUSH_SUMMARY_MAX_CHARS,
);

check("parse fail-softs on junk", Object.keys(parseGuestyPushHistoryStore("{not json").listings).length === 0);
check("parse fail-softs on null", Object.keys(parseGuestyPushHistoryStore(null).listings).length === 0);
{
  const store: GuestyPushHistoryStore = { version: 1, listings: {} };
  applyGuestyPushRecord(store, "listing-1", "amenities", entry(NOW), NOW);
  const roundTrip = parseGuestyPushHistoryStore(serializeGuestyPushHistoryStore(store));
  check("record + serialize + parse round-trips", roundTrip.listings["listing-1"]?.tabs.amenities?.summary === "81 amenities pushed");
  check("parse drops unknown tabs", (() => {
    const raw = JSON.stringify({ version: 1, listings: { a: { updatedAt: NOW, tabs: { hacked: entry(NOW), photos: entry(NOW, "45 photos pushed") } } } });
    const parsed = parseGuestyPushHistoryStore(raw);
    return parsed.listings.a?.tabs.photos != null && !("hacked" in (parsed.listings.a?.tabs ?? {}));
  })());
}
{
  const store: GuestyPushHistoryStore = { version: 1, listings: {} };
  for (let i = 0; i < GUESTY_PUSH_HISTORY_LISTING_CAP + 25; i++) {
    applyGuestyPushRecord(store, `listing-${i}`, "photos", entry(NOW), new Date(new Date(NOW).getTime() + i * 1000).toISOString());
  }
  const parsed = parseGuestyPushHistoryStore(serializeGuestyPushHistoryStore(store));
  const ids = Object.keys(parsed.listings);
  check("serialize evicts past the listing cap", ids.length === GUESTY_PUSH_HISTORY_LISTING_CAP, ids.length);
  check("eviction keeps the newest listings", ids.includes(`listing-${GUESTY_PUSH_HISTORY_LISTING_CAP + 24}`) && !ids.includes("listing-0"));
}

console.log("guesty-push-history: record overwrites, backfill never clobbers newer");
{
  const store: GuestyPushHistoryStore = { version: 1, listings: {} };
  applyGuestyPushRecord(store, "l1", "photos", entry(hoursAgo(2), "old"), NOW);
  applyGuestyPushRecord(store, "l1", "photos", entry(hoursAgo(1), "new"), NOW);
  check("live record overwrites (newest push IS the state)", store.listings.l1.tabs.photos?.summary === "new");
}

check("window: 47h old accepted", guestyPushBackfillWindowOk(hoursAgo(47), NOW));
check("window: 49h old rejected", !guestyPushBackfillWindowOk(hoursAgo(49), NOW));
check("window constant is 48", GUESTY_PUSH_RETROACTIVE_HOURS === 48);
check("window: 2min future (clock skew) accepted", guestyPushBackfillWindowOk(hoursAgo(-2 / 60), NOW));
check("window: 10min future rejected", !guestyPushBackfillWindowOk(hoursAgo(-10 / 60), NOW));

{
  const store: GuestyPushHistoryStore = { version: 1, listings: {} };
  applyGuestyPushRecord(store, "l1", "amenities", entry(hoursAgo(1), "server newer"), NOW);
  const result = applyGuestyPushBackfill(store, "l1", {
    amenities: entry(hoursAgo(3), "older local"),           // rejected: server is newer
    photos: entry(hoursAgo(3), "45 photos pushed"),         // applied: no server entry, in window
    descriptions: entry(hoursAgo(60), "too old"),           // rejected: outside 48h
    bogusTab: entry(hoursAgo(1)),                           // rejected: unknown tab
    pricing: { pushedAt: "junk", status: "success", summary: "x" }, // rejected: invalid
  }, NOW);
  check("backfill applies only valid in-window non-clobbering entries", result.applied === 1 && result.rejected === 4, result);
  check("backfill kept the newer server entry", store.listings.l1.tabs.amenities?.summary === "server newer");
  check("backfill wrote the new tab", store.listings.l1.tabs.photos?.summary === "45 photos pushed");
  const equalStamp = applyGuestyPushBackfill(store, "l1", { photos: entry(hoursAgo(3), "same stamp again") }, NOW);
  check("backfill rejects equal-timestamp clobber", equalStamp.applied === 0 && store.listings.l1.tabs.photos?.summary === "45 photos pushed");
}

console.log("guesty-push-history: merge + client candidates");
check("newest wins (b newer)", newestGuestyPushEntry(entry(hoursAgo(2), "a"), entry(hoursAgo(1), "b"))?.summary === "b");
check("newest wins (a newer)", newestGuestyPushEntry(entry(hoursAgo(1), "a"), entry(hoursAgo(2), "b"))?.summary === "a");
check("tie keeps a (server)", newestGuestyPushEntry(entry(NOW, "a"), entry(NOW, "b"))?.summary === "a");
check("null + entry → entry", newestGuestyPushEntry(null, entry(NOW, "b"))?.summary === "b");
check("null + null → null", newestGuestyPushEntry(null, undefined) === null);

{
  const candidates = guestyPushBackfillCandidates(
    {
      photos: { pushedAt: hoursAgo(3), status: "success", message: "45/45 photos" },
      amenities: { pushedAt: hoursAgo(3), status: "success", message: "older than server" },
      bedding: { pushedAt: hoursAgo(60), status: "success", message: "too old" },
    },
    { amenities: entry(hoursAgo(1)) },
    NOW,
  );
  check("candidates: in-window + newer-than-server only", Object.keys(candidates).join(",") === "photos", candidates);
  check("candidates map message→summary", candidates.photos?.summary === "45/45 photos");
}

console.log("guesty-push-history: summary wording locks");
check("amenities all confirmed", summarizeAmenitiesPush(81, 81) === "81 amenities pushed");
check("amenities partial", summarizeAmenitiesPush(81, 79) === "81 amenities pushed (79 confirmed on Guesty)");
check("amenities singular", summarizeAmenitiesPush(1, 1) === "1 amenity pushed");
check("photos all verified", summarizePhotosPush(45, 45) === "45 photos pushed");
check("photos shortfall", summarizePhotosPush(45, 43) === "45 photos pushed (43 verified on Guesty)");
check("photos singular", summarizePhotosPush(1, 1) === "1 photo pushed");
check("pricing verified", summarizePricingPush(366, 366) === "366 days of rates pushed");
check("pricing partial", summarizePricingPush(366, 300) === "366 days of rates pushed (300 verified)");
check("descriptions plural", summarizeDescriptionsPush(7) === "7 description fields pushed");
check("descriptions singular", summarizeDescriptionsPush(1) === "1 description field pushed");
check("bedding full", summarizeBeddingPush({ bedrooms: 6, bathrooms: 4, accommodates: 12, rooms: 6 }) === "Bedding pushed: 6 BR · 4 bath · sleeps 12");
check("bedding rooms-only fallback", summarizeBeddingPush({ rooms: 3 }) === "Bedding pushed: 3 rooms");
check("bedding empty fallback", summarizeBeddingPush({}) === "Bedding configuration pushed");
check("booking rules with min", summarizeBookingRulesPush(5, 365) === "Booking rules pushed (min 5 nights)");
check("booking rules without min", summarizeBookingRulesPush(null) === "Booking rules pushed");
check("cover collage plural", summarizeCoverCollagePush(46) === "Cover collage pushed (46 photos on the listing)");
check("cover collage singular", summarizeCoverCollagePush(1) === "Cover collage pushed (1 photo on the listing)");

console.log("guesty-push-history: proxy write classifier");
{
  const bedding = classifyGuestyProxyListingWrite("PUT", "/listings/abc123", {
    bedrooms: 6, bathrooms: 4, accommodates: 12, listingRooms: [{}, {}, {}, {}, {}, {}],
  });
  check("bedding PUT classified", bedding?.tab === "bedding" && bedding.listingId === "abc123" && (bedding as any).rooms === 6, bedding);
  const bookable = classifyGuestyProxyListingWrite("PUT", "/listings/abc123", { isListed: true });
  check("bookable PUT classified", bookable?.tab === "bookable" && (bookable as any).listed === true);
  const unlist = classifyGuestyProxyListingWrite("PUT", "/listings/abc123", { isListed: false });
  check("unlist classified as bookable(listed:false)", unlist?.tab === "bookable" && (unlist as any).listed === false);
  check(
    "listingRooms takes precedence over isListed",
    classifyGuestyProxyListingWrite("PUT", "/listings/x", { isListed: true, listingRooms: [{}] })?.tab === "bedding",
  );
  check("GET is not a ledger write", classifyGuestyProxyListingWrite("GET", "/listings/abc123", { listingRooms: [{}] }) === null);
  check("sub-path writes ignored", classifyGuestyProxyListingWrite("PUT", "/listings/abc123/availability-settings", { isListed: true }) === null);
  check("other body shapes ignored (address/nickname updates)", classifyGuestyProxyListingWrite("PUT", "/listings/abc123", { nickname: "x" }) === null);
  check("empty listingRooms is not a bedding push", classifyGuestyProxyListingWrite("PUT", "/listings/abc123", { listingRooms: [] }) === null);
}

// ── Source guards: the wiring this suite exists to protect ──────────────────
console.log("guesty-push-history: source guards (server + client wiring)");
const routes = readFileSync("server/routes.ts", "utf8");
const routesFlat = routes.replace(/\s+/g, " ");
const serverLedger = readFileSync("server/guesty-push-history.ts", "utf8");
const clientBuilder = readFileSync("client/src/components/GuestyListingBuilder/index.tsx", "utf8");

check("routes: push-descriptions records to the ledger", routesFlat.includes(`recordGuestyPush( listingId, "descriptions", "success", summarizeDescriptionsPush(`));
check("routes: push-amenities records to the ledger", routes.includes(`recordGuestyPush(listingId, "amenities", "success", summarizeAmenitiesPush(translated.length, savedAmenities.length))`));
check("routes: push-photos records to the ledger", routesFlat.includes(`recordGuestyPush( guestyListingId, "photos",`));
check("routes: pricing wrapper records to the ledger", routes.includes(`recordGuestyPush(listingId, "pricing", status === "ok" ? "success" : "error", tabSummary ?? summary)`));
check("routes: booking rules record as availability", routesFlat.includes(`recordGuestyPush( listingId, "availability",`));
// The collage rewrites the listing's pictures[] — a real Photos-tab push.
// Recording lives in the pushCoverCollageToGuesty wrapper so BOTH callers
// (manual upload-collage + auto-cover-collage, which the audit sweep's
// collage auto-fix drives) stamp the ledger.
check(
  "routes: cover-collage push records to the ledger (both callers via the wrapper)",
  routesFlat.includes(`summarizeCoverCollagePush(result.totalPhotos)`) &&
  routesFlat.includes(`recordGuestyPush( listingId, "photos", result.ok ? "success" : "error"`) &&
  routesFlat.includes("await pushCoverCollageToGuestyUnrecorded(listingId, rawBase64, existingPhotos)"),
);
check("routes: proxy classifies bedding/bookable writes", routes.includes("classifyGuestyProxyListingWrite(req.method, guestyPath, req.body)"));
check("routes: GET history endpoint exists", routes.includes(`app.get("/api/builder/guesty-push-history"`));
check("routes: backfill endpoint exists", routes.includes(`app.post("/api/builder/guesty-push-history/backfill"`));
check("routes: pricing overlay excludes seed rows", routes.includes(`sched.lastGuestyRatePushStatus !== "seed"`));
check("routes: availability overlay reads builder booking rules", routes.includes("storage.getBuilderBookingRules(historyPropertyId, listingId)"));

check("server ledger: persists under guesty_push_history.v1", serverLedger.includes(`"guesty_push_history.v1"`));
check("server ledger: recordGuestyPush is fire-and-forget", serverLedger.includes("void mutateStore((store, nowIso)"));

check("client: tab strip reads the MERGED log", clientBuilder.includes("const entry = pushTab ? mergedPushLog[pushTab] : undefined;"));
check("client: chips strip reads the MERGED log", clientBuilder.includes("const entry = mergedPushLog[key];"));
check("client: fetches the server ledger", clientBuilder.includes("/api/builder/guesty-push-history?"));
check("client: retroactive backfill uses the shared candidate filter", clientBuilder.includes("guestyPushBackfillCandidates(local, tabs, new Date().toISOString())"));
check("client: posts backfill to the server", clientBuilder.includes(`"/api/builder/guesty-push-history/backfill"`));
check("client: tab renders the push summary line", clientBuilder.includes("tab-push-info-"));

console.log(`\nguesty-push-history: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
