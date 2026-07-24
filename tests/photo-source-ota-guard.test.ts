/**
 * OTA photo-source guard (2026-07-23).
 *
 * LIVE INCIDENT: property 4 / unit-621 (Regency at Poipu Kai). The folder's
 * `_source.json` carried `sourceListing.url = https://www.vrbo.com/982364`,
 * stamped 2026-04-30 by the alert-remediate flow. Its 43 photos ARE that VRBO
 * listing's photos, so `photo_listing_checks` flagged the folder
 * `vrbo_status = found` on 2026-06-30 — the scanner working exactly as
 * designed. The defect was upstream: we sourced the gallery from an OTA.
 *
 * The find/discovery paths were already portal-gated
 * (`detectRealEstateListingPortal`: Zillow / Realtor / Redfin / Homes only).
 * Every path that CONSUMED a saved source URL was not, so one poisoned stamp
 * kept re-poisoning the gallery:
 *   - preflight "Re-pull all photos" posts `_source.json`'s url straight to
 *     `POST /api/community/fetch-unit-photos` (direct-`url` leg, unguarded)
 *   - `POST /api/builder/rescrape-unit-photos` re-resolves the same stamp
 *   - the same-unit hunt anchors on it (`readFolderSourceUrl`)
 *   - `POST /api/unit-swaps` + `/api/preflight/manual-unit-replacement`
 *     accepted any `http(s)` URL as `newSourceUrl`
 *
 * This suite locks the pure classifier plus a source guard on every one of
 * those seams. Loosening any of them re-opens the incident.
 */
import { readFileSync } from "fs";
import {
  EXTRA_OTA_PHOTO_SOURCE_HOSTS,
  isOtaPhotoSourceUrl,
  otaPhotoSourceMessage,
  otaPhotoSourceRejection,
  otaPhotoSourceRejectionMessage,
} from "../shared/photo-source-ota-guard";
import { detectRealEstateListingPortal } from "../shared/real-estate-listing-discovery";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
};

console.log("photo-source-ota-guard: the live incident URL");
{
  const LIVE = "https://www.vrbo.com/982364";
  check("the exact unit-621 stamp is rejected", isOtaPhotoSourceUrl(LIVE));
  const rejection = otaPhotoSourceRejection(LIVE);
  check("rejection names the platform and host",
    rejection?.platform === "vrbo" && rejection?.label === "VRBO" && rejection?.host === "vrbo.com",
    rejection);
  const message = otaPhotoSourceRejectionMessage(LIVE, "Replacement listing");
  check("message names the subject, the platform, and the allowed sources",
    !!message
      && message.startsWith("Replacement listing is a live VRBO listing")
      && message.includes("Zillow")
      && message.includes("Redfin"),
    message);
}

console.log("photo-source-ota-guard: scanner-bucketed OTA families");
{
  const rejected = [
    "https://www.vrbo.com/982364",
    "https://www.vrbo.com/en-gb/cottage/p982364",
    "https://www.homeaway.com/vacation-rental/p982364",
    "https://www.abritel.fr/location-vacances/p982364",
    "https://www.fewo-direkt.de/ferienwohnung/p982364",
    "https://www.stayz.com.au/holiday-rental/p982364",
    "https://www.bookabach.co.nz/holiday-rental/p982364",
    "https://www.airbnb.com/rooms/12345",
    "https://www.airbnb.co.uk/rooms/12345",
    "https://airbnb.com.au/rooms/12345",
    "https://www.booking.com/hotel/us/regency-poipu.html",
    "https://m.booking.com/hotel/us/regency-poipu.html",
  ];
  for (const url of rejected) {
    check(`rejected: ${url}`, isOtaPhotoSourceUrl(url));
  }
}

console.log("photo-source-ota-guard: supplementary OTA hosts");
{
  check("expedia is rejected", isOtaPhotoSourceUrl("https://www.expedia.com/Koloa-Hotels.h123.Hotel-Information"));
  check("hotels.com is rejected", isOtaPhotoSourceUrl("https://uk.hotels.com/ho123456/"));
  check("tripadvisor is rejected", isOtaPhotoSourceUrl("https://www.tripadvisor.com/VacationRentalReview-g60618"));
  check("flipkey is rejected", isOtaPhotoSourceUrl("https://www.flipkey.com/koloa-vacation-rentals/p123/"));
  check("hometogo is rejected", isOtaPhotoSourceUrl("https://www.hometogo.com/koloa/"));
  check("every supplementary host classifies as an OTA",
    EXTRA_OTA_PHOTO_SOURCE_HOSTS.every((host) => isOtaPhotoSourceUrl(`https://www.${host}/listing/1`)),
    EXTRA_OTA_PHOTO_SOURCE_HOSTS.filter((host) => !isOtaPhotoSourceUrl(`https://www.${host}/listing/1`)));
  check("supplementary hosts carry no scanner platform key",
    otaPhotoSourceRejection("https://www.expedia.com/x")?.platform === null);
}

console.log("photo-source-ota-guard: fail-open — legitimate sources are never rejected");
{
  const allowed = [
    // The real-estate portals discovery is already restricted to. Anything
    // detectRealEstateListingPortal accepts MUST pass this guard, or the
    // find/replace pipeline would reject its own candidates.
    "https://www.zillow.com/homedetails/1831-Poipu-Rd-APT-923-Koloa-HI-96756/80157527_zpid/",
    "https://www.redfin.com/HI/Koloa/1831-Poipu-Rd-96756/unit-611/home/88660173",
    "https://www.realtor.com/realestateandhomes-detail/1831-Poipu-Rd_Koloa_HI_96756_M12345-67890",
    "https://www.homes.com/property/1831-poipu-rd-koloa-hi/abc123/",
    // Property-manager and resort sites — two of these are CONFIGURED
    // community sources (COMMUNITY_SOURCE_URLS). Banning them would break the
    // community re-pull; the operator's rule is "not an OTA", not "not a
    // site that rents units".
    "https://www.parrishkauai.com/kauai-condos/regency-at-poipu-kai/",
    "https://www.olaproperties.com/ko-olina-beach-villas/",
    "https://www.waikikibeachrentals.com/unit/1234",
  ];
  for (const url of allowed) {
    check(`allowed: ${url}`, !isOtaPhotoSourceUrl(url));
  }
  check("every real-estate portal URL passes the guard",
    allowed
      .filter((url) => detectRealEstateListingPortal(url) !== null)
      .every((url) => !isOtaPhotoSourceUrl(url)));
  check("garbage input never rejects (callers own their own URL validation)",
    !isOtaPhotoSourceUrl("") && !isOtaPhotoSourceUrl(null) && !isOtaPhotoSourceUrl(undefined)
      && !isOtaPhotoSourceUrl("not a url") && !isOtaPhotoSourceUrl("   "));
}

console.log("photo-source-ota-guard: lookalike hosts must not be treated as OTAs");
{
  // The host-family matcher is what makes the guard safe to apply broadly:
  // a domain that merely CONTAINS an OTA brand is a different site.
  check("airbnb.evil.com is not Airbnb", !isOtaPhotoSourceUrl("https://airbnb.evil.com/rooms/1"));
  check("notvrbo.com is not VRBO", !isOtaPhotoSourceUrl("https://notvrbo.com/1"));
  check("vrbo-rentals.example.com is not VRBO", !isOtaPhotoSourceUrl("https://vrbo-rentals.example.com/1"));
  check("expedia.evil.com is not Expedia", !isOtaPhotoSourceUrl("https://expedia.evil.com/1"));
  check("subdomains of a real family DO match", isOtaPhotoSourceUrl("https://secure.booking.com/hotel/x"));
}

console.log("photo-source-ota-guard: message shape");
{
  const rejection = otaPhotoSourceRejection("https://www.airbnb.com/rooms/1")!;
  check("default subject is generic", otaPhotoSourceMessage(rejection).startsWith("Photo source is a live Airbnb listing"));
  check("message explains the duplicate-scanner consequence",
    otaPhotoSourceMessage(rejection).includes("duplicate-photo scanner"));
}

console.log("photo-source-ota-guard: server seams");
{
  const routes = readFileSync("server/routes.ts", "utf8");
  check("routes imports the shared guard",
    routes.includes('from "@shared/photo-source-ota-guard"'));

  // 1. fetch-unit-photos direct-`url` leg — the funnel BOTH the preflight
  //    re-pull job and the same-unit hunt's gallery scrape flow through.
  check("fetch-unit-photos refuses an OTA direct url",
    routes.includes("const directUrlOtaRejection = otaPhotoSourceRejection(url);")
      && routes.includes("[fetch-unit-photos] refusing OTA photo source"));

  // 2. rescrape-unit-photos — BOTH legs. The supplied check alone is not
  //    enough: the poisoned value arrives from `_source.json`.
  check("rescrape refuses a supplied OTA url",
    routes.includes("const suppliedOtaRejection = otaPhotoSourceRejection(sourceUrl);"));
  check("rescrape refuses a RESOLVED OTA url (the _source.json / unit_swap / community-map legs)",
    routes.includes("const resolvedOtaRejection = otaPhotoSourceRejection(sourceUrl);")
      && routes.includes("[rescrape] ${folder}: refusing OTA photo source"));
  check("the resolved refusal keeps the existing gallery and asks for a real URL",
    routes.includes("needsUrl: true,\n          keptExisting: true,\n          otaSource: true,"));

  // 3. Both unit-swap commit seams.
  check("POST /api/unit-swaps refuses an OTA newSourceUrl",
    routes.includes("const swapOtaRejection = otaPhotoSourceRejection(parsed.data.newSourceUrl);"));
  check("the swap refusal is a burnable candidate rejection, not a job failure",
    routes.includes('candidateRejection: "ota-source",'));
  check("manual-unit-replacement refuses a pasted OTA url",
    routes.includes("const manualOtaRejection = otaPhotoSourceRejection(sourceUrl);"));

  // 4. Belt and braces inside hydration, before any scrape.
  check("hydrateUnitSwapPhotoFolder refuses an OTA source before scraping",
    routes.includes("const hydrationOtaRejection = otaPhotoSourceRejection(url);"));

  // 5. The curated community primary bypasses the portal filter by design.
  check("the curated community primary is OTA-screened",
    routes.includes("!isOtaPhotoSourceUrl(curatedPrimary)"));
}
{
  const hunt = readFileSync("server/same-unit-photo-hunt.ts", "utf8");
  check("the hunt anchor reader drops an OTA stamp",
    hunt.includes("isOtaPhotoSourceUrl(savedUrl)")
      && hunt.includes("is a live OTA listing — ignoring it as a photo source"));
}
{
  const source = readFileSync("server/photo-folder-source.ts", "utf8");
  check("readFolderSourceUrl reports an OTA stamp as absent",
    source.includes("isOtaPhotoSourceUrl(url.trim()) ? undefined : url.trim()"));
  check("writeFolderSourceUrlIfMissing never records an OTA url",
    source.includes("if (isOtaPhotoSourceUrl(trimmed)) return false;"));
}
{
  const jobs = readFileSync("server/auto-replace-jobs.ts", "utf8");
  check("the orchestrator has a dedicated OTA burn bucket",
    jobs.includes("let burnedOtaSource = 0;")
      && jobs.includes('rejection === "ota-source"'));
  check("an OTA burn widens the pool via a find restart",
    jobs.includes("burnedBedrooms > 0 || burnedOtaSource > 0"));
  check("the all-burned receipt reports OTA burns honestly",
    jobs.includes("were live OTA listings (photos may never be sourced from Airbnb/VRBO/Booking.com)"));
  check("an OTA burn is not mislabeled as a community mismatch",
    jobs.includes("Candidate is a live OTA listing — photos may never be sourced from an OTA"));
}
{
  const preflight = readFileSync("client/src/pages/builder-preflight.tsx", "utf8");
  check("the client never re-sends an OTA stamp as a re-pull target",
    preflight.includes("const currentSourceUrl = savedSourceUrl && isOtaPhotoSourceUrl(savedSourceUrl) ? null : savedSourceUrl;"));
  check("the Photo Sources card flags an OTA-sourced gallery",
    preflight.includes("⚠ These photos came from a live OTA listing:"));
  check("Replace-with-URL rejects a pasted OTA listing client-side",
    preflight.includes("That's a live OTA listing"));
}

console.log(`\nphoto-source-ota-guard: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
