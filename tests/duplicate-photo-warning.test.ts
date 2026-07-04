import assert from "node:assert";
import {
  collectDuplicateListingLinks,
  distinctMatchedPhotoUrls,
  duplicatePhotoWarningSignature,
  formatDuplicatePhotoPlatforms,
  groupDuplicateListingLinksByUnit,
  groupLinksByPlatform,
  photoFilenameFromMatchUrl,
  photoReplaceRescanVerdict,
} from "../shared/duplicate-photo-warning";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("duplicate-photo-warning: dashboard duplicate-photos popup helpers");

// ── signature ────────────────────────────────────────────────────────────────
check("empty unit list → empty signature (no popup)", duplicatePhotoWarningSignature([]) === "");

const sigA = duplicatePhotoWarningSignature([
  { folder: "poipu-kai-a", platforms: ["vrbo", "airbnb"], checkedAt: "2026-07-01T10:00:00Z" },
  { folder: "kaha-lani-b", platforms: ["booking"], checkedAt: "2026-07-02T10:00:00Z" },
]);
const sigB = duplicatePhotoWarningSignature([
  { folder: "kaha-lani-b", platforms: ["booking"], checkedAt: "2026-07-02T10:00:00Z" },
  { folder: "poipu-kai-a", platforms: ["airbnb", "vrbo"], checkedAt: "2026-07-01T10:00:00Z" },
]);
check("signature is order-independent across units AND platforms", sigA === sigB && sigA.length > 0);

const sigNewScan = duplicatePhotoWarningSignature([
  { folder: "poipu-kai-a", platforms: ["vrbo", "airbnb"], checkedAt: "2026-07-03T10:00:00Z" },
  { folder: "kaha-lani-b", platforms: ["booking"], checkedAt: "2026-07-02T10:00:00Z" },
]);
check("a fresh scan re-confirming duplicates changes the signature (re-raises a dismissed popup)", sigNewScan !== sigA);

const sigNewPlatform = duplicatePhotoWarningSignature([
  { folder: "poipu-kai-a", platforms: ["vrbo", "airbnb", "booking"], checkedAt: "2026-07-01T10:00:00Z" },
  { folder: "kaha-lani-b", platforms: ["booking"], checkedAt: "2026-07-02T10:00:00Z" },
]);
check("a new platform on an existing unit changes the signature", sigNewPlatform !== sigA);

check("missing checkedAt is tolerated", duplicatePhotoWarningSignature([{ folder: "x", platforms: ["airbnb"] }]).includes("x|airbnb|"));

// ── platform labels ──────────────────────────────────────────────────────────
check("platform labels render operator-facing names", formatDuplicatePhotoPlatforms(["airbnb", "vrbo", "booking"]) === "Airbnb / VRBO / Booking.com");

// ── rescan verdict ───────────────────────────────────────────────────────────
const startedAt = Date.parse("2026-07-03T12:00:00Z");

check("no checkedAt yet → pending", photoReplaceRescanVerdict({
  rescanStartedAtMs: startedAt, checkedAt: null, statuses: {},
}).state === "pending");

check("stale checkedAt (before rescan start) → pending", photoReplaceRescanVerdict({
  rescanStartedAtMs: startedAt, checkedAt: "2026-07-03T11:59:58Z",
  statuses: { airbnb: "clean", vrbo: "clean", booking: "clean" },
}).state === "pending");

check("checkedAt within the 1s tolerance counts as done", photoReplaceRescanVerdict({
  rescanStartedAtMs: startedAt, checkedAt: "2026-07-03T11:59:59.500Z",
  statuses: { airbnb: "clean", vrbo: "clean", booking: "clean" },
}).state === "clean");

check("unparseable checkedAt → pending", photoReplaceRescanVerdict({
  rescanStartedAtMs: startedAt, checkedAt: "not-a-date",
  statuses: { airbnb: "clean", vrbo: "clean", booking: "clean" },
}).state === "pending");

check("all three clean after rescan → clean", photoReplaceRescanVerdict({
  rescanStartedAtMs: startedAt, checkedAt: "2026-07-03T12:05:00Z",
  statuses: { airbnb: "clean", vrbo: "clean", booking: "clean" },
}).state === "clean");

{
  const v = photoReplaceRescanVerdict({
    rescanStartedAtMs: startedAt, checkedAt: "2026-07-03T12:05:00Z",
    statuses: { airbnb: "clean", vrbo: "found", booking: "unknown" },
  });
  check("any FOUND wins over inconclusive → still_found on that platform only",
    v.state === "still_found" && v.platforms.join(",") === "vrbo");
}

{
  const v = photoReplaceRescanVerdict({
    rescanStartedAtMs: startedAt, checkedAt: "2026-07-03T12:05:00Z",
    statuses: { airbnb: "clean", vrbo: "unknown", booking: undefined },
  });
  check("no FOUND but unknown/missing platforms → inconclusive, never a soft clean",
    v.state === "inconclusive" && v.platforms.join(",") === "vrbo,booking");
}

// ── offending-listing links ──────────────────────────────────────────────────
{
  const { links, more } = collectDuplicateListingLinks({
    airbnb: [
      { listingUrl: "https://www.airbnb.com/rooms/123?check_in=2026-08-01", title: "Poipu Kai 3BR" },
      { listingUrl: "https://www.airbnb.com/rooms/123/", title: "Poipu Kai 3BR (2nd photo hit)" },
    ],
    vrbo: [{ listingUrl: "https://www.vrbo.com/998877", title: "" }],
    booking: [],
  });
  check("same listing matched by two photos collapses to ONE link (query/slash-insensitive)",
    links.filter((l) => l.platform === "airbnb").length === 1);
  check("platform order is Airbnb, VRBO, Booking", links.map((l) => l.platform).join(",") === "airbnb,vrbo");
  check("missing title falls back to the URL", links[1]?.title === "https://www.vrbo.com/998877");
  check("first-seen URL (with its params) is what gets linked", links[0]?.url === "https://www.airbnb.com/rooms/123?check_in=2026-08-01");
  check("no overflow when under the cap", more === 0);
}

{
  const { links, more } = collectDuplicateListingLinks({
    airbnb: Array.from({ length: 9 }, (_, i) => ({ listingUrl: `https://www.airbnb.com/rooms/${i}`, title: `L${i}` })),
  }, 6);
  check("link list capped with an accurate +N-more count", links.length === 6 && more === 3);
}

{
  const { links } = collectDuplicateListingLinks({
    airbnb: [{ listingUrl: "not-a-url", title: "junk" }, { listingUrl: null, title: "junk" }],
  });
  check("non-URL / null listingUrl rows are dropped", links.length === 0);
}

// ── matched-photo accumulation on de-duped links ─────────────────────────────
{
  const { links } = collectDuplicateListingLinks({
    airbnb: [
      { listingUrl: "https://www.airbnb.com/rooms/123", title: "Thief", photoUrl: "https://host/photos/mauna-kai-t3/03-living.jpg" },
      { listingUrl: "https://www.airbnb.com/rooms/123/", title: "Thief", photoUrl: "https://host/photos/mauna-kai-t3/07-master.jpg" },
      { listingUrl: "https://www.airbnb.com/rooms/123", title: "Thief", photoUrl: "https://host/photos/mauna-kai-t3/03-living.jpg" },
    ],
  });
  check("same listing accumulates its distinct matched photos",
    links.length === 1 && links[0].matchedPhotoUrls.length === 2 &&
    links[0].matchedPhotoUrls[0].endsWith("03-living.jpg"));
}

// ── photoFilenameFromMatchUrl ────────────────────────────────────────────────
check("filename parses out of a scanner photoUrl (query stripped)",
  photoFilenameFromMatchUrl("https://host/photos/mauna-kai-t3/07-master.jpg?w=640") === "07-master.jpg");
check("URL-encoded filename decodes", photoFilenameFromMatchUrl("https://h/photos/f/my%20photo.jpg") === "my photo.jpg");
check("non-image URL → null", photoFilenameFromMatchUrl("https://www.airbnb.com/rooms/123") === null);

// ── groupDuplicateListingLinksByUnit ─────────────────────────────────────────
const matchUrl = (n: number, photo: string) =>
  ({ listingUrl: `https://www.airbnb.com/rooms/${n}`, title: `L${n}`, photoUrl: `https://host/photos/shared/${photo}` });

{
  // Distinct galleries → links split per unit by matched filename.
  const groups = groupDuplicateListingLinksByUnit(
    {
      airbnb: [matchUrl(1, "a-living.jpg"), matchUrl(2, "b-lanai.jpg"), matchUrl(3, "mystery.jpg")],
      vrbo: [matchUrl(1, "a-master.jpg")],
    },
    [
      { label: "Unit A (7B)", filenames: ["a-living.jpg", "a-master.jpg"] },
      { label: "Unit B (8)", filenames: ["b-lanai.jpg", "b-kitchen.jpg"] },
    ],
  );
  const unitA = groups.find((g) => g.label === "Unit A (7B)");
  const unitB = groups.find((g) => g.label === "Unit B (8)");
  const rest = groups.find((g) => g.kind === "unassigned");
  check("distinct galleries → per-unit groups by matched filename",
    unitA?.links.length === 1 && unitA.links[0].url.endsWith("/1") &&
    unitB?.links.length === 1 && unitB.links[0].url.endsWith("/2"));
  check("photos in neither gallery land in an 'unassigned' group",
    rest?.links.length === 1 && rest.links[0].url.endsWith("/3"));
}

{
  // A listing hosting BOTH units' photos appears under both units.
  const groups = groupDuplicateListingLinksByUnit(
    { airbnb: [matchUrl(9, "a-living.jpg"), matchUrl(9, "b-lanai.jpg")] },
    [
      { label: "Unit A", filenames: ["a-living.jpg"] },
      { label: "Unit B", filenames: ["b-lanai.jpg"] },
    ],
  );
  check("a listing with both units' photos shows under BOTH units",
    groups.filter((g) => g.kind === "unit").every((g) => g.links.some((l) => l.url.endsWith("/9"))) &&
    groups.filter((g) => g.kind === "unit").length === 2);
}

{
  // Identical galleries (mauna-kai-t3 pattern: both units use the same list)
  // → one honest shared-gallery group, never fake per-unit attribution.
  const shared = ["03-living.jpg", "07-master.jpg"];
  const groups = groupDuplicateListingLinksByUnit(
    { airbnb: [matchUrl(1, "03-living.jpg")] },
    [
      { label: "Unit A (7B)", filenames: [...shared] },
      { label: "Unit B (8)", filenames: [...shared].reverse() },
    ],
  );
  check("identical shared gallery → single group flagged sharedGallery",
    groups.length === 1 && groups[0].kind === "all" && groups[0].sharedGallery === true);
}

{
  // Single or no owners → one plain group (per-folder rows already are per-unit).
  const groups = groupDuplicateListingLinksByUnit(
    { airbnb: [matchUrl(1, "x.jpg")] },
    [{ label: "Unit A", filenames: ["x.jpg"] }],
  );
  check("single owner → one plain group (no attribution needed)",
    groups.length === 1 && groups[0].kind === "all" && !groups[0].sharedGallery);
}

check("no links → no groups", groupDuplicateListingLinksByUnit({ airbnb: [] }, []).length === 0);

// ── distinctMatchedPhotoUrls + groupLinksByPlatform ──────────────────────────
{
  const links = collectDuplicateListingLinks({
    airbnb: [
      { listingUrl: "https://www.airbnb.com/rooms/1", title: "A1", photoUrl: "https://h/photos/f/x.jpg" },
      { listingUrl: "https://www.airbnb.com/rooms/2", title: "A2", photoUrl: "https://h/photos/f/x.jpg" },
    ],
    vrbo: [{ listingUrl: "https://www.vrbo.com/9", title: "V", photoUrl: "https://h/photos/f/y.jpg" }],
    booking: [{ listingUrl: "https://www.booking.com/hotel/us/z.html", title: "B", photoUrl: "https://h/photos/f/z.jpg" }],
  }).links;
  const photos = distinctMatchedPhotoUrls(links);
  check("group photo rollup de-dupes the same photo matched on two listings",
    photos.length === 3 && photos[0].endsWith("x.jpg") && photos[1].endsWith("y.jpg") && photos[2].endsWith("z.jpg"));
  const byPlatform = groupLinksByPlatform(links);
  check("platform breakout: Airbnb (2) / VRBO (1) / Booking.com (1), in order",
    byPlatform.map((g) => `${g.platform}:${g.links.length}`).join(",") === "airbnb:2,vrbo:1,booking:1");
  check("platform breakout drops empty platforms",
    groupLinksByPlatform(links.filter((l) => l.platform === "vrbo")).length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
