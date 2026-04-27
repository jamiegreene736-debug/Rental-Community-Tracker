import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertBuyInSchema, insertCommunityDraftSchema, insertUnitSwapSchema } from "@shared/schema";
import { getPropertyUnits, getUnitConfig, PROPERTY_UNIT_CONFIGS } from "@shared/property-units";
import path from "path";
import fs from "fs";
import JSZip from "jszip";
import { chromium } from "playwright";
import { runAvailabilityScan, isScannerRunning, getScannableProperties, getCurrentScanPropertyId, getPropertyName } from "./availability-scanner";
import { humanizeReply } from "./humanize-reply";
import { scheduleGuestySync, syncPropertyToGuesty, guestyRequest } from "./guesty-sync";
import { getAutoApproveStatus, setAutoApproveEnabled, runAutoApprove } from "./auto-approve";
import { getAutoReplyStatus, setAutoReplyEnabled, runAutoReply, sendDraftedReply, dismissReply } from "./auto-reply";
import { getBookingConfirmationStatus, setBookingConfirmationEnabled, runBookingConfirmations } from "./booking-confirmations";
import { validateAndFixPhoto } from "./photo-validator";
import { researchCommunitiesForCity, TOP_MARKET_SEEDS } from "./community-research";
import { checkCommunityType } from "@shared/community-type";
import { labelPhoto, inferKindFromFolder, listPhotoFiles, probeInteriorCoverage } from "./photo-labeler";
import { downloadAndPrioritize } from "./photo-pipeline";
import { countAirbnbCandidates, computeSetsFromCounts, verdictFor, type CandidateListing, type CountByBedrooms } from "./availability-search";
import { runFullScanNow, getScannerSchedulerStatus } from "./availability-scheduler";
import { runPhotoListingCheckForFolders, listScanableFolders } from "./photo-listing-scanner";
import { getGuestyToken, setGuestyTokenManually, getGuestyTokenStatus, RateLimitedError } from "./guesty-token";
import { insertMessageTemplateSchema } from "@shared/schema";
import { walkBetween } from "./walking-distance";
import { fallbackWalkForResort } from "@shared/walking-distance";

// Fetch the latest Guesty login verification code from the operator's Gmail
// inbox via IMAP. Polls for up to 90s (checking every 5s) so the server can
// tolerate some email-delivery lag. Only considers messages received AFTER
// `afterTimestamp` so we don't grab a stale code from a prior login.
async function fetchGuestyMfaCodeFromGmail(
  user: string,
  appPassword: string,
  afterTimestamp: number,
  trace: Array<{ step: string; detail?: string }>,
): Promise<string | null> {
  const { ImapFlow } = await import("imapflow");
  // Collect a short ring buffer of log lines so we can surface IMAP's
  // underlying failure reason on a connect error — "Command failed" from
  // IMAPflow's top-level throw hides what actually happened (bad auth,
  // TLS reset, rate-limit, etc.).
  const logBuffer: string[] = [];
  const pushLog = (entry: Record<string, unknown>) => {
    try {
      const short = JSON.stringify({ t: entry.t, msg: entry.msg, err: (entry.err as any)?.code ?? (entry.err as any)?.message })
        .slice(0, 200);
      logBuffer.push(short);
      if (logBuffer.length > 20) logBuffer.shift();
    } catch { /* noop */ }
  };
  // Normalize the app password — Google displays it with spaces
  // ("xxxx xxxx xxxx xxxx") and Railway sometimes preserves or strips them
  // inconsistently. IMAP servers accept the flat form, so strip whitespace
  // defensively.
  const cleanPass = (appPassword || "").replace(/\s+/g, "");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass: cleanPass },
    logger: {
      debug: pushLog, info: pushLog, warn: pushLog, error: pushLog,
    },
  });

  try {
    try {
      await client.connect();
      trace.push({ step: "imap-connected", detail: `as ${user}` });
    } catch (e) {
      const recent = logBuffer.slice(-8).join(" | ");
      trace.push({ step: "imap-connect-failed", detail: `${(e as Error).message} — recentLog=${recent}` });
      throw new Error(`IMAP connect failed: ${(e as Error).message}. Recent log: ${recent}`);
    }
    // Search INBOX first, fall back to All Mail if nothing matches —
    // Gmail's IMAP puts everything in "[Gmail]/All Mail" even when
    // filters auto-archive the message out of INBOX.
    const mailboxesToTry = ["INBOX", "[Gmail]/All Mail"];
    const afterCutoff = afterTimestamp - 60 * 1000;
    const loggedSubjects = new Set<string>();

    for (let attempt = 0; attempt < 18; attempt++) {
      for (const mbName of mailboxesToTry) {
        let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
        try {
          lock = await client.getMailboxLock(mbName);
        } catch {
          continue; // Skip mailboxes that don't exist on this account.
        }
        try {
          // Broad search — recent messages from any Guesty-related sender.
          // We include Okta since Okta sometimes sends the code on behalf of
          // enterprise tenants under a login.<brand>.com domain.
          const uids = await client.search({ since: new Date(afterCutoff) });
          if (!uids || uids.length === 0) continue;

          // Fetch newest-first so we prefer fresh codes on resends.
          for (const uid of uids.slice().reverse().slice(0, 25)) {
            const msg = await client.fetchOne(uid as number, { envelope: true, source: true });
            const fromAddr = (msg.envelope?.from?.[0]?.address || "").toLowerCase();
            const subject = msg.envelope?.subject || "";
            const dateMs = msg.envelope?.date?.getTime() ?? 0;

            // Log every recent subject at most once so we can see what
            // Gmail sees, even if we skip it as non-matching.
            const logKey = `${mbName}|${subject}|${dateMs}`;
            if (!loggedSubjects.has(logKey) && dateMs >= afterCutoff) {
              loggedSubjects.add(logKey);
              trace.push({ step: "mfa-inbox-peek", detail: `mb=${mbName} from=${fromAddr} subj=${subject.slice(0, 80)} date=${new Date(dateMs).toISOString()}` });
            }

            if (dateMs < afterCutoff) continue;
            const isGuesty = /guesty\.com|okta\.com|login\.guesty/i.test(fromAddr)
              || /guesty|verification/i.test(subject);
            if (!isGuesty) continue;

            const body = msg.source?.toString("utf8") ?? "";
            const flat = body.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
            // Extract HTML/text body section (skip MIME headers + transport
            // metadata) so our regex isn't matching random Message-IDs etc.
            // Also strip HTML tags so nearby-text regex sees visible content.
            const afterHeaders = flat.split(/\r?\n\r?\n/).slice(1).join("\n\n");
            const visible = afterHeaders.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
            // Try increasingly specific patterns. Report which one hit so we
            // can keep tightening if Guesty's format shifts.
            const patterns: Array<{ label: string; re: RegExp }> = [
              { label: "code-is", re: /\bcode\s*(?:is|:)\s*(\d{6})\b/i },
              { label: "verification-is", re: /\bverification\s*code\s*(?:is|:)\s*(\d{6})\b/i },
              { label: "one-time-is", re: /\bone[-\s]?time\s*(?:code|password|pin)?\s*(?:is|:)\s*(\d{6})\b/i },
              { label: "enter-this-code", re: /\benter\s*(?:this|the)\s*code[^0-9]{0,40}(\d{6})\b/i },
              { label: "standalone-in-visible", re: /(?:^|[>\s])(\d{6})(?:[<\s]|$)/ },
            ];
            for (const { label, re } of patterns) {
              const m = visible.match(re);
              if (m?.[1]) {
                lock.release();
                trace.push({ step: "mfa-code-extracted", detail: `pattern=${label} code=${m[1]} mb=${mbName} from=${fromAddr}` });
                return m[1];
              }
            }
            // No match yet — log a body preview so we can diagnose the
            // actual format of Guesty's email next run.
            trace.push({
              step: "mfa-code-not-in-body",
              detail: `from=${fromAddr} subj=${subject.slice(0,60)} visiblePreview=${visible.slice(0, 400).replace(/\s+/g, " ")}`,
            });
          }
        } finally {
          lock.release();
        }
      }
      trace.push({ step: "mfa-code-poll", detail: `attempt ${attempt + 1}/18 no-match-yet` });
      await new Promise((r) => setTimeout(r, 5000));
    }
    return null;
  } finally {
    await client.logout().catch(() => {});
  }
}

// Hardcoded listing URLs per community. Primary is scraped first; fallback is tried if primary fails.
// All other communities fall back to Google Images search.
const COMMUNITY_SOURCE_URLS: Record<string, { primary: string; fallback?: string }> = {
  "Regency at Poipu Kai": {
    primary: "https://www.zillow.com/homedetails/1831-Poipu-Rd-APT-823-Koloa-HI-96756/80152954_zpid/",
    fallback: "https://www.homes.com/property/1831-poipu-rd-koloa-hi-unit-720/gy46glh43cckm/",
  },
};

// Maps communityPhotoFolder folder names to their display community names
const COMMUNITY_FOLDER_TO_NAME: Record<string, string> = {
  "community-regency-poipu-kai": "Regency at Poipu Kai",
  "community-kekaha-estate": "Kekaha Beachfront Estate",
  "community-keauhou-estates": "Keauhou Estates",
  "community-mauna-kai": "Mauna Kai Princeville",
  "community-kaha-lani": "Kaha Lani Resort",
  "community-lae-nani": "Lae Nani Resort",
  "community-poipu-beachside": "Poipu Brenneckes Beachside",
  "community-kaiulani": "Kaiulani of Princeville",
  "community-poipu-oceanfront": "Poipu Brenneckes Oceanfront",
  "community-pili-mai": "Pili Mai",
};

// Street address fragment for each community — used to find individual
// Zillow unit listings via Google Images. Kept in sync with the
// address: field on each unit-builder-data.ts entry.
const COMMUNITY_FOLDER_TO_ADDRESS: Record<string, string> = {
  "community-regency-poipu-kai": "1831 Poipu Rd",           // Regency at Poipu Kai
  "community-kekaha-estate": "8497 Kekaha Rd",              // Kekaha Beachfront Estate
  "community-keauhou-estates": "78-6855 Ali'i Dr",          // Keauhou Estates
  "community-mauna-kai": "3920 Wyllie Rd",                  // Mauna Kai Princeville
  "community-kaha-lani": "4460 Nehe Rd",                    // Kaha Lani Resort
  "community-lae-nani": "410 Papaloa Rd",                   // Lae Nani Resort
  "community-poipu-beachside": "2298 Ho'one Rd",            // Poipu Brenneckes Beachside
  "community-kaiulani": "4100 Queen Emma's Dr",             // Kaiulani of Princeville
  "community-poipu-oceanfront": "2350 Ho'one Rd",           // Poipu Brenneckes Oceanfront
  "community-pili-mai": "2611 Kiahuna Plantation Dr",       // Pili Mai at Poipu
};

interface ScrapedPhoto {
  url: string;
  title: string;
  source: string;
  sourceLink: string;
}

// Structured listing facts (bed/bath counts) pulled from the scraper's
// response. Callers pass a mutable object and read it after the scrape —
// this keeps scrapeListingPhotos' photo-array return signature stable for
// the ~8 existing callers while letting new callers opt into the metadata.
export interface ListingFacts {
  bedrooms?: number;
  bathrooms?: number;
}

// Pick plausible bed/bath counts from a Zillow scraper payload. The various
// actor schemas expose them under different paths (`bedrooms`, `resoFacts.
// bedrooms`, `hdpData.homeInfo.bedrooms`), but they all use the same field
// names — so a depth-bounded walk that takes the first numeric value at the
// shallowest depth is robust across schemas. Ignore 0/negative/huge values
// to skip obvious junk like per-unit sub-records with zeroed fields.
function extractListingFacts(payload: any): ListingFacts {
  const facts: ListingFacts = {};
  function walk(o: any, depth: number): void {
    if (depth > 8 || !o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
    if (facts.bedrooms == null && typeof o.bedrooms === "number" && o.bedrooms > 0 && o.bedrooms < 50) {
      facts.bedrooms = Math.round(o.bedrooms);
    }
    if (facts.bathrooms == null) {
      // Prefer the most-precise field we can find. `bathrooms` carries the
      // 2.5 / 3.5 half-bath increments; `bathroomsFull` + `bathroomsHalf`
      // reconstructs the same value when the combined field is absent.
      // `bathroomsTotalInteger` is the last-resort integer-only fallback.
      let b: number | undefined;
      if (typeof o.bathrooms === "number") b = o.bathrooms;
      else if (typeof o.bathroomsFull === "number") {
        b = o.bathroomsFull + (typeof o.bathroomsHalf === "number" ? o.bathroomsHalf * 0.5 : 0);
      } else if (typeof o.bathroomsTotalInteger === "number") b = o.bathroomsTotalInteger;
      if (typeof b === "number" && b > 0 && b < 50) {
        // Snap to nearest 0.5 — Zillow half-baths are always multiples of
        // 0.5, so a non-half fractional is almost certainly noise.
        facts.bathrooms = Math.round(b * 2) / 2;
      }
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  }
  walk(payload, 0);
  return facts;
}

// Fallback 1: JSON-LD structured data. Many real-estate pages include a
// schema.org SingleFamilyResidence / Apartment / House object with
// numberOfRooms / numberOfBedrooms / numberOfBathroomsTotal fields. This is
// independent of __NEXT_DATA__ — useful when the Next hydration payload is
// missing (stripped by a proxy) but the JSON-LD block survived.
function extractFactsFromJsonLd(html: string): ListingFacts {
  const out: ListingFacts = {};
  const matches = Array.from(html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
  for (const m of matches) {
    try {
      const parsed = JSON.parse(m[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of items) {
        if (!obj || typeof obj !== "object") continue;
        const bd = obj.numberOfBedrooms ?? obj.numberOfRooms;
        const ba = obj.numberOfBathroomsTotal ?? obj.numberOfFullBathrooms;
        if (out.bedrooms == null && typeof bd === "number" && bd > 0 && bd < 50) {
          out.bedrooms = Math.round(bd);
        }
        if (out.bathrooms == null && typeof ba === "number" && ba > 0 && ba < 50) {
          out.bathrooms = Math.floor(ba);
        }
      }
    } catch {}
  }
  return out;
}

// Fallback 2: regex on the visible HTML text. Last-resort layer — ignores
// DOM structure entirely and just scans for Zillow's human-visible bed/bath
// phrases. Works even if the page layout changes completely, as long as
// Zillow still renders "3 bd" / "2 ba" / "3 beds" / "2 baths" somewhere.
// Only run on HTML where the primary structured sources produced nothing,
// because casual text matches can pick up prose like "2 bedroom suites
// nearby" that aren't the subject property.
function extractFactsFromText(html: string): ListingFacts {
  // Strip HTML tags so we're matching against visible text, not attribute
  // values. Simple regex is fine — false positives from stripped attribute
  // text would have to coincidentally contain "N bed" / "N bath" phrasing.
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const out: ListingFacts = {};
  const bedMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:beds?\b|bd\b|bedrooms?\b)/i);
  const bathMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:baths?\b|ba\b|bathrooms?\b)/i);
  if (bedMatch) {
    const n = parseFloat(bedMatch[1]);
    if (n > 0 && n < 50) out.bedrooms = Math.round(n);
  }
  if (bathMatch) {
    const n = parseFloat(bathMatch[1]);
    if (n > 0 && n < 50) out.bathrooms = Math.round(n * 2) / 2;
  }
  return out;
}

// Merge facts from a higher-priority source into a lower-priority one
// (primary wins on conflict; fill gaps from fallback).
function mergeFacts(primary: ListingFacts, fallback: ListingFacts): ListingFacts {
  return {
    bedrooms: primary.bedrooms ?? fallback.bedrooms,
    bathrooms: primary.bathrooms ?? fallback.bathrooms,
  };
}

// Read photos from the specific known-good keys on a Zillow listing
// payload, preserving the order the upstream actor returned them.
// Looks at (in priority order):
//   - item.responsivePhotos:    [{ mixedSources: { jpeg: [{ url, width }] } }]
//   - item.originalPhotos:      same shape, alternate actor output
//   - item.photos:              [{ url }] or [url]
//   - item.hdpData.homeInfo.responsivePhotos (legacy hdpData wrapper)
// Returns an ORDERED array of URLs — the best resolution variant of each
// photo in the order Zillow itself presents them.
function extractOrderedPhotosFromListingItem(item: any): string[] {
  if (!item || typeof item !== "object") return [];
  const pickBiggest = (jpegs: Array<{ url?: string; width?: number }>): string | null => {
    if (!Array.isArray(jpegs) || jpegs.length === 0) return null;
    const biggest = jpegs.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a), jpegs[0]);
    return biggest.url ?? null;
  };
  const candidates = [
    item.responsivePhotos,
    item.originalPhotos,
    item.hdpData?.homeInfo?.responsivePhotos,
    item.hdpData?.homeInfo?.originalPhotos,
  ];
  for (const arr of candidates) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const out: string[] = [];
    for (const rp of arr) {
      const jpegUrl = pickBiggest(rp?.mixedSources?.jpeg);
      if (jpegUrl) out.push(jpegUrl);
    }
    if (out.length > 0) return out;
  }
  // Flat URL array fallback.
  if (Array.isArray(item.photos) && item.photos.length > 0) {
    const out: string[] = [];
    for (const p of item.photos) {
      const url = typeof p === "string" ? p : p?.url;
      if (url && /zillowstatic\.com/.test(url)) out.push(url);
    }
    if (out.length > 0) return out;
  }
  return [];
}

// Depth-limited walker over a SINGLE listing item (not the whole dataset).
// Used only as a last-resort fallback when the named paths above yield
// nothing — a schema-change safety net. Still skips keys we know contain
// side-panel content (similar homes, nearby schools, etc.).
function walkForPhotosScoped(item: any, out: string[]): void {
  const skipKeys = new Set([
    "similarHomes", "nearbyHomes", "nearbySchools", "priceHistory",
    "relatedHomes", "collections", "agentListings", "comparableHomes",
  ]);
  function walk(obj: any, depth: number): void {
    if (depth > 8 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { obj.forEach((v) => walk(v, depth + 1)); return; }
    if (obj.mixedSources?.jpeg && Array.isArray(obj.mixedSources.jpeg)) {
      const jpegs: Array<{ url?: string; width?: number }> = obj.mixedSources.jpeg;
      if (jpegs.length > 0) {
        const biggest = jpegs.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a), jpegs[0]);
        if (biggest.url) out.push(biggest.url);
      }
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (skipKeys.has(k)) continue;
      if (typeof v === "string") {
        if (/^https?:\/\/photos?\.zillowstatic\.com\//i.test(v) && /\.(jpg|jpeg|png|webp)/i.test(v)) {
          out.push(v);
        }
      } else {
        walk(v, depth + 1);
      }
    }
  }
  walk(item, 0);
}

// Fetch Zillow listing photos via Apify. Pay-per-result (~$0.005 each) is
// 50-80× cheaper than ScrapingBee's credit model for our low volume.
// Requires APIFY_API_TOKEN on the env. APIFY_ZILLOW_ACTOR picks which
// actor to run — defaults to maxcopell/zillow-detail-scraper which takes
// a list of Zillow URLs and returns full listing JSON including photos.
async function scrapeZillowViaApify(url: string): Promise<{ urls: string[]; facts: ListingFacts }> {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    console.warn(`[scrapeZillow:Apify] APIFY_API_TOKEN not set`);
    return { urls: [], facts: {} };
  }
  const actor = (process.env.APIFY_ZILLOW_ACTOR || "maxcopell~zillow-detail-scraper").replace("/", "~");
  try {
    // run-sync-get-dataset-items blocks until the actor finishes and returns
    // the dataset as JSON in one call. Perfect for a single-URL lookup.
    const api = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    const r = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startUrls: [{ url }] }),
      signal: AbortSignal.timeout(180_000), // cold-start + scrape can take 60-120s
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.warn(`[scrapeZillow:Apify] HTTP ${r.status} ${body.slice(0, 300)}`);
      return { urls: [], facts: {} };
    }
    const items: any[] = await r.json().catch(() => []);
    if (!Array.isArray(items) || items.length === 0) {
      console.warn(`[scrapeZillow:Apify] empty dataset for ${url}`);
      return { urls: [], facts: {} };
    }
    const facts = extractListingFacts(items);

    // Read photos from the SPECIFIC known-good keys on the listing item,
    // in the order the upstream actor returned them. The previous version
    // walked the entire payload pulling any zillowstatic.com URL — which
    // swept in photos from "similar homes", "nearby schools", map
    // thumbnails, and other side-panel content, inflating a 16-photo
    // listing to 21+. Photos are ORDERED here (preserving what Zillow
    // itself presents as the photo carousel).
    const found = extractOrderedPhotosFromListingItem(items[0]);
    // Safety: if the primary paths came up empty, fall back to a scoped
    // walk on the item (not the whole payload). Almost never triggers
    // with the current actor but future schema churn stays behind a
    // depth-limited, item-local crawl instead of a full-dataset dig.
    if (found.length === 0) {
      walkForPhotosScoped(items[0], found);
    }

    // Hash-dedupe only collapses SIZE VARIANTS of the same photo (same
    // /fp/<hash>- prefix) — it never discards distinct listing photos,
    // because Zillow's own photo list is already de-duplicated.
    const hashRe = /\/fp\/([a-f0-9]{16,})-/i;
    const byHash = new Map<string, { url: string; score: number; pos: number }>();
    const scoreForUrl = (u: string): number => {
      const sizeMatch = u.match(/_(?:cc_ft_|uncropped_scaled_within_)?(\d{3,4})\./i);
      if (sizeMatch) return parseInt(sizeMatch[1], 10);
      if (/-p_h\./i.test(u)) return 1200;
      if (/-p_f\./i.test(u)) return 1024;
      if (/-p_e\./i.test(u)) return 800;
      if (/-p_d\./i.test(u)) return 600;
      return 0;
    };
    for (let i = 0; i < found.length; i++) {
      const u = found[i];
      const m = u.match(hashRe);
      if (!m) continue;
      const hash = m[1];
      const score = scoreForUrl(u);
      const prev = byHash.get(hash);
      if (!prev) {
        byHash.set(hash, { url: u, score, pos: i });
      } else if (score > prev.score) {
        byHash.set(hash, { url: u, score, pos: prev.pos });  // keep original position
      }
    }
    // Sort by original position so Zillow's ordering is preserved.
    const uniq = Array.from(byHash.values())
      .sort((a, b) => a.pos - b.pos)
      .map((v) => v.url);
    console.log(`[scrapeZillow:Apify] ${url} → ${found.length} raw → ${uniq.length} unique photos (facts: ${facts.bedrooms ?? "?"}BR / ${facts.bathrooms ?? "?"}BA)`);
    return { urls: uniq, facts };
  } catch (e: any) {
    console.warn(`[scrapeZillow:Apify] ${url}: ${e?.message ?? e}`);
    return { urls: [], facts: {} };
  }
}

async function scrapeZillowViaScrapingBee(url: string): Promise<{ urls: string[]; facts: ListingFacts }> {
  const key = process.env.SCRAPINGBEE_API_KEY;
  if (!key) {
    console.warn(`[scrapeZillow:SB] SCRAPINGBEE_API_KEY not set`);
    return { urls: [], facts: {} };
  }
  try {
    const params = new URLSearchParams({
      api_key: key,
      url,
      render_js: "true",
      stealth_proxy: "true",
      country_code: "us",
      // Speed up: skip images/fonts/styles while waiting for hydration.
      block_resources: "true",
    });
    const r = await fetch(`https://app.scrapingbee.com/api/v1/?${params.toString()}`, {
      signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.warn(`[scrapeZillow:SB] HTTP ${r.status} ${body.slice(0, 200)}`);
      return { urls: [], facts: {} };
    }
    const html = await r.text();
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    let nd: any = null;
    let factsMethod = "none";
    let facts: ListingFacts = {};
    const uniq: string[] = [];

    // Tier 1 (preferred): __NEXT_DATA__ — structured data from Next.js SSR.
    // Narrow to the target listing's own photo array using the same
    // extractor as the Apify path; only fall back to a scoped walk if
    // the primary paths come up empty. This prevents pulling in photos
    // from similar-homes / nearby / map side panels that live elsewhere
    // in the same __NEXT_DATA__ payload.
    if (match) {
      try { nd = JSON.parse(match[1]); } catch {}
      if (nd) {
        const out: string[] = [];
        // Zillow's __NEXT_DATA__ embeds the listing under a few possible
        // paths depending on page variant. Try them in order, then walk
        // the first subtree that looks like a home-info object.
        const candidatePaths = [
          nd?.props?.pageProps?.componentProps?.gdpClientCache,
          nd?.props?.pageProps?.initialData?.data?.homeInfo,
          nd?.props?.pageProps?.initialData?.data,
          nd?.props?.pageProps?.initialData,
          nd?.props?.pageProps,
        ];
        for (const candidate of candidatePaths) {
          if (!candidate) continue;
          // gdpClientCache is sometimes JSON-stringified further; parse
          // it if so. Keys inside look like "HomeDetailsQuery:..." with
          // objects containing `property: { responsivePhotos: [...] }`.
          let obj: any = candidate;
          if (typeof candidate === "string") {
            try { obj = JSON.parse(candidate); } catch { continue; }
          }
          // If it's the gdpClientCache shape, each top-level key maps to
          // an entry with a `property` field.
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            for (const v of Object.values(obj)) {
              const prop = (v as any)?.property ?? v;
              const photos = extractOrderedPhotosFromListingItem(prop);
              if (photos.length > 0) { out.push(...photos); break; }
            }
          }
          if (out.length === 0) {
            const direct = extractOrderedPhotosFromListingItem(obj);
            if (direct.length > 0) out.push(...direct);
          }
          if (out.length > 0) break;
        }
        // Safety net: scoped walk on nd if the named paths yielded
        // nothing. Still better than walking the whole payload — at
        // least it stops at skipKeys.
        if (out.length === 0) walkForPhotosScoped(nd, out);

        const hashRe = /\/fp\/([a-f0-9]{16,})-/i;
        const seenHashes = new Set<string>();
        for (const u of out) {
          const m2 = u.match(hashRe);
          const key = m2 ? m2[1] : u;
          if (seenHashes.has(key)) continue;
          seenHashes.add(key);
          uniq.push(u);
        }
        facts = extractListingFacts(nd);
        if (facts.bedrooms != null || facts.bathrooms != null) factsMethod = "__NEXT_DATA__";
      }
    } else {
      console.warn(`[scrapeZillow:SB] ${url}: no __NEXT_DATA__ blob (html length ${html.length})`);
    }

    // Tier 2 (fallback): JSON-LD. Runs when __NEXT_DATA__ is absent or
    // produced no bed/bath numbers. Fills gaps without overwriting.
    if (facts.bedrooms == null || facts.bathrooms == null) {
      const jsonLd = extractFactsFromJsonLd(html);
      const merged = mergeFacts(facts, jsonLd);
      if ((merged.bedrooms != null && facts.bedrooms == null) ||
          (merged.bathrooms != null && facts.bathrooms == null)) {
        factsMethod = factsMethod === "none" ? "json-ld" : `${factsMethod}+json-ld`;
      }
      facts = merged;
    }

    // Tier 3 (last resort): regex on visible HTML text. Bulletproof against
    // DOM redesigns — matches any "3 beds / 2 baths" phrasing in the body.
    if (facts.bedrooms == null || facts.bathrooms == null) {
      const textFacts = extractFactsFromText(html);
      const merged = mergeFacts(facts, textFacts);
      if ((merged.bedrooms != null && facts.bedrooms == null) ||
          (merged.bathrooms != null && facts.bathrooms == null)) {
        factsMethod = factsMethod === "none" ? "text-regex" : `${factsMethod}+text-regex`;
      }
      facts = merged;
    }

    if (uniq.length === 0 && facts.bedrooms == null && facts.bathrooms == null) {
      return { urls: [], facts: {} };
    }
    console.log(`[scrapeZillow:SB] ${url} → ${uniq.length} photos (facts: ${facts.bedrooms ?? "?"}BR / ${facts.bathrooms ?? "?"}BA via ${factsMethod})`);
    return { urls: uniq, facts };
  } catch (e: any) {
    console.warn(`[scrapeZillow:SB] ${url}: ${e?.message ?? e}`);
    return { urls: [], facts: {} };
  }
}

// scrapeListingPhotos optionally populates the caller's `listingFacts` object
// with the scraper-extracted bed/bath counts. Existing callers that don't
// pass one are unaffected. New callers (notably the rescrape handler) use
// these counts as ground truth over photo-based inference.
async function scrapeListingPhotos(
  primaryUrl: string,
  fallbackUrl?: string,
  listingFacts?: ListingFacts,
): Promise<ScrapedPhoto[]> {
  // Zillow URLs: run Apify and ScrapingBee in PARALLEL and union the
  // results. Each scraper sometimes returns an incomplete photo set for a
  // listing (different Zillow page variants, Apify actor quirks, cache
  // staleness). Running both doubles our coverage — ScrapingBee routinely
  // picks up photos Apify misses and vice versa. The MD5 byte-dedupe in
  // the download pipeline drops anything byte-identical, and the Zillow
  // URL-hash dedupe below collapses the same-photo-different-variant case.
  //
  // Cost: ~$0.005 (Apify) + ~1 ScrapingBee credit per rescrape. Worth it —
  // scraper under-coverage was the top remaining cause of missing
  // bedrooms/bathrooms in the e2e tests.
  // Apify first; ScrapingBee only as a fallback when Apify returns empty.
  // The earlier parallel-union approach was meant to improve coverage but
  // introduced the opposite problem: each scraper sometimes surfaces
  // different photos (including side-panel content from the same page),
  // so unioning inflated a 16-photo listing to 20+. With the walkers now
  // narrowed to the listing's own `responsivePhotos` array, a single
  // scraper returns exactly what Zillow shows — no need to union.
  if (/zillow\.com/i.test(primaryUrl)) {
    let result = await scrapeZillowViaApify(primaryUrl);
    if (result.urls.length === 0 && process.env.SCRAPINGBEE_API_KEY) {
      console.log(`[scrapeZillow] Apify returned 0, falling back to ScrapingBee`);
      result = await scrapeZillowViaScrapingBee(primaryUrl);
    }
    if (listingFacts) {
      if (result.facts.bedrooms != null) listingFacts.bedrooms = result.facts.bedrooms;
      if (result.facts.bathrooms != null) listingFacts.bathrooms = result.facts.bathrooms;
    }
    if (result.urls.length > 0) {
      return result.urls.map((u) => ({ url: u, title: "Zillow listing photo", source: "Zillow", sourceLink: primaryUrl }));
    }
    if (!fallbackUrl || /zillow\.com/i.test(fallbackUrl)) return [];
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    let navigatedUrl: string | null = null;

    // Try primary URL
    try {
      const resp = await page.goto(primaryUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
      if (resp && resp.status() < 400) navigatedUrl = primaryUrl;
    } catch (_) {}

    // Try fallback if primary failed
    if (!navigatedUrl && fallbackUrl) {
      try {
        const resp = await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
        if (resp && resp.status() < 400) navigatedUrl = fallbackUrl;
      } catch (_) {}
    }

    if (!navigatedUrl) return [];

    // Wait briefly for lazy-loaded images
    await page.waitForTimeout(2500);

    const currentUrl = page.url();
    const isZillow = currentUrl.includes("zillow.com");
    const isHomes = currentUrl.includes("homes.com");
    const sourceName = isZillow ? "Zillow" : isHomes ? "Homes.com" : new URL(currentUrl).hostname;

    let photoUrls: string[] = [];

    // --- Zillow: extract from __NEXT_DATA__ JSON blob (most reliable) ---
    if (isZillow) {
      photoUrls = await page.evaluate(() => {
        const nd = (window as any).__NEXT_DATA__;
        if (!nd) return [];
        const urls: string[] = [];

        function walk(obj: any, depth: number): void {
          if (depth > 14 || !obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) { obj.forEach(v => walk(v, depth + 1)); return; }
          // Zillow photo format: { mixedSources: { jpeg: [{url, width}, ...] } }
          if (obj.mixedSources?.jpeg && Array.isArray(obj.mixedSources.jpeg)) {
            const jpegs: Array<{ url: string; width?: number }> = obj.mixedSources.jpeg;
            if (jpegs.length > 0) {
              const biggest = jpegs.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a), jpegs[0]);
              if (biggest.url) urls.push(biggest.url);
            }
            return;
          }
          Object.values(obj).forEach(v => walk(v, depth + 1));
        }

        walk(nd, 0);
        return [...new Set(urls)];
      }).catch(() => [] as string[]);
    }

    // --- Homes.com / generic fallback: JSON-LD + img tags ---
    if (photoUrls.length === 0) {
      photoUrls = await page.evaluate(() => {
        const candidates: string[] = [];

        // JSON-LD structured data often has image arrays
        document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
          try {
            function pickImgs(obj: any): void {
              if (!obj || typeof obj !== "object") return;
              const imgs = obj.image ? (Array.isArray(obj.image) ? obj.image : [obj.image]) : [];
              imgs.forEach((img: any) => {
                if (typeof img === "string") candidates.push(img);
                else if (img?.url) candidates.push(img.url);
              });
              Object.values(obj).forEach(v => pickImgs(v));
            }
            pickImgs(JSON.parse(el.textContent || "{}"));
          } catch (_) {}
        });

        // img tags — collect src / data-src
        document.querySelectorAll("img").forEach(img => {
          const src = img.src || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || "";
          if (src.startsWith("http")) candidates.push(src);
        });

        return [...new Set(candidates)];
      }).catch(() => [] as string[]);
    }

    // Filter out icons/logos/SVGs/GIFs and format
    const results: ScrapedPhoto[] = photoUrls
      .filter(url => {
        const u = url.toLowerCase();
        return !u.endsWith(".svg") && !u.endsWith(".gif")
          && !u.includes("logo") && !u.includes("icon") && !u.includes("sprite")
          && !u.includes("placeholder") && url.startsWith("http");
      })
      .map(url => ({
        url,
        title: `${sourceName} listing photo`,
        source: sourceName,
        sourceLink: navigatedUrl!,
      }));

    return results;
  } finally {
    await browser.close();
  }
}

// ========== AI MAKEOVER JOB SYSTEM ==========
interface MakeoverJobPhoto {
  index: number;
  zipName: string;
  localPath: string;
  servePath: string;
  shouldProcess: boolean;
  status: "pending" | "processing" | "done" | "failed";
  resultBuffer?: Buffer;
}
interface MakeoverJob {
  name: string;
  status: "running" | "done" | "error";
  photos: MakeoverJobPhoto[];
  processedCount: number;
  totalCount: number;
  interiorCount: number;
  zipBuffer?: Buffer;
  error?: string;
  listeners: Set<any>;
  createdAt: number;
}
const makeoverJobs = new Map<string, MakeoverJob>();
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of makeoverJobs) {
    if (job.createdAt < cutoff) makeoverJobs.delete(id);
  }
}, 30 * 60 * 1000);

function emitJobEvent(jobId: string, data: object) {
  const job = makeoverJobs.get(jobId);
  if (!job) return;
  const line = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of job.listeners) { try { res.write(line); } catch (_) {} }
}

const EXTERIOR_KW = ["pool","community","exterior","outside","beach","ocean","view","patio","balcony","garden","yard","front","aerial","court","tennis","hot-tub","hottub","resort","grounds","walkway","entrance","driveway"];

// Any unit photo that isn't obviously exterior is treated as interior (makeover candidate).
// Generic filenames like photo_00.jpg default to interior since community/exterior photos
// are always served from the communityFolder (shouldProcess=false) not unit folders.
function isInteriorPhotoKw(filename: string): boolean {
  const lower = filename.toLowerCase();
  return !EXTERIOR_KW.some(k => lower.includes(k));
}

function getFilenamePromptKw(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes("bedroom") || lower.includes("master") || lower.includes("bed"))
    return "luxurious master bedroom, king bed with crisp white linens, coastal decor, bright natural light through large windows, modern furniture";
  if (lower.includes("kitchen"))
    return "modern vacation rental kitchen, white shaker cabinets, stainless steel appliances, quartz countertops, bright and clean, coastal style";
  if (lower.includes("bathroom") || lower.includes("bath"))
    return "luxury vacation rental bathroom, marble tiles, rainfall shower, modern fixtures, bright spa-like lighting";
  if (lower.includes("living") || lower.includes("lounge") || lower.includes("great"))
    return "elegant vacation rental living room, comfortable linen sofas, coastal modern decor, large windows with natural light, bright and airy";
  if (lower.includes("dining"))
    return "bright vacation rental dining room, wooden farmhouse table, upholstered chairs, pendant lighting, natural light";
  if (lower.includes("loft"))
    return "airy vacation rental loft space, comfortable seating, natural light from skylights, modern coastal decor";
  return "luxury vacation rental interior, modern coastal style, bright natural light, high-end furniture, professional real estate photography";
}

async function describeWithClaudeKw(imageBuffer: Buffer, mimeType: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022", max_tokens: 250,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBuffer.toString("base64") } },
          { type: "text", text: "Describe this vacation rental interior for an AI image generation prompt. Focus on: room type, furniture style, color palette, lighting, and overall aesthetic. Be specific, under 180 words, no preamble." },
        ]}],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return (data.content?.[0]?.text as string) || null;
  } catch { return null; }
}

async function generateWithStabilityKw(prompt: string): Promise<Buffer | null> {
  const key = process.env.STABILITY_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        text_prompts: [
          { text: `${prompt}, luxury vacation rental, professional real estate photography, bright natural light, 4K`, weight: 1 },
          { text: "low quality, blurry, dark, cluttered, people, text, watermark, bad anatomy", weight: -1 },
        ],
        cfg_scale: 7, height: 1024, width: 1024, samples: 1, steps: 30,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const b64 = data.artifacts?.[0]?.base64 as string | undefined;
    return b64 ? Buffer.from(b64, "base64") : null;
  } catch { return null; }
}

// Retry a Replicate POST up to maxRetries times on 429 rate-limit responses.
async function replicatePostWithRetry(url: string, key: string, body: object, label: string, maxRetries = 4): Promise<Response> {
  const headers = { "Authorization": `Token ${key}`, "Content-Type": "application/json", "Prefer": "wait=60" };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (resp.status !== 429) return resp;
    if (attempt === maxRetries) {
      console.error(`[${label}] Still rate-limited after ${maxRetries} retries — giving up`);
      return resp;
    }
    let retryAfter = 15;
    try { const j = await resp.json() as any; retryAfter = Math.min((j?.retry_after || 15) + 3, 90); } catch (_) {}
    console.log(`[${label}] 429 rate-limit (attempt ${attempt + 1}/${maxRetries + 1}) — waiting ${retryAfter}s...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
  }
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function generateWithReplicateKw(prompt: string): Promise<Buffer | null> {
  const key = process.env.REPLICATE_API_KEY;
  if (!key) { console.error("[flux] No REPLICATE_API_KEY set"); return null; }
  try {
    const createResp = await replicatePostWithRetry(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
      key,
      {
        input: {
          prompt: `${prompt}, luxury vacation rental interior, professional real estate photography, bright natural light, 4K high resolution`,
          num_outputs: 1,
          aspect_ratio: "1:1",
          output_quality: 90,
          num_inference_steps: 4,
        },
      },
      "flux"
    );
    if (!createResp.ok) {
      let errText = "";
      try { errText = await createResp.text(); } catch (_) {}
      console.error("[flux] Create failed:", createResp.status, errText);
      return null;
    }
    const prediction = await createResp.json() as { id?: string; status: string; output?: string[] | string; error?: string };
    console.log("[flux] Prediction response: status=", prediction.status, "id=", prediction.id, "error=", prediction.error, "output=", JSON.stringify(prediction.output)?.substring(0, 120));
    if (prediction.error) { console.error("[flux] Prediction error:", prediction.error); return null; }
    const extractUrl = (output: string[] | string | undefined): string | null => {
      if (!output) return null;
      if (Array.isArray(output)) return output[0] || null;
      if (typeof output === "string") return output;
      return null;
    };
    const downloadUrl = (status: string, output: string[] | string | undefined): string | null =>
      status === "succeeded" ? extractUrl(output) : null;
    const immediateUrl = downloadUrl(prediction.status, prediction.output);
    if (immediateUrl) {
      console.log("[sdxl] Immediate success, downloading from:", immediateUrl.substring(0, 80));
      const imgResp = await fetch(immediateUrl);
      if (!imgResp.ok) { console.error("[sdxl] Image download failed:", imgResp.status); return null; }
      return Buffer.from(await imgResp.arrayBuffer());
    }
    if (prediction.id) {
      console.log("[sdxl] Polling prediction:", prediction.id);
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
          headers: { "Authorization": `Token ${key}` },
        });
        const result = await pollResp.json() as { status: string; output?: string[] | string; error?: string };
        if (i % 10 === 0) console.log("[sdxl] Poll", i, "status=", result.status);
        if (result.error) { console.error("[sdxl] Poll error:", result.error); return null; }
        const pollUrl = downloadUrl(result.status, result.output);
        if (pollUrl) {
          console.log("[sdxl] Poll success at attempt", i, ", downloading");
          const imgResp = await fetch(pollUrl);
          if (!imgResp.ok) { console.error("[sdxl] Poll image download failed:", imgResp.status); return null; }
          return Buffer.from(await imgResp.arrayBuffer());
        }
        if (result.status === "failed" || result.status === "canceled") {
          console.error("[sdxl] Prediction failed/canceled at poll", i);
          return null;
        }
      }
      console.error("[sdxl] Timed out after 120s polling");
    }
    return null;
  } catch (err: any) {
    console.error("[sdxl] Exception:", err?.message || err);
    return null;
  }
}

async function upscaleWithReplicateKw(imageBuffer: Buffer, mimeType: string): Promise<Buffer | null> {
  const key = process.env.REPLICATE_API_KEY;
  if (!key) return null;
  try {
    const b64 = imageBuffer.toString("base64");
    const dataUri = `data:${mimeType};base64,${b64}`;
    const createResp = await replicatePostWithRetry(
      "https://api.replicate.com/v1/models/nightmareai/real-esrgan/predictions",
      key,
      { input: { image: dataUri, scale: 2, face_enhance: false } },
      "upscale"
    );
    if (!createResp.ok) {
      let errText = "";
      try { errText = await createResp.text(); } catch (_) {}
      console.error("[upscale] Replicate Real-ESRGAN error:", createResp.status, errText);
      return null;
    }
    const prediction = await createResp.json() as { id?: string; status: string; output?: string; error?: string };
    const resolveOutput = async (p: typeof prediction): Promise<Buffer | null> => {
      if (p.status === "succeeded" && p.output) {
        const imgResp = await fetch(p.output);
        if (!imgResp.ok) return null;
        return Buffer.from(await imgResp.arrayBuffer());
      }
      return null;
    };
    const quick = await resolveOutput(prediction);
    if (quick) return quick;
    if (prediction.id) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
          headers: { "Authorization": `Token ${key}` },
        });
        const result = await pollResp.json() as { status: string; output?: string; error?: string };
        if (result.status === "succeeded" && result.output) {
          const imgResp = await fetch(result.output);
          if (!imgResp.ok) return null;
          return Buffer.from(await imgResp.arrayBuffer());
        }
        if (result.status === "failed") { console.error("[upscale] Real-ESRGAN failed:", result.error); return null; }
      }
    }
    return null;
  } catch (err) { console.error("[upscale] exception:", err); return null; }
}

async function processPhotoWithAIKw(imageBuffer: Buffer, mimeType: string, filename: string): Promise<Buffer | null> {
  const claudeDesc = await describeWithClaudeKw(imageBuffer, mimeType);
  const prompt = claudeDesc || getFilenamePromptKw(filename);
  console.log(`[makeover-job] ${filename} → prompt: ${prompt.substring(0, 80)}...`);
  const generated = await (async () => {
    const stability = await generateWithStabilityKw(prompt);
    if (stability) return stability;
    return generateWithReplicateKw(prompt);
  })();
  if (!generated) return null;
  // Upscale the generated image 2x for higher resolution output
  console.log(`[makeover-job] ${filename} → upscaling 2x...`);
  const upscaled = await upscaleWithReplicateKw(generated, "image/jpeg");
  return upscaled || generated;
}

async function runMakeoverJob(jobId: string): Promise<void> {
  const job = makeoverJobs.get(jobId);
  if (!job) return;
  try {
    const zip = new JSZip();
    for (const photo of job.photos) {
      if (!fs.existsSync(photo.localPath)) {
        photo.status = "failed";
        emitJobEvent(jobId, { type: "photo_done", index: photo.index, status: "failed", hasResult: false, processedCount: job.processedCount });
        continue;
      }
      const rawData = fs.readFileSync(photo.localPath);
      const ext = path.extname(photo.localPath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : "image/jpeg";

      // Upscale every photo (interior and exterior) with Real-ESRGAN 2x.
      // This enhances the real photos without replacing their content.
      photo.status = "processing";
      emitJobEvent(jobId, { type: "photo_start", index: photo.index, total: job.totalCount, zipName: photo.zipName, servePath: photo.servePath });
      console.log(`[makeover-job] ${photo.zipName} → upscaling 2x (Real-ESRGAN)...`);
      const upscaled = await upscaleWithReplicateKw(rawData, mimeType);
      const finalBuffer = upscaled || rawData;
      photo.resultBuffer = upscaled || undefined;
      photo.status = "done";
      if (upscaled) job.processedCount++;
      zip.file(photo.zipName.replace(/\.(jpg|jpeg|png)$/i, ".jpg"), finalBuffer);

      emitJobEvent(jobId, { type: "photo_done", index: photo.index, status: photo.status, hasResult: !!photo.resultBuffer, processedCount: job.processedCount });
    }
    job.zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    job.status = "done";
    emitJobEvent(jobId, { type: "complete", processedCount: job.processedCount, totalCount: job.totalCount, interiorCount: job.interiorCount });
  } catch (err: any) {
    job.status = "error";
    job.error = err.message;
    emitJobEvent(jobId, { type: "error", message: err.message });
  }
  for (const res of job.listeners) { try { res.end(); } catch (_) {} }
  job.listeners.clear();
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/photos/zip-multi", async (req, res) => {
    const foldersParam = req.query.folders as string;
    const name = (req.query.name as string) || "all-photos";
    const communityFolder = (req.query.communityFolder as string || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const beginningPhotos = (req.query.beginningPhotos as string || "").split(",").filter(Boolean);
    const endPhotos = (req.query.endPhotos as string || "").split(",").filter(Boolean);

    if (!foldersParam) {
      return res.status(400).json({ error: "Missing folders query parameter" });
    }

    const folders = foldersParam.split(",").map(f => f.replace(/[^a-zA-Z0-9_-]/g, "")).filter(Boolean);
    if (folders.length === 0) {
      return res.status(400).json({ error: "No valid folders specified" });
    }

    const zip = new JSZip();
    let totalFiles = 0;
    let globalIndex = 1;
    const photosBase = path.join(process.cwd(), "client", "public", "photos");

    const addFileToZip = (filePath: string, zipName: string) => {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        zip.file(zipName, data);
        totalFiles++;
      }
    };

    if (communityFolder && beginningPhotos.length > 0) {
      const communityDir = path.join(photosBase, communityFolder);
      for (const photo of beginningPhotos) {
        const safePhoto = photo.replace(/[^a-zA-Z0-9_.-]/g, "");
        const paddedIndex = String(globalIndex).padStart(3, "0");
        const ext = path.extname(safePhoto);
        const baseName = path.basename(safePhoto, ext).replace(/^\d+-/, "");
        addFileToZip(path.join(communityDir, safePhoto), `${paddedIndex}-community-${baseName}${ext}`);
        globalIndex++;
      }
    }

    for (const folder of folders) {
      const photosDir = path.join(photosBase, folder);
      if (!fs.existsSync(photosDir)) continue;
      const files = fs.readdirSync(photosDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
      for (const file of files) {
        const paddedIndex = String(globalIndex).padStart(3, "0");
        const ext = path.extname(file);
        const baseName = path.basename(file, ext).replace(/^\d+-/, "");
        addFileToZip(path.join(photosDir, file), `${paddedIndex}-${folder}-${baseName}${ext}`);
        globalIndex++;
      }
    }

    if (communityFolder && endPhotos.length > 0) {
      const communityDir = path.join(photosBase, communityFolder);
      for (const photo of endPhotos) {
        const safePhoto = photo.replace(/[^a-zA-Z0-9_.-]/g, "");
        const paddedIndex = String(globalIndex).padStart(3, "0");
        const ext = path.extname(safePhoto);
        const baseName = path.basename(safePhoto, ext).replace(/^\d+-/, "");
        addFileToZip(path.join(communityDir, safePhoto), `${paddedIndex}-community-${baseName}${ext}`);
        globalIndex++;
      }
    }

    if (totalFiles === 0) {
      return res.status(404).json({ error: "No photos found" });
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "");
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeName}-photos.zip"`,
      "Content-Length": String(zipBuffer.length),
    });
    res.send(zipBuffer);
  });

  app.get("/api/photos/zip/:folder", async (req, res) => {
    const folder = req.params.folder.replace(/[^a-zA-Z0-9_-]/g, "");
    const photosDir = path.join(process.cwd(), "client", "public", "photos", folder);

    if (!fs.existsSync(photosDir)) {
      return res.status(404).json({ error: "Photo folder not found" });
    }

    const files = fs.readdirSync(photosDir).filter(f => f.endsWith(".jpg") || f.endsWith(".png") || f.endsWith(".jpeg"));
    if (files.length === 0) {
      return res.status(404).json({ error: "No photos found in folder" });
    }

    const zip = new JSZip();
    for (const file of files) {
      const filePath = path.join(photosDir, file);
      const data = fs.readFileSync(filePath);
      zip.file(file, data);
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${folder}-photos.zip"`,
      "Content-Length": String(zipBuffer.length),
    });
    res.send(zipBuffer);
  });

  // AI photo makeover: uses Claude vision to describe each interior photo, then generates
  // a new luxury-style version via Stability AI or Replicate SDXL. Returns a ZIP.
  app.post("/api/photos/ai-makeover", async (req, res) => {
    const replicateKey = process.env.REPLICATE_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const stabilityKey = process.env.STABILITY_API_KEY;

    if (!replicateKey && !stabilityKey) {
      return res.status(500).json({ error: "No AI image generation API key configured (need REPLICATE_API_KEY or STABILITY_API_KEY)" });
    }

    const { folders, communityFolder, beginningPhotos, endPhotos, name } = req.body as {
      folders: string[];
      communityFolder?: string;
      beginningPhotos?: string[];
      endPhotos?: string[];
      name?: string;
    };

    if (!folders || folders.length === 0) {
      return res.status(400).json({ error: "No folders provided" });
    }

    const photosBase = path.join(process.cwd(), "client", "public", "photos");

    // Interior keywords → these photos get AI treatment
    const interiorKeywords = ["living", "bedroom", "kitchen", "dining", "bathroom", "lounge", "family", "master", "bed", "bath", "office", "room", "interior", "sofa", "couch", "great-room", "great_room", "greatroom", "overview", "detail", "area", "space", "hallway", "foyer", "entry", "loft"];
    // Exterior keywords → pass through unchanged
    const exteriorKeywords = ["pool", "community", "exterior", "outside", "beach", "ocean", "view", "patio", "balcony", "garden", "yard", "front", "aerial", "court", "tennis", "hot-tub", "hottub"];

    function isInteriorWithFurniture(filename: string): boolean {
      const lower = filename.toLowerCase();
      if (exteriorKeywords.some(k => lower.includes(k))) return false;
      return interiorKeywords.some(k => lower.includes(k));
    }

    function getFilenamePrompt(filename: string): string {
      const lower = filename.toLowerCase();
      if (lower.includes("bedroom") || lower.includes("master") || lower.includes("bed"))
        return "luxurious master bedroom, king bed with crisp white linens, coastal decor, bright natural light through large windows, modern furniture";
      if (lower.includes("kitchen"))
        return "modern vacation rental kitchen, white shaker cabinets, stainless steel appliances, quartz countertops, bright and clean, coastal style";
      if (lower.includes("bathroom") || lower.includes("bath"))
        return "luxury vacation rental bathroom, marble tiles, rainfall shower, modern fixtures, bright spa-like lighting";
      if (lower.includes("living") || lower.includes("lounge") || lower.includes("great"))
        return "elegant vacation rental living room, comfortable linen sofas, coastal modern decor, large windows with natural light, bright and airy";
      if (lower.includes("dining"))
        return "bright vacation rental dining room, wooden farmhouse table, upholstered chairs, pendant lighting, natural light";
      if (lower.includes("loft"))
        return "airy vacation rental loft space, comfortable seating, natural light from skylights, modern coastal decor";
      return "luxury vacation rental interior, modern coastal style, bright natural light, high-end furniture, professional real estate photography";
    }

    // --- Step 1: Describe image with Claude vision (optional enhancement) ---
    async function describeWithClaude(imageBuffer: Buffer, mimeType: string): Promise<string | null> {
      if (!anthropicKey) return null;
      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 250,
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mimeType, data: imageBuffer.toString("base64") } },
                { type: "text", text: "Describe this vacation rental interior for an AI image generation prompt. Focus on: room type, furniture style, color palette, lighting, and overall aesthetic. Be specific, under 180 words, no preamble." },
              ],
            }],
          }),
        });
        if (!resp.ok) return null;
        const data = await resp.json() as any;
        return (data.content?.[0]?.text as string) || null;
      } catch {
        return null;
      }
    }

    // --- Step 2a: Generate with Stability AI ---
    async function generateWithStabilityAI(prompt: string): Promise<Buffer | null> {
      if (!stabilityKey) return null;
      try {
        const resp = await fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": `Bearer ${stabilityKey}`,
          },
          body: JSON.stringify({
            text_prompts: [
              { text: `${prompt}, luxury vacation rental, professional real estate photography, bright natural light, 4K`, weight: 1 },
              { text: "low quality, blurry, dark, cluttered, people, text, watermark, bad anatomy", weight: -1 },
            ],
            cfg_scale: 7,
            height: 1024,
            width: 1024,
            samples: 1,
            steps: 30,
          }),
        });
        if (!resp.ok) {
          console.error("Stability AI error:", resp.status, await resp.text());
          return null;
        }
        const data = await resp.json() as any;
        const b64 = data.artifacts?.[0]?.base64 as string | undefined;
        return b64 ? Buffer.from(b64, "base64") : null;
      } catch (err) {
        console.error("Stability AI exception:", err);
        return null;
      }
    }

    // --- Step 2b: Generate with Replicate SDXL text-to-image ---
    async function generateWithReplicate(prompt: string): Promise<Buffer | null> {
      if (!replicateKey) return null;
      try {
        const createResp = await fetch("https://api.replicate.com/v1/models/stability-ai/sdxl/predictions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${replicateKey}`,
            "Content-Type": "application/json",
            "Prefer": "wait=60",
          },
          body: JSON.stringify({
            input: {
              prompt: `${prompt}, luxury vacation rental, professional real estate photography, bright natural light, 4K high resolution`,
              negative_prompt: "low quality, blurry, dark, cluttered, people, text, watermark, deformed",
              width: 1024,
              height: 1024,
              num_inference_steps: 25,
              guidance_scale: 7.5,
              scheduler: "K_EULER",
            },
          }),
        });

        if (!createResp.ok) {
          console.error("Replicate SDXL error:", createResp.status, await createResp.text());
          return null;
        }

        const prediction = await createResp.json() as { id?: string; status: string; output?: string[]; error?: string };

        // Synchronous success (Prefer: wait hit)
        if (prediction.status === "succeeded" && prediction.output?.length) {
          const imgResp = await fetch(prediction.output[0]);
          if (!imgResp.ok) return null;
          return Buffer.from(await imgResp.arrayBuffer());
        }

        // Fall back to polling if still processing
        if (prediction.id) {
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
              headers: { "Authorization": `Bearer ${replicateKey}` },
            });
            const result = await pollResp.json() as { status: string; output?: string[]; error?: string };
            if (result.status === "succeeded" && result.output?.length) {
              const imgResp = await fetch(result.output[0]);
              if (!imgResp.ok) return null;
              return Buffer.from(await imgResp.arrayBuffer());
            }
            if (result.status === "failed") {
              console.error("Replicate prediction failed:", result.error);
              return null;
            }
          }
        }
        return null;
      } catch (err) {
        console.error("Replicate exception:", err);
        return null;
      }
    }

    // --- Orchestrate: describe → generate ---
    async function processPhotoWithAI(imageBuffer: Buffer, mimeType: string, filename: string): Promise<Buffer | null> {
      // Get a description from Claude if available, otherwise derive from filename
      const claudeDesc = await describeWithClaude(imageBuffer, mimeType);
      const prompt = claudeDesc || getFilenamePrompt(filename);
      console.log(`[ai-makeover] ${filename} → prompt: ${prompt.substring(0, 80)}...`);

      // Try Stability AI first, then fall back to Replicate
      const stabilityResult = await generateWithStabilityAI(prompt);
      if (stabilityResult) return stabilityResult;

      return await generateWithReplicate(prompt);
    }

    // Collect all image file paths with their desired ZIP names
    interface PhotoEntry {
      filePath: string;
      zipName: string;
      shouldProcess: boolean;
    }

    const allPhotos: PhotoEntry[] = [];
    let globalIndex = 1;

    // Community beginning photos (never process — resort amenities)
    if (communityFolder && beginningPhotos && beginningPhotos.length > 0) {
      const communityDir = path.join(photosBase, communityFolder);
      for (const photo of beginningPhotos) {
        const safePhoto = photo.replace(/[^a-zA-Z0-9_.-]/g, "");
        const paddedIndex = String(globalIndex).padStart(3, "0");
        const ext = path.extname(safePhoto);
        const baseName = path.basename(safePhoto, ext).replace(/^\d+-/, "");
        allPhotos.push({ filePath: path.join(communityDir, safePhoto), zipName: `${paddedIndex}-community-${baseName}${ext}`, shouldProcess: false });
        globalIndex++;
      }
    }

    // Unit photos
    for (const folder of folders) {
      const safeFolder = folder.replace(/[^a-zA-Z0-9_-]/g, "");
      const photosDir = path.join(photosBase, safeFolder);
      if (!fs.existsSync(photosDir)) continue;
      const files = fs.readdirSync(photosDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
      for (const file of files) {
        const paddedIndex = String(globalIndex).padStart(3, "0");
        const ext = path.extname(file);
        const baseName = path.basename(file, ext).replace(/^\d+-/, "");
        allPhotos.push({ filePath: path.join(photosDir, file), zipName: `${paddedIndex}-${safeFolder}-${baseName}${ext}`, shouldProcess: isInteriorWithFurniture(file) });
        globalIndex++;
      }
    }

    // Community end photos (never process)
    if (communityFolder && endPhotos && endPhotos.length > 0) {
      const communityDir = path.join(photosBase, communityFolder);
      for (const photo of endPhotos) {
        const safePhoto = photo.replace(/[^a-zA-Z0-9_.-]/g, "");
        const paddedIndex = String(globalIndex).padStart(3, "0");
        const ext = path.extname(safePhoto);
        const baseName = path.basename(safePhoto, ext).replace(/^\d+-/, "");
        allPhotos.push({ filePath: path.join(photosBase, communityFolder, safePhoto), zipName: `${paddedIndex}-community-${baseName}${ext}`, shouldProcess: false });
        globalIndex++;
      }
    }

    const validPhotos = allPhotos.filter(p => fs.existsSync(p.filePath));
    if (validPhotos.length === 0) {
      return res.status(404).json({ error: "No photos found" });
    }

    const processCount = validPhotos.filter(p => p.shouldProcess).length;
    res.setHeader("X-Photos-Total", String(validPhotos.length));
    res.setHeader("X-Photos-Processing", String(processCount));

    // Process all photos
    const zip = new JSZip();
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const photo of validPhotos) {
      const rawData = fs.readFileSync(photo.filePath);
      const ext = path.extname(photo.filePath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : "image/jpeg";

      if (photo.shouldProcess) {
        console.log(`[ai-makeover] Processing: ${photo.zipName}`);
        const result = await processPhotoWithAI(rawData, mimeType, photo.zipName);
        if (result) {
          zip.file(photo.zipName.replace(/\.(jpg|jpeg|png)$/i, ".jpg"), result);
          processed++;
        } else {
          zip.file(photo.zipName, rawData);
          failed++;
          console.warn(`[ai-makeover] Fell back to original for: ${photo.zipName}`);
        }
      } else {
        zip.file(photo.zipName, rawData);
        skipped++;
      }
    }

    console.log(`[ai-makeover] Done: ${processed} AI-generated, ${skipped} passed through, ${failed} fell back to original`);

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const safeName = (name || "ai-makeover").replace(/[^a-zA-Z0-9_-]/g, "");
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeName}-ai-makeover.zip"`,
      "Content-Length": String(zipBuffer.length),
      "X-Photos-Processed": String(processed),
      "X-Photos-Skipped": String(skipped),
      "X-Photos-Failed": String(failed),
    });
    res.send(zipBuffer);
  });

  // ========== JOB-BASED AI MAKEOVER (SSE progress) ==========
  app.post("/api/photos/ai-makeover/start", async (req, res) => {
    const { folders, communityFolder, beginningPhotos, endPhotos, name } = req.body as {
      folders: string[];
      communityFolder?: string;
      beginningPhotos?: string[];
      endPhotos?: string[];
      name?: string;
    };
    if (!folders || folders.length === 0) return res.status(400).json({ error: "No folders provided" });

    const photosBase = path.join(process.cwd(), "client", "public", "photos");
    const allPhotos: MakeoverJobPhoto[] = [];
    let globalIndex = 0;

    if (communityFolder && beginningPhotos && beginningPhotos.length > 0) {
      const communityDir = path.join(photosBase, communityFolder);
      for (const photo of beginningPhotos) {
        const safePhoto = photo.replace(/[^a-zA-Z0-9_.-]/g, "");
        const ext = path.extname(safePhoto);
        const baseName = path.basename(safePhoto, ext).replace(/^\d+-/, "");
        const paddedIndex = String(globalIndex + 1).padStart(3, "0");
        allPhotos.push({ index: globalIndex++, zipName: `${paddedIndex}-community-${baseName}${ext}`, localPath: path.join(communityDir, safePhoto), servePath: `/photos/${communityFolder}/${safePhoto}`, shouldProcess: false, status: "pending" });
      }
    }
    for (const folder of folders) {
      const safeFolder = folder.replace(/[^a-zA-Z0-9_-]/g, "");
      const photosDir = path.join(photosBase, safeFolder);
      if (!fs.existsSync(photosDir)) continue;
      const files = fs.readdirSync(photosDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
      for (const file of files) {
        const ext = path.extname(file);
        const baseName = path.basename(file, ext).replace(/^\d+-/, "");
        const paddedIndex = String(globalIndex + 1).padStart(3, "0");
        allPhotos.push({ index: globalIndex++, zipName: `${paddedIndex}-${safeFolder}-${baseName}${ext}`, localPath: path.join(photosDir, file), servePath: `/photos/${safeFolder}/${file}`, shouldProcess: isInteriorPhotoKw(file), status: "pending" });
      }
    }
    if (communityFolder && endPhotos && endPhotos.length > 0) {
      const communityDir = path.join(photosBase, communityFolder);
      for (const photo of endPhotos) {
        const safePhoto = photo.replace(/[^a-zA-Z0-9_.-]/g, "");
        const ext = path.extname(safePhoto);
        const baseName = path.basename(safePhoto, ext).replace(/^\d+-/, "");
        const paddedIndex = String(globalIndex + 1).padStart(3, "0");
        allPhotos.push({ index: globalIndex++, zipName: `${paddedIndex}-community-${baseName}${ext}`, localPath: path.join(photosBase, communityFolder, safePhoto), servePath: `/photos/${communityFolder}/${safePhoto}`, shouldProcess: false, status: "pending" });
      }
    }

    const interiorCount = allPhotos.filter(p => p.shouldProcess).length;
    const jobId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const job: MakeoverJob = { name: name || "ai-makeover", status: "running", photos: allPhotos, processedCount: 0, totalCount: allPhotos.length, interiorCount, listeners: new Set(), createdAt: Date.now() };
    makeoverJobs.set(jobId, job);
    runMakeoverJob(jobId).catch(err => {
      const j = makeoverJobs.get(jobId);
      if (j) { j.status = "error"; j.error = err.message; }
    });
    res.json({ jobId, totalCount: allPhotos.length, interiorCount, photos: allPhotos.map(p => ({ index: p.index, zipName: p.zipName, servePath: p.servePath, isInterior: p.shouldProcess })) });
  });

  app.get("/api/photos/ai-makeover/events/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = makeoverJobs.get(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    for (const photo of job.photos) {
      if (photo.status !== "pending") {
        res.write(`data: ${JSON.stringify({ type: "photo_done", index: photo.index, status: photo.status, hasResult: !!photo.resultBuffer, processedCount: job.processedCount })}\n\n`);
      }
    }
    if (job.status === "done") {
      res.write(`data: ${JSON.stringify({ type: "complete", processedCount: job.processedCount, totalCount: job.totalCount, interiorCount: job.interiorCount })}\n\n`);
      res.end(); return;
    }
    if (job.status === "error") {
      res.write(`data: ${JSON.stringify({ type: "error", message: job.error })}\n\n`);
      res.end(); return;
    }
    job.listeners.add(res);
    const keepAlive = setInterval(() => { try { res.write(":keep-alive\n\n"); } catch (_) {} }, 15000);
    req.on("close", () => { clearInterval(keepAlive); job.listeners.delete(res); });
  });

  app.get("/api/photos/ai-makeover/result/:jobId/photo/:index", (req, res) => {
    const { jobId, index } = req.params;
    const job = makeoverJobs.get(jobId);
    if (!job) return res.status(404).end();
    const photo = job.photos[parseInt(index, 10)];
    if (!photo || !photo.resultBuffer) return res.status(404).end();
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(photo.resultBuffer);
  });

  app.get("/api/photos/ai-makeover/download/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = makeoverJobs.get(jobId);
    if (!job || !job.zipBuffer) return res.status(job ? 202 : 404).json({ error: job ? "Still processing" : "Not found" });
    const safeName = job.name.replace(/[^a-zA-Z0-9_-]/g, "");
    res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${safeName}-ai-makeover.zip"`, "Content-Length": String(job.zipBuffer.length) });
    res.send(job.zipBuffer);
  });

  app.get("/api/photos/find-replacement", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SearchAPI not configured" });
    const { communityName, location, bedrooms } = req.query as Record<string, string>;
    if (!communityName || !location) return res.status(400).json({ error: "communityName and location required" });
    try {
      const bedroomsLabel = bedrooms ? `${bedrooms} bedroom ` : "";
      const query = `${bedroomsLabel}${communityName} ${location} vacation rental condo interior`;
      const params = new URLSearchParams({ engine: "google_images", q: query, api_key: apiKey, num: "20", safe: "active" });
      const response = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
      if (!response.ok) return res.status(500).json({ error: "Image search failed" });
      const data = await response.json() as any;
      const images = (data.images_results || [])
        .filter((img: any) => { const src = (img.original || img.thumbnail || "").toLowerCase(); return !src.includes("airbnb") && !src.includes("vrbo") && !src.includes("booking.com") && src; })
        .slice(0, 12)
        .map((img: any) => ({ url: img.original || img.thumbnail, thumbnail: img.thumbnail || img.original, label: img.title || "Replacement photo", source: img.source || "" }));
      res.json({ images });
    } catch (err: any) { res.status(500).json({ error: "Find replacement failed", message: err.message }); }
  });

  // ── Guesty OAuth token plumbing ─────────────────────────────────────────────
  // All token caching now lives in server/guesty-token.ts (DB-backed + file
  // fallback + in-memory + refresh dedup). This replaces the old per-file
  // caches that kept getting wiped by Railway's ephemeral filesystem.

  app.get("/api/guesty-property-map", async (_req, res) => {
    try {
      const map = await storage.getGuestyPropertyMap();
      res.json(map);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch Guesty property map", message: err.message });
    }
  });

  // POST /api/guesty-property-map — connect a propertyId (positive for
  // hardcoded units, negative `-draftId` for promoted drafts) to an
  // existing Guesty listing. Idempotent: re-POSTing for the same
  // propertyId rewrites the mapping. Used by the dashboard's "Connect
  // to Guesty" action on the gray G-dot.
  app.post("/api/guesty-property-map", async (req, res) => {
    try {
      const { propertyId, guestyListingId } = req.body as {
        propertyId?: unknown; guestyListingId?: unknown;
      };
      if (typeof propertyId !== "number" || !Number.isInteger(propertyId)) {
        return res.status(400).json({ error: "propertyId (integer) required" });
      }
      if (typeof guestyListingId !== "string" || !guestyListingId.trim()) {
        return res.status(400).json({ error: "guestyListingId (non-empty string) required" });
      }
      const row = await storage.upsertGuestyPropertyMap(propertyId, guestyListingId.trim());
      res.json(row);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to upsert Guesty property map", message: err.message });
    }
  });

  // GET /api/dashboard/channel-status
  //
  // Returns per-propertyId channel status for every mapped property in one
  // Guesty call, so the home dashboard can render Airbnb/VRBO/Booking.com
  // live/not-live indicators without N separate listing fetches.
  //
  // Response: { [propertyId: number]: {
  //   airbnb: { connected: boolean; live: boolean },
  //   vrbo:   { connected: boolean; live: boolean },
  //   bookingCom: { connected: boolean; live: boolean },
  // }}
  //
  // "connected" = integration exists with either an ID field or status ==
  //               COMPLETED / connected. "live" = connected AND listing.
  //               isListed == true (matches the client-side ChannelInfo
  //               semantics in services/guestyService.ts toInfo).
  app.get("/api/dashboard/channel-status", async (_req, res) => {
    try {
      const map = await storage.getGuestyPropertyMap();
      if (map.length === 0) return res.json({});
      // Single Guesty read across all mapped listings. fields= limits
      // payload so we don't ship full listing bodies back.
      const resp = await guestyRequest(
        "GET",
        `/listings?limit=200&fields=_id%20integrations%20isListed`,
      ) as { results?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
      const listings = Array.isArray(resp) ? resp : (resp.results ?? []);
      const byId = new Map<string, Record<string, unknown>>(
        listings.map((l) => [l._id as string, l]),
      );

      const evalChannel = (d: Record<string, unknown> | undefined, isListed: boolean) => {
        const idFields = ["id", "listingId", "propertyId", "hotelId", "advertiserId"];
        const hasId = !!d && idFields.some((k) => !!d[k]);
        const status = d?.status as string | undefined;
        const isCompleted = status === "COMPLETED" || status === "connected";
        const connected = hasId || isCompleted;
        // `syncFailed` means the integration record exists (so the listing
        // technically has a presence on the channel) but Guesty's most
        // recent sync attempt errored out. From the operator's POV that
        // means the channel isn't reliably bookable — Airbnb/VRBO may be
        // serving stale or partial listing data. Rendered amber on the
        // dashboard so it stands out from a clean green "live" cell.
        const syncFailed = connected && status === "FAILED";
        return { connected, live: connected && isListed, syncFailed };
      };

      const findIntegration = (
        integrations: Array<Record<string, unknown>>,
        platformKeys: string[],
      ): Record<string, unknown> | undefined => {
        const entry = integrations.find((i) =>
          platformKeys.includes(i.platform as string),
        );
        if (!entry) return undefined;
        const key = entry.platform as string;
        return entry[key] as Record<string, unknown> | undefined;
      };

      const result: Record<number, { airbnb: ReturnType<typeof evalChannel>; vrbo: ReturnType<typeof evalChannel>; bookingCom: ReturnType<typeof evalChannel> }> = {};
      for (const m of map) {
        const listing = byId.get(m.guestyListingId);
        if (!listing) continue;
        const integrations = Array.isArray(listing.integrations)
          ? (listing.integrations as Array<Record<string, unknown>>)
          : [];
        const isListed = !!listing.isListed;
        result[m.propertyId] = {
          airbnb:     evalChannel(findIntegration(integrations, ["airbnb2", "airbnb"]), isListed),
          vrbo:       evalChannel(findIntegration(integrations, ["homeaway2", "homeaway", "vrbo"]), isListed),
          bookingCom: evalChannel(findIntegration(integrations, ["bookingCom2", "bookingCom", "booking_com"]), isListed),
        };
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch channel status", message: err.message });
    }
  });

  app.post("/api/guesty-token", async (_req, res) => {
    try {
      const token = await getGuestyToken();
      const status = await getGuestyTokenStatus();
      return res.json({ access_token: token, expires_in: status.expiresInSeconds ?? 86400 });
    } catch (err: any) {
      if (err instanceof RateLimitedError) {
        return res.status(429).json({ error: "RATE_LIMITED", message: err.message });
      }
      return res.status(500).json({ error: "Guesty auth failed", message: err.message });
    }
  });

  // Admin: diagnostic + manual override for the token cache.
  // When Guesty's /oauth2/token is rate-limiting you, grab a fresh token from
  // Guesty's UI (or any working API call's Authorization header) and POST it
  // here to unstick the app without redeploying.
  app.get("/api/admin/guesty-token/status", async (_req, res) => {
    try {
      const s = await getGuestyTokenStatus();
      res.json(s);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/admin/guesty-token/set", async (req, res) => {
    const { token, expiresInSeconds } = req.body as { token?: string; expiresInSeconds?: number };
    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "token (string) required" });
    }
    const ttl = Math.max(60, Math.min(86400, Number(expiresInSeconds) || 86400));
    try {
      await setGuestyTokenManually(token, ttl);
      const status = await getGuestyTokenStatus();
      res.json({ success: true, source: status.source, expiresInSeconds: status.expiresInSeconds });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Guesty API proxy ─────────────────────────────────────────────────────────
  // All Guesty Open API calls are routed through here so the browser never needs
  // to call Guesty directly — avoids CORS issues and keeps the token server-side.
  // Usage: GET /api/guesty-proxy/listings?limit=5
  //        PUT /api/guesty-proxy/listings/:id
  //        etc. — maps 1:1 to https://open-api.guesty.com/v1/*
  app.all("/api/guesty-proxy/*path", async (req: Request, res: Response) => {
    // Shared token module handles memory/DB/file caching + refresh dedup.
    let token: string;
    try {
      token = await getGuestyToken();
    } catch (err: any) {
      if (err instanceof RateLimitedError) {
        return res.status(429).json({ error: "RATE_LIMITED", message: err.message });
      }
      return res.status(500).json({ error: "Guesty auth error", message: err.message });
    }

    // ── Forward request to Guesty ────────────────────────────────────────────
    // Strip the "/api/guesty-proxy" prefix to get the Guesty API path
    const guestyPath = req.path.replace(/^\/api\/guesty-proxy/, "") || "/";
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const url = `https://open-api.guesty.com/v1${guestyPath}${qs ? "?" + qs : ""}`;

    const fetchOptions: RequestInit = {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };

    if (req.method !== "GET" && req.method !== "HEAD" && req.body && Object.keys(req.body).length > 0) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    try {
      const guestyRes = await fetch(url, fetchOptions);

      if (guestyRes.status === 204) {
        return res.status(204).send();
      }

      const contentType = guestyRes.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await guestyRes.json();
        return res.status(guestyRes.status).json(data);
      } else {
        const text = await guestyRes.text();
        return res.status(guestyRes.status).send(text);
      }
    } catch (err: any) {
      return res.status(502).json({ error: "Guesty proxy error", message: err.message });
    }
  });

  // ========== BUY-IN CRUD ==========

  app.get("/api/buy-ins", async (_req, res) => {
    try {
      const buyIns = await storage.getBuyIns();
      res.json(buyIns);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch buy-ins", message: err.message });
    }
  });

  app.get("/api/buy-ins/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const buyIn = await storage.getBuyIn(id);
      if (!buyIn) return res.status(404).json({ error: "Buy-in not found" });
      res.json(buyIn);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch buy-in", message: err.message });
    }
  });

  app.post("/api/buy-ins", async (req, res) => {
    try {
      const parsed = insertBuyInSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid buy-in data", details: parsed.error.flatten() });
      }
      const buyIn = await storage.createBuyIn(parsed.data);
      res.status(201).json(buyIn);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to create buy-in", message: err.message });
    }
  });

  app.patch("/api/buy-ins/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const allowed = ["propertyId", "unitId", "propertyName", "unitLabel", "checkIn", "checkOut", "costPaid", "airbnbConfirmation", "airbnbListingUrl", "notes", "status"];
      const filtered: Record<string, any> = {};
      for (const key of allowed) {
        if (key in req.body) filtered[key] = req.body[key];
      }
      if (filtered.costPaid !== undefined) {
        const cost = parseFloat(String(filtered.costPaid));
        if (isNaN(cost) || cost < 0) return res.status(400).json({ error: "Invalid costPaid" });
        filtered.costPaid = String(cost);
      }
      if (filtered.checkIn && !/^\d{4}-\d{2}-\d{2}$/.test(filtered.checkIn)) {
        return res.status(400).json({ error: "Invalid checkIn date format (YYYY-MM-DD)" });
      }
      if (filtered.checkOut && !/^\d{4}-\d{2}-\d{2}$/.test(filtered.checkOut)) {
        return res.status(400).json({ error: "Invalid checkOut date format (YYYY-MM-DD)" });
      }
      const buyIn = await storage.updateBuyIn(id, filtered);
      if (!buyIn) return res.status(404).json({ error: "Buy-in not found" });
      res.json(buyIn);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to update buy-in", message: err.message });
    }
  });

  app.delete("/api/buy-ins/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const deleted = await storage.deleteBuyIn(id);
      if (!deleted) return res.status(404).json({ error: "Buy-in not found" });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to delete buy-in", message: err.message });
    }
  });

  // POST /api/admin/cleanup-removed-properties
  // One-shot cleanup after the 2026-04 condo-only pivot. Deletes every DB row
  // tied to propertyIds that were stripped from PROPERTY_UNIT_CONFIGS.
  // Idempotent — safe to run multiple times. Returns counts per table.
  app.post("/api/admin/cleanup-removed-properties", async (_req, res) => {
    const REMOVED_PROPERTY_IDS = [7, 10, 12, 14, 21, 26, 28, 31, 36];
    try {
      // Lazy-import drizzle helpers + tables so we don't pay the import cost
      // on every request.
      const { db } = await import("./db");
      const { inArray } = await import("drizzle-orm");
      const { buyIns, guestyPropertyMap, availabilityScans, unitSwaps } = await import("@shared/schema");

      const buyInsDeleted = await db
        .delete(buyIns)
        .where(inArray(buyIns.propertyId, REMOVED_PROPERTY_IDS))
        .returning({ id: buyIns.id });

      const mapsDeleted = await db
        .delete(guestyPropertyMap)
        .where(inArray(guestyPropertyMap.propertyId, REMOVED_PROPERTY_IDS))
        .returning({ id: guestyPropertyMap.id });

      const scansDeleted = await db
        .delete(availabilityScans)
        .where(inArray(availabilityScans.propertyId, REMOVED_PROPERTY_IDS))
        .returning({ id: availabilityScans.id });

      let swapsDeleted: { id: number }[] = [];
      try {
        swapsDeleted = await db
          .delete(unitSwaps)
          .where(inArray(unitSwaps.propertyId, REMOVED_PROPERTY_IDS))
          .returning({ id: unitSwaps.id });
      } catch {
        // unit_swaps may not exist or may not have propertyId — safe to skip
      }

      return res.json({
        removedPropertyIds: REMOVED_PROPERTY_IDS,
        buyIns: buyInsDeleted.length,
        guestyPropertyMap: mapsDeleted.length,
        availabilityScans: scansDeleted.length,
        unitSwaps: swapsDeleted.length,
      });
    } catch (err: any) {
      console.error("[admin/cleanup] error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ========== OPERATIONS: FIND BUY-IN ACROSS ALL SOURCES ==========
  //
  // Fan-out search across Airbnb, Vrbo/Booking.com, and Google-discovered
  // property-management companies for a given community + date range + bedroom
  // count. Returns unified, price-sorted candidates so the host can pick the
  // cheapest option to buy in at.
  //
  // GET /api/operations/find-buy-in?propertyId=X&bedrooms=N&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD
  // Response:
  //   {
  //     community, nights, dates,
  //     sources: { airbnb: [...], vrbo: [...], booking: [...], pm: [...] },
  //     cheapest: [top 2 cross-source by nightly price]
  //   }
  app.get("/api/operations/find-buy-in", async (req: Request, res: Response) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const propertyId = parseInt(req.query.propertyId as string, 10);
    const bedrooms = parseInt(req.query.bedrooms as string, 10);
    const checkIn = req.query.checkIn as string;
    const checkOut = req.query.checkOut as string;

    if (!propertyId || isNaN(propertyId)) return res.status(400).json({ error: "propertyId required" });
    if (!bedrooms || isNaN(bedrooms)) return res.status(400).json({ error: "bedrooms required" });
    if (!checkIn || !checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
      return res.status(400).json({ error: "checkIn and checkOut required (YYYY-MM-DD)" });
    }

    const config = PROPERTY_UNIT_NEEDS[propertyId];
    if (!config) return res.status(404).json({ error: "Property not in config" });

    const community = config.community;
    const nights = Math.max(1, Math.round((new Date(checkOut + "T12:00:00").getTime() - new Date(checkIn + "T12:00:00").getTime()) / 86_400_000));
    const searchLocation = COMMUNITY_SEARCH_LOCATIONS[community] || `${community}, Hawaii`;
    const vrboDestination = COMMUNITY_VRBO_DESTINATIONS[community] || `${community}, Hawaii`;
    const bounds = COMMUNITY_BOUNDS[community];

    // ── Resort-name resolution ───────────────────────────────────────────
    // The whole business model is combining two units IN THE SAME RESORT.
    // A generic "Kapaa, Hawaii" search catches anything in that area — not
    // useful. Look up the Guesty listing title and extract the resort name
    // from it (e.g. "Kaha Lani - 5BR Oceanfront - Sleeps 14" → "Kaha Lani").
    let resortName: string | null = null;
    let listingTitle: string | null = null;
    try {
      const guestyListingId = await storage.getGuestyListingId(propertyId);
      if (guestyListingId) {
        const listing = await guestyRequest("GET", `/listings/${guestyListingId}?fields=title%20nickname`) as any;
        listingTitle = listing?.title ?? listing?.nickname ?? null;
        if (listingTitle) {
          // Grab everything before the first " - " or " – " separator.
          // Works for "Kaha Lani - 5BR ..." and "Poipu Kai - 6BR Villas...".
          resortName = listingTitle.split(/\s+[–-]\s+/)[0].trim();
        }
      }
    } catch (e: any) {
      console.warn(`[find-buy-in] couldn't resolve resort name for property ${propertyId}:`, e.message);
    }

    // Normalize a string for inclusion checks — lowercase + collapse punctuation
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const resortTokens = resortName ? norm(resortName).split(" ").filter(t => t.length >= 3) : [];
    // True if the haystack mentions every significant token of the resort name
    const mentionsResort = (haystack: string): boolean => {
      if (!resortName || resortTokens.length === 0) return true; // no filter
      const n = norm(haystack);
      return resortTokens.every(t => n.includes(t));
    };

    // Bedroom extraction from free text — looks for "2BR", "2 bedroom",
    // "two bedroom", "three-bedroom", "studio" (=0), "efficiency" (=0), etc.
    const bedroomFromText = (text: string): number | null => {
      const t = text.toLowerCase();
      if (/\bstudio\b|\befficiency\b/.test(t)) return 0;
      const m = t.match(/(\d+)\s*(?:br|bd|bed|bedroom|bdr)/);
      if (m) return parseInt(m[1], 10);
      const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
      for (const [w, n] of Object.entries(words)) {
        if (new RegExp(`\\b${w}[\\s-]bedroom\\b`).test(t)) return n;
      }
      return null;
    };
    // Reject if text mentions a bedroom count that clearly doesn't match.
    // Keep unknowns — we show the user and they can verify.
    const bedroomOk = (text: string): boolean => {
      const b = bedroomFromText(text);
      if (b === null) return true; // unknown — keep for manual review
      return b >= bedrooms;
    };

    console.log(`[find-buy-in] resort="${resortName}" listing="${listingTitle}" bedrooms=${bedrooms} ${checkIn}→${checkOut}`);

    type Candidate = {
      source: "airbnb" | "vrbo" | "booking" | "pm";
      sourceLabel: string;
      title: string;
      url: string;
      nightlyPrice: number;
      totalPrice: number;
      bedrooms?: number;
      image?: string;
      snippet?: string;
      // Reverse-image-search matches on this candidate's photo. Used
      // to surface "this exact unit also listed at <PM company>" links
      // — the operator can't sublet from Airbnb directly, but the same
      // unit on a property-management company's own site is bookable
      // for commercial use. Only populated for the top 2 Airbnb
      // candidates (cost-controlled — Google Lens calls aren't free).
      photoMatches?: Array<{ url: string; title: string; domain: string }>;
    };

    const asNum = (v: unknown): number => {
      if (typeof v === "number") return v;
      if (typeof v === "string") return Number(v.replace(/[^\d.]/g, "")) || 0;
      return 0;
    };

    // ── URL quality: keep only links that lead directly to a specific unit.
    // Clicking a buy-in link should land on that unit's page, not a search
    // results page or the PM company's homepage. Patterns below match each
    // platform's canonical detail-page shape.
    const isDetailUrl = (source: "airbnb" | "vrbo" | "booking" | "pm", rawUrl: string): boolean => {
      let u: URL;
      try { u = new URL(rawUrl); } catch { return false; }
      const path = u.pathname;
      switch (source) {
        case "airbnb":
          // /rooms/12345, /rooms/plus/12345, /luxury/listing/12345
          return /^\/rooms\/(plus\/)?\d+/.test(path)
              || /^\/luxury\/listing\/\d+/.test(path);
        case "vrbo":
          // Property pages: numeric id paths like /1234567, /1234567ha,
          // or /vacation-rental/p1234567
          return /^\/\d+[a-z]{0,3}\/?$/.test(path)
              || /^\/vacation-rental\/p\d+/.test(path);
        case "booking":
          // Hotel detail pages end in .html under /hotel/
          return /^\/hotel\/[a-z]{2}\/.+\.html$/i.test(path)
              && !/searchresults/i.test(path);
        case "pm": {
          // PM sites vary wildly — an over-strict path heuristic kills the
          // only source with live prices (OTA organic results never carry
          // price). Accept anything deeper than the bare homepage; callers
          // can use `isLandingUrl` to rank landing pages lower.
          return path.length > 1 && path !== "/";
        }
      }
    };

    // Secondary signal: does this PM URL look like a resort-landing page
    // rather than a specific unit? Used for ranking, NOT for filtering —
    // we still surface landing pages if that's all the PM offers, but
    // unit-specific URLs bubble to the top.
    const isLandingUrl = (source: "airbnb" | "vrbo" | "booking" | "pm", rawUrl: string): boolean => {
      if (source !== "pm") return false;
      let u: URL;
      try { u = new URL(rawUrl); } catch { return false; }
      const segments = u.pathname.split("/").filter(Boolean);
      if (segments.length === 0) return true;
      const last = segments[segments.length - 1].toLowerCase();
      const resortSlug = resortName
        ? resortName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        : "";
      if (resortSlug && (last === resortSlug
                      || last === `${resortSlug}-resort`
                      || last.replace(/-resort$/, "") === resortSlug)) return true;
      if (/^(resort|resorts|hotel|hotels|vacation-rentals?|rentals?|kauai|oahu|maui|hawaii)$/.test(last)) return true;
      return false;
    };

    // Append the reservation's check-in/out to the URL so the landing page
    // opens with availability already filtered for those dates. Each platform
    // uses different query param names.
    const withStayDates = (source: "airbnb" | "vrbo" | "booking" | "pm", rawUrl: string): string => {
      let u: URL;
      try { u = new URL(rawUrl); } catch { return rawUrl; }
      const set = (k: string, v: string) => { if (!u.searchParams.has(k)) u.searchParams.set(k, v); };
      switch (source) {
        case "airbnb":
          set("check_in", checkIn);
          set("check_out", checkOut);
          set("adults", "2");
          break;
        case "vrbo":
          set("arrival", checkIn);
          set("departure", checkOut);
          break;
        case "booking":
          set("checkin", checkIn);
          set("checkout", checkOut);
          set("group_adults", "2");
          break;
        case "pm":
          // No universal convention across PM sites — sprinkle every common
          // param name. Sites that use one of these will pre-fill dates;
          // sites that don't will ignore unknown params.
          set("checkin", checkIn);
          set("checkout", checkOut);
          set("check_in", checkIn);
          set("check_out", checkOut);
          set("arrival", checkIn);
          set("departure", checkOut);
          break;
      }
      return u.toString();
    };

    // Helper: run a Google site: search restricted to one OTA and filter
    // aggressively. Requires the resort name to appear in title OR snippet
    // (if we resolved one), and the bedroom count to match.
    const siteSearch = async (
      siteDomain: string,
      source: "airbnb" | "vrbo" | "booking",
      sourceLabel: string,
    ): Promise<{ candidates: Candidate[]; raw: number; dropped: { noResort: number; wrongBedrooms: number } }> => {
      const resortQualifier = resortName ? `"${resortName}"` : searchLocation;
      const query = `site:${siteDomain} ${resortQualifier} ${bedrooms} bedroom`;
      try {
        const params = new URLSearchParams({ engine: "google", q: query, num: "15", api_key: apiKey });
        const r = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!r.ok) return { candidates: [], raw: 0, dropped: { noResort: 0, wrongBedrooms: 0 } };
        const data = await r.json() as any;
        const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];
        let noResort = 0;
        let wrongBedrooms = 0;
        const kept = organic
          .filter((o: any) => o?.link && o.link.includes(siteDomain))
          // Skip anything that isn't a real listing page — a search-results
          // page or region landing is useless as a buy-in link.
          .filter((o: any) => isDetailUrl(source, String(o.link)))
          .filter((o: any) => {
            const hay = `${o?.title ?? ""} ${o?.snippet ?? ""} ${o?.link ?? ""}`;
            if (!mentionsResort(hay)) { noResort++; return false; }
            if (!bedroomOk(hay)) { wrongBedrooms++; return false; }
            return true;
          })
          .slice(0, 8)
          .map((o: any): Candidate => {
            const snippet = String(o?.snippet ?? "");
            const inferred = bedroomFromText(`${o?.title ?? ""} ${snippet}`);
            return {
              source,
              sourceLabel,
              title: String(o?.title ?? `${sourceLabel} listing`),
              url: withStayDates(source, String(o?.link ?? "")),
              nightlyPrice: 0, // Google organic results don't carry live prices
              totalPrice: 0,
              bedrooms: inferred ?? undefined,
              snippet: snippet.slice(0, 160),
            };
          });
        return { candidates: kept, raw: organic.length, dropped: { noResort, wrongBedrooms } };
      } catch (e: any) {
        console.error(`[find-buy-in] ${source} site:${siteDomain} error:`, e.message);
        return { candidates: [], raw: 0, dropped: { noResort: 0, wrongBedrooms: 0 } };
      }
    };

    // ── Airbnb: TWO fetches run in parallel, then merged.
    //    1) site: Google search — great at resort-specific matches via
    //       quoted-name, but Google organic never carries live prices.
    //    2) SearchAPI airbnb engine — returns listings with real prices
    //       (price.extracted_total_price), filtered by location bounds.
    //    The engine sometimes returns listings outside the target resort
    //    so we post-filter to require the resort name in title/desc.
    //    This is what lets auto-fill actually pick a priced candidate.
    let airbnbRawCount = 0;
    let airbnbDropped = { noResort: 0, wrongBedrooms: 0 };
    let airbnbPricedCount = 0;
    const airbnbPromise: Promise<Candidate[]> = (async () => {
      const [site, priced] = await Promise.all([
        siteSearch("airbnb.com", "airbnb", "Airbnb"),
        (async (): Promise<Candidate[]> => {
          try {
            const sp: Record<string, string> = {
              engine: "airbnb",
              check_in_date: checkIn,
              check_out_date: checkOut,
              adults: "2",
              bedrooms: String(bedrooms),
              type_of_place: "entire_home",
              currency: "USD",
              api_key: apiKey,
              q: searchLocation,
            };
            if (bounds) {
              sp.sw_lat = String(bounds.sw_lat);
              sp.sw_lng = String(bounds.sw_lng);
              sp.ne_lat = String(bounds.ne_lat);
              sp.ne_lng = String(bounds.ne_lng);
            }
            const r = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`);
            if (!r.ok) return [];
            const data = await r.json() as any;
            let properties: any[] = Array.isArray(data?.properties) ? data.properties : [];
            airbnbPricedCount = properties.length;
            // Require resort mention in title/desc — the engine's geo
            // bounds aren't tight enough to guarantee it alone.
            if (resortName) {
              properties = properties.filter((p: any) => {
                const hay = `${p?.name ?? p?.title ?? ""} ${p?.description ?? ""}`;
                return mentionsResort(hay);
              });
            }
            return properties
              .filter((p: any) => p?.price?.extracted_total_price > 0 && p?.link)
              .map((p: any): Candidate => {
                const total = Number(p.price.extracted_total_price);
                const url = withStayDates("airbnb", String(p.link));
                return {
                  source: "airbnb",
                  sourceLabel: "Airbnb",
                  title: String(p?.name ?? p?.title ?? "Airbnb listing"),
                  url,
                  nightlyPrice: Math.round(total / Math.max(1, nights)),
                  totalPrice: total,
                  bedrooms: typeof p?.bedrooms === "number" ? p.bedrooms : undefined,
                  image: Array.isArray(p?.images) ? p.images[0] : undefined,
                  snippet: String(p?.description ?? "").slice(0, 160),
                };
              });
          } catch (e: any) {
            console.error(`[find-buy-in] airbnb engine error:`, e.message);
            return [];
          }
        })(),
      ]);
      airbnbRawCount = site.raw;
      airbnbDropped = site.dropped;
      // Dedupe by listing id in path, preferring the priced version.
      const roomId = (u: string): string | null => {
        const m = u.match(/\/rooms\/(?:plus\/)?(\d+)/);
        return m ? m[1] : null;
      };
      const byId = new Map<string, Candidate>();
      for (const c of priced) {
        const id = roomId(c.url);
        if (id) byId.set(id, c);
      }
      const unpriced = site.candidates.filter((c) => {
        const id = roomId(c.url);
        return !id || !byId.has(id);
      });
      return [...priced, ...unpriced];
    })();

    // ── Booking.com / hotel-style inventory via Google Hotels engine ──────
    // VRBO removed: same TOS subletting bar as Airbnb. Airbnb stays as
    // telemetry + photo seed for reverse-image PM matches.
    //
    // Booking.com flow mirrors the Airbnb pattern (site search + priced
    // engine, deduped). The priced side now uses SearchAPI's
    // `google_hotels` engine — returns structured JSON with check-in/
    // check-out date support and live `total_rate` / `rate_per_night`
    // fields, instead of the previous site:booking.com Google scrape
    // that depended on snippet text mentioning "$X/night" verbatim
    // (most Booking.com snippets don't). Engine returns hotels AND
    // vacation rentals from booking.com, hotels.com, expedia, etc. —
    // we keep them all since they're commercially bookable, but tag
    // the source as "booking" to fit the existing Candidate union.
    let bookingRawCount = 0;
    let bookingDropped = { noResort: 0, wrongBedrooms: 0 };
    let bookingPricedCount = 0;
    const bookingPromise: Promise<Candidate[]> = (async () => {
      const [site, priced] = await Promise.all([
        siteSearch("booking.com", "booking", "Booking.com"),
        (async (): Promise<Candidate[]> => {
          try {
            const sp: Record<string, string> = {
              engine: "google_hotels",
              q: searchLocation,
              check_in_date: checkIn,
              check_out_date: checkOut,
              adults: "2",
              currency: "USD",
              api_key: apiKey,
            };
            const r = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`);
            if (!r.ok) {
              console.warn(`[find-buy-in] google_hotels HTTP ${r.status}`);
              return [];
            }
            const data = await r.json() as any;
            let properties: any[] = Array.isArray(data?.properties) ? data.properties : [];
            bookingPricedCount = properties.length;
            // Resort filter — same rule we apply to the airbnb engine.
            if (resortName) {
              properties = properties.filter((p: any) => {
                const hay = `${p?.name ?? p?.title ?? ""} ${p?.description ?? ""}`;
                return mentionsResort(hay);
              });
            }
            return properties
              .map((p: any): Candidate | null => {
                // Different google_hotels response shapes seen in the
                // wild — total_rate.extracted_lowest is the most reliable
                // priced field; rate_per_night.extracted_lowest is its
                // per-night counterpart. Either presence is enough.
                const totalLowest = Number(p?.total_rate?.extracted_lowest ?? p?.total_rate?.lowest ?? 0);
                const perNightLowest = Number(p?.rate_per_night?.extracted_lowest ?? p?.rate_per_night?.lowest ?? 0);
                const total = totalLowest > 0 ? totalLowest : perNightLowest * Math.max(1, nights);
                const nightly = perNightLowest > 0 ? perNightLowest : Math.round(total / Math.max(1, nights));
                if (!(total > 0)) return null;
                const url = String(p?.link ?? p?.url ?? "");
                if (!url) return null;
                return {
                  source: "booking",
                  sourceLabel: "Booking.com",
                  title: String(p?.name ?? p?.title ?? "Hotel listing").slice(0, 100),
                  url,
                  nightlyPrice: Math.round(nightly),
                  totalPrice: Math.round(total),
                  // type_of_place often surfaces "Vacation rental" / "Hotel" /
                  // "Resort"; not directly bedroom-mappable but useful in UI.
                  bedrooms: typeof p?.bedrooms === "number" ? p.bedrooms : undefined,
                  image: Array.isArray(p?.images) ? (p.images[0]?.original_image ?? p.images[0]?.thumbnail ?? p.images[0]) : (p?.thumbnail ?? undefined),
                  snippet: String(p?.description ?? p?.type ?? "").slice(0, 160),
                };
              })
              .filter((c: Candidate | null): c is Candidate => c !== null);
          } catch (e: any) {
            console.error(`[find-buy-in] google_hotels engine error:`, e.message);
            return [];
          }
        })(),
      ]);
      bookingRawCount = site.raw;
      bookingDropped = site.dropped;
      // Dedupe by URL — prefer the priced (engine) version when both
      // surfaces have the same listing.
      const seen = new Set<string>();
      const out: Candidate[] = [];
      for (const c of priced) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        out.push(c);
      }
      for (const c of site.candidates) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        out.push(c);
      }
      return out;
    })();

    // ── Vrbo via Google site: search ─────────────────────────────────────
    // Re-enabled per operator request — Vrbo's TOS technically prohibits
    // commercial re-rental same as Airbnb, but the operator wants the
    // option to surface Vrbo-listed inventory for awareness / direct-with-
    // owner outreach. We do NOT push Vrbo into the priced pool by default
    // (caller can opt in via the response shape); auto-fill skips it.
    // Pricing comes from snippet extraction only — no dedicated Vrbo
    // engine in SearchAPI, so URLs are typically unpriced (operator
    // clicks through to see the rate).
    let vrboRawCount = 0;
    let vrboDropped = { noResort: 0, wrongBedrooms: 0 };
    const vrboPromise: Promise<Candidate[]> = (async () => {
      const { candidates, raw, dropped } = await siteSearch("vrbo.com", "vrbo", "Vrbo");
      vrboRawCount = raw;
      vrboDropped = dropped;
      return candidates;
    })();

    // ── Property-management companies via Google search ────────────────────
    // No live pricing — we return company sites + their booking page as
    // starting points so the host can price-check manually if the OTA results
    // above aren't cheap enough.
    // PM companies — Stage 1: find relevant PM companies via Google.
    // Stage 2: for each PM company, do a secondary `site:` search to surface
    // specific property listing pages (not just the homepage) for the target
    // bedroom count. This gives the host actual per-property URLs they can
    // click through to, rather than a generic PM homepage.
    let pmRawCount = 0;
    const pmPromise: Promise<Candidate[]> = (async () => {
      try {
        const qualifier = resortName ? `"${resortName}"` : community;
        const query = `${qualifier} vacation rental property management OR rentals -airbnb.com -vrbo.com -booking.com`;
        const params = new URLSearchParams({
          engine: "google",
          q: query,
          num: "10",
          api_key: apiKey,
        });
        const r = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!r.ok) return [];
        const data = await r.json() as any;
        const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];
        pmRawCount = organic.length;

        // Dedupe by domain and keep the top N candidate PM sites
        const seenDomains = new Set<string>();
        const pmSites: Array<{ domain: string; title: string; homepageUrl: string; snippet: string }> = [];
        for (const o of organic) {
          const url = String(o?.link ?? "");
          if (!url) continue;
          try {
            const domain = new URL(url).hostname.replace(/^www\./, "");
            if (/airbnb\.com|vrbo\.com|booking\.com|tripadvisor\.com|google\.com/.test(domain)) continue;
            if (seenDomains.has(domain)) continue;
            seenDomains.add(domain);
            pmSites.push({
              domain,
              title: String(o?.title ?? domain),
              homepageUrl: url,
              snippet: String(o?.snippet ?? "").slice(0, 140),
            });
            if (pmSites.length >= 6) break;
          } catch { /* skip malformed URLs */ }
        }

        // Stage 2: per-PM-site deep dive to find SPECIFIC property listing pages
        // with rates. We do this in parallel — 6 sites × ~1s each.
        //
        // Two queries per site (concurrent), merged + deduped:
        //   (a) date-aware: `site:${pm} "${community}" ${bedrooms}BR ${month} ${year}`
        //       — surfaces availability pages tied to the actual stay window
        //       (e.g. "December 2026 vacation rental Pili Mai"). PM sites
        //       often build per-month landing pages that index by URL slug.
        //   (b) generic: `site:${pm} "${community}" ${bedrooms} bedroom rental`
        //       — fallback for sites without month-indexed pages.
        // First version ran (b) only — coverage was OK, hit rate poor.
        const checkInDate = new Date(checkIn + "T12:00:00");
        const monthName = checkInDate.toLocaleString("en-US", { month: "long" });
        const stayYear = checkInDate.getFullYear();
        const deepResults = await Promise.all(pmSites.map(async (site): Promise<Candidate[]> => {
          try {
            const resortQualifier = resortName ?? community;
            const queries = [
              `site:${site.domain} "${resortQualifier}" ${bedrooms}BR ${monthName} ${stayYear}`,
              `site:${site.domain} "${resortQualifier}" ${bedrooms} bedroom rental`,
            ];
            const queryResults = await Promise.all(queries.map(async (q) => {
              const pp = new URLSearchParams({
                engine: "google",
                q,
                num: "5",
                api_key: apiKey,
              });
              const rr = await fetch(`https://www.searchapi.io/api/v1/search?${pp.toString()}`);
              if (!rr.ok) return [];
              const dd = await rr.json() as any;
              return Array.isArray(dd?.organic_results) ? dd.organic_results : [];
            }));
            // Dedupe by URL across the two queries.
            const seen = new Set<string>();
            const hits: any[] = [];
            for (const batch of queryResults) {
              for (const h of batch) {
                const link = String(h?.link ?? "");
                if (!link || seen.has(link)) continue;
                seen.add(link);
                hits.push(h);
              }
            }
            // Extract nightly price from snippet — broadened from the
            // original $X/night-only pattern to also catch "from $X",
            // "starting at $X", "$X/wk" / "$X/week" (÷ 7 → nightly),
            // "$X/month" / "$X/mo" (÷ 30 → nightly approximate).
            // Returns 0 when no price found; the caller treats unpriced
            // candidates as click-through-only (PR #148 fallback).
            const extractPrice = (text: string): number => {
              // Per-night first (most accurate).
              const perNight = text.match(/\$\s*([\d,]{3,5})\s*(?:\/|per|a\s+)?\s*(?:night|nt|nightly)/i);
              if (perNight) return parseInt(perNight[1].replace(/,/g, ""), 10);
              // From / starting at — usually a per-night quote.
              const startingAt = text.match(/(?:from|starting(?:\s+at)?)\s+\$\s*([\d,]{3,5})(?!\s*(?:\/|per|a\s+)?\s*(?:week|wk|month|mo))/i);
              if (startingAt) return parseInt(startingAt[1].replace(/,/g, ""), 10);
              // Per-week — divide by 7 for nightly approximation.
              const perWeek = text.match(/\$\s*([\d,]{4,6})\s*(?:\/|per|a\s+)?\s*(?:week|wk|weekly)/i);
              if (perWeek) return Math.round(parseInt(perWeek[1].replace(/,/g, ""), 10) / 7);
              // Per-month — divide by 30 (rough but useful).
              const perMonth = text.match(/\$\s*([\d,]{4,6})\s*(?:\/|per|a\s+)?\s*(?:month|mo|monthly)/i);
              if (perMonth) return Math.round(parseInt(perMonth[1].replace(/,/g, ""), 10) / 30);
              return 0;
            };
            const candidates: Candidate[] = hits
              .filter((h: any) => {
                const hay = `${h?.title ?? ""} ${h?.snippet ?? ""}`;
                // PM deep-dive still needs to land inside the target resort
                // with the right bedroom count — same rules as the OTAs.
                return mentionsResort(hay) && bedroomOk(hay);
              })
              // Reject bare-homepage URLs — the whole point of the deep-dive
              // is to land on a specific listing page.
              .filter((h: any) => h?.link && isDetailUrl("pm", String(h.link)))
              .slice(0, 3)
              .map((h: any) => {
                const snippetText = String(h?.snippet ?? "");
                const nightly = extractPrice(snippetText + " " + String(h?.title ?? ""));
                const inferred = bedroomFromText(`${h?.title ?? ""} ${snippetText}`);
                return {
                  source: "pm" as const,
                  sourceLabel: site.title,
                  title: String(h?.title ?? "Listing").slice(0, 100),
                  url: String(h?.link ?? ""),
                  nightlyPrice: nightly,
                  totalPrice: nightly ? nightly * nights : 0,
                  bedrooms: inferred ?? undefined,
                  snippet: snippetText.slice(0, 160),
                };
              })
              .filter((c: Candidate) => c.url);
            // No homepage fallback: if we can't find a specific listing page,
            // we'd rather show nothing than a link that opens the PM homepage
            // and makes the user hunt for the unit and dates manually.
            return candidates;
          } catch (e: any) {
            console.error(`[find-buy-in] pm deep-dive ${site.domain} error:`, e.message);
            return [];
          }
        }));
        return deepResults.flat().slice(0, 20);
      } catch (e: any) {
        console.error("[find-buy-in] pm error:", e.message);
        return [];
      }
    })();

    const [airbnb, booking, vrbo, pm] = await Promise.all([airbnbPromise, bookingPromise, vrboPromise, pmPromise]);

    // ── Path B: reverse-image search the top Airbnb candidates ───────────
    // Airbnb listings can't be sublet (Airbnb's TOS bars commercial
    // re-rental), but the SAME unit is often listed on the property-
    // management company's own site too — and PM sites usually reuse the
    // Airbnb-listed photos verbatim. Run Google Lens on each top
    // candidate's image, filter to non-OTA domains, surface the matches
    // as `photoMatches` on each candidate. Capped at the top 2 priced
    // Airbnb candidates so the SearchAPI cost stays bounded.
    //
    // Filter list mirrors the major OTAs we already track + a handful of
    // meta-search aggregators (kayak, trivago, hotels.com) that don't add
    // a useful new booking surface for the operator.
    const OTA_DOMAIN_FILTER = /(?:^|\.)(?:airbnb\.com|vrbo\.com|booking\.com|tripadvisor\.com|expedia\.com|hotels\.com|kayak\.com|trivago\.com|priceline\.com|orbitz\.com|travelocity\.com|google\.com|youtube\.com|facebook\.com|instagram\.com|pinterest\.com)$/i;
    async function lensMatches(imgUrl: string): Promise<Array<{ url: string; title: string; domain: string }>> {
      try {
        const sp = new URLSearchParams({ engine: "google_lens", url: imgUrl, api_key: apiKey });
        const r = await fetch(`https://www.searchapi.io/api/v1/search?${sp.toString()}`);
        if (!r.ok) return [];
        const data = await r.json() as any;
        const sources = [
          ...(Array.isArray(data?.visual_matches) ? data.visual_matches : []),
          ...(Array.isArray(data?.organic_results) ? data.organic_results : []),
          ...(Array.isArray(data?.pages_with_matching_images) ? data.pages_with_matching_images : []),
        ];
        const seen = new Set<string>();
        const out: Array<{ url: string; title: string; domain: string }> = [];
        for (const s of sources) {
          const url = String(s?.link || s?.url || s?.source_url || s?.source || "");
          if (!url) continue;
          let domain: string;
          try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { continue; }
          if (OTA_DOMAIN_FILTER.test(domain)) continue;
          if (seen.has(domain)) continue;
          seen.add(domain);
          out.push({
            url,
            title: String(s?.title || s?.source || domain).slice(0, 80),
            domain,
          });
          if (out.length >= 3) break;
        }
        return out;
      } catch (e: any) {
        console.warn(`[find-buy-in] google_lens error:`, e.message);
        return [];
      }
    }
    const topAirbnb = airbnb.filter((c) => c.image && c.nightlyPrice > 0).slice(0, 2);
    const photoMatchesByUrl = new Map<string, Array<{ url: string; title: string; domain: string }>>();
    if (topAirbnb.length > 0) {
      const lensResults = await Promise.all(topAirbnb.map((c) => lensMatches(c.image!)));
      topAirbnb.forEach((c, i) => photoMatchesByUrl.set(c.url, lensResults[i]));
    }
    const airbnbWithMatches: Candidate[] = airbnb.map((c) => ({
      ...c,
      photoMatches: photoMatchesByUrl.get(c.url) ?? [],
    }));

    // Promote photo-match URLs into the PM source. The reverse-image
    // matches collected above ARE PM company unit pages (PMs reuse
    // Airbnb-listed photos verbatim) — they're more actionable than
    // the generic PM Google search results because they point at the
    // SAME unit, not just "PM companies that handle this resort." Tag
    // them with source="pm" so they flow through the same UI section
    // and into auto-fill's bookable pool. Dedupe against the existing
    // pm[] array by URL so we don't double-render a domain that the
    // PM Google search already found.
    const existingPmUrls = new Set(pm.map((c) => c.url));
    const photoMatchPmCandidates: Candidate[] = [];
    for (const matches of photoMatchesByUrl.values()) {
      for (const m of matches) {
        if (existingPmUrls.has(m.url)) continue;
        existingPmUrls.add(m.url);
        photoMatchPmCandidates.push({
          source: "pm",
          sourceLabel: m.domain,
          title: m.title || `Match on ${m.domain}`,
          url: m.url,
          // Photo-match URLs come without prices (Google Lens response
          // doesn't include rates). They're click-through-only — the
          // operator opens the link and gets the price from the PM's
          // own booking page. Auto-fill's unpriced-PM fallback will
          // pick from these too.
          nightlyPrice: 0,
          totalPrice: 0,
          snippet: `Same photo as Airbnb listing — direct booking page on ${m.domain}`,
        });
      }
    }
    const pmAugmented: Candidate[] = [...pm, ...photoMatchPmCandidates];

    // Combined cheapest (top 2) across BOOKABLE sources that have pricing.
    //
    // Airbnb is INTENTIONALLY excluded from the cheapest pool — Auto-fill
    // pulls from `cheapest` and creates a buy-in attached to the picked
    // candidate's URL. Picking an Airbnb URL is a footgun: the operator
    // can't sublet it (Airbnb TOS), so the buy-in record points at a
    // listing that can't actually be booked for the guest. The PM
    // matches surfaced under each Airbnb row (photoMatches) ARE
    // bookable — but they don't have prices, so they don't compete on
    // "cheapest" anyway.
    //
    // Vrbo IS surfaced now (operator explicitly opted back in) but stays
    // OUT of the priced/cheapest pool — Vrbo's TOS has the same sublet
    // restriction as Airbnb, so picking a Vrbo URL for a buy-in carries
    // the same risk. It shows up under sources.vrbo for awareness/manual
    // outreach. Booking.com stays — many Booking.com listings are
    // commercial hotels that DO allow re-rental. PM stays — the whole
    // point of PM is they accept commercial bookings.
    const priced: Candidate[] = [...booking, ...pmAugmented]
      .filter((c) => c.nightlyPrice > 0)
      .sort((a, b) => a.nightlyPrice - b.nightlyPrice);
    // If no priced PM/Booking candidate exists, fall back to the top
    // unpriced PM URL so auto-fill still has SOMETHING to attach. PM
    // sites often don't surface live prices in Google snippets — but
    // the URL itself is what the operator needs to click through and
    // negotiate. Buy-in record gets created with $0 cost; operator
    // updates after talking to the PM. Better than a silent no-op
    // that leaves the slot looking unfilled when there are real PM
    // links available to click. pmAugmented prefers PM Google search
    // hits before photo-match-derived URLs (insertion order), so the
    // fallback picks a curated PM hit when one exists.
    const unpricedFallback: Candidate[] = priced.length === 0
      ? pmAugmented.filter((c) => c.url && c.nightlyPrice === 0).slice(0, 1)
      : [];
    const cheapest = priced.length > 0 ? priced.slice(0, 2) : unpricedFallback;
    // Telemetry: what would the cheapest have been if we counted Airbnb?
    // Useful to see how often Airbnb is undercutting the bookable channels.
    const airbnbCheapest = airbnbWithMatches
      .filter((c) => c.nightlyPrice > 0)
      .sort((a, b) => a.nightlyPrice - b.nightlyPrice)
      .slice(0, 1);

    const totalPhotoMatches = airbnbWithMatches.reduce((s, c) => s + (c.photoMatches?.length ?? 0), 0);
    console.log(
      `[find-buy-in] resort="${resortName}" ${bedrooms}BR ${checkIn}→${checkOut}: `
      + `airbnb=${airbnb.length}/${airbnbRawCount} (telemetry-only — bookable list excludes airbnb) `
      + `airbnbEngine=${airbnbPricedCount} raw · `
      + `vrbo=${vrbo.length}/${vrboRawCount} (awareness-only — same TOS as airbnb) `
      + `booking=${booking.length}/${bookingRawCount}+${bookingPricedCount} (priced=via google_hotels engine) `
      + `pm=${pm.length}/${pmRawCount}+${photoMatchPmCandidates.length} (google+photoMatches) · `
      + `photoMatchesUnderAirbnb=${totalPhotoMatches} · `
      + `bookable-priced=${priced.length}${airbnbCheapest[0] ? ` (airbnb-cheapest=${airbnbCheapest[0].nightlyPrice}, excluded)` : ""}`
    );

    return res.json({
      community,
      resortName,
      listingTitle,
      bedrooms,
      nights,
      checkIn,
      checkOut,
      sources: {
        airbnb: airbnbWithMatches.sort((a, b) => (a.nightlyPrice || 99999) - (b.nightlyPrice || 99999)),
        vrbo: vrbo.sort((a, b) => (a.nightlyPrice || 99999) - (b.nightlyPrice || 99999)),
        booking: booking.sort((a, b) => (a.nightlyPrice || 99999) - (b.nightlyPrice || 99999)),
        pm: pmAugmented.sort((a, b) => (a.nightlyPrice || 99999) - (b.nightlyPrice || 99999)),
      },
      debug: {
        rawCounts: { airbnb: airbnbRawCount, vrbo: vrboRawCount, booking: bookingRawCount, bookingEngine: bookingPricedCount, pm: pmRawCount, pmFromPhotoMatches: photoMatchPmCandidates.length, photoMatches: totalPhotoMatches },
        dropped: { airbnb: airbnbDropped, vrbo: vrboDropped, booking: bookingDropped },
        searchLocation,
        vrboDestination,
        resortName,
        // For-reference-only: what the cheapest Airbnb listing would have
        // been if Airbnb were a bookable channel. Helps the operator see
        // how much they're paying for the not-being-able-to-sublet
        // restriction (e.g. "Airbnb $250/night vs PM $370/night").
        airbnbCheapestTelemetry: airbnbCheapest[0]
          ? { nightlyPrice: airbnbCheapest[0].nightlyPrice, totalPrice: airbnbCheapest[0].totalPrice, url: airbnbCheapest[0].url }
          : null,
      },
      cheapest,
      totalPricedResults: priced.length,
    });
  });

  // ─── Availability verification ─────────────────────────────────────────
  // Pre-flight for auto-fill: given a specific listing URL + dates, confirm
  // the listing is actually bookable for those exact dates (not just that
  // it appeared in a broad search result). Prevents attaching buy-ins to
  // listings that have been booked since the initial search, or that
  // returned a "starting from" price not tied to our specific nights.
  //
  // Only Airbnb is verifiable — we re-call the airbnb engine with a narrow
  // query (resort + bedroom count + dates) and confirm the listing id is
  // still in the priced results. Vrbo/Booking/PM have no per-listing
  // verification endpoint in SearchAPI, so they return available=null
  // (unknown — don't block the attach, just flag to the client).
  app.get("/api/operations/verify-listing", async (req: Request, res: Response) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const url = req.query.url as string;
    const checkIn = req.query.checkIn as string;
    const checkOut = req.query.checkOut as string;
    const q = (req.query.q as string) || "";
    const bedroomsRaw = req.query.bedrooms as string | undefined;
    const bedrooms = bedroomsRaw ? parseInt(bedroomsRaw, 10) : null;

    if (!url) return res.status(400).json({ error: "url required" });
    if (!checkIn || !checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
      return res.status(400).json({ error: "checkIn and checkOut required (YYYY-MM-DD)" });
    }

    // Extract Airbnb listing id — skip verification for other sources.
    const m = url.match(/airbnb\.com\/rooms\/(?:plus\/)?(\d+)/);
    if (!m) {
      return res.json({ available: null, reason: "unsupported-source", listingId: null });
    }
    const listingId = m[1];

    try {
      const sp: Record<string, string> = {
        engine: "airbnb",
        check_in_date: checkIn,
        check_out_date: checkOut,
        adults: "2",
        currency: "USD",
        api_key: apiKey,
        q: q || "Hawaii",
      };
      if (bedrooms && !isNaN(bedrooms)) sp.bedrooms = String(bedrooms);
      const r = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`);
      if (!r.ok) {
        return res.json({ available: null, reason: `engine-${r.status}`, listingId });
      }
      const data = await r.json() as any;
      const properties: any[] = Array.isArray(data?.properties) ? data.properties : [];
      const match = properties.find((p: any) => String(p?.id ?? "") === listingId);

      if (!match) {
        // Listing didn't appear in the re-query. Could mean it's been booked,
        // dropped out of the top-N for other reasons, or is just further down
        // the results. Conservative: report available=false only when the
        // query was narrow enough that absence is meaningful (q present AND
        // bedrooms present). Otherwise report unknown.
        if (q && bedrooms) {
          return res.json({ available: false, reason: "not-in-priced-results", listingId, checkedCount: properties.length });
        }
        return res.json({ available: null, reason: "insufficient-query-scope", listingId, checkedCount: properties.length });
      }

      const total = Number(match?.price?.extracted_total_price ?? 0);
      if (!(total > 0)) {
        return res.json({ available: false, reason: "no-price-on-listing", listingId });
      }
      return res.json({
        available: true,
        listingId,
        currentTotalPrice: total,
        title: match?.name ?? match?.title ?? null,
      });
    } catch (e: any) {
      console.error(`[verify-listing] error for ${listingId}:`, e.message);
      return res.json({ available: null, reason: "network-error", listingId });
    }
  });

  // ── PM listing verifier (headless screenshot + Claude vision) ───────────
  // For unpriced PM URLs that auto-fill is about to attach at $0, navigate
  // the page in a real browser with the stay dates injected, screenshot
  // the priced view, and ask claude-haiku to extract
  // { isUnitPage, available, totalPrice, nightlyPrice, dateMatch }.
  // Replaces the "$0 pricing pending" UX with real numbers when
  // extraction succeeds; falls back to $0 when it doesn't (anti-bot
  // interstitials, non-unit pages, vision refusals — the caller is
  // expected to re-use the existing zero-cost-attach path).
  //
  // ~8-12s per call (Playwright cold-start + 4s render wait + vision).
  // ~$0.003 per call (claude-haiku, one ~75% jpeg).
  app.post("/api/operations/verify-pm-listing", async (req: Request, res: Response) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    const { url, checkIn, checkOut } = (req.body ?? {}) as {
      url?: string; checkIn?: string; checkOut?: string;
    };
    if (!url || typeof url !== "string") return res.status(400).json({ error: "url required" });
    if (!checkIn || !checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
      return res.status(400).json({ error: "checkIn and checkOut required (YYYY-MM-DD)" });
    }
    const nights = Math.max(
      1,
      Math.round((new Date(checkOut + "T12:00:00").getTime() - new Date(checkIn + "T12:00:00").getTime()) / 86400000),
    );

    // Inject every common date param style without overwriting any the URL
    // already carries — different PM platforms use different names and we
    // don't know which the host site reads. The page either honors one of
    // these and shows priced rates, or falls back to defaults (which
    // dateMatch will flag).
    let urlWithDates: string;
    try {
      const u = new URL(url);
      const setIfMissing = (k: string, v: string) => { if (!u.searchParams.has(k)) u.searchParams.set(k, v); };
      setIfMissing("check_in", checkIn);
      setIfMissing("check_out", checkOut);
      setIfMissing("checkin", checkIn);
      setIfMissing("checkout", checkOut);
      setIfMissing("arrival", checkIn);
      setIfMissing("departure", checkOut);
      setIfMissing("adults", "2");
      urlWithDates = u.toString();
    } catch {
      return res.status(400).json({ error: "invalid url" });
    }

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
        ],
      });
      const ctx = await browser.newContext({
        viewport: { width: 1366, height: 2400 },
        locale: "en-US",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
      const page = await ctx.newPage();
      await page.goto(urlWithDates, { waitUntil: "domcontentloaded", timeout: 12000 });
      // SPAs commonly fetch rates after first paint — give them time.
      await page.waitForTimeout(2500);

      // Dismiss newsletter / "book direct" popups that PM sites slap on
      // first load. Parrish Kauai's modal covers the date picker, so the
      // screenshot is useless without dismissing it. Try a battery of
      // common close-button selectors, then press Escape as a final
      // catch-all (most modal libraries bind Esc to close). All silent —
      // a missed popup just means the screenshot includes the overlay.
      try {
        const closeSelectors = [
          'button[aria-label*="close" i]',
          'button[aria-label*="dismiss" i]',
          '[aria-label="Close"]',
          '[role="button"][aria-label*="close" i]',
          'button.close', 'button.modal-close', 'button.close-btn', '.close-button',
          'button:has-text("×")', 'button:has-text("✕")', 'button:has-text("✖")',
          '[role="dialog"] button:has-text("Close")',
          '[role="dialog"] button:has-text("No thanks")',
          '[role="dialog"] button:has-text("Maybe later")',
        ];
        for (const sel of closeSelectors) {
          const el = page.locator(sel).first();
          if ((await el.count().catch(() => 0)) > 0) {
            await el.click({ timeout: 1500, force: true }).catch(() => {});
          }
        }
        // Final nudge: some libraries (Privy, Mailchimp popups) only
        // close on Escape, not button click.
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(400);
      } catch { /* silent */ }

      // Try to fill date inputs and click a search button before
      // screenshotting — most PM sites gate rates behind that flow.
      // Bail fast if nothing matches: prior implementation lingered for
      // 5+ seconds even when no button was found, which dragged the
      // whole verify call past the client's tolerance and starved the
      // 2nd auto-fill slot. Now we only wait for rate-fetch render if
      // we actually clicked something.
      let clicked = false;
      try {
        const dateInSelectors = [
          'input[name*="check_in" i]', 'input[name*="checkin" i]', 'input[name*="arrival" i]',
          'input[id*="check_in" i]', 'input[id*="checkin" i]', 'input[id*="arrival" i]',
          'input[placeholder*="check-in" i]', 'input[placeholder*="check in" i]', 'input[placeholder*="arrival" i]',
        ];
        const dateOutSelectors = [
          'input[name*="check_out" i]', 'input[name*="checkout" i]', 'input[name*="departure" i]',
          'input[id*="check_out" i]', 'input[id*="checkout" i]', 'input[id*="departure" i]',
          'input[placeholder*="check-out" i]', 'input[placeholder*="check out" i]', 'input[placeholder*="departure" i]',
        ];
        for (const sel of dateInSelectors) {
          const el = page.locator(sel).first();
          if ((await el.count().catch(() => 0)) > 0) { await el.fill(checkIn).catch(() => {}); break; }
        }
        for (const sel of dateOutSelectors) {
          const el = page.locator(sel).first();
          if ((await el.count().catch(() => 0)) > 0) { await el.fill(checkOut).catch(() => {}); break; }
        }
        const searchBtn = page.getByRole("button", {
          name: /^(search|check\s*availab|view\s*rates|see\s*rates|book\s*now|get\s*rates|find\s*available)/i,
        }).first();
        if ((await searchBtn.count().catch(() => 0)) > 0) {
          await searchBtn.click({ timeout: 2000 }).catch(() => {});
          clicked = true;
        }
      } catch { /* silent */ }
      if (clicked) await page.waitForTimeout(3500);

      const finalUrl = page.url();
      const title = await page.title().catch(() => "");
      // Viewport-only screenshot (1366×2400) — fullPage on Suite Paradise
      // and similar produces 8000+ px tall jpegs that take 30+s to encode
      // and inflate the vision payload to multi-MB. Calendar widgets and
      // rate breakdowns generally render in the top ~2400 px once the
      // search button is clicked.
      const screenshot = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
      const screenshotBase64 = screenshot.toString("base64");

      const prompt = [
        `You are looking at a vacation rental booking page.`,
        `The user wants to stay from ${checkIn} to ${checkOut} (${nights} nights).`,
        ``,
        `Examine the screenshot and answer:`,
        `1. Is this a SPECIFIC unit's booking page (vs a search results / category / index page)?`,
        `2. Is the unit shown as available for the requested dates ${checkIn} → ${checkOut}? Look for booking buttons, "available", or rate calendars matching these dates.`,
        `3. What is the TOTAL price for the entire ${nights}-night stay shown on the page? (USD integer, no symbols, no commas)`,
        `4. What is the per-night price? (USD integer)`,
        `5. Are the prices shown tied to the requested dates ${checkIn} → ${checkOut}, or default/placeholder rates for different dates?`,
        ``,
        `Use null when truly unknown. Respond with ONLY a single line of minified JSON:`,
        `{"isUnitPage":true|false,"available":true|false|null,"totalPrice":N|null,"nightlyPrice":N|null,"dateMatch":true|false|null,"reason":"<=140 chars"}`,
      ].join("\n");

      const visionResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 250,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: screenshotBase64 } },
              { type: "text", text: prompt },
            ],
          }],
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!visionResp.ok) {
        const body = await visionResp.text().catch(() => "");
        console.warn(`[verify-pm-listing] vision HTTP ${visionResp.status} ${body.slice(0, 200)}`);
        return res.json({
          ok: false,
          reason: `vision-${visionResp.status}`,
          finalUrl, title,
          screenshotBase64: `data:image/jpeg;base64,${screenshotBase64}`,
        });
      }
      const visionData = await visionResp.json() as any;
      const text: string = visionData?.content?.[0]?.text ?? "";
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
      let extracted: {
        isUnitPage?: boolean;
        available?: boolean | null;
        totalPrice?: number | null;
        nightlyPrice?: number | null;
        dateMatch?: boolean | null;
        reason?: string;
      } | null = null;
      if (jsonMatch) {
        try { extracted = JSON.parse(jsonMatch[0]); } catch { /* leave null */ }
      }

      return res.json({
        ok: true,
        finalUrl,
        title,
        extracted,
        screenshotBase64: `data:image/jpeg;base64,${screenshotBase64}`,
      });
    } catch (e: any) {
      console.error(`[verify-pm-listing] error:`, e?.message ?? e);
      return res.json({ ok: false, reason: "playwright-error", error: e?.message ?? String(e) });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  // ========== BOOKINGS ↔ BUY-INS (Layer A: per-unit-slot attachment) ==========
  //
  // A multi-unit Guesty listing (e.g. 6-BR = 3-BR Unit 721 + 3-BR Unit 812) requires
  // ONE buy-in per physical unit per reservation. All endpoints below are slot-aware.

  // List reservations for a Guesty listing, annotated with per-unit-slot fill status.
  app.get("/api/bookings/listing/:listingId", async (req, res) => {
    try {
      const listingId = req.params.listingId;
      const propertyId = parseInt((req.query.propertyId as string) ?? "", 10);
      const includePast = req.query.includePast === "true";
      const limit = Math.min(parseInt((req.query.limit as string) ?? "100", 10) || 100, 200);

      if (!propertyId) {
        return res.status(400).json({ error: "propertyId query param required" });
      }

      const unitSlots = getPropertyUnits(propertyId);
      if (unitSlots.length === 0) {
        return res.status(400).json({ error: `No unit config found for property ${propertyId}` });
      }

      const today = new Date().toISOString().slice(0, 10);
      const fields = encodeURIComponent("_id status checkIn checkOut checkInDateLocalized checkOutDateLocalized nightsCount guest money source integration confirmationCode preApproveState");
      // Guesty Open API requires the JSON `filters=[...]` syntax for
      // listingId — the simple `listingId=X` query param is silently
      // ignored, so the account-wide reservation list comes back
      // regardless. That was Jamie's bug: every property selection
      // returned the same first reservation (Mike Stevens) because
      // Guesty wasn't filtering at all. Status moves into the filter
      // array too so the whole filter set goes through one consistent
      // path; legacy `status[]=` is left out to avoid mixing syntaxes.
      // checkOut date filter only applies when includePast is false.
      // See https://open-api-docs.guesty.com/docs/how-to-search-for-reservations
      const filterArr: Array<Record<string, unknown>> = [
        { field: "listingId", operator: "$eq", value: listingId },
        // Bookings page = real bookings only. Inquiries belong in the
        // inbox; pulling them in here clutters the list with messages
        // that haven't actually committed to dates. `awaitingPayment`
        // stays because that's a confirmed booking that just hasn't
        // settled the first payment yet — still a real booking from
        // the operator's POV (units are blocked, dates are committed).
        { field: "status", operator: "$in", value: ["confirmed", "awaitingPayment"] },
      ];
      if (!includePast) {
        filterArr.push({ field: "checkOut", operator: "$gte", value: today });
      }
      const filtersParam = encodeURIComponent(JSON.stringify(filterArr));
      const url = `/reservations?filters=${filtersParam}&limit=${limit}&sort=checkIn&fields=${fields}`;
      const data = await guestyRequest("GET", url) as any;
      // Guesty wraps list responses inconsistently across accounts — could be
      //   { results: [...] }         (legacy)
      //   { data: [...] }            (new flat)
      //   { data: { results: [...] } } (new envelope)
      const reservations: any[] = Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.data?.results)
            ? data.data.results
            : [];

      // For each reservation build per-slot attachment info
      const enriched = await Promise.all(
        reservations.map(async (r) => {
          const attached = r._id ? await storage.getBuyInsByReservation(r._id) : [];
          const slots = unitSlots.map((slot) => {
            const buyIn = attached.find((b) => b.unitId === slot.unitId) ?? null;
            return { ...slot, buyIn };
          });
          const filled = slots.filter((s) => s.buyIn).length;
          return {
            ...r,
            slots,
            slotsFilled: filled,
            slotsTotal: slots.length,
            fullyLinked: filled === slots.length,
          };
        }),
      );

      res.json({
        reservations: enriched,
        total: enriched.length,
        unitSlots,
        propertyId,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch bookings", message: err.message });
    }
  });

  // Buy-in candidates for ONE specific unit slot on a booking.
  app.get("/api/bookings/:reservationId/buy-in-candidates", async (req, res) => {
    try {
      const reservationId = req.params.reservationId;
      const propertyId = parseInt((req.query.propertyId as string) ?? "", 10);
      const unitId = req.query.unitId as string;
      const checkIn = req.query.checkIn as string;
      const checkOut = req.query.checkOut as string;

      if (!propertyId || !unitId || !checkIn || !checkOut) {
        return res.status(400).json({ error: "propertyId, unitId, checkIn, checkOut query params required" });
      }

      const slot = getUnitConfig(propertyId, unitId);
      if (!slot) {
        return res.status(404).json({ error: `Unit ${unitId} not configured for property ${propertyId}` });
      }

      const candidates = await storage.getBuyInCandidates({ propertyId, unitId, checkIn, checkOut });
      const bookingNights = Math.max(1, Math.round((+new Date(checkOut) - +new Date(checkIn)) / 86400000));

      const ranked = candidates
        .map((b) => {
          const buyInNights = Math.max(1, Math.round((+new Date(b.checkOut) - +new Date(b.checkIn)) / 86400000));
          const cost = parseFloat(String(b.costPaid)) || 0;
          const costPerNight = cost / buyInNights;
          const wastedNights = buyInNights - bookingNights;
          const score = costPerNight * bookingNights + Math.max(0, wastedNights) * costPerNight * 0.5;
          return {
            buyIn: b,
            buyInNights,
            totalCost: cost,
            costPerNight: Math.round(costPerNight * 100) / 100,
            wastedNights,
            effectiveCost: Math.round(costPerNight * bookingNights * 100) / 100,
            score: Math.round(score * 100) / 100,
          };
        })
        .sort((a, b) => a.score - b.score);

      res.json({
        reservationId,
        slot,
        bookingNights,
        candidates: ranked,
        count: ranked.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to find candidates", message: err.message });
    }
  });

  // Attach a buy-in to a reservation. Enforces one buy-in per (reservation, unit slot).
  app.post("/api/bookings/:reservationId/attach-buy-in", async (req, res) => {
    try {
      const reservationId = req.params.reservationId;
      const { buyInId } = req.body as { buyInId: number };
      if (!buyInId) return res.status(400).json({ error: "buyInId required" });

      const buyIn = await storage.attachBuyIn(buyInId, reservationId);
      if (!buyIn) return res.status(404).json({ error: "Buy-in not found" });
      res.json(buyIn);
    } catch (err: any) {
      res.status(400).json({ error: "Failed to attach buy-in", message: err.message });
    }
  });

  // Detach a specific buy-in from its reservation (pass buyInId, not reservationId-only).
  app.post("/api/bookings/detach-buy-in/:buyInId", async (req, res) => {
    try {
      const buyInId = parseInt(req.params.buyInId, 10);
      const buyIn = await storage.detachBuyIn(buyInId);
      if (!buyIn) return res.status(404).json({ error: "Buy-in not found" });
      res.json(buyIn);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to detach buy-in", message: err.message });
    }
  });

  // ========== AIRBNB SEARCH VIA SEARCHAPI.IO ==========

  // CONDO / TOWNHOME ONLY — mirrors shared/property-units.ts.
  // Removed villa/single-family entries (7, 10, 12, 14, 21, 26, 28, 31) on
  // 2026-04 per business-model pivot.
  const PROPERTY_UNIT_NEEDS: Record<number, { community: string; units: { bedrooms: number }[] }> = {
    1: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 2 }, { bedrooms: 2 }] },
    4: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    8: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    9: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    18: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    19: { community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    20: { community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    23: { community: "Kapaa Beachfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    24: { community: "Poipu Oceanfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    27: { community: "Poipu Kai", units: [{ bedrooms: 2 }, { bedrooms: 2 }] },
    29: { community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 4 }] },
    32: { community: "Pili Mai", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    33: { community: "Pili Mai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    34: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  };

  const COMMUNITY_SEARCH_LOCATIONS: Record<string, string> = {
    "Poipu Kai": "Regency at Poipu Kai, Koloa, Kauai, Hawaii",
    "Kekaha Beachfront": "Kekaha, Kauai, Hawaii",
    "Keauhou": "Keauhou, Kailua-Kona, Big Island, Hawaii",
    "Princeville": "Princeville, Kauai, Hawaii",
    "Kapaa Beachfront": "Kapaa, Kauai, Hawaii",
    "Poipu Oceanfront": "Poipu Beach, Koloa, Kauai, Hawaii",
    "Poipu Brenneckes": "Brenneckes Beach, Poipu, Kauai, Hawaii",
    "Pili Mai": "Pili Mai at Poipu, Koloa, Kauai, Hawaii",
  };

  // Bounding boxes (SW lat/lng → NE lat/lng) for each community.
  // SearchAPI Airbnb supports sw_lat/sw_lng/ne_lat/ne_lng to geo-constrain results.
  // We also post-filter by GPS coordinates in the returned listings for extra precision.
  const COMMUNITY_BOUNDS: Record<string, { sw_lat: number; sw_lng: number; ne_lat: number; ne_lng: number }> = {
    "Poipu Kai":        { sw_lat: 21.875, sw_lng: -159.478, ne_lat: 21.895, ne_lng: -159.458 },
    "Pili Mai":         { sw_lat: 21.882, sw_lng: -159.483, ne_lat: 21.899, ne_lng: -159.468 },
    "Poipu Brenneckes": { sw_lat: 21.872, sw_lng: -159.462, ne_lat: 21.882, ne_lng: -159.448 },
    "Poipu Oceanfront": { sw_lat: 21.872, sw_lng: -159.462, ne_lat: 21.882, ne_lng: -159.448 },
    "Princeville":      { sw_lat: 22.210, sw_lng: -159.498, ne_lat: 22.235, ne_lng: -159.468 },
    "Kapaa Beachfront": { sw_lat: 22.060, sw_lng: -159.333, ne_lat: 22.085, ne_lng: -159.308 },
    "Kekaha Beachfront":{ sw_lat: 21.955, sw_lng: -159.758, ne_lat: 21.978, ne_lng: -159.733 },
    "Keauhou":          { sw_lat: 19.528, sw_lng: -155.992, ne_lat: 19.558, ne_lng: -155.966 },
  };

  app.get("/api/airbnb/search", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "SearchAPI.io API key not configured" });
    }

    try {
      const propertyId = parseInt(req.query.propertyId as string, 10);
      const checkIn = req.query.checkIn as string;
      const checkOut = req.query.checkOut as string;

      if (!propertyId || isNaN(propertyId)) {
        return res.status(400).json({ error: "propertyId is required" });
      }
      if (!checkIn || !checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
        return res.status(400).json({ error: "checkIn and checkOut required in YYYY-MM-DD format" });
      }

      const propertyConfig = PROPERTY_UNIT_NEEDS[propertyId];
      if (!propertyConfig) {
        return res.status(404).json({ error: "Property not found in multi-unit config" });
      }

      const searchLocation = COMMUNITY_SEARCH_LOCATIONS[propertyConfig.community] || `${propertyConfig.community}, Hawaii`;

      const bedroomCounts: Record<number, number> = {};
      for (const unit of propertyConfig.units) {
        bedroomCounts[unit.bedrooms] = (bedroomCounts[unit.bedrooms] || 0) + 1;
      }

      const results: Record<string, any> = {
        community: propertyConfig.community,
        searchLocation,
        checkIn,
        checkOut,
        unitsNeeded: Object.entries(bedroomCounts).map(([br, count]) => ({
          bedrooms: parseInt(br),
          count,
        })),
        searches: {},
      };

      const communityBounds = COMMUNITY_BOUNDS[propertyConfig.community];

      for (const [bedroomStr, count] of Object.entries(bedroomCounts)) {
        const bedrooms = parseInt(bedroomStr);
        const searchParams: Record<string, string> = {
          engine: "airbnb",
          check_in_date: checkIn,
          check_out_date: checkOut,
          adults: "2",
          bedrooms: String(bedrooms),
          type_of_place: "entire_home",
          currency: "USD",
          api_key: apiKey,
        };

        // q is always required by SearchAPI; bounds are added on top for geo-precision
        searchParams.q = searchLocation;
        if (communityBounds) {
          searchParams.sw_lat = String(communityBounds.sw_lat);
          searchParams.sw_lng = String(communityBounds.sw_lng);
          searchParams.ne_lat = String(communityBounds.ne_lat);
          searchParams.ne_lng = String(communityBounds.ne_lng);
        }

        const params = new URLSearchParams(searchParams);

        const response = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!response.ok) {
          const errText = await response.text();
          console.error(`SearchAPI error for ${bedrooms}BR:`, errText);
          results.searches[`${bedrooms}BR`] = { error: `SearchAPI returned ${response.status}`, count, properties: [] };
          continue;
        }

        const data = await response.json();
        let properties = (data.properties || []).map((p: any) => ({
          id: p.id,
          title: p.title,
          description: p.description,
          link: p.link,
          bookingLink: p.booking_link,
          rating: p.rating,
          reviews: p.reviews,
          price: p.price,
          accommodations: p.accommodations,
          images: (p.images || []).slice(0, 3),
          badges: p.badges,
          gpsCoordinates: p.gps_coordinates,
          source: "airbnb",
        }));

        // Post-filter by GPS coordinates if bounding box is defined and listings have coordinates
        if (communityBounds) {
          const geoFiltered = properties.filter((p: any) => {
            const lat = p.gpsCoordinates?.latitude;
            const lng = p.gpsCoordinates?.longitude;
            if (!lat || !lng) return true; // keep if no coords (don't drop unknowns)
            return (
              lat >= communityBounds.sw_lat && lat <= communityBounds.ne_lat &&
              lng >= communityBounds.sw_lng && lng <= communityBounds.ne_lng
            );
          });
          // Only apply GPS filter if it retains at least some results
          if (geoFiltered.length > 0) properties = geoFiltered;
        }

        properties.sort((a: any, b: any) => {
          const priceA = a.price?.extracted_total_price ?? Infinity;
          const priceB = b.price?.extracted_total_price ?? Infinity;
          return priceA - priceB;
        });

        results.searches[`${bedrooms}BR`] = {
          count,
          totalResults: properties.length,
          properties: properties.slice(0, 10),
          geoFiltered: !!communityBounds,
        };
      }

      res.json(results);
    } catch (err: any) {
      console.error("Airbnb search error:", err);
      res.status(500).json({ error: "Failed to search Airbnb", message: err.message });
    }
  });

  // ========== VRBO DIRECT SCRAPER ==========

  const COMMUNITY_VRBO_DESTINATIONS: Record<string, string> = {
    "Poipu Kai": "Regency at Poipu Kai, Koloa, Hawaii",
    "Kekaha Beachfront": "Kekaha, Hawaii",
    "Keauhou": "Keauhou, Kailua-Kona, Hawaii",
    "Princeville": "Princeville, Kauai, Hawaii",
    "Kapaa Beachfront": "Kapaa, Kauai, Hawaii",
    "Poipu Oceanfront": "Poipu Beach, Koloa, Hawaii",
    "Poipu Brenneckes": "Poipu Beach, Koloa, Hawaii",
    "Pili Mai": "Pili Mai at Poipu, Koloa, Hawaii",
  };

  const COMMUNITY_SP_SLUGS: Record<string, string> = {
    "Poipu Kai": "poipu-vacation-rentals",
    "Poipu Oceanfront": "poipu-vacation-rentals",
    "Poipu Brenneckes": "poipu-vacation-rentals",
    "Pili Mai": "poipu-vacation-rentals",
    "Kapaa Beachfront": "kapaa-vacation-rentals",
    "Princeville": "princeville-vacation-rentals",
  };

  function detectPlatform(name: string, link: string, source: string): string {
    const combined = `${name} ${link} ${source}`.toLowerCase();
    if (combined.includes("vrbo") || combined.includes("homeaway")) return "vrbo";
    if (combined.includes("suite-paradise") || combined.includes("suite paradise") || combined.includes("suiteparadise")) return "suite-paradise";
    if (combined.includes("airbnb")) return "airbnb";
    if (combined.includes("booking.com")) return "booking";
    return "other";
  }

  app.get("/api/vrbo/search", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "SearchAPI.io API key not configured" });
    }

    try {
      const propertyId = parseInt(req.query.propertyId as string, 10);
      const checkIn = req.query.checkIn as string;
      const checkOut = req.query.checkOut as string;

      if (!propertyId || isNaN(propertyId)) {
        return res.status(400).json({ error: "propertyId is required" });
      }
      if (!checkIn || !checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
        return res.status(400).json({ error: "checkIn and checkOut required in YYYY-MM-DD format" });
      }

      const propertyConfig = PROPERTY_UNIT_NEEDS[propertyId];
      if (!propertyConfig) {
        return res.status(404).json({ error: "Property not found in multi-unit config" });
      }

      const destination = COMMUNITY_VRBO_DESTINATIONS[propertyConfig.community] || `${propertyConfig.community}, Hawaii`;
      const spSlug = COMMUNITY_SP_SLUGS[propertyConfig.community];

      const bedroomCounts: Record<number, number> = {};
      for (const unit of propertyConfig.units) {
        bedroomCounts[unit.bedrooms] = (bedroomCounts[unit.bedrooms] || 0) + 1;
      }

      const checkInDate = new Date(checkIn + "T12:00:00");
      const checkOutDate = new Date(checkOut + "T12:00:00");
      const totalNights = Math.max(1, Math.round((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24)));

      const vrboResults: Record<string, any> = {};
      const suiteParadiseResults: Record<string, any> = {};

      const searchPromises = Object.entries(bedroomCounts).map(async ([bedroomStr, count]) => {
        const bedrooms = parseInt(bedroomStr);

        const searchParams: Record<string, string> = {
          engine: "google_hotels",
          q: destination,
          check_in_date: checkIn,
          check_out_date: checkOut,
          adults: "2",
          property_type: "vacation_rental",
          bedrooms: String(bedrooms),
          sort_by: "lowest_price",
          currency: "USD",
          api_key: apiKey,
        };

        try {
          const params = new URLSearchParams(searchParams);
          const response = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);

          if (!response.ok) {
            const errText = await response.text();
            console.error(`Google Hotels search error for ${bedrooms}BR:`, errText);
            vrboResults[`${bedrooms}BR`] = { count, totalResults: 0, properties: [], error: `Search returned ${response.status}` };
            return;
          }

          const data = await response.json();
          const allProperties = (data.properties || []).map((p: any, idx: number) => {
            const pricePerNight = p.price_per_night?.extracted_price || p.extracted_price || null;
            const totalPrice = pricePerNight ? pricePerNight * totalNights : null;
            const source = detectPlatform(p.name || "", p.link || "", p.source || "");

            return {
              id: `gh-${bedrooms}br-${idx}`,
              title: p.name || "Vacation Rental",
              description: p.description || `${bedrooms} bedroom vacation rental`,
              link: p.link && p.link.startsWith("/") ? `https://www.google.com${p.link}` : (p.link || ""),
              bookingLink: p.link && p.link.startsWith("/") ? `https://www.google.com${p.link}` : (p.link || ""),
              source,
              price: totalPrice ? {
                total_price: `$${totalPrice.toLocaleString()}`,
                extracted_total_price: totalPrice,
                price_per_night: pricePerNight,
              } : null,
              rating: p.overall_rating || null,
              reviews: p.reviews || null,
              images: p.images?.slice(0, 3).map((img: any) => img.thumbnail || img.original_image || img) || [],
              badges: [],
              accommodations: [
                p.type || "Vacation Rental",
                ...(p.amenities?.slice(0, 3) || []),
              ].filter(Boolean),
            };
          });

          const vrboListings = allProperties.filter((p: any) => p.source === "vrbo" || p.source === "other" || p.source === "booking");
          const spListings = allProperties.filter((p: any) => p.source === "suite-paradise");

          const vrboSearchUrl = `https://www.vrbo.com/search?` + new URLSearchParams({
            destination,
            startDate: checkIn,
            endDate: checkOut,
            adults: "2",
            bedrooms: String(bedrooms),
            sort: "PRICE_RELEVANT",
          }).toString();

          vrboResults[`${bedrooms}BR`] = {
            count,
            totalResults: vrboListings.length,
            properties: vrboListings.slice(0, 15),
            vrboSearchUrl,
          };

          const formatSpDate = (dateStr: string) => {
            const [y, m, d] = dateStr.split("-");
            return `${m}/${d}/${y}`;
          };
          const spSearchUrl = spSlug
            ? `https://www.suite-paradise.com/${spSlug}?check_in=${formatSpDate(checkIn)}&check_out=${formatSpDate(checkOut)}`
            : null;

          suiteParadiseResults[`${bedrooms}BR`] = {
            count,
            totalResults: spListings.length,
            properties: spListings.slice(0, 10),
            searchUrl: spSearchUrl,
            note: spListings.length === 0
              ? (spSlug ? "Suite Paradise listings can't be searched automatically. Use the link below to search their site directly — they often have great deals for booking direct." : "Suite Paradise may not have listings in this community.")
              : undefined,
          };
        } catch (fetchErr: any) {
          console.error(`Search error for ${bedrooms}BR:`, fetchErr.message);
          vrboResults[`${bedrooms}BR`] = { count, totalResults: 0, properties: [], error: fetchErr.message };
          suiteParadiseResults[`${bedrooms}BR`] = { count, totalResults: 0, properties: [] };
        }
      });

      await Promise.all(searchPromises);

      res.json({
        community: propertyConfig.community,
        checkIn,
        checkOut,
        totalNights,
        unitsNeeded: Object.entries(bedroomCounts).map(([br, count]) => ({
          bedrooms: parseInt(br),
          count,
        })),
        vrbo: vrboResults,
        suiteParadise: suiteParadiseResults,
      });
    } catch (err: any) {
      console.error("VRBO/SP search error:", err);
      res.status(500).json({ error: "Failed to search vacation rentals", message: err.message });
    }
  });

  // ========== BUILDER PHOTO UPSCALE & UPLOAD ==========

  // Upscales a single local photo via Real-ESRGAN, hosts on ImgBB, returns public URL.
  // Client calls this for each photo in sequence then passes ImgBB URLs to Guesty.
  app.post("/api/builder/upscale-photo", async (req, res) => {
    const imgbbKey = process.env.IMGBB_API_KEY;
    const replicateKey = process.env.REPLICATE_API_KEY;

    const { localPath } = req.body as { localPath: string };
    if (!localPath || !localPath.startsWith("/photos/")) {
      return res.status(400).json({ error: "Invalid localPath — must start with /photos/" });
    }

    const safePath = localPath.replace(/\.\./g, "");
    const fullPath = path.join(process.cwd(), "client", "public", safePath);

    let rawData: Buffer;
    try {
      rawData = fs.readFileSync(fullPath);
    } catch {
      return res.status(404).json({ error: "Photo file not found", localPath: safePath });
    }

    const ext = path.extname(safePath).toLowerCase();
    const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

    // Upscale with Real-ESRGAN if key available
    let finalBuffer = rawData;
    let wasUpscaled = false;
    if (replicateKey) {
      console.log(`[builder-upscale] Upscaling ${safePath}...`);
      const upscaled = await upscaleWithReplicateKw(rawData, mimeType);
      if (upscaled) {
        finalBuffer = upscaled;
        wasUpscaled = true;
        console.log(`[builder-upscale] ✓ ${safePath} upscaled (${rawData.length} → ${upscaled.length} bytes)`);
      } else {
        console.warn(`[builder-upscale] Upscale failed for ${safePath}, using original`);
      }
    }

    // Upload to ImgBB to get a publicly accessible URL for Guesty
    if (!imgbbKey) {
      return res.status(500).json({ error: "IMGBB_API_KEY not configured — needed to host photos for Guesty" });
    }

    try {
      const form = new FormData();
      form.append("image", finalBuffer.toString("base64"));
      const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
        method: "POST",
        body: form,
      });
      if (!imgbbResp.ok) {
        const errText = await imgbbResp.text();
        return res.status(502).json({ error: "ImgBB upload failed", detail: errText });
      }
      const imgbbData = await imgbbResp.json() as any;
      const publicUrl = imgbbData?.data?.url;
      if (!publicUrl) return res.status(502).json({ error: "ImgBB returned no URL" });

      res.json({ url: publicUrl, wasUpscaled, localPath: safePath });
    } catch (err: any) {
      res.status(500).json({ error: "Upload to ImgBB failed", message: err.message });
    }
  });

  // ========== BUILDER COVER COLLAGE UPLOAD ==========
  // POST /api/builder/upload-collage
  // Accepts:
  //   { base64: string (data URL or raw base64),
  //     listingId: string,
  //     existingPhotos?: { original: string; caption: string }[]  // optional
  //   }
  // Uploads the collage bytes to ImgBB, then PUTs Guesty's pictures
  // array with the collage at index 0 + the rest.
  //
  // "The rest" is either:
  //   (a) what the CALLER just pushed (passed in as `existingPhotos`) —
  //       preferred, because this is race-free. Guesty's read-after-write
  //       isn't strongly consistent, so a GET right after a push-photos
  //       finish can return stale data and we'd write back fewer pictures
  //       than the caller actually uploaded.
  //   (b) a fresh GET from Guesty — fallback for callers that don't
  //       track their last push (e.g. user returns to the tab later and
  //       regenerates the collage without re-pushing).
  app.post("/api/builder/upload-collage", async (req, res) => {
    const imgbbKey = process.env.IMGBB_API_KEY;
    if (!imgbbKey) return res.status(500).json({ error: "IMGBB_API_KEY not configured" });

    const { base64, listingId, existingPhotos } = req.body as {
      base64: string;
      listingId: string;
      existingPhotos?: { original: string; caption: string }[];
    };
    if (!base64 || !listingId) return res.status(400).json({ error: "base64 and listingId required" });

    // Strip data URL prefix if present
    const raw = base64.replace(/^data:image\/[a-z]+;base64,/, "");

    // Upload to ImgBB
    let collageUrl: string;
    try {
      const form = new FormData();
      form.append("image", raw);
      const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, { method: "POST", body: form });
      if (!imgbbResp.ok) {
        const t = await imgbbResp.text();
        return res.status(502).json({ error: "ImgBB upload failed", detail: t.slice(0, 200) });
      }
      const imgbbData = await imgbbResp.json() as any;
      collageUrl = imgbbData?.data?.url;
      if (!collageUrl) return res.status(502).json({ error: "ImgBB returned no URL" });
    } catch (e: any) {
      return res.status(500).json({ error: "ImgBB error", message: e.message });
    }

    try {
      let existing: { original: string; caption: string }[];

      if (Array.isArray(existingPhotos) && existingPhotos.length > 0) {
        // Race-free path: trust the caller's list.
        existing = existingPhotos
          .map((p) => ({ original: String(p.original || ""), caption: String(p.caption || "") }))
          .filter((p) => p.original);
      } else {
        // Fallback: GET from Guesty. Subject to eventual-consistency
        // lag after recent PUTs — callers that just finished a push
        // should pass `existingPhotos` instead.
        const listing = await guestyRequest("GET", `/listings/${listingId}`) as any;
        existing = (listing?.pictures || []).map((p: any) => ({
          original: p.original || p.url || "",
          caption: p.caption || "",
        })).filter((p: any) => p.original);
      }

      // Remove any previous collage so regeneration doesn't accumulate.
      const withoutOldCollage = existing.filter(p => p.caption !== "Cover Collage");
      const updated = [{ original: collageUrl, caption: "Cover Collage" }, ...withoutOldCollage];
      await guestyRequest("PUT", `/listings/${listingId}`, { pictures: updated });

      res.json({ success: true, collageUrl, totalPhotos: updated.length });
    } catch (e: any) {
      res.status(500).json({ error: "Guesty update failed", message: e.message });
    }
  });

  // POST /api/builder/push-descriptions
  // POST /api/builder/push-channel-markups
  // Sets per-channel price adjustments on a Guesty listing, so the rate the
  // guest sees on Booking.com / Vrbo / Airbnb is ± X% vs the base rate.
  // Typically used to offset higher channel host-fees — e.g. +17% on
  // Booking.com to recover their commission.
  //
  // Body: { listingId: string, markups: { airbnb?: number, vrbo?: number, booking?: number, direct?: number } }
  //   Each markup is a decimal (0.05 = +5%). Negative decreases the rate.
  //
  // Guesty's schema for channel markup has drifted — we try a few known paths:
  //   1. PUT /listings/{id} body { priceMarkup: {airbnb: 0.05, ...} }
  //   2. PUT /listings/{id} body { integrations: {airbnb2: {priceMarkup: 0.05}, ...} }
  //   3. PUT /listings/{id} body { channels: {airbnb2: {priceMarkup: 0.05}, ...} }
  //   4. PUT /listings/{id}/channel-commissions body { channel: "airbnb", markup }
  // We POST all of them in a single PUT with both shape variants merged so whichever
  // Guesty cares about gets applied.
  app.post("/api/builder/push-channel-markups", async (req: Request, res: Response) => {
    const { listingId, markups } = req.body as {
      listingId?: string;
      markups?: Partial<Record<"airbnb" | "vrbo" | "booking" | "direct", number>>;
    };
    if (!listingId) return res.status(400).json({ error: "listingId required" });
    if (!markups || typeof markups !== "object") return res.status(400).json({ error: "markups object required" });

    // Map our logical channel keys to Guesty's integration platform keys.
    // Confirmed from a real listing read-back on 2026-04-21:
    //   Airbnb  → airbnb2     (legacy `airbnb` kept as fallback)
    //   Vrbo    → homeaway2   (Vrbo uses the HomeAway-2 integration slug;
    //                          `homeaway`/`vrbo` are NOT accepted)
    //   Booking → bookingCom
    //   Direct  → no integration record in Guesty — handled via base rate
    const channelToGuesty: Record<string, string[]> = {
      airbnb: ["airbnb2", "airbnb"],
      vrbo: ["homeaway2", "homeaway", "vrbo"],
      booking: ["bookingCom", "booking"],
      direct: ["manual", "direct"],
    };

    // Build PUT body that targets every known shape Guesty might accept
    const priceMarkupFlat: Record<string, number> = {};
    const integrationsPatch: Record<string, { priceMarkup?: number; priceAdjustment?: number }> = {};
    const channelsPatch: Record<string, { priceMarkup?: number }> = {};

    for (const [key, value] of Object.entries(markups)) {
      if (typeof value !== "number" || isNaN(value)) continue;
      priceMarkupFlat[key] = value;
      for (const guestyKey of channelToGuesty[key] ?? [key]) {
        integrationsPatch[guestyKey] = { priceMarkup: value, priceAdjustment: value };
        channelsPatch[guestyKey] = { priceMarkup: value };
      }
    }

    console.log(`[push-channel-markups] listing ${listingId}`, priceMarkupFlat);

    // Based on inspecting a live Guesty listing:
    //   - There's a top-level `markups: {}` field. That's the real target.
    //   - `integrations` is an ARRAY of {platform, ...}, not an object —
    //     so the old {integrations: {airbnb2: ...}} body was malformed.
    //   - `useAccountMarkups: true` flag forces Guesty to use account-level
    //     markups and IGNORE listing-level ones. We must flip it to false
    //     alongside the markup write or the push is silently thrown away.
    //
    // Guesty's exact schema for `markups` isn't documented (at least not
    // in the Open API reference) so we still try a few candidate shapes
    // and let the read-back confirm which one Guesty honors.
    type ShapeAttempt = {
      shape: string;
      body: Record<string, unknown>;
      ok: boolean;
      error?: string;
    };
    const attempts: ShapeAttempt[] = [];

    const tryShape = async (shape: string, body: Record<string, unknown>) => {
      try {
        await guestyRequest("PUT", `/listings/${listingId}`, body);
        attempts.push({ shape, body, ok: true });
        return true;
      } catch (e: any) {
        attempts.push({ shape, body, ok: false, error: e?.message ?? String(e) });
        return false;
      }
    };

    // Helper: snapshot the listing AFTER a push to see what Guesty actually
    // stored. The UI shows this so the operator knows which field path
    // (if any) got through.
    const readbackSaved = async () => {
      try {
        const fetched = await guestyRequest("GET", `/listings/${listingId}`) as any;
        return {
          markups: fetched?.markups ?? null,
          useAccountMarkups: fetched?.useAccountMarkups ?? null,
          priceMarkup: fetched?.priceMarkup ?? null,
        };
      } catch (e: any) {
        return { markups: null, useAccountMarkups: null, priceMarkup: null, readError: e?.message };
      }
    };

    // Convert our channel keys to Guesty platform keys for the `markups` body.
    const markupsByPlatform: Record<string, number> = {};
    const markupsByPlatformObj: Record<string, { percent: number; active: boolean }> = {};
    for (const [key, value] of Object.entries(priceMarkupFlat)) {
      for (const guestyKey of channelToGuesty[key] ?? [key]) {
        markupsByPlatform[guestyKey] = value;
        markupsByPlatformObj[guestyKey] = { percent: value * 100, active: true };
      }
    }

    // IMPORTANT: always flip useAccountMarkups off — listing-level markups
    // are ignored when the account-level toggle is true.
    let anySucceeded = false;
    if (!anySucceeded && Object.keys(markupsByPlatform).length > 0) {
      // Shape A: markups: { airbnb2: 0.148, ... } — flat decimals under `markups`
      anySucceeded = await tryShape("markups-flat-decimal", {
        useAccountMarkups: false,
        markups: markupsByPlatform,
      });
      if (anySucceeded) {
        const rb = await readbackSaved();
        if (rb.markups && typeof rb.markups === "object" && Object.keys(rb.markups).length > 0) {
          return res.json({ success: true, sent: markups, saved: rb, attempts, storedShape: "markups-flat-decimal" });
        }
        // Stored empty again — keep trying other shapes.
        anySucceeded = false;
      }
    }
    if (!anySucceeded && Object.keys(markupsByPlatformObj).length > 0) {
      // Shape B: markups: { airbnb2: { percent: 14.8, active: true }, ... }
      anySucceeded = await tryShape("markups-object-percent", {
        useAccountMarkups: false,
        markups: markupsByPlatformObj,
      });
      if (anySucceeded) {
        const rb = await readbackSaved();
        if (rb.markups && typeof rb.markups === "object" && Object.keys(rb.markups).length > 0) {
          return res.json({ success: true, sent: markups, saved: rb, attempts, storedShape: "markups-object-percent" });
        }
        anySucceeded = false;
      }
    }
    if (!anySucceeded) {
      // Shape C: legacy priceMarkup flat (old code path — kept as fallback).
      anySucceeded = await tryShape("priceMarkup-flat", { priceMarkup: priceMarkupFlat });
      if (anySucceeded) {
        const rb = await readbackSaved();
        if (rb.priceMarkup && Object.keys(rb.priceMarkup).length > 0) {
          return res.json({ success: true, sent: markups, saved: rb, attempts, storedShape: "priceMarkup-flat" });
        }
        anySucceeded = false;
      }
    }

    // Every attempt "succeeded" at HTTP level but Guesty stored nothing.
    // Tell the client honestly — they'll need to set markups in the
    // Guesty UI or at account level since the Open API path isn't honoring
    // any of the body shapes we've tried for this account.
    const saved = await readbackSaved();
    return res.json({
      success: false,
      sent: markups,
      saved,
      attempts,
      error:
        "Guesty accepted each PUT with HTTP 200 but stored nothing. Most likely cause: "
        + "listing-level channel markups aren't exposed via the Open API on this account. "
        + "Set them manually in the Guesty UI (Channel Manager → per-channel markup), "
        + "or we need a real documented field path.",
    });
  });

  // POST /api/builder/push-compliance — pushes TMK, TAT, and GET license to Guesty's internal tags (not synced to Airbnb/VRBO)
  app.post("/api/builder/push-compliance", async (req: Request, res: Response) => {
    const { listingId, taxMapKey, tatLicense, getLicense, strPermit } = req.body as {
      listingId: string;
      taxMapKey?: string;
      tatLicense?: string;
      getLicense?: string;
      strPermit?: string;
    };
    if (!listingId) return res.status(400).json({ error: "listingId required" });
    if (!taxMapKey && !tatLicense && !getLicense) return res.status(400).json({ error: "taxMapKey, tatLicense, or getLicense required" });

    console.log(`[push-compliance] listing ${listingId} TMK:${taxMapKey} TAT:${tatLicense} GET:${getLicense}`);
    try {
      const current = await guestyRequest("GET", `/listings/${listingId}`) as Record<string, unknown>;

      // ── Step 1: Guesty tags (internal reference) ────────────────────────────
      const existingTags: string[] = Array.isArray(current.tags) ? current.tags : [];
      const stripped = existingTags.filter(t => !t.startsWith("TMK:") && !t.startsWith("TAT:") && !t.startsWith("GET:"));
      if (taxMapKey) stripped.push(`TMK:${taxMapKey}`);
      if (tatLicense) stripped.push(`TAT:${tatLicense}`);
      if (getLicense) stripped.push(`GET:${getLicense}`);
      await guestyRequest("PUT", `/listings/${listingId}`, { tags: stripped });

      // ── Step 2: licenseNumber field — Guesty's top-level "Registration/License
      //            Number" field. TAT is the STR permit so it's the primary value.
      //            taxId is Guesty's GET/General Excise Tax field.
      const licenseNumValue = tatLicense || getLicense || null;
      const taxIdValue = getLicense || null;
      const licPayload: Record<string, string> = {};
      if (licenseNumValue) licPayload.licenseNumber = licenseNumValue;
      if (taxIdValue) licPayload.taxId = taxIdValue;
      if (Object.keys(licPayload).length > 0) {
        await guestyRequest("PUT", `/listings/${listingId}`, licPayload);
      }

      // ── Step 3: VRBO channel compliance fields ───────────────────────────────
      // Guesty exposes these under channels.homeaway only once VRBO OAuth is
      // active for the listing. We attempt a best-effort push and verify.
      const vrboPayload: Record<string, unknown> = {};
      if (tatLicense || getLicense || taxMapKey) {
        vrboPayload["channels"] = {
          homeaway: {
            ...(tatLicense  ? { licenseNumber: tatLicense } : {}),
            ...(getLicense  ? { taxId:         getLicense } : {}),
            ...(taxMapKey   ? { parcelNumber:   taxMapKey  } : {}),
          },
        };
        try {
          await guestyRequest("PUT", `/listings/${listingId}`, vrboPayload);
        } catch { /* silently swallow — VRBO fields are optional */ }
      }

      // ── Step 3b: Booking.com channel compliance fields ───────────────────────
      // Booking.com's Guesty path uses a structured license object with a
      // `variantId` that selects the jurisdiction-specific schema. For
      // Hawaii the variant is 6 ("hawaii-hotel_v1") which accepts:
      //   number         → TAT ID      (required by Booking.com)
      //   tmk_number     → Tax Map Key
      //   permit_number  → STR permit
      // We push this whenever we have at least the TAT, since it's the
      // required field. For non-Hawaii listings we skip (variantId 6 is
      // Hawaii-only; we haven't mapped other states' variants yet).
      const stateLooksHawaii = ((current.address as Record<string, unknown> | undefined)?.state as string | undefined || "").toLowerCase().startsWith("hawaii")
        || ((current.address as Record<string, unknown> | undefined)?.state as string | undefined || "").toUpperCase() === "HI";
      const bookingPayload: Record<string, unknown> = {};
      if (stateLooksHawaii && tatLicense) {
        const contentData: Array<{ name: string; value: string }> = [
          { name: "number", value: tatLicense },
        ];
        if (taxMapKey) contentData.push({ name: "tmk_number", value: taxMapKey });
        if (strPermit) contentData.push({ name: "permit_number", value: strPermit });
        bookingPayload["channels"] = {
          bookingCom: {
            license: {
              information: {
                variantId: 6,
                contentData,
              },
            },
          },
        };
        try {
          await guestyRequest("PUT", `/listings/${listingId}`, bookingPayload);
        } catch { /* best-effort — Booking.com may not be connected */ }
      }

      // ── Step 4: publicDescription.notes (OTA-facing compliance block) ────────
      // NOTE: Intentionally DO NOT write the Tax Map Key here. TMK is a bare
      // 12-digit number and Airbnb's content moderation flags it as contact
      // info ("Links and contact info can't be shared"), which rejects the
      // entire Guesty→Airbnb sync and leaves the channel stuck in FAILED
      // status. GET and TAT are safe because they carry letter prefixes
      // (GE- / TA-) that phone-number filters skip.
      //
      // TMK still flows through tags (Step 1), licenseNumber/taxId (Step 2),
      // VRBO parcelNumber (Step 3), Booking.com tmk_number (Step 3b), and
      // Airbnb's regulation form directly — none of which are OTA-scanned
      // content fields. Keeping it out of the public notes is safe.
      const COMPLIANCE_MARKER = "=== Hawaii Tax Compliance ===";
      const pubDesc = (current.publicDescription || {}) as Record<string, string>;
      const existingNotes: string = pubDesc.notes || "";
      const notesWithoutOldBlock = existingNotes.split(COMPLIANCE_MARKER)[0].trimEnd();
      const complianceLines: string[] = [COMPLIANCE_MARKER];
      if (getLicense) complianceLines.push(`General Excise Tax ID (GET): ${getLicense}`);
      if (tatLicense) complianceLines.push(`Transient Accommodations Tax ID (TAT): ${tatLicense}`);
      const newNotes = [notesWithoutOldBlock, complianceLines.join("\n")].filter(Boolean).join("\n\n");
      await guestyRequest("PUT", `/listings/${listingId}`, { publicDescription: { notes: newNotes } });

      // ── Step 5: Verify everything via GET ────────────────────────────────────
      await new Promise(r => setTimeout(r, 500));
      const fetched = await guestyRequest("GET", `/listings/${listingId}`) as Record<string, unknown>;

      const savedTags: string[] = Array.isArray(fetched.tags) ? fetched.tags : [];
      const savedNotes: string = ((fetched.publicDescription as Record<string, string> | undefined)?.notes) || "";
      const savedLicenseNumber: string = (fetched.licenseNumber as string) || "";
      const savedTaxId: string = (fetched.taxId as string) || "";
      const vrboChannel = ((fetched.channels as Record<string, unknown> | undefined)?.homeaway || {}) as Record<string, string>;
      const savedVrboLicense  = vrboChannel.licenseNumber  || "";
      const savedVrboTaxId    = vrboChannel.taxId          || "";
      const savedVrboParcel   = vrboChannel.parcelNumber   || "";

      // Booking.com license schema lives under integrations[].bookingCom.license,
      // not channels.bookingCom. Guesty translates our PUT into the right path
      // internally. Pull what came back to verify.
      const integrations = Array.isArray(fetched.integrations) ? fetched.integrations as any[] : [];
      const bookingInteg = integrations.find((i: any) => i.platform === "bookingCom");
      const bookingLicense = bookingInteg?.bookingCom?.license?.information?.contentData as Array<{ name: string; value: string }> | undefined;
      const savedBookingTAT    = bookingLicense?.find((c) => c.name === "number")?.value ?? "";
      const savedBookingTMK    = bookingLicense?.find((c) => c.name === "tmk_number")?.value ?? "";
      const savedBookingPermit = bookingLicense?.find((c) => c.name === "permit_number")?.value ?? "";

      const tagsVerified =
        (!taxMapKey  || savedTags.some(t => t.includes(taxMapKey)))  &&
        (!tatLicense || savedTags.some(t => t.includes(tatLicense))) &&
        (!getLicense || savedTags.some(t => t.includes(getLicense)));
      const notesVerified = savedNotes.includes(COMPLIANCE_MARKER);
      const licenseNumberSaved = licenseNumValue ? savedLicenseNumber === licenseNumValue : null;
      const taxIdSaved = taxIdValue ? savedTaxId === taxIdValue : null;
      const vrboActive = !!(savedVrboLicense || savedVrboTaxId || savedVrboParcel);

      console.log(`[push-compliance] tags=${tagsVerified} notes=${notesVerified} licenseNumber=${licenseNumberSaved} taxId=${taxIdSaved} vrbo=${vrboActive}`);

      return res.json({
        success: true,
        verified: tagsVerified && notesVerified,
        savedTags,
        notesUpdated: notesVerified,
        licenseNumber: { sent: licenseNumValue, saved: savedLicenseNumber, ok: licenseNumberSaved },
        taxId:         { sent: taxIdValue,       saved: savedTaxId,         ok: taxIdSaved },
        vrbo: {
          attempted: Object.keys(vrboPayload).length > 0,
          saved: vrboActive,
          licenseNumber:  savedVrboLicense,
          taxId:          savedVrboTaxId,
          parcelNumber:   savedVrboParcel,
          note: vrboActive
            ? "VRBO channel compliance fields saved."
            : "VRBO fields not saved — listing needs an active VRBO channel (OAuth) in Guesty UI first.",
        },
        bookingCom: {
          attempted: Object.keys(bookingPayload).length > 0,
          saved: !!(savedBookingTAT || savedBookingTMK || savedBookingPermit),
          number:         savedBookingTAT,
          tmk_number:     savedBookingTMK,
          permit_number:  savedBookingPermit,
          variantId:      bookingInteg?.bookingCom?.license?.information?.variantId ?? null,
          note: stateLooksHawaii
            ? (tatLicense
                ? "Booking.com Hawaii-hotel license pushed via channels.bookingCom."
                : "Skipped — Booking.com Hawaii variant requires tatLicense (the 'number' field) at minimum.")
            : "Skipped — Booking.com license variants for states other than Hawaii aren't mapped yet.",
        },
        airbnb: {
          note: "Airbnb compliance can't be pushed programmatically — Guesty's airbnb2.permits.regulations is read-only. Use the Playwright submit endpoint or enter manually at /regulations/{listingId}/{jurisdiction}/registration.",
        },
      });
    } catch (err: any) {
      console.error(`[push-compliance] error:`, err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/builder/push-amenities — writes canonical amenity names to Guesty's
  // properties-api, which drives the Popular-Amenities checkboxes in the UI.
  // Body: { listingId, amenities: string[] } where amenities are Guesty canonical
  // names (e.g. "Air conditioning", "BBQ grill") from /properties-api/amenities/supported.
  app.post("/api/builder/push-amenities", async (req: Request, res: Response) => {
    const { listingId, amenities } = req.body as { listingId?: string; amenities?: string[] };
    if (!listingId) return res.status(400).json({ success: false, error: "listingId required" });
    if (!Array.isArray(amenities)) return res.status(400).json({ success: false, error: "amenities must be an array" });

    console.log(`[push-amenities] listing ${listingId} — ${amenities.length} amenities in`);
    try {
      // Resolve propertyId from the listing. Guesty's account schema varies:
      //  - Newer accounts expose propertyId / property._id as a separate entity.
      //  - Legacy accounts fold listing and property into one record; the listing _id
      //    is the property id used by /properties-api/amenities/{propertyId}.
      const listing = await guestyRequest("GET", `/listings/${listingId}`) as Record<string, unknown>;
      const propertyId =
        (listing.propertyId as string | undefined) ??
        (listing as any).property?._id ??
        (listing as any)._id ??
        listingId;
      console.log(
        `[push-amenities] resolved propertyId=${propertyId} ` +
        `(listing top-level keys: ${Object.keys(listing).slice(0, 25).join(",")})`,
      );

      // Normalize inputs against Guesty's canonical supported-amenities list.
      // Anything that doesn't map to a canonical name is pushed as a free-form
      // `otherAmenities` entry (Guesty surfaces these in the "Other" section).
      const supportedRaw = await guestyRequest("GET", "/properties-api/amenities/supported") as unknown;
      const supportedList: { name?: string }[] = Array.isArray(supportedRaw)
        ? supportedRaw as { name?: string }[]
        : ((supportedRaw as any)?.results ?? (supportedRaw as any)?.amenities ?? []);
      const canonicalNames = supportedList.map(a => a.name).filter((n): n is string => !!n);
      const norm = (s: string) =>
        s.toLowerCase().replace(/[_\-/&]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
      const byNorm = new Map(canonicalNames.map(n => [norm(n), n]));

      // Explicit aliases: our label/key → normalized Guesty name. Added for cases
      // where Guesty's wording diverges from ours. Values must pre-normalize cleanly
      // to a key present in byNorm.
      const aliasPairs: [string, string][] = [
        // Confirmed from user feedback (round 1)
        ["COVERED_LANAI_PATIO", "patio or balcony"],
        ["Covered Lanai / Patio", "patio or balcony"],
        ["OUTDOOR_FURNITURE", "outdoor seating furniture"],
        ["Outdoor Furniture", "outdoor seating furniture"],
        ["NEAR_SHOPPING", "shopping"],
        ["Near Shopping", "shopping"],
        ["NEAR_BEACH", "beach"],
        ["Near Beach (walking distance)", "beach"],
        // Confirmed from user feedback (round 2 — suggestion-panel alternatives)
        ["BEACHFRONT", "beach front"],
        ["Beachfront (on the beach)", "beach front"],
        ["OCEAN_VIEW", "sea view"],
        ["Ocean View", "sea view"],
        ["CARBON_MONOXIDE_ALARM", "carbon monoxide detector"],
        ["Carbon Monoxide Alarm", "carbon monoxide detector"],
        ["SMOKE_ALARM", "smoke detector"],
        ["SWIMMING_POOL_SHARED", "outdoor pool"],
        ["Swimming Pool (Shared)", "outdoor pool"],
        // "Pool" in our profile (if present) also goes to outdoor pool (Hawaii default)
        ["POOL", "outdoor pool"],
        ["CHILDREN_WELCOME", "family kid friendly"],
        ["Children Welcome", "family kid friendly"],
        // Previously-working items (keep)
        ["AIR_CONDITIONING", "air conditioning"],
        ["BBQ_GRILL", "bbq grill"],
        ["BBQ / Grill", "bbq grill"],
        ["ELEVATOR", "elevator"],
        ["Elevator Access", "elevator"],
        ["HAIR_DRYER", "hair dryer"],
        ["IRON_IRONING_BOARD", "iron"],
        ["COFFEE_MAKER", "coffee maker"],
        ["CABLE_TV", "cable tv"],
        ["PRIVATE_ENTRANCE", "private entrance"],
        ["LAPTOP_FRIENDLY_WORKSPACE", "laptop friendly workspace"],
        ["LONG_TERM_STAYS_ALLOWED", "long term stays allowed"],
      ];
      const aliasMap = new Map(aliasPairs.map(([k, v]) => [norm(k), v]));

      const resolveCanonical = (input: string): string | null => {
        const n = norm(input);
        const direct = byNorm.get(n);
        if (direct) return direct;
        const aliased = aliasMap.get(n);
        if (aliased) return byNorm.get(aliased) ?? null;
        return null;
      };

      const translated: string[] = [];
      const otherToSend: string[] = [];
      const dedupe = new Set<string>();
      const otherDedupe = new Set<string>();
      for (const a of amenities) {
        const hit = resolveCanonical(a);
        if (hit) {
          if (!dedupe.has(hit)) { dedupe.add(hit); translated.push(hit); }
        } else {
          // Preserve a human-readable form for the "Other" bucket.
          const pretty = a.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
          const key = pretty.toLowerCase();
          if (!otherDedupe.has(key)) { otherDedupe.add(key); otherToSend.push(pretty); }
        }
      }
      console.log(`[push-amenities] canonical=${translated.length} other=${otherToSend.length}`);
      if (otherToSend.length) console.log(`[push-amenities] other (not sent, Guesty ignores):`, otherToSend.slice(0, 10));

      // Only send canonical amenities. Guesty's PUT silently ignores otherAmenities
      // so we stop wasting the slot — unmapped items are reported back to the UI.
      await guestyRequest("PUT", `/properties-api/amenities/${propertyId}`, {
        amenities: translated,
      });

      // GET-after-PUT — wait briefly for Guesty's async write to commit
      await new Promise(r => setTimeout(r, 2000));
      const fetched = await guestyRequest("GET", `/properties-api/amenities/${propertyId}`) as Record<string, unknown>;
      const savedAmenities: string[] = Array.isArray(fetched.amenities) ? fetched.amenities as string[] : [];
      const savedOther: string[] = Array.isArray((fetched as any).otherAmenities) ? (fetched as any).otherAmenities : [];
      const savedLower = new Set([...savedAmenities, ...savedOther].map(s => s.toLowerCase()));
      const missing = [...translated, ...otherToSend].filter(a => !savedLower.has(a.toLowerCase()));

      // Build a nearest-match suggestion for each item Guesty couldn't accept,
      // so the UI can show the user Guesty's closest available name.
      // Suggestion ranker. Prefer:
      //  (1) exact token match anywhere in the candidate name (worth more than substring)
      //  (2) candidates whose token count matches the input's
      //  (3) shorter candidates when scores tie (less noise)
      // and return up to 3 candidates per input so the user can pick the right one.
      const suggestFor = (input: string): string[] => {
        const inputTokens = norm(input).split(" ").filter(t => t.length >= 2);
        if (!inputTokens.length) return [];
        const ranked = canonicalNames.map(name => {
          const candTokens = norm(name).split(" ").filter(Boolean);
          const candSet = new Set(candTokens);
          let score = 0;
          for (const t of inputTokens) {
            if (candSet.has(t)) score += 10 + t.length;       // exact token match
            else if (candTokens.some(c => c.startsWith(t) || t.startsWith(c))) score += 5;  // prefix overlap
            else if (norm(name).includes(t)) score += 1;      // substring fallback
          }
          // Penalise candidates that are much longer than the input
          const lenPenalty = Math.max(0, candTokens.length - inputTokens.length) * 2;
          return { name, score: score - lenPenalty, len: name.length };
        }).filter(x => x.score > 0);
        ranked.sort((a, b) => b.score - a.score || a.len - b.len);
        return ranked.slice(0, 3).map(r => r.name);
      };
      const suggestions = otherToSend.map(name => ({ name, suggestion: suggestFor(name)[0] ?? null, alternatives: suggestFor(name).slice(1) }));

      console.log(`[push-amenities] saved=${savedAmenities.length} missing=${missing.length} rejected=${otherToSend.length}`);
      console.log(`[push-amenities] guesty returned sample:`, savedAmenities.slice(0, 10));
      if (missing.length) console.log(`[push-amenities] missing sample:`, missing.slice(0, 10));
      res.json({
        success: true,
        sent: translated.length,
        saved: savedAmenities.length,
        savedAmenities,
        otherAmenities: savedOther,
        rejected: otherToSend,
        suggestions,
        missing,
        propertyId,
        guestyCatalogSize: canonicalNames.length,
      });
    } catch (err: any) {
      console.error(`[push-amenities] error:`, err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/builder/guesty-amenities?listingId=xxx — returns {amenities, otherAmenities}
  // currently set on the property (drives the Popular-Amenities panel in Guesty UI).
  app.get("/api/builder/guesty-amenities", async (req: Request, res: Response) => {
    const { listingId } = req.query as { listingId?: string };
    if (!listingId) return res.status(400).json({ error: "listingId required" });
    try {
      const listing = await guestyRequest("GET", `/listings/${listingId}`) as Record<string, unknown>;
      const propertyId =
        (listing.propertyId as string | undefined) ??
        (listing as any).property?._id ??
        (listing as any)._id ??
        listingId;
      const data = await guestyRequest("GET", `/properties-api/amenities/${propertyId}`);
      return res.json({ ...(data as object), propertyId });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/builder/guesty-supported-amenities — returns Guesty's canonical amenity list
  app.get("/api/builder/guesty-supported-amenities", async (req: Request, res: Response) => {
    try {
      const data = await guestyRequest("GET", "/properties-api/amenities/supported");
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/builder/inspect-listing?listingId=xxx  — returns raw Guesty listing JSON
  app.get("/api/builder/inspect-listing", async (req: Request, res: Response) => {
    const { listingId } = req.query as { listingId?: string };
    if (!listingId) return res.status(400).json({ error: "listingId required" });
    try {
      const data = await guestyRequest("GET", `/listings/${listingId}`);
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Pushes publicDescriptions fields to a Guesty listing via server-side guestyRequest.
  // Returns { success, sent, response?, error? } for debugging.
  app.post("/api/builder/push-descriptions", async (req: Request, res: Response) => {
    const { listingId, descriptions } = req.body as {
      listingId: string;
      descriptions: {
        title?: string;
        summary?: string;
        space?: string;
        neighborhood?: string;
        transit?: string;
        access?: string;
        notes?: string;
        houseRules?: string;
      };
    };

    if (!listingId) return res.status(400).json({ error: "listingId is required" });
    if (!descriptions) return res.status(400).json({ error: "descriptions is required" });

    const payload: Record<string, unknown> = {};
    if (descriptions.title) payload.title = descriptions.title;

    const publicDescriptions: Record<string, string> = {};
    if (descriptions.summary)      publicDescriptions.summary      = descriptions.summary;
    if (descriptions.space)        publicDescriptions.space        = descriptions.space;
    if (descriptions.access)       publicDescriptions.access       = descriptions.access;
    if (descriptions.neighborhood) publicDescriptions.neighborhood = descriptions.neighborhood;
    if (descriptions.transit)      publicDescriptions.transit      = descriptions.transit;
    if (descriptions.notes)        publicDescriptions.notes        = descriptions.notes;
    if (descriptions.houseRules)   publicDescriptions.houseRules   = descriptions.houseRules;

    if (Object.keys(publicDescriptions).length > 0) {
      payload.publicDescription = publicDescriptions;
    }

    console.log(`[push-descriptions] PUT /listings/${listingId}`, JSON.stringify(payload).slice(0, 300) + "...");

    try {
      await guestyRequest("PUT", `/listings/${listingId}`, payload);

      // Immediately GET the listing back to verify what Guesty actually stored
      const fetched = await guestyRequest("GET", `/listings/${listingId}`) as Record<string, unknown>;
      const savedDesc = fetched.publicDescription as Record<string, string> | undefined;
      const savedNickname = fetched.nickname as string | undefined;
      const savedTitle = fetched.title as string | undefined;

      console.log(`[push-descriptions] GET after PUT — nickname: "${savedNickname}", publicDescription keys: ${JSON.stringify(Object.keys(savedDesc ?? {}))}`);
      console.log(`[push-descriptions] summary preview: "${String(savedDesc?.summary ?? "").slice(0, 80)}"`);

      const summaryWasSaved = !!(savedDesc?.summary && savedDesc.summary.length > 10);

      return res.json({
        success: true,
        verified: summaryWasSaved,
        savedDescriptions: savedDesc ?? null,
        savedNickname: savedNickname ?? null,
        savedTitle: savedTitle ?? null,
      });
    } catch (err: any) {
      console.error(`[push-descriptions] error:`, err.message);
      return res.status(500).json({ success: false, error: err.message, sent: payload });
    }
  });

  // POST /api/builder/push-photos
  // Streams NDJSON events as each photo completes so the connection never times out.
  // Each line: { type:"photo", index, total, localPath, success, url?, wasUpscaled?, error? }
  // Final line: { type:"done", successCount, upscaledCount, total }
  app.post("/api/builder/push-photos", async (req, res) => {
    const imgbbKey = process.env.IMGBB_API_KEY;
    const replicateKey = process.env.REPLICATE_API_KEY;

    if (!imgbbKey) {
      return res.status(500).json({ error: "IMGBB_API_KEY not configured — needed to host photos for Guesty" });
    }

    const { guestyListingId, photos: rawPhotos, upscale = true } = req.body as {
      guestyListingId: string;
      photos: { localPath: string; caption: string }[];
      upscale?: boolean;
    };

    if (!guestyListingId || !Array.isArray(rawPhotos) || rawPhotos.length === 0) {
      return res.status(400).json({ error: "guestyListingId and photos[] are required" });
    }

    // Cap total photos sent to Guesty at 40 so Booking.com (~40 hard
    // limit) and VRBO (50) don't reject the push. The client already
    // orders photos as: community-begin → Unit A → Unit B → ... →
    // community-end, which is the priority we want preserved. Trim
    // from the end (lowest-priority community-end photos first).
    const MAX_GUESTY_PHOTOS = 40;
    const photos = rawPhotos.length > MAX_GUESTY_PHOTOS
      ? rawPhotos.slice(0, MAX_GUESTY_PHOTOS)
      : rawPhotos;
    const trimmedCount = rawPhotos.length - photos.length;

    // Stream NDJSON — one JSON line per photo + a final summary line.
    // This keeps the HTTP connection alive for as long as needed (no timeout).
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering if present
    res.flushHeaders();

    const emit = (obj: Record<string, unknown>) => {
      res.write(JSON.stringify(obj) + "\n");
    };

    let upscaledCount = 0;

    // Phase 1: Upload each photo to ImgBB (stream per-photo progress).
    // Collect successful { original, caption } objects for a single Guesty PUT at the end.
    // Guesty's v1 API does NOT have POST /listings/{id}/pictures — pictures are set via
    // PUT /listings/{id} with a "pictures" array where each item uses the "original" field.
    const collected: { original: string; caption: string }[] = [];
    const perPhotoResults: Array<{ index: number; localPath: string; success: boolean; url?: string; wasUpscaled?: boolean; error?: string }> = [];

    for (let i = 0; i < photos.length; i++) {
      const { localPath, caption } = photos[i];
      const index = i + 1;

      // Validate path
      if (!localPath || !localPath.startsWith("/photos/")) {
        emit({ type: "photo", index, total: photos.length, localPath, success: false, error: "Invalid path" });
        perPhotoResults.push({ index, localPath, success: false, error: "Invalid path" });
        continue;
      }

      const safePath = localPath.replace(/\.\./g, "");
      const fullPath = path.join(process.cwd(), "client", "public", safePath);

      // Read local file
      let rawData: Buffer;
      try {
        rawData = fs.readFileSync(fullPath);
      } catch {
        emit({ type: "photo", index, total: photos.length, localPath, success: false, error: "File not found on server" });
        perPhotoResults.push({ index, localPath, success: false, error: "File not found" });
        continue;
      }

      const ext = path.extname(safePath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

      // Optionally upscale with Replicate (skipped if upscale=false or no key)
      let finalBuffer = rawData;
      let finalMime = mimeType;
      let wasUpscaled = false;
      if (upscale && replicateKey) {
        try {
          const upscaled = await upscaleWithReplicateKw(rawData, mimeType);
          if (upscaled) {
            finalBuffer = upscaled;
            wasUpscaled = true;
          }
        } catch {
          // upscale failure is non-fatal — push original
        }
      }

      // Pre-flight validation: normalize to Guesty/Booking.com/Airbnb-compatible spec
      //   landscape, width=1920, JPEG, <=4MB. Auto-rotates portraits, resizes, recompresses.
      // Runs AFTER Replicate so AI upscale quality is preserved, then we enforce final spec.
      let validationChanges: string[] = [];
      try {
        const validated = await validateAndFixPhoto(finalBuffer, finalMime);
        finalBuffer = validated.buffer;
        finalMime = validated.mimeType;
        validationChanges = validated.changes;
        if (validationChanges.length > 0) {
          console.log(`[push-photos] validate ${index}/${photos.length} ${safePath}: ${validationChanges.join("; ")}`);
          emit({
            type: "validation",
            index,
            total: photos.length,
            localPath,
            changes: validationChanges,
            finalWidth: validated.finalWidth,
            finalHeight: validated.finalHeight,
            finalBytes: validated.finalBytes,
          });
        }
      } catch (e: any) {
        // Validation failure is non-fatal — push original buffer and flag it
        console.error(`[push-photos] validation failed ${index}/${photos.length}: ${e.message}`);
        emit({
          type: "validation",
          index,
          total: photos.length,
          localPath,
          warning: `validation failed: ${e.message} — pushing original`,
        });
      }

      // Upload to ImgBB to get a publicly accessible URL
      let publicUrl: string;
      try {
        const form = new FormData();
        form.append("image", finalBuffer.toString("base64"));
        const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
          method: "POST",
          body: form,
        });
        if (!imgbbResp.ok) {
          const errText = await imgbbResp.text();
          emit({ type: "photo", index, total: photos.length, localPath, success: false, error: `ImgBB ${imgbbResp.status}: ${errText.slice(0, 100)}` });
          perPhotoResults.push({ index, localPath, success: false, error: `ImgBB ${imgbbResp.status}` });
          continue;
        }
        const imgbbData = await imgbbResp.json() as any;
        publicUrl = imgbbData?.data?.url;
        if (!publicUrl) {
          emit({ type: "photo", index, total: photos.length, localPath, success: false, error: "ImgBB returned no URL" });
          perPhotoResults.push({ index, localPath, success: false, error: "ImgBB no URL" });
          continue;
        }
      } catch (e: any) {
        emit({ type: "photo", index, total: photos.length, localPath, success: false, error: `ImgBB error: ${e.message}` });
        perPhotoResults.push({ index, localPath, success: false, error: e.message });
        continue;
      }

      // ImgBB upload succeeded — queue for Guesty PUT
      if (wasUpscaled) upscaledCount++;
      collected.push({ original: publicUrl, caption: caption || "" });
      perPhotoResults.push({ index, localPath, success: true, url: publicUrl, wasUpscaled });
      emit({ type: "photo", index, total: photos.length, localPath, success: true, url: publicUrl, wasUpscaled, validationChanges, pending: true });
      console.log(`[push-photos] ✓ ImgBB ${index}/${photos.length} ${safePath}`);

      // Checkpoint: commit accumulated photos to Guesty every 5 successful uploads.
      // Each PUT replaces the full pictures array, so we accumulate. This way a server
      // restart or network drop mid-run still leaves the completed photos in Guesty.
      const CHECKPOINT_EVERY = 5;
      if (collected.length > 0 && collected.length % CHECKPOINT_EVERY === 0) {
        emit({ type: "checkpoint", saved: collected.length, total: photos.length });
        try {
          await guestyRequest("PUT", `/listings/${guestyListingId}`, { pictures: collected });
          console.log(`[push-photos] ✓ Checkpoint Guesty PUT — ${collected.length} photos committed`);
        } catch (e: any) {
          console.error(`[push-photos] ✗ Checkpoint Guesty PUT failed: ${e.message}`);
          // Non-fatal: keep uploading remaining photos, try final PUT at end
        }
      }
    }

    // Final PUT to Guesty with all collected pictures (handles remainder after last checkpoint).
    // Guesty stores pictures via PUT /listings/{id} with pictures[].original (not url).
    // This replaces all existing photos on the listing.
    let successCount = 0;
    if (collected.length > 0) {
      emit({ type: "saving", count: collected.length });
      try {
        await guestyRequest("PUT", `/listings/${guestyListingId}`, { pictures: collected });
        successCount = collected.length;
        console.log(`[push-photos] ✓ Guesty PUT — ${successCount} photos saved to listing ${guestyListingId}`);
      } catch (e: any) {
        console.error(`[push-photos] ✗ Guesty PUT failed: ${e.message}`);
        emit({ type: "done", successCount: 0, upscaledCount, total: photos.length, trimmed: trimmedCount, guestyError: e.message });
        res.end();
        return;
      }
    }

    // Verify-and-retry loop. Guesty silently drops pictures from the
    // array when it can't fetch the URL during its internal validation
    // (observed: ImgBB CDN propagation lag on newly-uploaded images
    // causes the last few URLs to 404 when Guesty tries them, and Guesty
    // strips them from `pictures` without signaling an error). Without
    // this loop the server reports successCount=N but Guesty stored
    // fewer. The retry gives the ImgBB CDN time to catch up and re-PUTs.
    //
    // Retry ladder: wait 3s, verify, retry if short. Wait 6s, verify,
    // retry. Wait 10s, verify. Give up after that and report the final
    // observed count so the UI doesn't lie.
    let verifiedCount = successCount;
    if (collected.length > 0) {
      const waits = [3000, 6000, 10000];
      for (let attempt = 0; attempt < waits.length; attempt++) {
        await new Promise((r) => setTimeout(r, waits[attempt]));
        try {
          const listing = await guestyRequest("GET", `/listings/${guestyListingId}?fields=pictures`) as any;
          const savedLen = Array.isArray(listing?.pictures) ? listing.pictures.length : 0;
          emit({ type: "verify", attempt: attempt + 1, expected: collected.length, got: savedLen });
          console.log(`[push-photos] Verify #${attempt + 1}: expected ${collected.length}, Guesty has ${savedLen}`);
          if (savedLen >= collected.length) {
            verifiedCount = savedLen;
            break;
          }
          // Under-count — re-PUT and loop. Don't early-break on success
          // because some later attempts might succeed once the CDN
          // settles.
          try {
            await guestyRequest("PUT", `/listings/${guestyListingId}`, { pictures: collected });
            console.log(`[push-photos] Retry PUT #${attempt + 1} — re-pushed ${collected.length} pictures after short-count verify`);
          } catch (e: any) {
            console.error(`[push-photos] Retry PUT #${attempt + 1} failed: ${e.message}`);
          }
          verifiedCount = savedLen;
        } catch (e: any) {
          console.error(`[push-photos] Verify #${attempt + 1} GET failed: ${e.message}`);
          // Don't break — a transient GET failure shouldn't abort the loop
        }
      }
    }

    const shortfall = collected.length - verifiedCount;
    emit({
      type: "done",
      successCount,
      verifiedCount,
      shortfall: shortfall > 0 ? shortfall : 0,
      upscaledCount,
      total: photos.length,
      trimmed: trimmedCount,
    });
    console.log(`[push-photos] Done: ${successCount}/${photos.length} pushed, verified ${verifiedCount} on Guesty${shortfall > 0 ? ` (shortfall ${shortfall} — Guesty silently dropped them)` : ""}, ${upscaledCount} upscaled${trimmedCount ? `, ${trimmedCount} trimmed` : ""}`);
    res.end();
  });

  // GET /api/builder/guesty-monthly-rates/:propertyId
  // Pulls Guesty's daily calendar rate for the given property across the requested
  // year range, then aggregates to a per-month average. Used by the pricing table
  // to show "what Guesty is ACTUALLY charging" next to "what our sheet expects".
  //
  // Query: ?startYear=2026&months=24  (default 24 months starting this month)
  // Response: { units: [{ guestyListingId, unitId, unitLabel, months: [{yearMonth,avgRate,minRate,maxRate,days}] }] }
  app.get("/api/builder/guesty-monthly-rates/:propertyId", async (req: Request, res: Response) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });

    const months = Math.min(parseInt((req.query.months as string) ?? "24", 10) || 24, 36);
    const startParam = req.query.start as string | undefined;
    const start = startParam ? new Date(startParam) : new Date();
    start.setDate(1); start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setMonth(end.getMonth() + months);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    try {
      // Multi-unit properties have multiple Guesty listings. For now we look up the
      // property's canonical Guesty listing via guestyPropertyMap. Multi-listing
      // support is a follow-up (returning one unit per Guesty listing).
      const listingId = await storage.getGuestyListingId(propertyId);
      if (!listingId) {
        return res.status(404).json({ error: `No Guesty listing mapped for property ${propertyId}` });
      }

      // Guesty's calendar endpoint — per-day price and availability.
      // https://open-api-docs.guesty.com/reference/calendarscontroller_getcalendars
      const url = `/availability-pricing/api/calendar/listings/${listingId}?startDate=${iso(start)}&endDate=${iso(end)}`;
      const calendarResp = await guestyRequest("GET", url) as any;
      // Response shape varies — could be array directly, {data: [...]}, or {status, data: [...]}.
      const days: any[] = Array.isArray(calendarResp)
        ? calendarResp
        : Array.isArray(calendarResp?.data) ? calendarResp.data
        : Array.isArray(calendarResp?.data?.days) ? calendarResp.data.days
        : Array.isArray(calendarResp?.days) ? calendarResp.days
        : [];

      // Bucket per-day rates by yearMonth
      const buckets = new Map<string, number[]>();
      for (const d of days) {
        const dateStr: string = d.date ?? d.day ?? "";
        const rate: number = Number(d.price ?? d.rate ?? d.nightlyPrice ?? 0);
        if (!dateStr || !rate || isNaN(rate)) continue;
        const ym = dateStr.slice(0, 7);
        const arr = buckets.get(ym) ?? [];
        arr.push(rate);
        buckets.set(ym, arr);
      }

      const monthEntries = Array.from(buckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([yearMonth, rates]) => {
          const total = rates.reduce((s, r) => s + r, 0);
          return {
            yearMonth,
            avgRate: Math.round(total / rates.length),
            minRate: Math.min(...rates),
            maxRate: Math.max(...rates),
            days: rates.length,
          };
        });

      return res.json({
        propertyId,
        guestyListingId: listingId,
        months: monthEntries,
        totalDays: days.length,
      });
    } catch (err: any) {
      console.error(`[guesty-monthly-rates] error:`, err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/builder/push-seasonal-rates
  // Pushes per-day base nightly rates to Guesty's calendar. The client sends
  // a flat rate per month and this expands it to the days in each month, then
  // PUTs them to Guesty in one chunked batch.
  //
  // Why this exists: a flat Guesty base rate combined with seasonal buy-in
  // cost creates wildly variable margins (95% in low season, 20% in high).
  // To hit a steady margin target across months, the base rate itself has
  // to scale with season — that's what this endpoint writes.
  app.post("/api/builder/push-seasonal-rates", async (req: Request, res: Response) => {
    const { listingId, monthlyRates } = req.body as {
      listingId?: string;
      // Each entry: { yearMonth: "2026-08", price: 1970 } — price becomes the
      // per-night base for every day in that month.
      monthlyRates?: Array<{ yearMonth: string; price: number }>;
    };
    if (!listingId) return res.status(400).json({ error: "listingId required" });
    if (!Array.isArray(monthlyRates) || monthlyRates.length === 0) {
      return res.status(400).json({ error: "monthlyRates array required" });
    }

    // Expand monthly rates into per-day entries Guesty will accept.
    type DayEntry = { date: string; price: number };
    const days: DayEntry[] = [];
    for (const { yearMonth, price } of monthlyRates) {
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) continue;
      if (!Number.isFinite(price) || price <= 0) continue;
      const [y, m] = yearMonth.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last day of this
      for (let d = 1; d <= lastDay; d++) {
        const ds = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        days.push({ date: ds, price: Math.round(price) });
      }
    }
    if (days.length === 0) return res.status(400).json({ error: "no valid days to push" });

    // Guesty's calendar update prefers ranges over individual days — group
    // consecutive same-price days into {startDate, endDate, price} ranges.
    type Range = { startDate: string; endDate: string; price: number };
    const ranges: Range[] = [];
    let current: Range | null = null;
    for (const d of days) {
      if (current && current.price === d.price) {
        current.endDate = d.date;
      } else {
        if (current) ranges.push(current);
        current = { startDate: d.date, endDate: d.date, price: d.price };
      }
    }
    if (current) ranges.push(current);

    console.log(`[push-seasonal-rates] listing ${listingId} · ${ranges.length} ranges · ${days.length} days`);

    // Guesty's calendar PUT validates one range at a time:
    //   PUT /availability-pricing/api/calendar/listings/:id
    //   { startDate, endDate, price }
    // Bulk-array bodies fail with "days is not allowed". We loop and PUT
    // one range per call. ~13 calls for the typical 24-month seasonal map.
    let pushedRanges = 0;
    const failedRanges: Array<{ range: Range; error: string }> = [];
    for (const range of ranges) {
      try {
        await guestyRequest("PUT", `/availability-pricing/api/calendar/listings/${listingId}`, {
          startDate: range.startDate,
          endDate: range.endDate,
          price: range.price,
        });
        pushedRanges++;
      } catch (e: any) {
        failedRanges.push({ range, error: e?.message ?? String(e) });
        // Keep going — partial success is more useful than aborting the
        // whole 24-month push because one range glitched.
      }
    }

    try {
      // Read back a sample of days to confirm the push stuck.
      const firstDate = days[0].date;
      const lastDate = days[days.length - 1].date;
      const verifyUrl = `/availability-pricing/api/calendar/listings/${listingId}?startDate=${firstDate}&endDate=${lastDate}`;
      const verify = await guestyRequest("GET", verifyUrl) as any;
      const vDays: any[] = Array.isArray(verify) ? verify
        : Array.isArray(verify?.data) ? verify.data
        : Array.isArray(verify?.data?.days) ? verify.data.days
        : Array.isArray(verify?.days) ? verify.days
        : [];
      // Count how many days in the response match the price we intended.
      const priceByDate = new Map(days.map((d) => [d.date, d.price]));
      let matched = 0;
      for (const d of vDays) {
        const dateStr: string = d.date ?? d.day ?? "";
        const rate: number = Number(d.price ?? d.rate ?? d.nightlyPrice ?? 0);
        if (priceByDate.get(dateStr) === Math.round(rate)) matched++;
      }
      return res.json({
        success: failedRanges.length === 0,
        pushedDays: days.length,
        pushedRanges,
        totalRanges: ranges.length,
        failedRanges: failedRanges.slice(0, 5),
        verifiedDays: matched,
        sampleRange: ranges[0],
      });
    } catch (err: any) {
      console.error(`[push-seasonal-rates] verify error:`, err.message);
      // Push happened (or partially happened); only verification failed.
      return res.json({
        success: failedRanges.length === 0,
        pushedDays: days.length,
        pushedRanges,
        totalRanges: ranges.length,
        failedRanges: failedRanges.slice(0, 5),
        verifyError: err.message,
      });
    }
  });

  // GET /api/builder/market-comps/:propertyId?nights=7
  // Fetches comparable Airbnb listings with the same total bedroom count as
  // our property bundle across three representative date windows (low,
  // high, holiday). Returns per-season price distributions — median,
  // percentiles, count — so the pricing table can flag whether a
  // proposed rate lands in the competitive range or way above market.
  //
  // Why this exists: a 6BR combined listing competes against area 6BR
  // villas + other multi-unit resort bundles. "$1,970/night" is meaningless
  // without knowing what a 6BR oceanfront rental in Kauai actually goes
  // for in July. This gives us the ceiling reference.
  app.get("/api/builder/market-comps/:propertyId", async (req: Request, res: Response) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });
    const nights = Math.min(Math.max(parseInt((req.query.nights as string) ?? "7", 10) || 7, 2), 14);

    const config = PROPERTY_UNIT_NEEDS[propertyId];
    if (!config) return res.status(404).json({ error: "Property not in config" });

    const totalBR = config.units.reduce((s, u) => s + u.bedrooms, 0);
    const community = config.community;
    const searchLocation = COMMUNITY_SEARCH_LOCATIONS[community] || `${community}, Hawaii`;
    const bounds = COMMUNITY_BOUNDS[community];

    // Pick one check-in per season bucket. We want recent-but-future dates —
    // far enough ahead that Airbnb returns actual listings, not dead
    // inventory; not so far that the pricing engines haven't built calendars
    // yet. Walk ~4-10 months ahead and pick a weekday for each season.
    const now = new Date();
    const monthAhead = (delta: number): Date => {
      const d = new Date(now);
      d.setMonth(d.getMonth() + delta, 12);
      return d;
    };
    // LOW: mid-September (shoulder). HIGH: mid-July (summer). HOLIDAY: late Dec.
    // If we're already past those months this year, roll to next year.
    const pickDate = (targetMonth: number, targetDay: number): Date => {
      const y = now.getFullYear();
      const thisYear = new Date(y, targetMonth, targetDay, 12, 0, 0);
      if (thisYear.getTime() < now.getTime() + 30 * 86_400_000) {
        return new Date(y + 1, targetMonth, targetDay, 12, 0, 0);
      }
      return thisYear;
    };
    const toYmd = (d: Date) => d.toISOString().slice(0, 10);
    const addDays = (d: Date, n: number) => {
      const c = new Date(d); c.setDate(c.getDate() + n); return c;
    };
    const seasonWindows: Array<{ season: "LOW" | "HIGH" | "HOLIDAY"; checkIn: string; checkOut: string }> = [
      (() => { const ci = pickDate(8, 15); return { season: "LOW" as const,     checkIn: toYmd(ci), checkOut: toYmd(addDays(ci, nights)) }; })(),
      (() => { const ci = pickDate(6, 10); return { season: "HIGH" as const,    checkIn: toYmd(ci), checkOut: toYmd(addDays(ci, nights)) }; })(),
      (() => { const ci = pickDate(11, 26); return { season: "HOLIDAY" as const, checkIn: toYmd(ci), checkOut: toYmd(addDays(ci, nights)) }; })(),
    ];
    // Safety net — keep only windows whose check-in is actually in the
    // future. (pickDate already handles the roll-forward but double-check.)
    const safeWindows = seasonWindows.filter((w) => new Date(w.checkIn) >= now);
    if (safeWindows.length === 0) monthAhead(1); // silence unused warning

    // Distribution stats on a sorted array. Returns null if too few comps
    // — we don't want to call a "market median" on 2 samples.
    const percentile = (sortedArr: number[], p: number): number | null => {
      if (sortedArr.length === 0) return null;
      const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
      return sortedArr[idx];
    };
    const computeStats = (rates: number[]) => {
      if (rates.length < 3) return { n: rates.length, enough: false, median: null, p25: null, p40: null, p75: null, p90: null, min: null, max: null };
      const sorted = [...rates].sort((a, b) => a - b);
      return {
        n: sorted.length,
        enough: true,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p25: percentile(sorted, 25),
        p40: percentile(sorted, 40),
        median: percentile(sorted, 50),
        p75: percentile(sorted, 75),
        p90: percentile(sorted, 90),
      };
    };

    try {
      const perSeason = await Promise.all(seasonWindows.map(async (w) => {
        const sp: Record<string, string> = {
          engine: "airbnb",
          check_in_date: w.checkIn,
          check_out_date: w.checkOut,
          adults: String(Math.min(16, totalBR * 2)),
          bedrooms: String(totalBR),
          type_of_place: "entire_home",
          currency: "USD",
          api_key: apiKey,
          q: searchLocation,
        };
        if (bounds) {
          sp.sw_lat = String(bounds.sw_lat);
          sp.sw_lng = String(bounds.sw_lng);
          sp.ne_lat = String(bounds.ne_lat);
          sp.ne_lng = String(bounds.ne_lng);
        }
        try {
          const r = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`);
          if (!r.ok) return {
            ...w, error: `HTTP ${r.status}`,
            condo: { stats: computeStats([]), sample: [] },
            villa: { stats: computeStats([]), sample: [] },
            all:   { stats: computeStats([]), sample: [] },
          };
          const data = await r.json() as any;
          const props: any[] = Array.isArray(data?.properties) ? data.properties : [];
          // Post-filter: require actual BR count >= totalBR. The engine's
          // `bedrooms` param is a minimum but some results slip through.
          const qualifying = props.filter((p: any) => {
            const pb = typeof p?.bedrooms === "number" ? p.bedrooms : null;
            return pb == null || pb >= totalBR;
          });

          // Classify each comp as villa-tier (premium, standalone) or
          // condo-tier (direct peer to our bundle). We read Airbnb's
          // `property_type` first — it's the authoritative field — and
          // fall back to title/description keyword detection when the
          // engine didn't populate it. Ambiguous entries are excluded
          // from BOTH buckets so they don't pollute either median.
          const classify = (p: any): "villa" | "condo" | "ambiguous" => {
            const pt = String(p?.property_type ?? p?.room_type ?? "").toLowerCase();
            const hay = `${pt} ${String(p?.name ?? p?.title ?? "").toLowerCase()} ${String(p?.description ?? "").toLowerCase()}`;
            const villaHit = /\b(villa|estate|mansion|chalet|bungalow|cottage|standalone|single[- ]family|detached|private home|pool home)\b/.test(hay);
            const condoHit = /\b(condo|condominium|townhome|townhouse|apartment|apt\.?|flat|suite)\b/.test(hay);
            if (villaHit && !condoHit) return "villa";
            if (condoHit && !villaHit) return "condo";
            // `property_type=House` alone typically skews villa for 6BR+
            // listings — we lean it into the villa tier so the ceiling
            // isn't under-populated. Condo tier only gets explicit condos.
            if (!villaHit && !condoHit && /\b(house|home)\b/.test(pt)) return "villa";
            return "ambiguous";
          };

          type Tier = "villa" | "condo" | "ambiguous";
          const bucket: Record<Tier, { rates: number[]; sample: any[] }> = {
            villa:     { rates: [], sample: [] },
            condo:     { rates: [], sample: [] },
            ambiguous: { rates: [], sample: [] },
          };

          for (const p of qualifying) {
            const total = Number(p?.price?.extracted_total_price ?? 0);
            if (!(total > 0)) continue;
            const nightly = total / nights;
            const tier = classify(p);
            bucket[tier].rates.push(nightly);
            if (bucket[tier].sample.length < 5) {
              bucket[tier].sample.push({
                title: String(p?.name ?? p?.title ?? "Listing"),
                url: String(p?.link ?? ""),
                bedrooms: typeof p?.bedrooms === "number" ? p.bedrooms : null,
                propertyType: String(p?.property_type ?? ""),
                nightlyRate: Math.round(nightly),
                tier,
              });
            }
          }

          const allRates = [...bucket.villa.rates, ...bucket.condo.rates, ...bucket.ambiguous.rates];
          return {
            ...w,
            condo: { stats: computeStats(bucket.condo.rates), sample: bucket.condo.sample },
            villa: { stats: computeStats(bucket.villa.rates), sample: bucket.villa.sample },
            all:   { stats: computeStats(allRates),          sample: [...bucket.condo.sample, ...bucket.villa.sample].slice(0, 6) },
            rawCount: props.length,
            qualifyingCount: qualifying.length,
          };
        } catch (e: any) {
          return {
            ...w, error: e.message,
            condo: { stats: computeStats([]), sample: [] },
            villa: { stats: computeStats([]), sample: [] },
            all:   { stats: computeStats([]), sample: [] },
          };
        }
      }));

      // Keyed by season for easy client lookup.
      const seasons: Record<string, any> = {};
      for (const s of perSeason) seasons[s.season] = s;

      return res.json({
        propertyId,
        community,
        totalBR,
        nights,
        seasons,
        searchLocation,
      });
    } catch (err: any) {
      console.error(`[market-comps] error:`, err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ===========================================================
  // AVAILABILITY / INVENTORY SCANNER  (Phase 1+2)
  // ===========================================================
  //
  // The dashboard's Availability tab used to surface individual buy-in
  // candidates to click. That's not the job — the real goal is a
  // booking-safety guarantee: for every 7-day window in the next 24
  // months, make sure we can find enough independent complete buy-in
  // SETS (one listing per unit slot, no reuse across sets) to honor
  // whatever a guest books + some buffer. When we can't, block that
  // window in Guesty's calendar so it can't be oversold.
  //
  // Two endpoints:
  //   GET  /api/availability/scan/:propertyId         streams per-window verdicts
  //   POST /api/availability/sync-blocks/:propertyId  diffs scan vs DB-tracked
  //                                                    blocks and writes to Guesty
  //
  // Guesty blocking uses POST /blocks (with reasonType: "owner_block"),
  // NOT the calendar PUT. Scanner-placed blocks get a `source: "nexstay-scanner"`
  // tag in the DB so the diff step never touches blocks placed by
  // humans or other integrations.

  app.get("/api/availability/scan/:propertyId", async (req: Request, res: Response) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });
    const weeks = Math.min(Math.max(parseInt((req.query.weeks as string) ?? "52", 10) || 52, 4), 104);
    const minSets = Math.max(1, parseInt((req.query.minSets as string) ?? "3", 10) || 3);

    const config = PROPERTY_UNIT_CONFIGS[propertyId];
    if (!config) return res.status(404).json({ error: `Property ${propertyId} not in config` });

    const community = config.community;

    // Resort name from the Guesty listing title — makes the search query
    // tight enough that we count listings AT this resort, not the broader
    // area.
    let resortName: string | null = null;
    let guestyListingId: string | null = null;
    try {
      guestyListingId = await storage.getGuestyListingId(propertyId);
      if (guestyListingId) {
        const listing = await guestyRequest("GET", `/listings/${guestyListingId}?fields=title%20nickname`) as any;
        const title = listing?.title ?? listing?.nickname ?? null;
        if (title) resortName = title.split(/\s+[–-]\s+/)[0].trim();
      }
    } catch { /* non-fatal */ }

    // Manual overrides — short-circuit the verdict for specific weeks.
    const overrides = await storage.getScannerOverrides(propertyId).catch(() => []);
    const overrideByStart = new Map(overrides.map((o) => [o.startDate, o]));

    const uniqueBedrooms = Array.from(new Set(config.units.map((u) => u.bedrooms)));

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const emit = (obj: Record<string, unknown>) => { res.write(JSON.stringify(obj) + "\n"); };

    emit({
      type: "start",
      propertyId,
      guestyListingId,
      community,
      resortName,
      units: config.units,
      minSets,
      weeks,
    });

    // Cheap mode: ONE site:airbnb.com/rooms search per unique BR count
    // for the whole scan. Listings at a given resort don't appear or
    // disappear week-to-week, so the same count applies to every window.
    // Cost: ~3 SearchAPI calls for an 11-property × daily-scan portfolio
    // instead of ~5,000.
    const countsByBR: Record<number, number> = {};
    const samplesByBR: Record<number, CandidateListing[]> = {};
    const errorsByBR: Record<number, string> = {};
    await Promise.all(uniqueBedrooms.map(async (br) => {
      try {
        const r = await countAirbnbCandidates({ resortName, community, bedrooms: br, apiKey });
        countsByBR[br] = r.count;
        samplesByBR[br] = r.sample;
      } catch (e: any) {
        errorsByBR[br] = e?.message ?? String(e);
        countsByBR[br] = 0;
        samplesByBR[br] = [];
      }
    }));

    const baselineSets = computeSetsFromCounts(config.units, countsByBR);
    const baselineVerdict = verdictFor(baselineSets, minSets);

    emit({
      type: "candidates",
      countsByBR,
      samplesByBR,
      errors: errorsByBR,
      baselineSets,
      baselineVerdict,
    });

    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const toYmd = (d: Date) => d.toISOString().slice(0, 10);

    for (let w = 1; w <= weeks; w++) {
      const start = new Date(today);
      start.setDate(start.getDate() + (w - 1) * 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      const startDate = toYmd(start);
      const endDate = toYmd(end);

      const ov = overrideByStart.get(startDate);
      if (ov) {
        const verdict = ov.mode === "force-block" ? "blocked" : "open";
        emit({
          type: "window",
          startDate, endDate,
          verdict,
          maxSets: ov.mode === "force-open" ? minSets + 5 : 0,
          minSets,
          overridden: true,
          overrideMode: ov.mode,
          overrideNote: ov.note ?? null,
          listingCounts: countsByBR,
          sample: samplesByBR,
        });
        continue;
      }

      // Same baseline applies to every non-overridden window.
      emit({
        type: "window",
        startDate, endDate,
        verdict: baselineVerdict,
        maxSets: baselineSets,
        minSets,
        listingCounts: countsByBR,
        sample: samplesByBR,
      });
    }

    emit({ type: "done", weeks, baselineSets, baselineVerdict });
    res.end();
  });

  // POST /api/availability/sync-blocks/:propertyId
  //
  // Reads the client's scan results (array of windows with verdicts),
  // diffs against the DB-tracked blocks we previously placed, and writes
  // the delta to Guesty's calendar:
  //
  //   New blocked windows → PUT /availability-pricing/api/calendar/listings/{id}
  //                         with { startDate, endDate, status: "unavailable" }
  //   Previously-blocked windows now open/tight → same path with status: "available"
  //
  // (Confirmed by probe — the legacy POST /blocks path returns 404; the
  // calendar PUT with a status field is the working approach.)
  // Only touches blocks where `source = "nexstay-scanner"`. Human-placed
  // blocks from other tools are never modified.
  app.post("/api/availability/sync-blocks/:propertyId", async (req: Request, res: Response) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });

    const body = req.body as {
      windows?: Array<{ startDate: string; endDate: string; verdict: string; maxSets?: number; minSets?: number }>;
    };
    const windows = Array.isArray(body.windows) ? body.windows : [];
    if (windows.length === 0) return res.status(400).json({ error: "windows array required" });

    const guestyListingId = await storage.getGuestyListingId(propertyId);
    if (!guestyListingId) return res.status(404).json({ error: `No Guesty listing mapped for property ${propertyId}` });

    const active = await storage.getActiveScannerBlocks(propertyId);
    const activeKeyed = new Map(active.map((b) => [`${b.startDate}:${b.endDate}`, b]));
    const desiredBlocks = new Set(
      windows.filter((w) => w.verdict === "blocked").map((w) => `${w.startDate}:${w.endDate}`),
    );

    let created = 0;
    let removed = 0;
    const failures: Array<{ action: string; startDate: string; error: string }> = [];
    const calPath = `/availability-pricing/api/calendar/listings/${guestyListingId}`;

    // Block new windows via calendar PUT with status: "unavailable"
    for (const w of windows.filter((ww) => ww.verdict === "blocked")) {
      const key = `${w.startDate}:${w.endDate}`;
      if (activeKeyed.has(key)) continue; // already blocked by us
      try {
        const reason = `low-inventory: ${w.maxSets ?? 0} / ${w.minSets ?? 0} sets`;
        const resp = await guestyRequest("PUT", calPath, {
          startDate: w.startDate,
          endDate: w.endDate,
          status: "unavailable",
          note: `nexstay-scanner: ${reason}`,
        }) as any;
        // Guesty returns the created blocks in resp.data.blocks.createdBlocks[0]._id
        const createdBlocksArr = resp?.data?.blocks?.createdBlocks
          ?? resp?.blocks?.createdBlocks
          ?? [];
        const guestyBlockId = createdBlocksArr[0]?._id ?? createdBlocksArr[0]?.id ?? null;
        await storage.createScannerBlock({
          propertyId,
          guestyListingId,
          startDate: w.startDate,
          endDate: w.endDate,
          guestyBlockId,
          reason,
        });
        created++;
        await new Promise((r) => setTimeout(r, 120));
      } catch (e: any) {
        failures.push({ action: "create", startDate: w.startDate, error: e?.message ?? String(e) });
      }
    }

    // Unblock windows by setting status: "available" on the same range
    for (const b of active) {
      const key = `${b.startDate}:${b.endDate}`;
      if (desiredBlocks.has(key)) continue;
      try {
        await guestyRequest("PUT", calPath, {
          startDate: b.startDate,
          endDate: b.endDate,
          status: "available",
        });
        await storage.markScannerBlockRemoved(b.id);
        removed++;
        await new Promise((r) => setTimeout(r, 120));
      } catch (e: any) {
        failures.push({ action: "remove", startDate: b.startDate, error: e?.message ?? String(e) });
      }
    }

    return res.json({
      success: failures.length === 0,
      propertyId,
      guestyListingId,
      created,
      removed,
      unchanged: active.length - removed,
      failures,
    });
  });

  // GET /api/availability/overrides/:propertyId
  app.get("/api/availability/overrides/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });
    const rows = await storage.getScannerOverrides(propertyId);
    res.json({ overrides: rows });
  });

  // POST /api/availability/overrides/:propertyId  { startDate, endDate, mode, note }
  app.post("/api/availability/overrides/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });
    const { startDate, endDate, mode, note } = req.body as {
      startDate?: string; endDate?: string; mode?: string; note?: string;
    };
    if (!startDate || !endDate || !mode) return res.status(400).json({ error: "startDate, endDate, mode required" });
    if (mode !== "force-open" && mode !== "force-block") return res.status(400).json({ error: "mode must be force-open or force-block" });
    const row = await storage.upsertScannerOverride({ propertyId, startDate, endDate, mode, note: note ?? null });
    res.json({ override: row });
  });

  // DELETE /api/availability/overrides/:propertyId/:startDate
  app.delete("/api/availability/overrides/:propertyId/:startDate", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    const { startDate } = req.params;
    if (isNaN(propertyId) || !startDate) return res.status(400).json({ error: "invalid params" });
    const ok = await storage.deleteScannerOverride(propertyId, startDate);
    res.json({ deleted: ok });
  });

  // ── Airbnb session probe (cookie-injection mode) ──
  // Bypasses Airbnb's bot-detection on the login page entirely by
  // loading a real authenticated browser session (cookies exported from
  // the user's normal browser via "EditThisCookie" or DevTools) into a
  // Playwright context. Then we navigate straight to /hosting and check
  // whether Airbnb treats the request as authenticated.
  //
  // Cookies live in AIRBNB_SESSION_COOKIES env var as a JSON array in
  // EditThisCookie's export format. They expire ~30 days after issue;
  // refresh by re-exporting from a logged-in browser.
  app.post("/api/admin/airbnb/test-login", async (_req: Request, res: Response) => {
    const cookieJson = process.env.AIRBNB_SESSION_COOKIES;
    if (!cookieJson) {
      return res.status(500).json({
        ok: false,
        error: "AIRBNB_SESSION_COOKIES env var not set",
        instructions: [
          "1) Log into airbnb.com on Chrome (your normal browser).",
          "2) Install the 'EditThisCookie' Chrome extension (or use DevTools → Application → Storage → Cookies → airbnb.com).",
          "3) Click EditThisCookie → Export → 'Copy to clipboard' (JSON format).",
          "4) Paste the JSON array into Railway env var AIRBNB_SESSION_COOKIES. Don't escape it — paste as-is.",
          "5) Re-trigger this endpoint.",
        ],
      });
    }

    type RawCookie = {
      name?: string; value?: string;
      domain?: string; path?: string;
      expirationDate?: number; expires?: number;
      httpOnly?: boolean; secure?: boolean;
      sameSite?: string;
    };
    let raw: RawCookie[];
    try {
      raw = JSON.parse(cookieJson);
      if (!Array.isArray(raw)) throw new Error("not an array");
    } catch (e: any) {
      return res.status(500).json({
        ok: false,
        error: `AIRBNB_SESSION_COOKIES isn't valid JSON: ${e?.message ?? e}`,
      });
    }

    // EditThisCookie uses snake_case sameSite values that Playwright
    // doesn't accept directly. Translate.
    const sameSiteMap: Record<string, "Strict" | "Lax" | "None"> = {
      strict: "Strict", lax: "Lax", no_restriction: "None", unspecified: "Lax", none: "None",
    };
    const cookies = raw
      .filter((c) => c.name && c.value && c.domain)
      .map((c) => ({
        name: c.name!,
        value: c.value!,
        domain: c.domain!.startsWith(".") ? c.domain! : `.${c.domain!}`,
        path: c.path ?? "/",
        expires: typeof c.expirationDate === "number" ? Math.floor(c.expirationDate)
              : typeof c.expires === "number" ? Math.floor(c.expires)
              : -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? true,
        sameSite: sameSiteMap[(c.sameSite ?? "lax").toLowerCase()] ?? "Lax" as "Strict" | "Lax" | "None",
      }));

    const started = Date.now();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
        ],
      });
      const ctx = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: "en-US",
        timezoneId: "Pacific/Honolulu",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
      // INJECT THE SESSION COOKIES BEFORE NAVIGATING — this is what
      // turns Playwright from "bot trying to log in" into "authenticated
      // returning user".
      await ctx.addCookies(cookies);

      const page = await ctx.newPage();
      const steps: Array<{ at: number; label: string; url: string }> = [];
      const snap = (label: string) => steps.push({ at: Date.now() - started, label, url: page.url() });

      await page.goto("https://www.airbnb.com/hosting", { waitUntil: "domcontentloaded", timeout: 30000 });
      snap("loaded-hosting");
      await page.waitForTimeout(3000);
      snap("post-wait");

      const finalUrl = page.url();
      const title = await page.title().catch(() => "");
      const bodyText = await page
        .evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 4000))
        .catch(() => "");
      const sessionCookies = await ctx.cookies();
      const screenshot = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false }).catch(() => null);

      // Verdict heuristics
      const stayedOnHosting = /\/hosting\b/.test(finalUrl) && !/\/login\b/.test(finalUrl);
      const hasHostCookie = sessionCookies.some((c) =>
        c.name === "_user_attributes" || c.name === "aat" || c.name === "_aat" || c.name === "_csrf_token");
      const titleHostHint = /host|hosting|dashboard|listing/i.test(title);
      const blockedByBotMgr = /503|temporarily unavailable|stay tuned/i.test(title) || /503|temporarily unavailable|stay tuned/i.test(bodyText);

      const verdict =
        blockedByBotMgr ? "blocked-by-bot-detection" :
        stayedOnHosting && (hasHostCookie || titleHostHint) ? "logged-in" :
        /\/login/.test(finalUrl) ? "cookies-expired-or-invalid" :
        "unknown";

      return res.json({
        ok: true,
        verdict,
        elapsedMs: Date.now() - started,
        finalUrl,
        title,
        injectedCookieCount: cookies.length,
        sessionCookieCount: sessionCookies.length,
        sessionCookieNames: sessionCookies.map((c) => c.name).sort().slice(0, 30),
        signals: { stayedOnHosting, hasHostCookie, titleHostHint, blockedByBotMgr },
        steps,
        bodyExcerpt: bodyText.slice(0, 1200),
        screenshotBase64: screenshot ? `data:image/jpeg;base64,${screenshot.toString("base64")}` : null,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  // ── Airbnb regulatory-page inspector (read-only dry run) ──
  // Loads the host session, navigates to a specific listing's regulatory
  // tab, and returns form metadata (input names, labels, current values)
  // + a screenshot. No writes, no clicks on save — this is the schema
  // probe we use to design the real compliance-push step.
  //
  // Query body: { listingId: string, candidatePaths?: string[] }
  // Default candidates cover the observed path styles Airbnb has used;
  // first one that loads a non-404 listing-editor page wins.
  app.post("/api/admin/airbnb/inspect-regulatory", async (req: Request, res: Response) => {
    const cookieJson = process.env.AIRBNB_SESSION_COOKIES;
    if (!cookieJson) return res.status(500).json({ error: "AIRBNB_SESSION_COOKIES not set" });

    const { listingId, candidatePaths } = (req.body ?? {}) as {
      listingId?: string;
      candidatePaths?: string[];
    };
    if (!listingId || !/^\d+$/.test(listingId)) {
      return res.status(400).json({ error: "listingId required (numeric Airbnb listing id)" });
    }

    // Same cookie-normalize logic as test-login.
    type RawCookie = { name?: string; value?: string; domain?: string; path?: string; expirationDate?: number; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string };
    const raw: RawCookie[] = JSON.parse(cookieJson);
    const sameSiteMap: Record<string, "Strict" | "Lax" | "None"> = {
      strict: "Strict", lax: "Lax", no_restriction: "None", unspecified: "Lax", none: "None",
    };
    const cookies = raw
      .filter((c) => c.name && c.value && c.domain)
      .map((c) => ({
        name: c.name!,
        value: c.value!,
        domain: c.domain!.startsWith(".") ? c.domain! : `.${c.domain!}`,
        path: c.path ?? "/",
        expires: typeof c.expirationDate === "number" ? Math.floor(c.expirationDate)
              : typeof c.expires === "number" ? Math.floor(c.expires)
              : -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? true,
        sameSite: sameSiteMap[(c.sameSite ?? "lax").toLowerCase()] ?? "Lax" as "Strict" | "Lax" | "None",
      }));

    // Paths Airbnb has used for the regulatory tab (pattern matches the
    // `/details/photo-tour` URL the user pointed at). Try in order; take
    // the first that doesn't 404.
    const pathsToTry = (candidatePaths && candidatePaths.length > 0) ? candidatePaths : [
      `/hosting/listings/editor/${listingId}/details/regulatory`,
      `/hosting/listings/editor/${listingId}/details/registration`,
      `/hosting/listings/editor/${listingId}/details/compliance`,
      `/hosting/listings/editor/${listingId}/details/legal`,
      `/hosting/listings/${listingId}/details/regulatory`,
      `/hosting/listings/${listingId}/details/registration`,
    ];

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
      });
      const ctx = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: "en-US",
        timezoneId: "Pacific/Honolulu",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();

      const attempts: Array<{ path: string; finalUrl: string; title: string; looksValid: boolean }> = [];
      let chosenPath: string | null = null;

      // SINGLE-NAV strategy — 4 rapid sub-path fetches triggered Akamai's
      // bot detector on the last probe. Instead: one warm-up navigation
      // to /hosting (we know that works), a humanized wait, then ONE
      // navigation to the listing editor root. The editor auto-redirects
      // to whatever its default sub-path is, and we scrape the sidebar
      // from there to discover where compliance/regulatory actually lives.
      await page.goto("https://www.airbnb.com/hosting", { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(3000);
      // Simulated scroll / mouse jiggle — low-budget humanization.
      await page.mouse.move(500, 300);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(1500);

      await page.goto(`https://www.airbnb.com/hosting/listings/editor/${listingId}`, {
        waitUntil: "domcontentloaded", timeout: 30000,
      });
      await page.waitForTimeout(4000);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(1500);

      const landedUrl = page.url();
      const landedTitle = await page.title().catch(() => "");
      const bodyCheckAfterLanding = await page.evaluate(() =>
        (document.body?.innerText || "").slice(0, 500).toLowerCase()
      ).catch(() => "");
      const blockedByBotMgr = /503|temporarily unavailable|stay tuned/i.test(landedTitle) ||
                              /503|temporarily unavailable|stay tuned/i.test(bodyCheckAfterLanding);
      attempts.push({
        path: `/hosting/listings/editor/${listingId}`,
        finalUrl: landedUrl,
        title: landedTitle,
        looksValid: !blockedByBotMgr && !/page not found/i.test(landedTitle),
      });
      if (!blockedByBotMgr && !/page not found/i.test(landedTitle)) {
        chosenPath = new URL(landedUrl).pathname;
      }

      // Scrape every in-editor link for the sidebar. Airbnb's sidebar
      // lives as `a[href*='/details/']` inside the listing editor —
      // grab all of them, dedupe by href, and capture visible text so
      // we can find the regulatory / compliance / license tab by name.
      let sidebarLinks: Array<{ href: string; text: string }> = [];
      try {
        sidebarLinks = await page.evaluate((lid: string) => {
          const out: Array<{ href: string; text: string }> = [];
          const seen = new Set<string>();
          document.querySelectorAll("a").forEach((a) => {
            const href = (a as HTMLAnchorElement).href;
            // Only keep in-editor links for THIS listing
            if (!href.includes("/hosting/listings/editor/" + lid)) return;
            if (seen.has(href)) return;
            seen.add(href);
            const text = ((a as HTMLAnchorElement).innerText || "").replace(/\s+/g, " ").trim();
            out.push({ href, text: text.slice(0, 80) });
          });
          return out.slice(0, 80);
        }, listingId);
      } catch { /* best effort */ }

      // Dump all inputs + labels on whichever page we landed on.
      const formFields = await page.evaluate(() => {
        type Field = { tag: string; type?: string; name?: string; id?: string; label?: string; placeholder?: string; value?: string; ariaLabel?: string };
        const out: Field[] = [];
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea"));
        for (const el of inputs) {
          // Find an associated label
          let label: string | undefined;
          if ((el as HTMLInputElement).labels && (el as HTMLInputElement).labels!.length > 0) {
            label = (el as HTMLInputElement).labels![0].innerText?.trim();
          }
          if (!label && el.id) {
            const lbl = document.querySelector(`label[for='${el.id}']`);
            if (lbl) label = (lbl as HTMLLabelElement).innerText?.trim();
          }
          out.push({
            tag: el.tagName.toLowerCase(),
            type: (el as HTMLInputElement).type,
            name: el.getAttribute("name") || undefined,
            id: el.id || undefined,
            label,
            placeholder: el.getAttribute("placeholder") || undefined,
            value: (el as HTMLInputElement).value?.slice(0, 120) || undefined,
            ariaLabel: el.getAttribute("aria-label") || undefined,
          });
        }
        return out.filter((f) =>
          // Skip hidden / irrelevant inputs to keep the response sane.
          f.type !== "hidden" && f.type !== "submit" && f.type !== "button"
        ).slice(0, 60);
      });

      const finalUrl = page.url();
      const title = await page.title().catch(() => "");
      const bodyText = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 3500)).catch(() => "");
      const screenshot = await page.screenshot({ type: "jpeg", quality: 60, fullPage: true }).catch(() => null);

      return res.json({
        ok: true,
        chosenPath,
        finalUrl,
        title,
        attempts,
        sidebarLinks,
        formFieldCount: formFields.length,
        formFields,
        bodyExcerpt: bodyText.slice(0, 1500),
        screenshotBase64: screenshot ? `data:image/jpeg;base64,${screenshot.toString("base64")}` : null,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  // ── Airbnb network-request inspector (Option C reverse-engineering) ──
  // Loads the listing editor with cookie injection AND network logging.
  // Every HTTP request the editor UI fires during load is captured; the
  // endpoint filters for regulatory/license/permit/registration terms and
  // returns them so we can find the API Airbnb's own UI uses to read
  // (and presumably write) license data. Then we can replay that request
  // directly with cookies — no Playwright form automation needed.
  app.post("/api/admin/airbnb/inspect-network", async (req: Request, res: Response) => {
    const cookieJson = process.env.AIRBNB_SESSION_COOKIES;
    if (!cookieJson) return res.status(500).json({ error: "AIRBNB_SESSION_COOKIES not set" });

    const { listingId, keepFor, widenCapture, editorPaths, fullUrls } = (req.body ?? {}) as {
      listingId?: string;
      keepFor?: number; // ms to keep listening after initial load (default 12s)
      widenCapture?: boolean;
      editorPaths?: string[];
      // When provided, navigate to THESE absolute URLs instead of walking
      // the /hosting/listings/editor/ sub-paths. Lets us probe Airbnb
      // namespaces that live outside the editor (e.g. /regulations/...).
      fullUrls?: string[];
    };
    console.error(`[inspect-network] body keys: ${Object.keys(req.body ?? {}).join(", ")}`);
    console.error(`[inspect-network] fullUrls type: ${typeof fullUrls}, isArray: ${Array.isArray(fullUrls)}, length: ${Array.isArray(fullUrls) ? fullUrls.length : "n/a"}`);
    if (Array.isArray(fullUrls)) {
      for (const u of fullUrls) console.error(`[inspect-network]   fullUrl: ${u}`);
    }
    if (!listingId || !/^\d+$/.test(listingId)) {
      return res.status(400).json({ error: "listingId required (numeric Airbnb listing id)" });
    }
    const listenMs = Math.min(Math.max(keepFor ?? 12000, 4000), 30000);

    type RawCookie = { name?: string; value?: string; domain?: string; path?: string; expirationDate?: number; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string };
    const raw: RawCookie[] = JSON.parse(cookieJson);
    const sameSiteMap: Record<string, "Strict" | "Lax" | "None"> = { strict: "Strict", lax: "Lax", no_restriction: "None", unspecified: "Lax", none: "None" };
    const cookies = raw
      .filter((c) => c.name && c.value && c.domain)
      .map((c) => ({
        name: c.name!, value: c.value!,
        domain: c.domain!.startsWith(".") ? c.domain! : `.${c.domain!}`,
        path: c.path ?? "/",
        expires: typeof c.expirationDate === "number" ? Math.floor(c.expirationDate)
              : typeof c.expires === "number" ? Math.floor(c.expires) : -1,
        httpOnly: c.httpOnly ?? false, secure: c.secure ?? true,
        sameSite: sameSiteMap[(c.sameSite ?? "lax").toLowerCase()] ?? "Lax" as "Strict" | "Lax" | "None",
      }));

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
      });
      const ctx = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: "en-US",
        timezoneId: "Pacific/Honolulu",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
      await ctx.addCookies(cookies);

      type CapturedReq = {
        method: string;
        url: string;
        resourceType: string;
        // GraphQL operation name / persisted-query hash, when detectable
        operationName?: string;
        bodyPreview?: string;
        // Response data — only populated for matched endpoints (to keep payload small)
        respStatus?: number;
        respPreview?: string;
      };
      const captured: CapturedReq[] = [];
      const keywordRe = /regulat|licens|permit|regist|complian|taxmap|tat_license|str_license/i;

      const page = await ctx.newPage();

      page.on("request", (reqEvt) => {
        const url = reqEvt.url();
        const method = reqEvt.method();
        const type = reqEvt.resourceType();
        // Skip static assets — we want API calls only.
        if (["image", "stylesheet", "font", "media"].includes(type)) return;
        // Interesting if it hits an Airbnb API path AND matches a keyword,
        // OR is a GraphQL op whose operationName is regulatory.
        let operationName: string | undefined;
        let bodyPreview: string | undefined;
        const pdata = reqEvt.postData();
        if (pdata) {
          bodyPreview = pdata.slice(0, 600);
          // GraphQL calls post JSON with `operationName`. Pull it out
          // when present — Airbnb names operations after the feature.
          if (/operationName/.test(pdata)) {
            try {
              const parsed = JSON.parse(pdata);
              if (Array.isArray(parsed)) operationName = parsed[0]?.operationName;
              else operationName = parsed?.operationName;
            } catch { /* ignore */ }
          }
        }
        const blob = `${url} ${operationName ?? ""} ${bodyPreview ?? ""}`;
        const matchesKeyword = keywordRe.test(blob);
        // Widen mode: capture every airbnb.com/api/* call so we can see
        // the actual API surface the editor uses, even when no one
        // endpoint has a regulatory-sounding name.
        const isApi = /airbnb\.com\/api\//.test(url);
        if (!matchesKeyword && !(widenCapture && isApi)) return;
        captured.push({ method, url, resourceType: type, operationName, bodyPreview });
      });

      page.on("response", async (resp) => {
        const url = resp.url();
        const matched = captured.find((c) => c.url === url);
        if (!matched) return;
        try {
          matched.respStatus = resp.status();
          const headers = resp.headers();
          const ct = headers["content-type"] || "";
          if (ct.includes("json")) {
            const text = await resp.text().catch(() => "");
            matched.respPreview = text.slice(0, 1200);
          }
        } catch { /* ignore */ }
      });

      // Warm up with /hosting so Akamai's trust cookies settle
      await page.goto("https://www.airbnb.com/hosting", { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(2500);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(1000);

      // Two modes:
      //   fullUrls: navigate to these absolute URLs one after another.
      //             Used to probe namespaces outside /hosting/listings/editor/
      //             like /regulations/{id}/{jurisdiction}/.
      //   editorPaths: legacy mode that walks /hosting/listings/editor/{id}{path}.
      if (fullUrls && fullUrls.length > 0) {
        const perDwell = Math.max(3000, Math.floor(listenMs / fullUrls.length));
        for (const u of fullUrls) {
          try {
            await page.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 });
          } catch { /* 404s/redirects expected on some */ }
          await page.waitForTimeout(perDwell);
          await page.mouse.wheel(0, 800);
          await page.waitForTimeout(800);
          await page.mouse.wheel(0, 1600);
          await page.waitForTimeout(800);
        }
      } else {
        const defaultPaths = [
          "/details/regulations",
          "/details/registration",
          "/details/licenses",
          "/details/taxes",
          "/policies/hosting-rules",
          "/compliance",
          "/laws",
          "",
        ];
        const pathsToVisit = (editorPaths && editorPaths.length > 0) ? editorPaths : defaultPaths;
        const perPathDwell = Math.max(2000, Math.floor(listenMs / pathsToVisit.length));
        for (const p of pathsToVisit) {
          const targetUrl = `https://www.airbnb.com/hosting/listings/editor/${listingId}${p}`;
          try {
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
          } catch { /* 404s expected on some paths */ }
          await page.waitForTimeout(perPathDwell);
          await page.mouse.wheel(0, 600);
          await page.waitForTimeout(400);
        }
        // Public listing page fallback — regulatory info can render in the footer.
        await page.goto(`https://www.airbnb.com/rooms/${listingId}`, {
          waitUntil: "domcontentloaded", timeout: 30000,
        });
        await page.waitForTimeout(Math.floor(listenMs / 2));
        await page.mouse.wheel(0, 4000);
        await page.waitForTimeout(3000);
      }

      // Also scrape the sidebar once more so the user can see what we saw
      const sidebar = await page.evaluate((lid: string) => {
        const out: Array<{ href: string; text: string }> = [];
        const seen = new Set<string>();
        document.querySelectorAll("a").forEach((a) => {
          const href = (a as HTMLAnchorElement).href;
          if (!href.includes("/hosting/listings/editor/" + lid)) return;
          if (seen.has(href)) return;
          seen.add(href);
          const text = ((a as HTMLAnchorElement).innerText || "").replace(/\s+/g, " ").trim();
          out.push({ href, text: text.slice(0, 60) });
        });
        return out;
      }, listingId).catch(() => []);

      return res.json({
        ok: true,
        listingId,
        listenMs,
        usedFullUrls: Array.isArray(fullUrls) && fullUrls.length > 0,
        fullUrlsReceived: Array.isArray(fullUrls) ? fullUrls : null,
        finalUrl: page.url(),
        finalTitle: await page.title().catch(() => ""),
        capturedCount: captured.length,
        capturedRequests: captured.slice(0, 60),
        sidebarSample: sidebar.slice(0, 10),
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  // ============================================================
  // POST /api/admin/airbnb/inspect-form
  //
  // Navigates to the /regulations/{listingId}/{jurisdiction}/registration/
  // initial/{step} URL and dumps the form's DOM structure (all input
  // elements, their labels, names, types) so we can learn how to fill it.
  // Read-only — never submits.
  //
  // Body: { listingId, jurisdiction, step? }
  //   jurisdiction defaults to "kauai_county_hawaii"
  //   step defaults to "existing-registration"
  // ============================================================
  app.post("/api/admin/airbnb/inspect-form", async (req: Request, res: Response) => {
    const cookieJson = process.env.AIRBNB_SESSION_COOKIES;
    if (!cookieJson) return res.status(500).json({ error: "AIRBNB_SESSION_COOKIES not set" });

    const { listingId, jurisdiction, step } = (req.body ?? {}) as {
      listingId?: string;
      jurisdiction?: string;
      step?: string;
    };
    if (!listingId || !/^\d+$/.test(listingId)) {
      return res.status(400).json({ error: "listingId required" });
    }
    const juri = (jurisdiction || "kauai_county_hawaii").replace(/[^a-z0-9_]/gi, "");
    const stp = (step || "existing-registration").replace(/[^a-z0-9_-]/gi, "");

    type RawCookie = { name?: string; value?: string; domain?: string; path?: string; expirationDate?: number; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string };
    const raw: RawCookie[] = JSON.parse(cookieJson);
    const sameSiteMap: Record<string, "Strict" | "Lax" | "None"> = { strict: "Strict", lax: "Lax", no_restriction: "None", unspecified: "Lax", none: "None" };
    const cookies = raw
      .filter((c) => c.name && c.value && c.domain)
      .map((c) => ({
        name: c.name!, value: c.value!,
        domain: c.domain!.startsWith(".") ? c.domain! : `.${c.domain!}`,
        path: c.path ?? "/",
        expires: typeof c.expirationDate === "number" ? Math.floor(c.expirationDate)
              : typeof c.expires === "number" ? Math.floor(c.expires) : -1,
        httpOnly: c.httpOnly ?? false, secure: c.secure ?? true,
        sameSite: sameSiteMap[(c.sameSite ?? "lax").toLowerCase()] ?? "Lax" as "Strict" | "Lax" | "None",
      }));

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
      });
      const ctx = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: "en-US",
        timezoneId: "Pacific/Honolulu",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();

      // Warm up with /hosting so Akamai cookies settle before navigating to
      // the regulations flow.
      await page.goto("https://www.airbnb.com/hosting", { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(2500);
      const targetUrl = `https://www.airbnb.com/regulations/${listingId}/${juri}/registration/initial/${stp}`;
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(5000); // let the form hydrate

      // Dump every input/select/textarea on the page with enough context to
      // identify each field. The visible label usually sits in a preceding
      // <label> or an adjacent text node — we capture both so the caller
      // has a fighting chance to map field semantics.
      const formFields = await page.evaluate(() => {
        const getLabel = (el: Element): string => {
          const id = (el as HTMLInputElement).id;
          if (id) {
            const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lab) return (lab.textContent || "").trim().slice(0, 120);
          }
          // Walk up looking for the nearest label wrapper
          let cur: Element | null = el;
          for (let i = 0; i < 4 && cur; i++) {
            const parentLabel = cur.closest("label");
            if (parentLabel) return (parentLabel.textContent || "").trim().slice(0, 120);
            cur = cur.parentElement;
          }
          // Fallback: aria-label on the element
          const al = el.getAttribute("aria-label");
          if (al) return al.slice(0, 120);
          return "";
        };
        const rows: Array<{ tag: string; type?: string; name?: string; id?: string; placeholder?: string; value?: string; label: string; required?: boolean }> = [];
        document.querySelectorAll("input, select, textarea").forEach((el) => {
          const tag = el.tagName.toLowerCase();
          const t = el as HTMLInputElement;
          if (["hidden", "submit", "button"].includes(t.type)) return;
          rows.push({
            tag,
            type: t.type || undefined,
            name: t.name || undefined,
            id: t.id || undefined,
            placeholder: t.placeholder || undefined,
            value: t.value ? t.value.slice(0, 80) : undefined,
            label: getLabel(el),
            required: t.required || undefined,
          });
        });
        return rows;
      }).catch(() => []);

      // Also dump headings so we can see what step / section we landed on.
      const headings = await page.evaluate(() =>
        Array.from(document.querySelectorAll("h1, h2, h3")).map((h) => (h.textContent || "").trim().slice(0, 140)).filter(Boolean)
      ).catch(() => []);

      // Dump all visible button labels so we know what to click to submit.
      const buttons = await page.evaluate(() =>
        Array.from(document.querySelectorAll("button")).map((b) => ({
          text: (b.textContent || "").trim().slice(0, 80),
          type: b.type,
          disabled: b.disabled,
          ariaLabel: b.getAttribute("aria-label") || "",
          dataTestId: b.getAttribute("data-testid") || "",
        })).filter((b) => b.text)
      ).catch(() => []);

      const bodyPreview = await page
        .evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 2000))
        .catch(() => "");

      return res.json({
        ok: true,
        listingId, jurisdiction: juri, step: stp,
        targetUrl,
        finalUrl: page.url(),
        finalTitle: await page.title().catch(() => ""),
        formFields,
        headings,
        buttons: buttons.slice(0, 30),
        bodyPreview,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  // ============================================================
  // POST /api/admin/airbnb/submit-compliance
  //
  // Auto-submits the Kauai County Hawaii regulations form for a listing.
  // Based on the DOM captured by inspect-form, the form has three fields:
  //   #permit_number-text  → TMK (labeled "Tax Map Key number")
  //   #tat_number-text     → TAT license number
  //   #attestation-...     → legal attestation checkbox
  //   button "Next"        → advances to confirm step
  //
  // Body: { listingId, jurisdiction?, taxMapKey, tatLicense, dryRun? }
  //   dryRun: fill the form but do NOT click Next — for debugging.
  // ============================================================
  app.post("/api/admin/airbnb/submit-compliance", async (req: Request, res: Response) => {
    const cookieJson = process.env.AIRBNB_SESSION_COOKIES;
    if (!cookieJson) return res.status(500).json({ error: "AIRBNB_SESSION_COOKIES not set" });

    const { listingId, jurisdiction, taxMapKey, tatLicense, dryRun } = (req.body ?? {}) as {
      listingId?: string;
      jurisdiction?: string;
      taxMapKey?: string;
      tatLicense?: string;
      dryRun?: boolean;
    };
    if (!listingId || !/^\d+$/.test(listingId)) return res.status(400).json({ error: "listingId required" });
    if (!taxMapKey || !tatLicense) return res.status(400).json({ error: "taxMapKey and tatLicense both required" });
    const juri = (jurisdiction || "kauai_county_hawaii").replace(/[^a-z0-9_]/gi, "");

    type RawCookie = { name?: string; value?: string; domain?: string; path?: string; expirationDate?: number; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string };
    const raw: RawCookie[] = JSON.parse(cookieJson);
    const sameSiteMap: Record<string, "Strict" | "Lax" | "None"> = { strict: "Strict", lax: "Lax", no_restriction: "None", unspecified: "Lax", none: "None" };
    const cookies = raw
      .filter((c) => c.name && c.value && c.domain)
      .map((c) => ({
        name: c.name!, value: c.value!,
        domain: c.domain!.startsWith(".") ? c.domain! : `.${c.domain!}`,
        path: c.path ?? "/",
        expires: typeof c.expirationDate === "number" ? Math.floor(c.expirationDate)
              : typeof c.expires === "number" ? Math.floor(c.expires) : -1,
        httpOnly: c.httpOnly ?? false, secure: c.secure ?? true,
        sameSite: sameSiteMap[(c.sameSite ?? "lax").toLowerCase()] ?? "Lax" as "Strict" | "Lax" | "None",
      }));

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    const trace: Array<{ step: string; detail?: string }> = [];
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
      });
      const ctx = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: "en-US",
        timezoneId: "Pacific/Honolulu",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();

      trace.push({ step: "warming-up" });
      await page.goto("https://www.airbnb.com/hosting", { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(2500);

      const targetUrl = `https://www.airbnb.com/regulations/${listingId}/${juri}/registration/initial/existing-registration`;
      trace.push({ step: "navigating", detail: targetUrl });
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      // Form hydrates via client-side rendering; give it room.
      await page.waitForSelector("#permit_number-text", { timeout: 15000 });
      await page.waitForTimeout(1500);

      // Fill TMK — clear any existing value first, else we'd append.
      trace.push({ step: "filling-tmk", detail: taxMapKey });
      await page.fill("#permit_number-text", "");
      await page.fill("#permit_number-text", taxMapKey);

      trace.push({ step: "filling-tat", detail: tatLicense });
      await page.fill("#tat_number-text", "");
      await page.fill("#tat_number-text", tatLicense);

      // Attestation checkbox — selector has a generated-id suffix, so target by
      // prefix. The native <input> is hidden under a styled label on Airbnb's
      // React form, so .click() on the input often fires but doesn't toggle
      // the controlled state. Verify post-click and fall back to the label.
      const attestationHandle = await page.$('input[id^="attestation-attestation-row"]');
      if (attestationHandle) {
        const attestationId = await attestationHandle.getAttribute("id").catch(() => null);
        const startChecked = await attestationHandle.isChecked().catch(() => false);
        if (!startChecked) {
          await attestationHandle.check({ force: true }).catch(() => {});
          let nowChecked = await attestationHandle.isChecked().catch(() => false);
          if (!nowChecked && attestationId) {
            await page.click(`label[for="${attestationId}"]`, { force: true }).catch(() => {});
            nowChecked = await attestationHandle.isChecked().catch(() => false);
          }
          trace.push({ step: nowChecked ? "checked-attestation" : "attestation-click-did-not-toggle" });
        } else {
          trace.push({ step: "attestation-already-checked" });
        }
      } else {
        trace.push({ step: "attestation-not-found" });
      }
      await page.waitForTimeout(500);

      if (dryRun) {
        trace.push({ step: "dry-run-stopping-before-submit" });
        const screenshot = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false }).catch(() => null);
        return res.json({
          ok: true, dryRun: true, trace,
          finalUrl: page.url(),
          screenshot: screenshot ? screenshot.toString("base64") : null,
        });
      }

      // Click Next. The button lives at the top-level of the form; match by visible text.
      trace.push({ step: "clicking-next" });
      const nextClickError = await page.click('button:has-text("Next")', { timeout: 8000 }).then(() => null).catch((err: Error) => err.message);
      if (nextClickError) trace.push({ step: "next-click-failed", detail: nextClickError });
      // Wait for the URL to change rather than a fixed timeout — Airbnb's form
      // sometimes takes 8-12s to process + navigate, and the earlier 4s wait
      // was racy (caught the button mid-spinner). 15s ceiling is generous
      // enough to ride out slow responses without hanging indefinitely.
      try {
        await page.waitForURL((u) => u.toString() !== targetUrl, { timeout: 15000 });
        trace.push({ step: "url-advanced-after-next" });
      } catch {
        trace.push({ step: "url-did-not-advance-within-15s" });
      }
      // Small post-navigation buffer for React hydration on the new page.
      await page.waitForTimeout(1500);

      // If we landed somewhere that isn't the same form, assume progress.
      const postSubmitUrl = page.url();
      const postHeadings = await page.evaluate(() =>
        Array.from(document.querySelectorAll("h1, h2, h3")).map((h) => (h.textContent || "").trim().slice(0, 140)).filter(Boolean)
      ).catch(() => []);
      const postBodyPreview = await page
        .evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 1500))
        .catch(() => "");
      // Scrape visible validation errors so the UI can show the actual reason
      // rather than a generic "didn't advance" message.
      const errorMessages = await page.evaluate(() => {
        const out = new Set<string>();
        document.querySelectorAll('[role="alert"], [aria-live="polite"], [aria-live="assertive"]').forEach((el) => {
          const txt = (el.textContent || "").trim();
          if (txt && txt.length > 0 && txt.length < 300) out.add(txt);
        });
        // Airbnb's inline field errors are rendered adjacent to aria-invalid inputs.
        document.querySelectorAll('[aria-invalid="true"]').forEach((el) => {
          const describedBy = el.getAttribute("aria-describedby");
          if (describedBy) {
            describedBy.split(/\s+/).forEach((id) => {
              const target = id && document.getElementById(id);
              const txt = target && (target.textContent || "").trim();
              if (txt && txt.length < 300) out.add(txt);
            });
          }
        });
        return Array.from(out).slice(0, 5);
      }).catch(() => [] as string[]);
      // Capture visible button/link texts — when the flow is multi-step the
      // post-Next page has a "Submit" / "Confirm" / "Done" button we need
      // to click to complete the registration. Knowing the exact labels lets
      // us extend the automation rather than guessing.
      const buttonTexts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, a[role="button"]'))
          .map((b) => ({
            text: (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
            type: (b as HTMLButtonElement).type || null,
            disabled: (b as HTMLButtonElement).disabled ?? false,
            ariaLabel: b.getAttribute("aria-label"),
          }))
          .filter((b) => b.text.length > 0)
          .slice(0, 25)
      ).catch(() => [] as Array<{ text: string; type: string | null; disabled: boolean; ariaLabel: string | null }>);
      const advanced = postSubmitUrl !== targetUrl;

      // Pull the saved status from Guesty — airbnb2.permits.regulations is
      // Guesty's read-through of Airbnb's regulatory state, so if the
      // submit worked we'll see status:"success" there (may take a
      // moment to propagate; caller can re-check).
      trace.push({ step: advanced ? "submission-advanced" : "submission-maybe-stuck", detail: postSubmitUrl });

      // Step 2 of Airbnb's flow: "Review your information" page with a single
      // Submit button. Without this click, Airbnb discards the registration
      // silently (Guesty's permits object stays empty). Order of operations:
      //   1. Dismiss the "Help us improve your experience" cookie banner,
      //      which can overlay the Submit button on some viewports. Picking
      //      "Only necessary" avoids opting into tracking cookies.
      //   2. Confirm we're on the review page by looking for its heading.
      //   3. Click Submit (with force: true as a fallback in case the banner
      //      re-renders mid-dismiss).
      //   4. Verify URL changed — if yes, the registration was committed.
      let submissionComplete = false;
      let finalUrl = postSubmitUrl;
      if (advanced) {
        const hasCookieBanner = await page.$('text=/Help us improve your experience/i').catch(() => null);
        if (hasCookieBanner) {
          trace.push({ step: "dismissing-cookie-banner" });
          await page.click('button:has-text("Only necessary")', { timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(500);
        }

        const hasReviewHeading = await page.$('text=/Review your information/i').catch(() => null);
        if (hasReviewHeading) {
          trace.push({ step: "on-review-page" });
          const submitErr = await page
            .click('button:has-text("Submit")', { timeout: 8000 })
            .then(() => null)
            .catch((err: Error) => err.message);
          if (submitErr) {
            trace.push({ step: "submit-click-retrying-force", detail: submitErr });
            await page.click('button:has-text("Submit")', { timeout: 5000, force: true }).catch(() => {});
          }
          // Same pattern as the Next click: wait for the URL to actually
          // change, not a fixed timeout.
          try {
            await page.waitForURL((u) => u.toString() !== postSubmitUrl, { timeout: 15000 });
            trace.push({ step: "url-advanced-after-submit" });
          } catch {
            trace.push({ step: "url-did-not-advance-after-submit-within-15s" });
          }
          await page.waitForTimeout(1500);
          finalUrl = page.url();
          submissionComplete = finalUrl !== postSubmitUrl;
          trace.push({
            step: submissionComplete ? "submission-completed" : "submit-clicked-no-advance",
            detail: finalUrl,
          });
        } else {
          trace.push({ step: "review-heading-not-found" });
        }
      }

      // Screenshot reflects whichever step we ended up on (step 2 review page
      // if Submit never clicked, step 3 confirmation if it did). Saved to the
      // photos volume under /photos/debug/ so it's reachable via public URL.
      // Keeps last ~20 files to stay bounded.
      const screenshotBuf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false }).catch(() => null);
      let screenshotUrl: string | null = null;
      if (screenshotBuf) {
        try {
          const debugDir = path.resolve(process.cwd(), "client/public/photos/debug");
          if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
          const fname = `compliance-${listingId}-${Date.now()}.jpg`;
          fs.writeFileSync(path.join(debugDir, fname), screenshotBuf);
          screenshotUrl = `/photos/debug/${fname}`;
          try {
            const all = fs.readdirSync(debugDir)
              .filter((f) => f.startsWith("compliance-") && f.endsWith(".jpg"))
              .map((f) => ({ f, mtime: fs.statSync(path.join(debugDir, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime);
            for (const old of all.slice(20)) fs.unlinkSync(path.join(debugDir, old.f));
          } catch { /* non-fatal prune */ }
        } catch (e) {
          trace.push({ step: "screenshot-save-failed", detail: (e as Error).message });
        }
      }

      console.log(`[airbnb-compliance] listing=${listingId} advanced=${advanced} submissionComplete=${submissionComplete} finalUrl=${finalUrl} screenshot=${screenshotUrl} headings=${JSON.stringify(postHeadings)} buttons=${JSON.stringify(buttonTexts)} errors=${JSON.stringify(errorMessages)} trace=${JSON.stringify(trace)}`);

      return res.json({
        ok: true,
        advanced,
        submissionComplete,
        trace,
        finalUrl,
        reviewPageUrl: postSubmitUrl,
        postSubmitHeadings: postHeadings,
        postBodyPreview,
        errorMessages,
        buttonTexts,
        screenshot: screenshotBuf ? screenshotBuf.toString("base64") : null,
        screenshotUrl,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? String(e), trace });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  // ============================================================
  // POST /api/admin/guesty/inspect-vrbo-compliance
  //
  // Loads Guesty's Owner & license page for a listing
  // (app.guesty.com/properties/{id}/owners-and-license), scrolls to the
  // "Vrbo license requirements" section, clicks its Edit affordance, and
  // returns a diagnostic snapshot of the resulting form: visible text,
  // form fields, dropdown options, and a screenshot saved under
  // /photos/debug/.
  //
  // This is inspection-only — does NOT save anything. Use it to discover
  // the form's exact field names + valid dropdown values so the companion
  // submit endpoint can wire them up correctly.
  //
  // Body: { listingId }  — 24-char hex Guesty listing ID.
  // Env:  GUESTY_SESSION_COOKIES  — JSON array (Cookie-Editor export
  //       format) of cookies for app.guesty.com.
  // ============================================================
  app.post("/api/admin/guesty/inspect-vrbo-compliance", async (req: Request, res: Response) => {
    const cookieJson = process.env.GUESTY_SESSION_COOKIES;
    if (!cookieJson) return res.status(500).json({ error: "GUESTY_SESSION_COOKIES not set" });

    const { listingId } = (req.body ?? {}) as { listingId?: string };
    if (!listingId || !/^[a-f0-9]{24}$/i.test(listingId)) {
      return res.status(400).json({ error: "listingId required (24-char hex Guesty listing ID)" });
    }

    type RawCookie = { name?: string; value?: string; domain?: string; path?: string; expirationDate?: number; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string };
    const raw: RawCookie[] = JSON.parse(cookieJson);
    const sameSiteMap: Record<string, "Strict" | "Lax" | "None"> = { strict: "Strict", lax: "Lax", no_restriction: "None", unspecified: "Lax", none: "None" };
    const cookies = raw
      .filter((c) => c.name && c.value && c.domain)
      .map((c) => ({
        name: c.name!, value: c.value!,
        domain: c.domain!.startsWith(".") ? c.domain! : `.${c.domain!}`,
        path: c.path ?? "/",
        expires: typeof c.expirationDate === "number" ? Math.floor(c.expirationDate)
              : typeof c.expires === "number" ? Math.floor(c.expires) : -1,
        httpOnly: c.httpOnly ?? false, secure: c.secure ?? true,
        sameSite: sameSiteMap[(c.sameSite ?? "lax").toLowerCase()] ?? "Lax" as "Strict" | "Lax" | "None",
      }));

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    const trace: Array<{ step: string; detail?: string }> = [];
    const saveShot = async (page: any, tag: string): Promise<string | null> => {
      const buf = await page.screenshot({ type: "jpeg", quality: 70, fullPage: true }).catch(() => null);
      if (!buf) return null;
      try {
        const debugDir = path.resolve(process.cwd(), "client/public/photos/debug");
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        const fname = `guesty-vrbo-${tag}-${listingId}-${Date.now()}.jpg`;
        fs.writeFileSync(path.join(debugDir, fname), buf);
        return `/photos/debug/${fname}`;
      } catch { return null; }
    };
    try {
      // rebrowser-playwright is a drop-in Playwright replacement that
      // patches the CDP Runtime.Enable leak that every detection service
      // (CreepJS, FingerprintJS Pro, Okta ThreatInsight) uses to identify
      // headless/automated browsers. Vanilla playwright exposes this leak
      // no matter what stealth scripts you inject. Only used here, not in
      // the Airbnb endpoint (which already works with vanilla Playwright).
      const { chromium: rbChromium } = await import("rebrowser-playwright");
      browser = await rbChromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
        ],
      }) as unknown as Awaited<ReturnType<typeof chromium.launch>>;
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: "en-US",
        timezoneId: "Pacific/Honolulu",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
      });
      // Comprehensive stealth init — covers the vectors Okta JS is known
      // to probe: webdriver flag, plugins array, languages, permissions
      // API oddities, WebGL renderer, Chrome runtime shape.
      await ctx.addInitScript(() => {
        // 1. webdriver flag
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });

        // 2. Plugins — return a realistic non-empty array. Detection code
        //    checks navigator.plugins.length > 0 as a basic signal.
        const fakePlugins = [
          { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "" },
          { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "" },
          { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "" },
          { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "" },
        ];
        Object.defineProperty(navigator, "plugins", {
          get: () => {
            const arr = fakePlugins.map((p) => Object.assign(Object.create(Plugin.prototype), p));
            Object.defineProperty(arr, "item", { value: (i: number) => arr[i] });
            Object.defineProperty(arr, "namedItem", { value: (n: string) => arr.find((p: any) => p.name === n) || null });
            Object.defineProperty(arr, "refresh", { value: () => {} });
            return arr;
          },
        });

        // 3. Languages — ensure array matches Accept-Language header shape.
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });

        // 4. Permissions query — headless Chromium returns "denied" for
        //    notifications; real Chrome typically returns "default" / "prompt".
        //    Fake the mismatch Okta watches for.
        const origQuery = navigator.permissions.query.bind(navigator.permissions);
        (navigator.permissions as any).query = (params: { name: string }) =>
          params?.name === "notifications"
            ? Promise.resolve({ state: "prompt" } as unknown as PermissionStatus)
            : origQuery(params as PermissionDescriptor);

        // 5. WebGL renderer — headless Chrome reports "SwiftShader" or
        //    "ANGLE (llvmpipe)", both dead giveaways. Spoof to a common
        //    Intel integrated GPU string.
        const getParamProto = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param: number) {
          // 37445 = UNMASKED_VENDOR_WEBGL, 37446 = UNMASKED_RENDERER_WEBGL
          if (param === 37445) return "Intel Inc.";
          if (param === 37446) return "Intel Iris OpenGL Engine";
          return getParamProto.call(this, param);
        };

        // 6. window.chrome shape — real Chrome has a `chrome` object with
        //    specific runtime / loadTimes / csi properties. Headless
        //    Chromium has none of these.
        if (!(window as any).chrome) {
          (window as any).chrome = {};
        }
        if (!(window as any).chrome.runtime) {
          (window as any).chrome.runtime = {
            OnInstalledReason: {},
            OnRestartRequiredReason: {},
            PlatformArch: {},
            PlatformOs: {},
            RequestUpdateCheckStatus: {},
          };
        }

        // 7. Hide the CDP Runtime.Enable / MAIN-world isolated-world
        //    boundary. rebrowser-playwright handles most of this at the
        //    patch layer, but also nullify document.$cdc_asdjflasutopfhvcZLmcfl_
        //    and similar webdriver property leaks seen in some builds.
        for (const key of Object.keys(document)) {
          if (/^\$[cC]dc_|^\$[wW]dc_/.test(key)) {
            delete (document as any)[key];
          }
        }
      });

      await ctx.addCookies(cookies);
      const page = await ctx.newPage();

      // Guesty uses Okta's JS SDK which stores auth state in localStorage
      // and possibly sessionStorage. Inputs (any combination):
      //   - GUESTY_OKTA_TOKEN_STORAGE: raw value for the okta-token-storage key
      //   - GUESTY_LOCAL_STORAGE: JSON object { key: value, ... } for localStorage
      //   - GUESTY_SESSION_STORAGE: JSON object for sessionStorage
      // Use addInitScript so storage is primed BEFORE the SPA's first auth
      // check runs — setting after page.goto is too late, the route guard
      // already redirected to /auth/login before our page.evaluate fires.
      const toInjectLocal: Record<string, string> = {};
      const lsObjRaw = process.env.GUESTY_LOCAL_STORAGE;
      if (lsObjRaw) {
        try {
          Object.assign(toInjectLocal, JSON.parse(lsObjRaw) as Record<string, string>);
        } catch (e) {
          trace.push({ step: "localstorage-json-parse-failed", detail: (e as Error).message });
        }
      }
      const oktaRaw = process.env.GUESTY_OKTA_TOKEN_STORAGE;
      if (oktaRaw) toInjectLocal["okta-token-storage"] = oktaRaw;

      const toInjectSession: Record<string, string> = {};
      const ssObjRaw = process.env.GUESTY_SESSION_STORAGE;
      if (ssObjRaw) {
        try {
          Object.assign(toInjectSession, JSON.parse(ssObjRaw) as Record<string, string>);
        } catch (e) {
          trace.push({ step: "sessionstorage-json-parse-failed", detail: (e as Error).message });
        }
      }

      const localKeys = Object.keys(toInjectLocal);
      const sessionKeys = Object.keys(toInjectSession);
      if (localKeys.length > 0 || sessionKeys.length > 0) {
        trace.push({ step: "priming-storage-via-init-script", detail: `localStorage=${localKeys.length} sessionStorage=${sessionKeys.length}` });
        // Run on every new document so storage is ready before the SPA's
        // route guard fires. Wrapped in try/catch because about:blank /
        // chrome-error:// pages will refuse storage access.
        await ctx.addInitScript((payload: { local: Array<[string, string]>; session: Array<[string, string]> }) => {
          try {
            for (const [k, v] of payload.local) window.localStorage.setItem(k, v);
          } catch { /* storage blocked on this origin */ }
          try {
            for (const [k, v] of payload.session) window.sessionStorage.setItem(k, v);
          } catch { /* storage blocked on this origin */ }
        }, { local: Object.entries(toInjectLocal), session: Object.entries(toInjectSession) });
      } else {
        trace.push({ step: "no-storage-env", detail: "set GUESTY_OKTA_TOKEN_STORAGE (raw) or GUESTY_LOCAL_STORAGE / GUESTY_SESSION_STORAGE (JSON objects)" });
      }

      const targetUrl = `https://app.guesty.com/properties/${listingId}/owners-and-license`;
      trace.push({ step: "navigating", detail: targetUrl });
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
      // Guesty's admin SPA is heavy — give it time to hydrate before scraping.
      await page.waitForTimeout(5000);

      // Check if we've been redirected to the login page.
      const isLoginPage = async (): Promise<boolean> => {
        const u = page.url();
        if (/\/auth\//i.test(u)) return true;
        return /okta-signin-username|okta-signin-password|Please enter your details to sign in/i
          .test(await page.content().catch(() => ""));
      };

      if (await isLoginPage()) {
        // Fall through to the email/password flow. Storage injection
        // alone doesn't cut it — Guesty has server-side session
        // validation that redirects before the SPA ever reads our
        // localStorage.
        const guestyEmail = process.env.GUESTY_EMAIL;
        const guestyPassword = process.env.GUESTY_PASSWORD;
        if (!guestyEmail || !guestyPassword) {
          const beforeShot = await saveShot(page, "needs-login-no-creds");
          return res.json({
            ok: false,
            error: "Guesty redirected to login and GUESTY_EMAIL / GUESTY_PASSWORD env vars are not set. Token/storage injection doesn't bypass Guesty's server-side session check — set the email+password env vars to enable the Playwright login flow.",
            finalUrl: page.url(),
            beforeShotUrl: beforeShot,
            trace,
          });
        }

        trace.push({ step: "starting-login-flow" });

        // STEP 1: Email. Guesty's branded login accepts either the email
        // input on its own page or the Okta single-form widget.
        const emailInput = await page.waitForSelector(
          'input[type="email"], input[name="username"], input[name="email"], input[id*="okta-signin-username"], input[placeholder*="@"]',
          { timeout: 10000 },
        ).catch(() => null);
        if (!emailInput) {
          const shot = await saveShot(page, "no-email-input");
          return res.json({
            ok: false,
            error: "Login page loaded but no email input was found. Guesty may have changed their login form — check the screenshot.",
            finalUrl: page.url(),
            beforeShotUrl: shot,
            trace,
          });
        }
        await emailInput.fill(guestyEmail);
        trace.push({ step: "filled-email" });

        // Keep "Remember me" checked so subsequent runs can potentially
        // reuse the device-trust cookie and skip MFA.
        const rememberMe = await page.$(
          'input[type="checkbox"][name*="remember" i], input[type="checkbox"][id*="remember" i]',
        ).catch(() => null);
        if (rememberMe) {
          const checked = await rememberMe.isChecked().catch(() => false);
          if (!checked) await rememberMe.check({ force: true }).catch(() => {});
        }

        // Submit the first step. The button label varies ("Continue" /
        // "Sign In" / "Next") so try any visible submit button.
        await page.click(
          'button[type="submit"], input[type="submit"], button:has-text("Continue"), button:has-text("Sign In"), button:has-text("Next"), button:has-text("Log In")',
          { timeout: 8000 },
        ).catch(() => {});
        trace.push({ step: "clicked-email-submit" });

        // STEP 2: Password — either on same page (Okta widget) or next page.
        const passwordInput = await page.waitForSelector(
          'input[type="password"], input[name="password"], input[id*="okta-signin-password"]',
          { timeout: 20000 },
        ).catch(() => null);
        if (!passwordInput) {
          const shot = await saveShot(page, "no-password-input");
          return res.json({
            ok: false,
            error: "Couldn't find password input after email submit. Guesty may be using Google SSO-only for this account, or the form changed.",
            finalUrl: page.url(),
            beforeShotUrl: shot,
            trace,
          });
        }
        await passwordInput.fill(guestyPassword);
        trace.push({ step: "filled-password" });

        await page.click(
          'button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Verify"), button:has-text("Submit")',
          { timeout: 8000 },
        ).catch(() => {});
        trace.push({ step: "clicked-password-submit" });

        // Wait for either auth completion OR an MFA email-code screen.
        // Guesty's flow sends a 6-digit code to the account email whenever
        // the login is from a new device — which is always the case for us
        // since Railway's browsers are ephemeral.
        const mfaInputSelector = 'input[type="text"][inputmode="numeric"], input[maxlength="6"], input[placeholder*="000000"], input[id*="code" i][type="text"], input[name*="code" i]';
        try {
          await Promise.race([
            page.waitForURL(
              (u) => {
                const s = u.toString();
                return /app\.guesty\.com/i.test(s) && !/\/auth\//i.test(s);
              },
              { timeout: 30000 },
            ),
            page.waitForSelector(mfaInputSelector, { timeout: 30000 }).then(() => {
              throw new Error("MFA_PROMPT");
            }),
          ]);
          trace.push({ step: "login-redirected", detail: page.url() });
        } catch (err: any) {
          if (err?.message === "MFA_PROMPT") {
            trace.push({ step: "mfa-email-code-prompt" });
            // Fetch the latest code from the Gmail inbox via IMAP.
            const gmailUser = process.env.GMAIL_USER;
            const gmailPass = process.env.GMAIL_APP_PASSWORD;
            if (!gmailUser || !gmailPass) {
              const shot = await saveShot(page, "mfa-no-gmail");
              return res.json({
                ok: false,
                error: "Guesty sent an email verification code but GMAIL_USER / GMAIL_APP_PASSWORD env vars aren't set. Add them so the server can fetch the code automatically.",
                finalUrl: page.url(),
                beforeShotUrl: shot,
                trace,
              });
            }
            const mfaStartedAt = Date.now();
            let code: string | null = null;
            try {
              code = await fetchGuestyMfaCodeFromGmail(gmailUser, gmailPass, mfaStartedAt, trace);
            } catch (imapErr: any) {
              const shot = await saveShot(page, "mfa-imap-error");
              return res.json({
                ok: false,
                error: `IMAP failed while fetching Guesty MFA code: ${imapErr?.message ?? String(imapErr)}. Check GMAIL_APP_PASSWORD is a valid app password for GMAIL_USER, that IMAP is enabled in Gmail settings, and that the account isn't blocking "less secure apps" (app passwords bypass that but 2FA must be on).`,
                finalUrl: page.url(),
                beforeShotUrl: shot,
                trace,
              });
            }
            if (!code) {
              const shot = await saveShot(page, "mfa-code-not-found");
              return res.json({
                ok: false,
                error: "Couldn't find a Guesty verification code in the Gmail inbox within 90s. Either the email didn't arrive, GMAIL_APP_PASSWORD is wrong, or the sender/subject heuristics need updating.",
                finalUrl: page.url(),
                beforeShotUrl: shot,
                trace,
              });
            }
            trace.push({ step: "mfa-code-fetched", detail: `${code.length} digits` });

            const codeInput = await page.$(mfaInputSelector);
            if (!codeInput) {
              const shot = await saveShot(page, "mfa-no-input");
              return res.json({ ok: false, error: "MFA prompt detected earlier but code input isn't there now.", finalUrl: page.url(), beforeShotUrl: shot, trace });
            }
            await codeInput.fill(code);
            trace.push({ step: "mfa-code-filled" });

            await page.click(
              'button[type="submit"], input[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue")',
              { timeout: 8000 },
            ).catch(() => {});
            trace.push({ step: "mfa-code-submitted" });

            try {
              await page.waitForURL(
                (u) => {
                  const s = u.toString();
                  return /app\.guesty\.com/i.test(s) && !/\/auth\//i.test(s);
                },
                { timeout: 30000 },
              );
              trace.push({ step: "mfa-verified-login-redirected", detail: page.url() });
            } catch {
              const shot = await saveShot(page, "mfa-verify-stuck");
              return res.json({
                ok: false,
                error: "MFA code was filled + submitted but Guesty didn't redirect. The code may have been wrong/stale or Guesty added another verification step.",
                finalUrl: page.url(),
                beforeShotUrl: shot,
                trace,
              });
            }
          } else {
            // No MFA — something else stalled.
            const html = await page.content().catch(() => "");
            const badCreds = /invalid|incorrect|try again|doesn.?t match|not recognized/i.test(html);
            const shot = await saveShot(page, "login-stuck");
            return res.json({
              ok: false,
              error: badCreds
                ? "Login failed — email or password rejected by Guesty. Verify GUESTY_EMAIL / GUESTY_PASSWORD values."
                : `Login didn't complete within 30s: ${err?.message ?? "unknown"}. Check the screenshot for what Guesty is showing.`,
              finalUrl: page.url(),
              beforeShotUrl: shot,
              trace,
            });
          }
        }

        // Login worked — navigate to the target URL if we're not already
        // there (post-login redirect usually lands on the dashboard).
        if (!page.url().includes("owners-and-license")) {
          trace.push({ step: "navigating-to-target-after-login", detail: targetUrl });
          await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
          await page.waitForTimeout(5000);
        }
      }

      const beforeShot = await saveShot(page, "before");

      // Final sanity check — if we're still on login after the flow,
      // bail out with the same diagnostics so the operator can see.
      if (await isLoginPage()) {
        return res.json({
          ok: false,
          error: "Still on login page after Playwright login flow — something failed silently.",
          finalUrl: page.url(),
          beforeShotUrl: beforeShot,
          trace,
        });
      }

      // Scroll through the page so lazy-rendered sections mount.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);

      // Dump the top-level structure: heading texts + visible button texts.
      const structure = await page.evaluate(() => {
        const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']"))
          .map((h) => (h.textContent || "").trim().replace(/\s+/g, " "))
          .filter((t) => t.length > 0 && t.length < 200)
          .slice(0, 50);
        const buttons = Array.from(document.querySelectorAll("button, a[role='button']"))
          .map((b) => ({
            text: (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 100),
            ariaLabel: b.getAttribute("aria-label"),
            dataTestId: b.getAttribute("data-testid"),
          }))
          .filter((b) => b.text.length > 0 || b.ariaLabel)
          .slice(0, 60);
        return { headings, buttons };
      }).catch(() => ({ headings: [], buttons: [] }));

      // Find the VRBO heading and its nearest Edit button.
      const clickResult = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("*"));
        const vrboEl = all.find((el) => {
          const t = (el.textContent || "").trim().toLowerCase();
          return t.includes("vrbo license requirements") && t.length < 60;
        });
        if (!vrboEl) return { found: false, reason: "no 'Vrbo license requirements' text element" };
        // Walk up the DOM looking for a section container that also contains an Edit button.
        let container: Element | null = vrboEl;
        for (let depth = 0; depth < 8 && container; depth++) {
          const editBtn = Array.from(container.querySelectorAll("button")).find((b) => /^\s*edit\s*$/i.test(b.textContent || ""));
          if (editBtn) {
            (editBtn as HTMLElement).scrollIntoView({ block: "center" });
            (editBtn as HTMLElement).click();
            return { found: true, depth, buttonText: (editBtn.textContent || "").trim() };
          }
          container = container.parentElement;
        }
        return { found: false, reason: "no Edit button within 8 ancestors of VRBO heading" };
      });
      trace.push({ step: "clicked-edit", detail: JSON.stringify(clickResult) });

      await page.waitForTimeout(2500);

      // Scrape the form that appeared — could be inline, modal, or drawer.
      const formSnapshot = await page.evaluate(() => {
        const fields: Array<{ tag: string; type?: string; id?: string; name?: string; ariaLabel?: string; placeholder?: string; value?: string; required?: boolean; textContext?: string }> = [];
        document.querySelectorAll("input, select, textarea, [role='combobox'], [role='listbox']").forEach((el) => {
          const parent = el.closest("label,[class*='field'],[class*='form'],div");
          const textContext = parent ? (parent.textContent || "").trim().slice(0, 120) : "";
          fields.push({
            tag: el.tagName,
            type: (el as HTMLInputElement).type,
            id: el.id || undefined,
            name: el.getAttribute("name") || undefined,
            ariaLabel: el.getAttribute("aria-label") || undefined,
            placeholder: el.getAttribute("placeholder") || undefined,
            value: (el as HTMLInputElement).value || undefined,
            required: (el as HTMLInputElement).required || undefined,
            textContext,
          });
        });
        const nativeSelects = Array.from(document.querySelectorAll("select")).map((s) => ({
          id: s.id,
          name: s.name,
          ariaLabel: s.getAttribute("aria-label"),
          options: Array.from(s.querySelectorAll("option")).map((o) => ({ value: o.value, label: (o.textContent || "").trim() })),
        }));
        // Many React UIs render dropdowns as role="combobox" buttons that
        // trigger a role="listbox" popup on click. Grab any currently-visible
        // listbox options as a fallback snapshot.
        const openListboxItems = Array.from(document.querySelectorAll("[role='option'],[role='listbox'] [role='option']"))
          .map((el) => ({ text: (el.textContent || "").trim().slice(0, 80), value: el.getAttribute("data-value") || el.getAttribute("data-option-value") || null }));
        // Button texts currently on screen (Save / Cancel / etc).
        const activeButtons = Array.from(document.querySelectorAll("button, a[role='button']"))
          .map((b) => ({ text: (b.textContent || "").trim().slice(0, 80), ariaLabel: b.getAttribute("aria-label") }))
          .filter((b) => b.text.length > 0 || b.ariaLabel)
          .slice(0, 40);
        return { fields, nativeSelects, openListboxItems, activeButtons };
      }).catch(() => null);

      const afterShot = await saveShot(page, "after-edit");

      console.log(`[guesty-vrbo-inspect] listing=${listingId} click=${JSON.stringify(clickResult)} shots=${beforeShot}|${afterShot} fields=${formSnapshot?.fields?.length ?? 0} selects=${formSnapshot?.nativeSelects?.length ?? 0}`);

      return res.json({
        ok: true,
        trace,
        clickResult,
        structure,
        formSnapshot,
        beforeShotUrl: beforeShot,
        afterShotUrl: afterShot,
        finalUrl: page.url(),
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? String(e), trace });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  // ── Scheduler (Phase 4) ──
  app.get("/api/availability/schedule/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });
    const row = await storage.getScannerSchedule(propertyId);
    res.json({ schedule: row ?? null, tick: getScannerSchedulerStatus() });
  });

  app.post("/api/availability/schedule/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });
    const body = req.body as Partial<{
      enabled: boolean; intervalHours: number; runInventory: boolean; runPricing: boolean;
      runSyncBlocks: boolean; targetMargin: number; minSets: number;
    }>;
    const existing = await storage.getScannerSchedule(propertyId);
    const row = await storage.upsertScannerSchedule({
      propertyId,
      enabled: body.enabled ?? existing?.enabled ?? false,
      intervalHours: body.intervalHours ?? existing?.intervalHours ?? 12,
      runInventory: body.runInventory ?? existing?.runInventory ?? true,
      runPricing: body.runPricing ?? existing?.runPricing ?? true,
      runSyncBlocks: body.runSyncBlocks ?? existing?.runSyncBlocks ?? true,
      targetMargin: String(body.targetMargin ?? (existing ? parseFloat(String(existing.targetMargin)) : 0.2)),
      minSets: body.minSets ?? existing?.minSets ?? 3,
    });
    res.json({ schedule: row });
  });

  // GET /api/availability/scanner-history/:propertyId?limit=5 — returns
  // the N most recent scanner runs (scheduled ticks + manual "Run now"
  // calls) for the given property. Default limit 5, capped at 50.
  app.get("/api/availability/scanner-history/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });
    const limit = Math.max(1, Math.min(50, parseInt(String(req.query.limit ?? "5"), 10) || 5));
    const rows = await storage.getRecentScannerRuns(propertyId, limit);
    res.json({ runs: rows });
  });

  // GET /api/availability/scanner-blocks/:propertyId — returns the active
  // (non-removed) blocks the scanner has pushed to Guesty for the given
  // property. The availability-scheduler summary reports aggregate counts
  // (e.g. "blocks +2/-1"); this endpoint surfaces the actual date ranges
  // so the UI can list which weeks got blocked.
  app.get("/api/availability/scanner-blocks/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });
    const rows = await storage.getActiveScannerBlocks(propertyId);
    res.json({ blocks: rows });
  });

  // POST /api/availability/run-now/:propertyId — trigger the full pipeline
  // on demand (user clicked "Run now" in the UI).
  app.post("/api/availability/run-now/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });
    // Don't await — let it run in the background and the UI polls status.
    runFullScanNow(propertyId).catch(() => {});
    res.json({ started: true });
  });

  // ── Weekly pricing correlation ──────────────────────────────────────
  // Takes the per-week scan verdicts the client sends in (usually from
  // the last run of the availability scan) and emits a per-week pricing
  // forecast that the UI renders side-by-side with the scanner output.
  //
  // Formula:
  //   baseNightly     = sum over units of buy_in_rate[BR] × season_multiplier
  //   demandFactor    = tight → 1.12  |  open → 1.00  |  blocked → 0 (skipped)
  //   targetRate      = round(baseNightly × demandFactor × (1 + margin) / (1 - 0.03))
  //   deltaVsBase     = (targetRate - baseOnlyRate) / baseOnlyRate
  //
  // The demand factor is the knob that turns "tight inventory at this
  // resort this week" into a publishable price bump — when fewer
  // competing listings are available the floor clears naturally and our
  // own rate can move with it.
  app.post("/api/availability/weekly-pricing/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });
    const config = PROPERTY_UNIT_CONFIGS[propertyId];
    if (!config) return res.status(404).json({ error: "property not in config" });
    const body = (req.body ?? {}) as {
      windows?: Array<{ startDate: string; endDate: string; verdict: "open" | "tight" | "blocked" }>;
      targetMargin?: number;
    };
    const windows = body.windows ?? [];
    if (windows.length === 0) return res.status(400).json({ error: "windows required — run scan first" });
    const { totalNightlyBuyInForMonth } = await import("@shared/pricing-rates");
    const targetMargin = typeof body.targetMargin === "number" ? body.targetMargin : 0.20;
    const feeDirect = 0.03;
    // Cache baseNightly per month-key so we only look it up once per month.
    const baseByMonth = new Map<string, number>();
    const rows = windows.map((w) => {
      const monthKey = w.startDate.slice(0, 7);
      let baseNightly = baseByMonth.get(monthKey);
      if (baseNightly == null) {
        baseNightly = totalNightlyBuyInForMonth(config.community, config.units, monthKey);
        baseByMonth.set(monthKey, baseNightly);
      }
      const demandFactor = w.verdict === "tight" ? 1.12 : w.verdict === "blocked" ? 0 : 1.00;
      const baseOnlyRate = Math.round(baseNightly * (1 + targetMargin) / (1 - feeDirect));
      const targetRate = demandFactor > 0
        ? Math.round(baseNightly * demandFactor * (1 + targetMargin) / (1 - feeDirect))
        : 0;
      const deltaVsBase = baseOnlyRate > 0 && targetRate > 0
        ? (targetRate - baseOnlyRate) / baseOnlyRate
        : 0;
      return {
        startDate: w.startDate,
        endDate: w.endDate,
        verdict: w.verdict,
        baseNightly,
        demandFactor,
        baseOnlyRate,
        targetRate,
        deltaVsBase,
      };
    });
    res.json({
      community: config.community,
      targetMargin,
      feeDirect,
      rows,
    });
  });

  // Push the weekly rate ranges to Guesty's calendar. Body: the same
  // shape the weekly-pricing endpoint returns (so the client can send
  // exactly what it's displaying). Skips weeks where verdict=blocked
  // (those get blocked, not re-priced).
  app.post("/api/availability/sync-weekly-rates/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });
    const guestyListingId = await storage.getGuestyListingId(propertyId);
    if (!guestyListingId) return res.status(400).json({ error: "no Guesty listing mapped" });

    const body = (req.body ?? {}) as {
      rows?: Array<{ startDate: string; endDate: string; targetRate: number; verdict: string }>;
    };
    const rows = (body.rows ?? []).filter((r) => r.verdict !== "blocked" && r.targetRate > 0);
    const calPath = `/availability-pricing/api/calendar/listings/${guestyListingId}`;
    let pushed = 0;
    const failures: Array<{ startDate: string; error: string }> = [];
    for (const r of rows) {
      try {
        await guestyRequest("PUT", calPath, {
          startDate: r.startDate,
          endDate: r.endDate,
          price: r.targetRate,
        });
        pushed++;
        await new Promise((resolve) => setTimeout(resolve, 120));
      } catch (e: any) {
        failures.push({ startDate: r.startDate, error: e?.message ?? String(e) });
      }
    }
    res.json({
      ok: failures.length === 0,
      pushed,
      total: rows.length,
      failures,
      syncedAt: new Date().toISOString(),
    });
  });

  // POST /api/builder/normalize-photos
  // Fetch a listing's existing Guesty pictures, run each through validateAndFixPhoto,
  // re-upload the fixed ones to ImgBB, and PUT the listing back.
  // Body: { guestyListingId: string }  OR  { all: true }  (iterates every mapped listing)
  // Streams NDJSON events: {type:"listing-start",id,name}, {type:"photo",...},
  //   {type:"listing-done",id,fixedCount,totalCount}, {type:"all-done",listingCount,...}
  app.post("/api/builder/normalize-photos", async (req, res) => {
    const imgbbKey = process.env.IMGBB_API_KEY;
    if (!imgbbKey) {
      return res.status(500).json({ error: "IMGBB_API_KEY not configured" });
    }

    const { guestyListingId, all } = req.body as { guestyListingId?: string; all?: boolean };
    if (!guestyListingId && !all) {
      return res.status(400).json({ error: "guestyListingId or all:true required" });
    }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const emit = (obj: Record<string, unknown>) => res.write(JSON.stringify(obj) + "\n");

    // Build target list
    let targets: { guestyListingId: string; propertyId?: number }[] = [];
    if (all) {
      const maps = await storage.getGuestyPropertyMap();
      targets = maps.map((m) => ({ guestyListingId: m.guestyListingId, propertyId: m.propertyId }));
    } else {
      targets = [{ guestyListingId: guestyListingId! }];
    }

    emit({ type: "start", listingCount: targets.length });

    let globalFixed = 0;
    let globalSkipped = 0;
    let globalFailed = 0;

    for (const target of targets) {
      const listingId = target.guestyListingId;
      let listingName = listingId;
      let pictures: Array<{ original?: string; _id?: string; caption?: string; url?: string }> = [];

      try {
        const listing = await guestyRequest("GET", `/listings/${listingId}`) as any;
        listingName = listing?.title || listing?.nickname || listingId;
        pictures = Array.isArray(listing?.pictures) ? listing.pictures : [];
      } catch (e: any) {
        emit({ type: "listing-error", id: listingId, error: `GET failed: ${e.message}` });
        globalFailed++;
        continue;
      }

      emit({ type: "listing-start", id: listingId, name: listingName, photoCount: pictures.length });

      if (pictures.length === 0) {
        emit({ type: "listing-done", id: listingId, name: listingName, fixedCount: 0, skippedCount: 0, totalCount: 0 });
        continue;
      }

      const normalized: { original: string; caption: string }[] = [];
      let fixedCount = 0;
      let skippedCount = 0;

      for (let i = 0; i < pictures.length; i++) {
        const pic = pictures[i];
        const url = pic.original || pic.url;
        const caption = pic.caption || "";
        const index = i + 1;

        if (!url) {
          emit({ type: "photo", listingId, index, total: pictures.length, success: false, error: "no URL on picture" });
          continue;
        }

        // Preserve the auto-generated cover collage exactly — it's already at spec
        // (1920×1080 JPEG from canvas) and re-encoding blurs the thin divider line.
        if (caption === "Cover Collage") {
          normalized.push({ original: url, caption });
          skippedCount++;
          emit({ type: "photo", listingId, index, total: pictures.length, success: true, skipped: true, preservedCollage: true });
          continue;
        }

        try {
          // Download current photo
          const dlResp = await fetch(url);
          if (!dlResp.ok) {
            emit({ type: "photo", listingId, index, total: pictures.length, success: false, error: `download ${dlResp.status}` });
            // Keep original in the array so we don't drop it
            normalized.push({ original: url, caption });
            continue;
          }
          const inBuf = Buffer.from(await dlResp.arrayBuffer());
          const contentType = dlResp.headers.get("content-type") || "image/jpeg";

          // Validate + fix
          const validated = await validateAndFixPhoto(inBuf, contentType);

          if (validated.changes.length === 0) {
            // Already compliant — keep original URL, no re-upload
            normalized.push({ original: url, caption });
            skippedCount++;
            emit({
              type: "photo",
              listingId,
              index,
              total: pictures.length,
              success: true,
              skipped: true,
              finalWidth: validated.finalWidth,
              finalHeight: validated.finalHeight,
            });
            continue;
          }

          // Re-upload the fixed buffer to ImgBB
          const form = new FormData();
          form.append("image", validated.buffer.toString("base64"));
          const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
            method: "POST",
            body: form,
          });
          if (!imgbbResp.ok) {
            emit({ type: "photo", listingId, index, total: pictures.length, success: false, error: `ImgBB ${imgbbResp.status}` });
            normalized.push({ original: url, caption }); // fall back to original
            continue;
          }
          const imgbbData = await imgbbResp.json() as any;
          const newUrl = imgbbData?.data?.url;
          if (!newUrl) {
            emit({ type: "photo", listingId, index, total: pictures.length, success: false, error: "ImgBB no URL" });
            normalized.push({ original: url, caption });
            continue;
          }

          normalized.push({ original: newUrl, caption });
          fixedCount++;
          emit({
            type: "photo",
            listingId,
            index,
            total: pictures.length,
            success: true,
            fixed: true,
            changes: validated.changes,
            originalWidth: validated.originalWidth,
            originalHeight: validated.originalHeight,
            finalWidth: validated.finalWidth,
            finalHeight: validated.finalHeight,
            url: newUrl,
          });
        } catch (e: any) {
          emit({ type: "photo", listingId, index, total: pictures.length, success: false, error: e.message });
          // Keep original URL so we don't strip photos from the listing
          normalized.push({ original: url, caption });
        }
      }

      // PUT back only if we actually changed something
      if (fixedCount > 0) {
        try {
          await guestyRequest("PUT", `/listings/${listingId}`, { pictures: normalized });
          console.log(`[normalize-photos] ✓ ${listingName}: ${fixedCount} fixed, ${skippedCount} ok`);
        } catch (e: any) {
          emit({ type: "listing-error", id: listingId, name: listingName, error: `PUT failed: ${e.message}` });
          globalFailed++;
          continue;
        }
      }

      globalFixed += fixedCount;
      globalSkipped += skippedCount;
      emit({
        type: "listing-done",
        id: listingId,
        name: listingName,
        fixedCount,
        skippedCount,
        totalCount: pictures.length,
      });
    }

    emit({
      type: "all-done",
      listingCount: targets.length,
      globalFixed,
      globalSkipped,
      globalFailed,
    });
    res.end();
  });

  // ========== BUILDER AVAILABILITY WINDOW SCANNER ==========

  app.get("/api/builder/scan-window", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const propertyId = parseInt(req.query.propertyId as string, 10);
    const checkIn = req.query.checkIn as string;
    const checkOut = req.query.checkOut as string;

    if (!propertyId || isNaN(propertyId)) return res.status(400).json({ error: "propertyId required" });
    if (!checkIn || !checkOut) return res.status(400).json({ error: "checkIn and checkOut required" });

    const propertyConfig = PROPERTY_UNIT_NEEDS[propertyId];
    if (!propertyConfig) return res.status(404).json({ error: "Property not in config" });

    const communityBounds = COMMUNITY_BOUNDS[propertyConfig.community];
    const searchLocation = COMMUNITY_SEARCH_LOCATIONS[propertyConfig.community] || `${propertyConfig.community}, Hawaii`;

    // Count how many of each bedroom type we need
    const bedroomCounts: Record<number, number> = {};
    for (const unit of propertyConfig.units) {
      bedroomCounts[unit.bedrooms] = (bedroomCounts[unit.bedrooms] || 0) + 1;
    }
    const neededCount = propertyConfig.units.length;

    try {
      let totalFound = 0;
      const unitResults: { bedrooms: number; needed: number; found: number }[] = [];
      const cheapestByBedroom: Record<number, { price: number; title: string; link: string }> = {};

      for (const [bedroomStr, needed] of Object.entries(bedroomCounts)) {
        const bedrooms = parseInt(bedroomStr);
        const searchParams: Record<string, string> = {
          engine: "airbnb",
          check_in_date: checkIn,
          check_out_date: checkOut,
          adults: "2",
          bedrooms: String(bedrooms),
          type_of_place: "entire_home",
          currency: "USD",
          api_key: apiKey,
        };

        // q is always required by SearchAPI; bounds are added on top for geo-precision
        searchParams.q = searchLocation;
        if (communityBounds) {
          searchParams.sw_lat = String(communityBounds.sw_lat);
          searchParams.sw_lng = String(communityBounds.sw_lng);
          searchParams.ne_lat = String(communityBounds.ne_lat);
          searchParams.ne_lng = String(communityBounds.ne_lng);
        }

        const params = new URLSearchParams(searchParams);
        const response = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!response.ok) {
          const errText = await response.text();
          console.error(`[scan-window] SearchAPI error for ${bedrooms}BR:`, errText);
          unitResults.push({ bedrooms, needed, found: 0 });
          continue;
        }

        const data = await response.json();
        let properties = data.properties || [];

        // GPS post-filter
        if (communityBounds) {
          const geoFiltered = properties.filter((p: any) => {
            const lat = p.gps_coordinates?.latitude;
            const lng = p.gps_coordinates?.longitude;
            if (!lat || !lng) return true;
            return lat >= communityBounds.sw_lat && lat <= communityBounds.ne_lat &&
                   lng >= communityBounds.sw_lng && lng <= communityBounds.ne_lng;
          });
          if (geoFiltered.length > 0) properties = geoFiltered;
        }

        const found = Math.min(properties.length, needed);
        totalFound += found;
        unitResults.push({ bedrooms, needed, found });

        // Track cheapest listing for pricing estimate
        const withPrice = (properties as any[]).filter(p => p.price?.extracted_total_price);
        withPrice.sort((a, b) => a.price.extracted_total_price - b.price.extracted_total_price);
        const cheapest = withPrice[0];
        if (cheapest) {
          cheapestByBedroom[bedrooms] = {
            price: cheapest.price.extracted_total_price,
            title: cheapest.name || cheapest.title || "Unknown",
            link: cheapest.link || cheapest.url || "",
          };
        }
      }

      // Estimated buy-in cost = sum of cheapest price × needed count per bedroom type
      let estimatedBuyInCost = 0;
      for (const [bedroomStr, needed] of Object.entries(bedroomCounts)) {
        const bedrooms = parseInt(bedroomStr);
        const cheap = cheapestByBedroom[bedrooms];
        if (cheap) estimatedBuyInCost += cheap.price * needed;
      }

      const status = totalFound >= neededCount ? "available" :
                     totalFound > 0            ? "low"       : "none";

      res.json({ status, availableCount: totalFound, neededCount, unitResults, checkIn, checkOut, cheapestByBedroom, estimatedBuyInCost: estimatedBuyInCost > 0 ? estimatedBuyInCost : undefined });
    } catch (err: any) {
      res.status(500).json({ error: "Scan failed", message: err.message });
    }
  });

  // ── Schedule availability sync to Guesty after listing creation ───────────────
  app.post("/api/builder/schedule-sync", async (req: Request, res: Response) => {
    const { propertyId, guestyListingId, delayMinutes = 60 } = req.body as {
      propertyId: number;
      guestyListingId: string;
      delayMinutes?: number;
    };

    if (!propertyId || !guestyListingId) {
      return res.status(400).json({ error: "propertyId and guestyListingId required" });
    }

    await storage.upsertGuestyPropertyMap(propertyId, guestyListingId);
    const delayMs = Math.min(delayMinutes, 180) * 60 * 1000;
    scheduleGuestySync(propertyId, guestyListingId, delayMs);

    res.json({ ok: true, syncScheduledInMinutes: Math.round(delayMs / 60000) });
  });

  // ── Manual Guesty sync trigger (for testing / admin use) ───────────────────
  app.post("/api/builder/sync-now", async (req: Request, res: Response) => {
    const { propertyId, guestyListingId } = req.body as { propertyId: number; guestyListingId: string };
    if (!propertyId || !guestyListingId) return res.status(400).json({ error: "propertyId and guestyListingId required" });

    try {
      const result = await syncPropertyToGuesty(propertyId, guestyListingId);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: "Sync failed", message: err.message });
    }
  });

  // ========== AVAILABILITY / RECOMMENDATIONS ==========

  app.get("/api/availability", async (req, res) => {
    try {
      const checkIn = req.query.checkIn as string;
      const checkOut = req.query.checkOut as string;
      if (!checkIn || !checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
        return res.status(400).json({ error: "checkIn and checkOut required in YYYY-MM-DD format" });
      }
      const booked = await storage.getBookedUnits(checkIn, checkOut);
      res.json(booked);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to check availability", message: err.message });
    }
  });

  // ========== PROFITABILITY REPORTS ==========

  app.get("/api/reports/monthly", async (req, res) => {
    try {
      const year = parseInt(req.query.year as string, 10) || new Date().getFullYear();
      const month = parseInt(req.query.month as string, 10) || new Date().getMonth() + 1;

      const report = await storage.getMonthlyReport(year, month);
      const totalBuyInCost = report.buyIns.reduce((sum, b) => sum + parseFloat(b.costPaid || "0"), 0);
      const totalRevenue = report.bookings.reduce((sum, b) => sum + parseFloat(b.totalAmount || "0"), 0);

      res.json({
        year,
        month,
        totalBuyInCost,
        totalRevenue,
        profit: totalRevenue - totalBuyInCost,
        buyInCount: report.buyIns.length,
        bookingCount: report.bookings.length,
        buyIns: report.buyIns,
        bookings: report.bookings,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to generate report", message: err.message });
    }
  });

  app.get("/api/reports/summary", async (_req, res) => {
    try {
      const allBuyIns = await storage.getBuyIns();
      const allBookings = await storage.getLodgifyBookings();

      const totalBuyInCost = allBuyIns.reduce((sum, b) => sum + parseFloat(b.costPaid || "0"), 0);
      const totalRevenue = allBookings.reduce((sum, b) => sum + parseFloat(b.totalAmount || "0"), 0);
      const activeBuyIns = allBuyIns.filter(b => b.status === "active").length;

      const monthlyData: Record<string, { buyInCost: number; revenue: number; buyIns: number; bookings: number }> = {};
      for (const b of allBuyIns) {
        const key = b.checkIn ? b.checkIn.substring(0, 7) : "unknown";
        if (!monthlyData[key]) monthlyData[key] = { buyInCost: 0, revenue: 0, buyIns: 0, bookings: 0 };
        monthlyData[key].buyInCost += parseFloat(b.costPaid || "0");
        monthlyData[key].buyIns++;
      }
      for (const b of allBookings) {
        const key = b.checkIn ? b.checkIn.substring(0, 7) : "unknown";
        if (!monthlyData[key]) monthlyData[key] = { buyInCost: 0, revenue: 0, buyIns: 0, bookings: 0 };
        monthlyData[key].revenue += parseFloat(b.totalAmount || "0");
        monthlyData[key].bookings++;
      }

      res.json({
        totalBuyInCost,
        totalRevenue,
        totalProfit: totalRevenue - totalBuyInCost,
        totalBuyIns: allBuyIns.length,
        activeBuyIns,
        totalBookings: allBookings.length,
        monthlyBreakdown: Object.entries(monthlyData)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, data]) => ({ month, ...data, profit: data.revenue - data.buyInCost })),
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to generate summary", message: err.message });
    }
  });

  app.get("/api/photo-audit/check-vrbo", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SearchAPI.io API key not configured" });

    const unitNumber = req.query.unitNumber as string;
    const complexName = req.query.complexName as string;
    if (!unitNumber || !complexName) return res.status(400).json({ error: "Missing unitNumber or complexName" });

    const searchPlatform = async (siteQuery: string, sitePattern: string) => {
      try {
        const params = new URLSearchParams({ engine: "google", q: siteQuery, api_key: apiKey, num: "5" });
        const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!resp.ok) return [];
        const data = await resp.json() as any;
        return (data.organic_results || [])
          .filter((r: any) => {
            const url = (r.link || "").toLowerCase();
            const text = `${r.title || ""} ${r.snippet || ""}`.toLowerCase();
            return url.includes(sitePattern) && (
              text.includes(unitNumber.toLowerCase()) || text.includes(`#${unitNumber.toLowerCase()}`)
            );
          })
          .map((r: any) => ({ title: r.title, url: r.link, snippet: r.snippet }));
      } catch { return []; }
    };

    try {
      const [vrboListings, airbnbListings, bookingListings] = await Promise.all([
        searchPlatform(`${complexName} ${unitNumber} site:vrbo.com`, "vrbo.com"),
        searchPlatform(`${complexName} ${unitNumber} site:airbnb.com`, "airbnb.com"),
        searchPlatform(`${complexName} ${unitNumber} site:booking.com`, "booking.com"),
      ]);

      const otherCompanies = ["parrish", "kauai exclusive", "cb island", "elite pacific", "gather", "ali'i resorts"];
      const hasConflict = [...vrboListings, ...airbnbListings, ...bookingListings].some((listing: any) => {
        const text = `${listing.title} ${listing.snippet}`.toLowerCase();
        return otherCompanies.some(company => text.includes(company));
      });

      res.json({
        unitNumber,
        complexName,
        vrboListings,
        airbnbListings,
        bookingListings,
        hasConflict,
        isListedOnVrbo: vrboListings.length > 0,
        isListedOnAirbnb: airbnbListings.length > 0,
        isListedOnBooking: bookingListings.length > 0,
        isListedAnywhere: vrboListings.length > 0 || airbnbListings.length > 0 || bookingListings.length > 0,
        checkedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: "Platform check failed", message: err.message });
    }
  });

  // Quick 3-platform address-based check — used by Buy-In Tracker gate
  app.get("/api/platform-check/quick", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const address = (req.query.address as string || "").trim();
    const unitNumber = (req.query.unitNumber as string || "").trim();
    const complexName = (req.query.complexName as string || "").trim();
    if (!unitNumber || (!address && !complexName)) {
      return res.status(400).json({ error: "unitNumber and (address or complexName) required" });
    }

    // Extract street portion (everything before the first comma)
    const street = address ? address.split(",")[0].trim() : complexName;

    const checkOnePlatform = async (
      siteKey: string,
      sitePattern: string,
    ): Promise<{ listed: boolean; url: string | null; snippet: string | null }> => {
      const domain = sitePattern;
      // Address-based query is the primary (most precise); name-based is fallback
      const queries = [
        `site:${domain} "${street}" "${unitNumber}"`,
        `site:${domain} "${complexName}" "${unitNumber}"`,
      ].filter((q, i, arr) => arr.indexOf(q) === i); // dedupe if street === complexName
      try {
        for (const q of queries) {
          const params = new URLSearchParams({ engine: "google", q, api_key: apiKey, num: "5" });
          const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
          if (!resp.ok) continue;
          const data = await resp.json() as any;
          for (const r of (data.organic_results || []) as any[]) {
            const url: string = (r.link || "").toLowerCase();
            const text = `${r.title || ""} ${r.snippet || ""}`.toLowerCase();
            if (url.includes(sitePattern) && (
              text.includes(unitNumber.toLowerCase()) || text.includes(`#${unitNumber.toLowerCase()}`)
            )) {
              return { listed: true, url: r.link, snippet: `${r.title} — ${r.snippet}`.slice(0, 200) };
            }
          }
          await new Promise(r => setTimeout(r, 300));
        }
        return { listed: false, url: null, snippet: null };
      } catch { return { listed: false, url: null, snippet: null }; }
    };

    try {
      const [airbnb, vrbo, booking] = await Promise.all([
        checkOnePlatform("airbnb", "airbnb.com"),
        checkOnePlatform("vrbo", "vrbo.com"),
        checkOnePlatform("booking", "booking.com"),
      ]);
      res.json({ unitNumber, address, complexName, airbnb, vrbo, booking, checkedAt: new Date().toISOString() });
    } catch (err: any) {
      res.status(500).json({ error: "Quick platform check failed", message: err.message });
    }
  });

  app.get("/api/photo-audit/find-non-vrbo", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "SearchAPI.io API key not configured" });
    }

    const complexName = req.query.complexName as string;
    const bedrooms = req.query.bedrooms as string;
    if (!complexName || !bedrooms) {
      return res.status(400).json({ error: "Missing complexName or bedrooms" });
    }

    try {
      const searchQuery = `${bedrooms} bedroom ${complexName} Kauai rentals -site:vrbo.com -site:airbnb.com`;
      const searchParams = new URLSearchParams({
        engine: "google",
        q: searchQuery,
        api_key: apiKey,
        num: "15",
      });

      const searchResponse = await fetch(`https://www.searchapi.io/api/v1/search?${searchParams.toString()}`);
      if (!searchResponse.ok) {
        return res.status(500).json({ error: `Search failed: ${searchResponse.status}` });
      }

      const searchData = await searchResponse.json() as any;
      const candidates = (searchData.organic_results || [])
        .filter((r: any) => {
          const url = (r.link || "").toLowerCase();
          return !url.includes("vrbo.com") && !url.includes("airbnb.com");
        })
        .slice(0, 10)
        .map((r: any) => ({
          title: r.title,
          url: r.link,
          snippet: r.snippet,
          source: new URL(r.link).hostname,
        }));

      const unitPattern = /(?:#|unit\s*|room\s*)(\w+)/gi;
      const candidatesWithUnits = candidates.map((c: any) => {
        const text = `${c.title} ${c.snippet}`;
        const matches = [...text.matchAll(unitPattern)];
        const unitNumbers = [...new Set(matches.map(m => m[1]))];
        return { ...c, extractedUnits: unitNumbers };
      });

      const verified: any[] = [];
      for (const candidate of candidatesWithUnits) {
        if (candidate.extractedUnits.length === 0) {
          verified.push({ ...candidate, vrboStatus: "no_unit_number" });
          continue;
        }

        for (const unitNum of candidate.extractedUnits.slice(0, 2)) {
          const vrboQuery = `${complexName} ${unitNum} site:vrbo.com`;
          const vrboParams = new URLSearchParams({
            engine: "google",
            q: vrboQuery,
            api_key: apiKey,
            num: "5",
          });

          await new Promise(r => setTimeout(r, 500));

          try {
            const vrboResponse = await fetch(`https://www.searchapi.io/api/v1/search?${vrboParams.toString()}`);
            if (vrboResponse.ok) {
              const vrboData = await vrboResponse.json() as any;
              const vrboResults = (vrboData.organic_results || []).filter((r: any) => {
                const url = (r.link || "").toLowerCase();
                const title = (r.title || "").toLowerCase();
                return url.includes("vrbo.com") && (title.includes(unitNum.toLowerCase()) || title.includes(`#${unitNum.toLowerCase()}`));
              });

              verified.push({
                ...candidate,
                checkedUnit: unitNum,
                vrboStatus: vrboResults.length > 0 ? "on_vrbo" : "not_on_vrbo",
                vrboMatches: vrboResults.length,
              });
            }
          } catch {
            verified.push({ ...candidate, checkedUnit: unitNum, vrboStatus: "check_failed" });
          }
        }
      }

      const safeUnits = verified.filter(v => v.vrboStatus === "not_on_vrbo");
      const onVrbo = verified.filter(v => v.vrboStatus === "on_vrbo");

      res.json({
        complexName,
        bedrooms,
        totalCandidates: candidates.length,
        verified,
        safeUnits,
        onVrboCount: onVrbo.length,
        safeCount: safeUnits.length,
        checkedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: "Search failed", message: err.message });
    }
  });

  app.get("/api/scanner/properties", async (_req, res) => {
    res.json(getScannableProperties());
  });

  app.post("/api/scanner/run", async (req, res) => {
    if (isScannerRunning()) {
      return res.status(409).json({ error: "A scan is already running" });
    }
    let propertyId: number | undefined;
    if (req.body?.propertyId) {
      propertyId = parseInt(req.body.propertyId);
      if (isNaN(propertyId)) {
        return res.status(400).json({ error: "Invalid propertyId" });
      }
      const validIds = getScannableProperties().map(p => p.id);
      if (!validIds.includes(propertyId)) {
        return res.status(400).json({ error: `Property ${propertyId} is not a scannable listing` });
      }
    }
    const weeksAhead = 52;
    runAvailabilityScan(weeksAhead, propertyId).catch(err => {
      console.error("Scanner run error:", err);
    });
    const label = propertyId ? getPropertyName(propertyId) : "all properties";
    res.json({ message: `Scan started for ${label}`, weeksAhead, propertyId });
  });

  app.get("/api/scanner/status", async (_req, res) => {
    try {
      const latest = await storage.getLatestScannerRun();
      res.json({
        running: isScannerRunning(),
        currentPropertyId: getCurrentScanPropertyId(),
        latestRun: latest || null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/scanner/runs", async (_req, res) => {
    try {
      const runs = await storage.getScannerRuns(20);
      res.json(runs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve community photo listing as { url, filename }[] — used by Builder Step 3
  app.get("/api/photos/community/:folder", async (req, res) => {
    const folder = req.params.folder.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!folder) return res.status(400).json({ error: "Missing folder" });
    const folderPath = path.join(process.cwd(), "client/public/photos", folder);
    try {
      const files = await fs.promises.readdir(folderPath).catch(() => []);
      const imageFiles = (files as string[])
        .filter((f: string) => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .sort();
      const result = imageFiles.map((f: string) => ({
        url: `/photos/${folder}/${f}`,
        filename: f,
      }));
      res.json(result);
    } catch {
      res.json([]);
    }
  });

  // List actual files in a community photo folder (dynamic — doesn't rely on hardcoded data)
  app.get("/api/photos/community-files", async (req, res) => {
    const folder = (req.query.folder as string || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!folder) return res.status(400).json({ error: "Missing folder" });
    const folderPath = path.join(process.cwd(), "client/public/photos", folder);
    try {
      const files = await fs.promises.readdir(folderPath).catch(() => []);
      const imageFiles = files
        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .sort();
      res.json({ folder, files: imageFiles });
    } catch {
      res.json({ folder, files: [] });
    }
  });

  // Community Photo Finder
  app.get("/api/community-photos/search", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "SearchAPI.io API key not configured" });
    }

    const communityName = req.query.communityName as string;
    if (!communityName || !communityName.trim()) {
      return res.status(400).json({ error: "Missing communityName parameter" });
    }

    const name = communityName.trim();

    // --- If this community has a hardcoded listing URL, scrape it directly ---
    const sourceConfig = COMMUNITY_SOURCE_URLS[name];
    if (sourceConfig) {
      try {
        const scraped = await scrapeListingPhotos(sourceConfig.primary, sourceConfig.fallback);
        if (scraped.length > 0) {
          const results = scraped.map((p, i) => ({
            url: p.url,
            thumbnail: p.url,
            title: p.title,
            source: p.source,
            sourceLink: p.sourceLink,
            score: 100 - i, // preserve order, high score so they sort first
          }));
          return res.json({ communityName: name, results, totalFound: results.length, source: "listing" });
        }
        // Scraped but got nothing — fall through to Google Images search
      } catch (err: any) {
        console.warn(`[community-photos] Scraping failed for ${name}, falling back to search:`, err.message);
        // Fall through to search below
      }
    }

    // Five targeted on-property queries — each focuses on a specific amenity/area type
    const queries = [
      `"${name}" pool`,
      `"${name}" building exterior`,
      `"${name}" amenities`,
      `"${name}" clubhouse`,
      `"${name}" resort grounds`,
    ];

    // Also include property management site searches for known high-quality sources
    const COMMUNITY_PM_QUERIES: Record<string, string[]> = {
      "Regency at Poipu Kai": [`site:suiteparadise.com "Poipu Kai"`, `site:kauaibeachrentals.com "Poipu Kai"`],
      "Kaha Lani Resort": [`site:suiteparadise.com "Kaha Lani"`, `site:parrish.com "Kaha Lani"`],
      "Lae Nani Resort": [`site:suiteparadise.com "Lae Nani"`, `site:castleresorts.com "Lae Nani"`],
      "Kaiulani of Princeville": [`site:parrish.com "Kaiulani"`, `site:princeville.com "Kaiulani"`],
      "Mauna Kai Princeville": [`site:parrish.com "Mauna Kai"`, `site:princeville.com "Mauna Kai"`],
      "Pili Mai": [`site:koloa-landing.com "Pili Mai"`, `site:suiteparadise.com "Pili Mai"`],
      "Keauhou Estates": [`site:outrigger.com "Keauhou"`, `site:holua.com "Keauhou"`],
    };
    const pmQueries = COMMUNITY_PM_QUERIES[name] || [];

    // Keywords that indicate an individual unit interior — reject these
    const interiorKeywords = [
      "bedroom", "kitchen", "bathroom", "bath", "living room", "dining room",
      "interior", "couch", "sofa", "bed ", "master", "loft", "hallway",
      "floor plan", "floorplan", "map", "square feet",
    ];

    // Sources to deprioritize (individual listing platforms show unit interiors)
    const lowTrustSources = ["airbnb.com", "vrbo.com", "booking.com", "homeaway.com"];

    // Sources known to have accurate community property photos
    const highTrustSources = [
      "tripadvisor.com", "suiteparadise.com", "outrigger.com",
      "castleresorts.com", "parrish.com", "google.com", "maps.google.com",
      "jeanandabbott.com", "kauaibeachrentals.com", "remax.com", "zillow.com",
    ];

    const nameWords = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);

    function scoreAndValidate(img: any): { valid: boolean; label: string; score: number } {
      const title = (img.title || "").toLowerCase();
      const sourceLink = (img.source?.link || "").toLowerCase();
      const sourceName = (img.source?.name || "").toLowerCase();
      const imageUrl = (img.original?.link || "").toLowerCase();

      // Must have an original image URL
      if (!img.original?.link) return { valid: false, label: "", score: 0 };

      // Skip SVG/GIF/tiny images
      if (imageUrl.endsWith(".svg") || imageUrl.endsWith(".gif")) return { valid: false, label: "", score: 0 };
      const w = img.original?.width || 0;
      const h = img.original?.height || 0;
      if (w > 0 && h > 0 && (w < 300 || h < 200)) return { valid: false, label: "", score: 0 };

      // Reject if title strongly suggests interior unit photo
      const hasInterior = interiorKeywords.some(kw => title.includes(kw));
      if (hasInterior) return { valid: false, label: "", score: 0 };

      // Reject low-trust individual listing platforms
      if (lowTrustSources.some(s => sourceLink.includes(s) || imageUrl.includes(s))) {
        return { valid: false, label: "", score: 0 };
      }

      // Community name validation: at least one significant word from community name
      // must appear in the title, source URL, or image URL
      const contextText = `${title} ${sourceLink} ${sourceName} ${imageUrl}`;
      const nameMatch = nameWords.some(w => contextText.includes(w));
      if (!nameMatch) return { valid: false, label: "", score: 0 };

      // Build a human-readable label
      let label = img.title || name;
      if (label.length > 80) label = label.substring(0, 77) + "...";

      // Score: higher = better
      let score = 50;
      if (highTrustSources.some(s => sourceLink.includes(s))) score += 30;

      // Boost for community/resort/pool keywords in title
      const boostWords = ["pool", "resort", "grounds", "exterior", "building", "aerial", "community", "clubhouse", "tennis", "complex", "property"];
      boostWords.forEach(w => { if (title.includes(w)) score += 5; });

      return { valid: true, label, score };
    }

    try {
      // Run all queries in parallel: 5 targeted on-property queries + PM site queries
      const allQueries = [...queries, ...pmQueries];
      const searchPromises = allQueries.map(async (q) => {
        const params = new URLSearchParams({
          engine: "google_images",
          q,
          api_key: apiKey,
          num: "30",
          safe: "active",
        });
        const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!resp.ok) return [];
        const data = await resp.json() as any;
        return (data.images || []) as any[];
      });

      const allResults = await Promise.all(searchPromises);
      const combined = allResults.flat();

      // Deduplicate by original image URL
      const seen = new Set<string>();
      const validated: any[] = [];

      for (const img of combined) {
        const url = img.original?.link;
        if (!url || seen.has(url)) continue;
        seen.add(url);

        const { valid, label, score } = scoreAndValidate(img);
        if (!valid) continue;

        validated.push({
          url,
          thumbnail: img.thumbnail || url,
          title: label,
          source: img.source?.name || img.source?.link || "Unknown",
          sourceLink: img.source?.link || "",
          width: img.original?.width,
          height: img.original?.height,
          score,
        });
      }

      // Sort by score descending, take top 40
      validated.sort((a, b) => b.score - a.score);
      const top = validated.slice(0, 40);

      res.json({ communityName: name, results: top, totalFound: top.length });
    } catch (err: any) {
      res.status(500).json({ error: "Community photo search failed", message: err.message });
    }
  });

  // Save selected community photos directly into the community folder
  app.post("/api/community-photos/save", async (req, res) => {
    const { communityFolder, imageUrls } = req.body as { communityFolder: string; imageUrls: string[] };
    if (!communityFolder || !imageUrls?.length) {
      return res.status(400).json({ error: "Missing communityFolder or imageUrls" });
    }
    if (!/^community-[\w-]+$/.test(communityFolder)) {
      return res.status(400).json({ error: "Invalid communityFolder name" });
    }

    const folderPath = path.join(process.cwd(), "client/public/photos", communityFolder);
    await fs.promises.mkdir(folderPath, { recursive: true });

    // Clear existing files in folder
    const existing = await fs.promises.readdir(folderPath).catch(() => []);
    for (const f of existing) {
      if (/\.(jpg|jpeg|png|webp)$/i.test(f)) {
        await fs.promises.unlink(path.join(folderPath, f)).catch(() => {});
      }
    }

    const saved: string[] = [];
    const failed: string[] = [];

    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      try {
        const imgResp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; VacationRentalBot/1.0)" },
          signal: AbortSignal.timeout(10000),
        });
        if (!imgResp.ok) { failed.push(url); continue; }
        const contentType = imgResp.headers.get("content-type") || "";
        const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
        const filename = `${String(i + 1).padStart(2, "0")}-community.${ext}`;
        const buffer = Buffer.from(await imgResp.arrayBuffer());
        if (buffer.length < 5000) { failed.push(url); continue; } // skip tiny/broken images
        await fs.promises.writeFile(path.join(folderPath, filename), buffer);
        saved.push(filename);
      } catch {
        failed.push(url);
      }
    }

    // Auto-label the newly-saved photos with Claude Vision so the photo
    // tab renders accurate captions without the user having to manually
    // hit the relabel-all button after adding a community.
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey && saved.length > 0) {
      // Fire-and-forget so the save response isn't blocked on 5-6 Claude calls.
      (async () => {
        await storage.deletePhotoLabelsByFolder(communityFolder).catch(() => {});
        for (const filename of saved) {
          try {
            const result = await labelPhoto(
              path.join(folderPath, filename),
              inferKindFromFolder(communityFolder),
              anthropicKey,
            );
            if (result) {
              await storage.upsertPhotoLabel({
                folder: communityFolder,
                filename,
                label: result.label,
                category: result.category,
                model: result.model,
              });
            }
          } catch (e: any) {
            console.warn(`[auto-label] ${communityFolder}/${filename}: ${e?.message ?? e}`);
          }
        }
        console.log(`[auto-label] ${communityFolder}: labeled ${saved.length} photo(s)`);
      })();
    }

    res.json({ saved, failed, folder: communityFolder, autoLabeling: anthropicKey ? saved.length : 0 });
  });

  // Rescrape a unit (or community) photo folder from a Zillow listing URL.
  // Clears the folder, downloads the scraped photos as photo_NN.jpg, updates
  // _source.json so future rescrapes are one click, and kicks off Claude labeling.
  //
  // sourceUrl resolution order (caller can omit the URL after the first scrape):
  //   1. body.sourceUrl (explicit override)
  //   2. _source.json → sourceListing.url (stamped by a previous rescrape)
  //   3. unit_swaps.newSourceUrl (if this folder was swapped in via pre-flight)
  //   4. COMMUNITY_SOURCE_URLS[<communityName>] (for community-* folders)
  // If none are available, responds 409 with { needsUrl: true } so the UI
  // knows to prompt exactly once.
  app.post("/api/builder/rescrape-unit-photos", async (req, res) => {
    const { folder, sourceUrl: suppliedUrl, limit } = req.body as {
      folder?: string;
      sourceUrl?: string;
      limit?: number;
    };
    if (!folder || !/^[\w-]+$/.test(folder)) {
      return res.status(400).json({ error: "Invalid folder" });
    }
    const folderPath = path.join(process.cwd(), "client/public/photos", folder);
    try {
      const stat = await fs.promises.stat(folderPath).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        return res.status(404).json({ error: `Folder not found: ${folder}` });
      }

      // Resolve the best sourceUrl we can find.
      let sourceUrl = typeof suppliedUrl === "string" && /^https?:\/\//i.test(suppliedUrl)
        ? suppliedUrl : null;
      let urlSource: "supplied" | "_source.json" | "unit_swap" | "community_map" | null =
        sourceUrl ? "supplied" : null;

      const sourcePath = path.join(folderPath, "_source.json");
      let sourceDoc: any = {};
      try {
        sourceDoc = JSON.parse(await fs.promises.readFile(sourcePath, "utf8"));
      } catch {}

      if (!sourceUrl) {
        const prev = sourceDoc?.sourceListing?.url;
        if (typeof prev === "string" && /^https?:\/\//i.test(prev)) {
          sourceUrl = prev; urlSource = "_source.json";
        }
      }

      // unit_swaps lookup — if pre-flight replaced this unit, the URL is on file.
      if (!sourceUrl) {
        try {
          const refs: Array<{ propertyId: number; unitId?: string }> =
            (sourceDoc?.referencedBy as any[]) ?? [];
          for (const ref of refs) {
            if (!ref.propertyId) continue;
            const swaps = await storage.getUnitSwaps(ref.propertyId);
            const match = swaps.find((s: any) =>
              s.committed && (!ref.unitId || s.oldUnitId === ref.unitId) &&
              /^https?:\/\//i.test(s.newSourceUrl),
            );
            if (match) {
              sourceUrl = match.newSourceUrl;
              urlSource = "unit_swap";
              break;
            }
          }
        } catch {}
      }

      // Community folder fallback — the hardcoded map at the top of this file.
      if (!sourceUrl && folder.startsWith("community-")) {
        const commName = COMMUNITY_FOLDER_TO_NAME[folder];
        const entry = commName ? COMMUNITY_SOURCE_URLS[commName] : null;
        if (entry?.primary) {
          sourceUrl = entry.primary; urlSource = "community_map";
        }
      }

      if (!sourceUrl) {
        return res.status(409).json({
          needsUrl: true,
          error: "No source URL on file for this folder. Paste the listing URL and I'll save it for next time.",
        });
      }

      const listingFacts: ListingFacts = {};
      const scraped = await scrapeListingPhotos(sourceUrl, undefined, listingFacts);
      if (!scraped.length) {
        return res.status(502).json({ error: "Scraper returned zero photos. The page may have bot-detection or changed layout." });
      }

      // Cap how many we ultimately keep. The pipeline downloads ALL scraped
      // photos first, labels them, then keeps the top N by category priority
      // (Bedrooms > Bathrooms > Living > Dining > Kitchen > ...) — so we
      // never drop a bedroom just because it was late in Apify's list.
      const maxKeep = Math.max(1, Math.min(40, limit ?? 25));
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      // Expected bed/bath counts. The Zillow listing's own structured data
      // (listingFacts) is authoritative when available — the scraper pulled
      // it straight out of the listing payload. Fall back to the unit_swap
      // reference on the source doc if the scraper didn't surface facts.
      let expectedBedrooms: number | undefined = listingFacts.bedrooms;
      let expectedBathrooms: number | undefined = listingFacts.bathrooms;
      const refs = (sourceDoc?.referencedBy as Array<Record<string, unknown>> | undefined) ?? [];
      if (refs.length > 0) {
        const ref = refs[0];
        if (expectedBedrooms == null && typeof ref.bedrooms === "number") expectedBedrooms = ref.bedrooms;
        if (expectedBathrooms == null) {
          if (typeof ref.bathrooms === "number") expectedBathrooms = ref.bathrooms;
          else if (typeof ref.bathrooms === "string" && !isNaN(parseFloat(ref.bathrooms))) {
            // Preserve half-baths (2.5 → 2.5) — snap to nearest 0.5 in case
            // the string has trailing noise like "2.5 (plus half bath)".
            expectedBathrooms = Math.round(parseFloat(ref.bathrooms) * 2) / 2;
          }
        }
      }
      const result = await downloadAndPrioritize({
        folder,
        folderPath,
        scrapedUrls: scraped.map((s) => s.url),
        maxKeep,
        anthropicKey,
        kind: inferKindFromFolder(folder),
        requiredBedrooms: expectedBedrooms,
        requiredBathrooms: expectedBathrooms,
      });

      // The UI-facing bed/bath counts. Prefer the listing's own declared
      // numbers over photo-derived inference — Zillow knows what the unit
      // has far more reliably than a vision model counting photos. Keep
      // photo-derived as the floor, so if the listing undersells (rare),
      // we don't over-suppress the detected rooms.
      const displayBedroomCount = Math.max(result.bedroomCount, listingFacts.bedrooms ?? 0);
      const displayBathroomCount = Math.max(result.bathroomCount, listingFacts.bathrooms ?? 0);

      // Stamp the URL back into _source.json so the next rescrape is one click.
      sourceDoc.sourceListing = {
        url: sourceUrl,
        platform: /zillow\.com/i.test(sourceUrl) ? "zillow" : /homes\.com/i.test(sourceUrl) ? "homes.com" : /vrbo\.com/i.test(sourceUrl) ? "vrbo" : /airbnb\.com/i.test(sourceUrl) ? "airbnb" : "other",
        scrapedDate: new Date().toISOString().slice(0, 10),
      };
      sourceDoc.verificationStatus = "needs-review";
      sourceDoc.verifiedDate = new Date().toISOString().slice(0, 10);
      sourceDoc.verifiedBy = "rescrape";
      await fs.promises.writeFile(sourcePath, JSON.stringify(sourceDoc, null, 2));

      res.json({
        folder,
        sourceUrl,
        urlSource,
        scrapedCount: scraped.length,
        savedCount: result.kept,
        failedCount: result.downloaded - result.kept - result.dropped,
        downloaded: result.downloaded,
        dropped: result.dropped,
        bedroomCount: displayBedroomCount,
        bathroomCount: displayBathroomCount,
        bedroomTypes: result.bedroomTypes,
        bathroomTypes: result.bathroomTypes,
        listingFacts,
        coverage: result.coverage,
        categorySummary: result.categorySummary,
        saved: result.keptFilenames,
        autoLabeling: anthropicKey ? result.kept : 0,
      });
    } catch (err: any) {
      console.error(`[rescrape] ${folder}: ${err?.message ?? err}`);
      res.status(500).json({ error: err?.message ?? "rescrape failed" });
    }
  });

  // Walking-distance estimator for multi-unit listings.
  // GET /api/tools/walk-between?a=<addr>&b=<addr>&resort=<name>
  // Returns { minutes, feet, description, source }.
  app.get("/api/tools/walk-between", async (req, res) => {
    const a = String(req.query.a ?? "").trim();
    const b = String(req.query.b ?? "").trim();
    const resort = String(req.query.resort ?? "").trim() || undefined;
    if (!a || !b) return res.status(400).json({ error: "both 'a' and 'b' query params required" });
    try {
      const result = await walkBetween(a, b, resort);
      res.json(result);
    } catch (e: any) {
      res.json(fallbackWalkForResort(resort));
    }
  });

  // Diagnostic: does the Zillow scraper actually return photos for a given URL?
  // Usage: GET /api/builder/probe-zillow?url=<zillow url>
  // Returns the list of CDN URLs the scraper found, without writing anything.
  app.get("/api/builder/probe-zillow", async (req, res) => {
    const url = String(req.query.url ?? "");
    if (!/^https?:\/\/(www\.)?zillow\.com\//i.test(url)) {
      return res.status(400).json({ error: "url query must be a zillow.com URL" });
    }
    const scraped = await scrapeListingPhotos(url);
    res.json({
      url,
      count: scraped.length,
      samples: scraped.slice(0, 10).map((p) => p.url),
    });
  });

  // Read _source.json for a folder (so the client can pre-fill the URL prompt).
  app.get("/api/builder/photo-source/:folder", async (req, res) => {
    const folder = req.params.folder;
    if (!folder || !/^[\w-]+$/.test(folder)) return res.status(400).json({ error: "invalid folder" });
    const sourcePath = path.join(process.cwd(), "client/public/photos", folder, "_source.json");
    try {
      const doc = JSON.parse(await fs.promises.readFile(sourcePath, "utf8"));
      res.json({ folder, source: doc });
    } catch {
      res.json({ folder, source: null });
    }
  });

  // ── Photo labels: read + relabel ──────────────────────────────────────
  // Returns the Claude-vision-generated captions for a given folder plus
  // any human overrides (userLabel / userCategory / hidden). The curation
  // UI needs BOTH sets so it can show the model's output and let the user
  // override — existing callers that only touched `label` / `category`
  // keep working since those fields are unchanged.
  app.get("/api/photo-labels/:folder", async (req, res) => {
    const folder = req.params.folder;
    if (!folder || !/^[\w-]+$/.test(folder)) return res.status(400).json({ error: "invalid folder" });
    try {
      const rows = await storage.getPhotoLabelsByFolder(folder);
      const labels: Record<string, {
        label: string;
        category: string | null;
        confidence: number | null;
        userLabel: string | null;
        userCategory: string | null;
        hidden: boolean;
      }> = {};
      for (const r of rows) {
        labels[r.filename] = {
          label: r.label,
          category: r.category,
          confidence: r.confidence,
          userLabel: r.userLabel,
          userCategory: r.userCategory,
          hidden: r.hidden,
        };
      }
      return res.json({ folder, labels, count: rows.length });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Update a single photo's human-authored overrides. Accepts any subset
  // of { userLabel, userCategory, hidden }; the labeler-generated fields
  // (label, category, confidence, model) are preserved. Pass null on
  // userLabel / userCategory to clear an override.
  app.put("/api/photo-labels/:folder/:filename", async (req, res) => {
    const { folder, filename } = req.params;
    if (!folder || !/^[\w-]+$/.test(folder)) return res.status(400).json({ error: "invalid folder" });
    if (!filename || !/^[\w.-]+\.(jpe?g|png|webp)$/i.test(filename)) {
      return res.status(400).json({ error: "invalid filename" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: { userLabel?: string | null; userCategory?: string | null; hidden?: boolean } = {};
    if ("userLabel" in body) {
      patch.userLabel = body.userLabel == null ? null : String(body.userLabel).slice(0, 200);
    }
    if ("userCategory" in body) {
      patch.userCategory = body.userCategory == null ? null : String(body.userCategory).slice(0, 64);
    }
    if ("hidden" in body) {
      patch.hidden = Boolean(body.hidden);
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "no override fields in body" });
    }
    try {
      const row = await storage.updatePhotoLabelOverrides(folder, filename, patch);
      if (!row) return res.status(404).json({ error: "photo label not found — rescrape first?" });
      return res.json({ ok: true, row });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Bulk-relabel every photo in every folder under client/public/photos.
  // Streams NDJSON progress. Throttled to stay under Anthropic's
  // ~50-req/min Haiku ceiling. Skip-existing mode (default) only labels
  // photos missing from the DB, so re-runs are cheap and resumable
  // after a partial failure.
  app.post("/api/admin/relabel-all-photos", async (req, res) => {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

    const reqBody = (req.body ?? {}) as Record<string, unknown>;
    const onlyFolder = typeof reqBody.folder === "string" ? reqBody.folder as string : null;
    // Default: skip files we've already labeled. Pass {force: true} to
    // wipe + redo every label (the rare case where the prompt changed).
    const force = reqBody.force === true;
    const photosRoot = path.join(process.cwd(), "client/public/photos");
    if (!fs.existsSync(photosRoot)) return res.status(404).json({ error: "photos directory missing" });

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const emit = (obj: Record<string, unknown>) => { res.write(JSON.stringify(obj) + "\n"); };

    try {
      const all = await fs.promises.readdir(photosRoot);
      const folders = all.filter((f) => !onlyFolder || f === onlyFolder);

      // For skip-existing mode, build a set of (folder|filename) pairs
      // already labeled so we can drop them from the work queue.
      const alreadyLabeled = new Set<string>();
      if (!force) {
        const existing = await storage.getAllPhotoLabels();
        for (const r of existing) alreadyLabeled.add(`${r.folder}|${r.filename}`);
      }

      let total = 0;
      const perFolder: Array<{ folder: string; files: string[] }> = [];
      for (const folder of folders) {
        const folderPath = path.join(photosRoot, folder);
        const stat = await fs.promises.stat(folderPath).catch(() => null);
        if (!stat?.isDirectory()) continue;
        let files = await listPhotoFiles(folderPath);
        if (!force) {
          files = files.filter((f) => !alreadyLabeled.has(`${folder}|${f}`));
        }
        if (files.length === 0) continue;
        perFolder.push({ folder, files });
        total += files.length;
      }

      emit({ type: "start", folders: perFolder.length, total, mode: force ? "force" : "skip-existing" });

      // Throttle: Anthropic Haiku ceiling is 50 req/min for our org. Pace
      // at 45/min = one request every 1.4s with a small jitter.
      const sleepMs = 1400;

      let done = 0;
      let failed = 0;
      for (const { folder, files } of perFolder) {
        emit({ type: "folder", folder, files: files.length });
        if (force) {
          await storage.deletePhotoLabelsByFolder(folder).catch(() => {});
        }
        const kind = inferKindFromFolder(folder);
        for (const filename of files) {
          const abs = path.join(photosRoot, folder, filename);
          const result = await labelPhoto(abs, kind, anthropicKey);
          done++;
          if (!result) {
            failed++;
            emit({ type: "photo", folder, filename, ok: false, done, total });
          } else {
            await storage.upsertPhotoLabel({
              folder, filename,
              label: result.label,
              category: result.category,
              model: result.model,
            });
            emit({ type: "photo", folder, filename, ok: true, label: result.label, category: result.category, done, total });
          }
          // Pace requests to stay under the rate limit.
          await new Promise((resolve) => setTimeout(resolve, sleepMs));
        }
      }

      emit({ type: "done", total, done, failed, folders: perFolder.length });
      res.end();
    } catch (err: any) {
      emit({ type: "error", error: err.message });
      res.end();
    }
  });

  // Batch-populate all community photo folders from web search (one-time operation)
  app.post("/api/community-photos/populate-all", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SearchAPI.io API key not configured" });

    const COMMUNITIES_MAP: Record<string, string> = {
      "Regency at Poipu Kai": "community-regency-poipu-kai",
      "Kekaha Beachfront Estate": "community-kekaha-estate",
      "Keauhou Estates": "community-keauhou-estates",
      "Mauna Kai Princeville": "community-mauna-kai",
      "Kaha Lani Resort": "community-kaha-lani",
      "Lae Nani Resort": "community-lae-nani",
      "Poipu Brenneckes Beachside": "community-poipu-beachside",
      "Kaiulani of Princeville": "community-kaiulani",
      "Poipu Brenneckes Oceanfront": "community-poipu-oceanfront",
      "Pili Mai": "community-pili-mai",
    };

    const interiorKeywords = ["bedroom", "kitchen", "bathroom", "bath", "living room", "dining room", "interior", "couch", "sofa", "bed ", "master", "loft", "hallway", "floor plan", "floorplan", "map", "square feet"];
    const lowTrustSources = ["airbnb.com", "vrbo.com", "booking.com", "homeaway.com"];
    const highTrustSources = ["tripadvisor.com", "suiteparadise.com", "outrigger.com", "castleresorts.com", "parrish.com", "google.com", "jeanandabbott.com", "kauaibeachrentals.com"];

    const COMMUNITY_PM_QUERIES_BATCH: Record<string, string[]> = {
      "Regency at Poipu Kai": [`site:suiteparadise.com "Poipu Kai"`, `site:kauaibeachrentals.com "Poipu Kai"`],
      "Kaha Lani Resort": [`site:suiteparadise.com "Kaha Lani"`, `site:parrish.com "Kaha Lani"`],
      "Lae Nani Resort": [`site:suiteparadise.com "Lae Nani"`, `site:castleresorts.com "Lae Nani"`],
      "Kaiulani of Princeville": [`site:parrish.com "Kaiulani"`, `site:princeville.com "Kaiulani"`],
      "Mauna Kai Princeville": [`site:parrish.com "Mauna Kai"`, `site:princeville.com "Mauna Kai"`],
      "Pili Mai": [`site:koloa-landing.com "Pili Mai"`, `site:suiteparadise.com "Pili Mai"`],
      "Keauhou Estates": [`site:outrigger.com "Keauhou"`, `site:holua.com "Keauhou"`],
    };

    const results: Record<string, { saved: number; failed: number }> = {};

    for (const [communityName, folderName] of Object.entries(COMMUNITIES_MAP)) {
      console.log(`[populate-all] ▶ Starting: ${communityName} → ${folderName}`);
      try {
        // Five targeted on-property queries + PM site queries
        const queries = [
          `"${communityName}" pool`,
          `"${communityName}" building exterior`,
          `"${communityName}" amenities`,
          `"${communityName}" clubhouse`,
          `"${communityName}" resort grounds`,
          ...(COMMUNITY_PM_QUERIES_BATCH[communityName] || []),
        ];
        const nameWords = communityName.toLowerCase().split(/\s+/).filter(w => w.length > 3);

        const allImages: any[] = [];
        for (const q of queries) {
          const params = new URLSearchParams({ engine: "google_images", q, api_key: apiKey, num: "30", safe: "active" });
          const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
          if (resp.ok) {
            const data = await resp.json() as any;
            allImages.push(...(data.images || []));
          }
          await new Promise(r => setTimeout(r, 400)); // rate limit between queries
        }
        console.log(`[populate-all] ${communityName}: fetched ${allImages.length} raw images across ${queries.length} queries`);

        // Deduplicate and score
        const seen = new Set<string>();
        const validated: any[] = [];
        for (const img of allImages) {
          const url = img.original?.link;
          if (!url || seen.has(url)) continue;
          seen.add(url);
          const title = (img.title || "").toLowerCase();
          const sourceLink = (img.source?.link || "").toLowerCase();
          const imageUrl = url.toLowerCase();
          if (!img.original?.link) continue;
          if (imageUrl.endsWith(".svg") || imageUrl.endsWith(".gif")) continue;
          const w = img.original?.width || 0; const h = img.original?.height || 0;
          if (w > 0 && h > 0 && (w < 300 || h < 200)) continue;
          if (interiorKeywords.some(kw => title.includes(kw))) continue;
          if (lowTrustSources.some(s => sourceLink.includes(s) || imageUrl.includes(s))) continue;
          const contextText = `${title} ${sourceLink} ${imageUrl}`;
          if (!nameWords.some(w => contextText.includes(w))) continue;
          let score = 50;
          if (highTrustSources.some(s => sourceLink.includes(s))) score += 30;
          ["pool", "resort", "grounds", "exterior", "building", "aerial", "community", "clubhouse"].forEach(w => { if (title.includes(w)) score += 5; });
          validated.push({ url, score });
        }
        validated.sort((a, b) => b.score - a.score);
        const topUrls = validated.slice(0, 8).map(v => v.url);
        console.log(`[populate-all] ${communityName}: ${validated.length} valid candidates, saving top ${topUrls.length}`);

        // Purge existing community photos then save new ones
        const folderPath = path.join(process.cwd(), "client/public/photos", folderName);
        await fs.promises.mkdir(folderPath, { recursive: true });
        const existing = await fs.promises.readdir(folderPath).catch(() => []);
        let purged = 0;
        for (const f of existing) {
          if (/\.(jpg|jpeg|png|webp)$/i.test(f)) {
            await fs.promises.unlink(path.join(folderPath, f)).catch(() => {});
            purged++;
          }
        }
        console.log(`[populate-all] ${communityName}: purged ${purged} old photos`);

        let saved = 0; let failed = 0;
        for (let i = 0; i < topUrls.length; i++) {
          try {
            const imgResp = await fetch(topUrls[i], {
              headers: { "User-Agent": "Mozilla/5.0 (compatible; VacationRentalBot/1.0)" },
              signal: AbortSignal.timeout(12000),
            });
            if (!imgResp.ok) { failed++; continue; }
            const ct = imgResp.headers.get("content-type") || "";
            const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
            const buffer = Buffer.from(await imgResp.arrayBuffer());
            if (buffer.length < 5000) { failed++; continue; }
            await fs.promises.writeFile(path.join(folderPath, `${String(i + 1).padStart(2, "0")}-community.${ext}`), buffer);
            saved++;
          } catch { failed++; }
        }
        results[communityName] = { saved, failed };
        console.log(`[populate-all] ✓ ${communityName}: saved=${saved}, failed=${failed}`);
      } catch (err: any) {
        console.log(`[populate-all] ✗ ${communityName}: ERROR — ${err?.message}`);
        results[communityName] = { saved: 0, failed: -1 };
      }
      await new Promise(r => setTimeout(r, 1000)); // rate limit between communities
    }
    console.log(`[populate-all] ✅ Complete! Results:`, JSON.stringify(results));

    res.json({ status: "complete", results });
  });

  app.get("/api/scanner/results", async (req, res) => {
    try {
      const filters: { runId?: number; community?: string; status?: string } = {};
      if (req.query.runId) filters.runId = parseInt(req.query.runId as string);
      if (req.query.community) filters.community = req.query.community as string;
      if (req.query.status) filters.status = req.query.status as string;
      const results = await storage.getAvailabilityScans(filters);
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ========== PLATFORM CHECK (reverse image search) ==========
  // Checks whether a photo (local or via URL) appears on Airbnb, VRBO, or Booking.com.
  // Local photos are first uploaded to ImgBB to get a public URL.
  app.post("/api/photos/platform-check", async (req, res) => {
    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    const imgbbKey = process.env.IMGBB_API_KEY;

    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const { folder, filename, imageUrl, communityName, location } = req.body as {
      folder?: string;
      filename?: string;
      imageUrl?: string;
      communityName?: string;
      location?: string;
    };

    // Island detection helpers for location-based filtering
    const ISLAND_KEYWORDS: Record<string, string[]> = {
      kauai: ["kauai", "lihue", "kapaa", "koloa", "poipu", "princeville", "hanalei", "waimea", "eleele", "kalaheo", "96766", "96746", "96756", "96765", "96741"],
      oahu: ["oahu", "honolulu", "waikiki", "kailua", "kaneohe", "aiea", "pearl city", "96815", "96816", "96734", "96701"],
      maui: ["maui", "kihei", "lahaina", "wailea", "paia", "makena", "kapalua", "kahului", "96753", "96761", "96732"],
      "big island": ["big island", "kona", "kailua-kona", "hilo", "waikoloa", "kohala", "waimea", "96740", "96720", "96743"],
      molokai: ["molokai", "kaunakakai"],
      lanai: ["lanai city"],
    };
    const detectIsland = (text: string): string | null => {
      const lower = text.toLowerCase();
      for (const [island, keywords] of Object.entries(ISLAND_KEYWORDS)) {
        if (keywords.some(k => lower.includes(k))) return island;
      }
      return null;
    };
    const ourIsland = detectIsland(location || "");
    const communityWords = (communityName || "").toLowerCase().split(/\s+/).filter(w => w.length > 3);

    let publicUrl: string | null = null;

    if (imageUrl) {
      // External photo — use URL directly
      publicUrl = imageUrl;
    } else if (folder && filename) {
      // Local photo — upload to ImgBB first
      if (!imgbbKey) {
        return res.status(500).json({ error: "IMGBB_API_KEY not configured — needed to upload local photos for reverse search" });
      }
      const photosBase = path.join(process.cwd(), "client", "public", "photos");
      const safeFolder = (folder || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const safeFile = (filename || "").replace(/[^a-zA-Z0-9_.-]/g, "");
      const filePath = path.join(photosBase, safeFolder, safeFile);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Photo not found" });
      }

      const base64Data = fs.readFileSync(filePath).toString("base64");
      const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `image=${encodeURIComponent(base64Data)}`,
      });

      if (!imgbbResp.ok) {
        const errText = await imgbbResp.text();
        console.error("[platform-check] ImgBB upload failed:", imgbbResp.status, errText);
        return res.status(500).json({ error: "Failed to upload image for reverse search" });
      }

      const imgbbData = await imgbbResp.json() as any;
      publicUrl = imgbbData?.data?.url || null;
      if (!publicUrl) return res.status(500).json({ error: "ImgBB did not return a URL" });
    } else {
      return res.status(400).json({ error: "Provide either folder+filename (local photo) or imageUrl (external photo)" });
    }

    // Run Google Lens reverse image search via SearchAPI
    const searchResp = await fetch(
      `https://www.searchapi.io/api/v1/search?engine=google_lens&url=${encodeURIComponent(publicUrl)}&api_key=${searchApiKey}`,
    );

    if (!searchResp.ok) {
      const errText = await searchResp.text();
      console.error("[platform-check] SearchAPI failed:", searchResp.status, errText);
      return res.status(500).json({ error: "Reverse image search failed" });
    }

    const searchData = await searchResp.json() as any;

    // Check all result arrays for vacation rental platform URLs
    const PLATFORMS: Record<string, string> = {
      "airbnb.com": "Airbnb",
      "vrbo.com": "VRBO",
      "booking.com": "Booking.com",
    };

    const found: { name: string; url: string; title: string; matchLocation: string; confidence: "high" | "medium" | "low" }[] = [];

    const allResults = [
      ...(searchData.visual_matches || []),
      ...(searchData.organic_results || []),
      ...(searchData.image_results || []),
      ...(searchData.inline_images || []),
      ...(searchData.pages_with_matching_images || []),
    ];

    for (const result of allResults) {
      const url: string = result.link || result.source_url || result.url || result.source?.link || "";
      const title: string = result.title || result.snippet || "";
      const titleLower = title.toLowerCase();
      const position: number = result.position ?? 999;

      // ── 1. Island mismatch filter: discard if matched listing is on a different island ──
      if (ourIsland) {
        const matchIsland = detectIsland(title + " " + url);
        if (matchIsland && matchIsland !== ourIsland) {
          console.log(`[platform-check] Discarding cross-island match: "${title}" (${matchIsland} vs our ${ourIsland})`);
          continue;
        }
      }

      // ── 2. Community name cross-reference ──
      const hasCommunityMatch = communityWords.length > 0 && communityWords.some(w => titleLower.includes(w));

      // ── 3. Similarity threshold via position ──
      // With community name match: accept top 10 results (high confidence from branding)
      // Without community name match: only accept position 1-2 (near-identical visuals required)
      const positionLimit = hasCommunityMatch ? 10 : 2;
      if (position > positionLimit) {
        console.log(`[platform-check] Skipping low-confidence match pos=${position} (limit=${positionLimit}): "${title}"`);
        continue;
      }

      const confidence: "high" | "medium" | "low" = hasCommunityMatch ? "high" : position === 1 ? "medium" : "low";
      const matchLocation = detectIsland(title + " " + url) || "";

      for (const [domain, platformName] of Object.entries(PLATFORMS)) {
        if (url.includes(domain) && !found.some(f => f.name === platformName && f.url === url)) {
          found.push({ name: platformName, url, title, matchLocation, confidence });
        }
      }
    }

    console.log(`[platform-check] ${filename || imageUrl}: ourIsland=${ourIsland} community="${communityName}" → ${found.length > 0 ? found.map(f => `${f.name}(${f.confidence})`).join(", ") : "clear"}`);
    res.json({ filename: filename || null, platforms: found, checkedUrl: publicUrl });
  });

  // ========== PRE-FLIGHT CHECK ==========

  // Platform check: searches Google for the property on Airbnb, VRBO, and Booking.com
  app.get("/api/preflight/platform-check", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    const imgbbKey = process.env.IMGBB_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const name = (req.query.name as string || "").trim();
    const city = (req.query.city as string || "").trim();
    const unitsParam = (req.query.units as string || "[]");
    if (!name) return res.status(400).json({ error: "name is required" });

    let units: { unitId: string; unitNumber: string; address: string; photoFolder?: string }[] = [];
    try { units = JSON.parse(unitsParam); } catch { return res.status(400).json({ error: "Invalid units JSON" }); }
    if (units.length === 0) return res.status(400).json({ error: "units array is required" });

    const PLATFORM_CONFIGS = [
      { key: "airbnb",  pattern: "airbnb.com/rooms/" },
      { key: "vrbo",    pattern: "vrbo.com/" },
      { key: "booking", pattern: "booking.com/" },
    ];
    const photosBase = path.join(process.cwd(), "client", "public", "photos");

    // ── Helper: strip the unit number from an address so queries can target
    // the street portion cleanly. Input "4460 Nehe Rd 122 Lihue HI" with
    // unit="122" → "4460 Nehe Rd Lihue HI". Without this, the street query
    // double-counts the unit number ("4460 Nehe Rd 122" already contains it)
    // and a villa whose snippet mentions any "122" gets a false positive.
    const stripUnitFromAddress = (addr: string, unitNumber: string): string => {
      const n = (unitNumber || "").trim();
      if (!n || !addr) return addr;
      // Match unit-number with or without a marker, bounded by space/comma.
      const re = new RegExp(
        `(?:[,\\s])(?:unit\\s*#?|apt\\.?\\s*#?|apartment\\s*#?|suite\\s*#?|ste\\.?\\s*#?|no\\.?\\s*|#)?\\s*${n}(?=[,\\s]|$)`,
        "i",
      );
      return addr.replace(re, " ").replace(/\s*,\s*/g, ", ").replace(/\s{2,}/g, " ").trim();
    };

    // Extract the street portion (before the first comma, or before the city
    // if no commas) so we can demand the snippet mentions OUR street, not
    // just the unit number alone.
    const extractStreet = (cleanedAddr: string): string => {
      if (cleanedAddr.includes(",")) return cleanedAddr.split(",")[0].trim();
      // No comma form: "4460 Nehe Rd Lihue HI" — take through the last
      // street-type token (Rd/St/Ave/Dr/Blvd/Ln/Way/Ct/Pl/Ter/Cir/Pkwy/Hwy).
      const m = cleanedAddr.match(/^(.*?\b(?:rd|road|st|street|ave|avenue|dr|drive|blvd|boulevard|ln|lane|way|ct|court|pl|place|ter|terrace|cir|circle|pkwy|parkway|hwy|highway))\b/i);
      return (m ? m[1] : cleanedAddr).trim();
    };

    // Build a lowercase "haystack" from a search result for text checks.
    const resultText = (r: any): string =>
      `${r.title || ""} ${r.snippet || ""} ${r.link || ""}`.toLowerCase();

    // ── Helper: is this a "short" unit number (1-2 digits) whose bare
    // appearance in a snippet is too ambiguous to trust? Short numeric
    // IDs like "9" collide with review scores (9.2), counts ("9 guests"),
    // distances ("9 miles"), and any other stray digit on the page.
    // For these, we require an explicit unit marker everywhere — both
    // in the Google query and in snippet validation. "721", "228",
    // "13B" etc. are specific enough that they don't need marker-gating.
    const isShortUnitNumber = (n: string): boolean => /^\d{1,2}$/.test((n || "").trim());

    // Build the unit term for a Google query. Short units get an OR of
    // explicit marker forms; long/alphanumeric units use the bare term.
    const unitQueryTerm = (unitNumber: string): string => {
      const n = (unitNumber || "").trim();
      if (!n) return "";
      if (!isShortUnitNumber(n)) return `"${n}"`;
      return `("Unit ${n}" OR "#${n}" OR "Apt ${n}" OR "Suite ${n}")`;
    };

    // ── Helper: does the snippet mention the unit number with a marker strong
    // enough to distinguish it from a random "122" in a price / zip / review
    // count? We require either an explicit unit marker (Unit 122, #122, Apt
    // 122 …) OR the number as its own space-bounded word immediately after
    // the street (e.g. "Nehe Rd 122" or "Rd, 122"). Bare "122" anywhere is
    // rejected — it was the source of the Unit 122 / VRBO villa false
    // positive where the snippet mentioned the digits in an unrelated field.
    //
    // For short units (1-2 digits) the street-adjacency fallback is ALSO
    // disabled: "3920 Wyllie Rd 9" collides with snippets like "3920
    // Wyllie Rd · 9.2 rating" that Google serves for shared-building
    // listings. Short units must have an explicit marker or they
    // don't count.
    const snippetMentionsUnit = (r: any, unitNumber: string, streetTail?: string): boolean => {
      const text = resultText(r);
      const num = unitNumber.toLowerCase().replace(/^0+/, ""); // strip leading zeros
      if (!num) return false;
      // Strong markers — any of these is sufficient on its own.
      const markerPatterns = [
        new RegExp(`\\b(?:unit|apt\\.?|apartment|suite|ste\\.?|no\\.?)\\s*#?\\s*${num}\\b`, "i"),
        new RegExp(`#\\s*${num}\\b`, "i"),
        // URL slug form: property-name-122 (dash-prefixed, only in the link portion)
        new RegExp(`-${num}(?:[\\/\\?\\-]|$)`, "i"),
      ];
      if (markerPatterns.some((re) => re.test(text))) return true;
      // Weaker: number immediately after the street name ("Nehe Rd 122").
      // Only count when the street is also visible in the same text AND
      // the unit number is long enough that accidental collisions are
      // unlikely. For short units, this fallback is disabled entirely.
      if (streetTail && !isShortUnitNumber(unitNumber)) {
        const tail = streetTail.toLowerCase();
        const adjacent = new RegExp(`\\b${tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,?\\s*#?\\s*${num}\\b`, "i");
        if (adjacent.test(text)) return true;
      }
      return false;
    };

    // ── Helper: confirm URL is a specific listing page (not a search/region page) ─
    const isListingUrl = (url: string, cfg: typeof PLATFORM_CONFIGS[0]): boolean => {
      if (!url) return false;
      const u = url.toLowerCase();
      if (cfg.key === "airbnb") return u.includes("airbnb.com/rooms/") || u.includes("airbnb.com/h/");
      if (cfg.key === "vrbo") {
        // Accept every URL shape that actually resolves to ONE specific
        // listing. VRBO has several historical variants — the /es-es/p…vb
        // URL in the bug report is a Spanish-locale listing page, which the
        // old regex missed entirely.
        if (/vrbo\.com\/\d+[a-z]{0,3}(?:[\/?#]|$)/.test(u)) return true;       // /1234567, /1234567ha
        if (/vrbo\.com\/[a-z]{2}-[a-z]{2}\/p\d+/.test(u)) return true;          // /en-us/p12345, /es-es/p12345vb
        if (/vrbo\.com\/vacation-rental\/p\d+/.test(u)) return true;            // /vacation-rental/p12345
        // Explicitly reject category/search pages even though they live
        // under vrbo.com — those aren't a unit someone can have booked.
        if (/vrbo\.com\/(search|region|destinations?|vacation-rentals\/[a-z])/.test(u)) return false;
        return false;
      }
      if (cfg.key === "booking") return u.includes("booking.com/hotel/") || u.includes("booking.com/apartments/");
      return u.includes(cfg.pattern);
    };

    // ── Helper: text search per platform for a unit — address-based + name-based
    // Uses Google snippet text for verification (no HTML fetch — platforms block bots).
    //
    // Methodology (rev. 2026-04 after villa false-positive on VRBO /es-es/ URL):
    //   1. Strip the unit number out of the address before building the
    //      street query so we don't double-count "122" in the source text.
    //   2. Only trust URLs that match a specific-listing shape per platform.
    //      No longer fall back to "any URL under vrbo.com" — that accepted
    //      region/search pages and misdirected listings.
    //   3. snippetMentionsUnit requires a unit marker (#, Unit 122, -122)
    //      OR street-adjacent placement (Nehe Rd 122). Bare "122" anywhere
    //      in the snippet (price, review count, zip) is NOT sufficient.
    //   4. titleMatch additionally requires the street portion to appear in
    //      the snippet — otherwise it's a weak match (reported as unconfirmed).
    const textSearch = async (
      unit: { unitNumber: string; address: string },
      cfg: typeof PLATFORM_CONFIGS[0],
    ): Promise<{ listed: boolean | null; url: string | null; titleMatch: boolean }> => {
      const domain = cfg.key === "booking" ? "booking.com" : `${cfg.key}.com`;
      // Pre-clean the address so the unit number only appears in the
      // dedicated unit-number term of the query, never in the street term.
      const cleanedAddr = stripUnitFromAddress(unit.address || "", unit.unitNumber);
      const street = extractStreet(cleanedAddr);
      // Run address-based query (primary) and name+city query (fallback)
      // in parallel. For short (1-2 digit) units we wrap the unit term
      // in an explicit-marker OR so Google only returns pages that
      // actually position the number as a unit identifier — not as a
      // review score / guest count / distance.
      const unitTerm = unitQueryTerm(unit.unitNumber);
      const queries = [
        street && unitTerm ? `site:${domain} "${street}" ${unitTerm}` : null,
        unitTerm ? `site:${domain} "${name}" "${city}" ${unitTerm}` : null,
      ].filter(Boolean) as string[];
      try {
        const searchResults = await Promise.all(queries.map(async (q) => {
          const params = new URLSearchParams({ engine: "google", q, api_key: apiKey, num: "5" });
          const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`, {
            headers: { "User-Agent": "NexStay/1.0" },
          });
          if (!resp.ok) return [];
          const data = await resp.json() as any;
          return (data.organic_results || []) as any[];
        }));
        // Merge results from both queries, dedupe by URL
        const seen = new Set<string>();
        const allResults: any[] = [];
        for (const batch of searchResults) {
          for (const r of batch) {
            const link: string = r.link || r.url || "";
            if (!seen.has(link)) { seen.add(link); allResults.push(r); }
          }
        }
        // Extract the street name alone (without the leading number) so we
        // can demand it appears in the snippet — this is what distinguishes
        // "Nehe Rd 122" (real match) from a random "122" in a different
        // listing's description.
        const streetName = street.replace(/^\d+\s*/, "").trim();
        const streetTail = streetName; // used for adjacency heuristic in snippetMentionsUnit

        let bestUrl: string | null = null;
        let bestTitleMatch = false;
        for (const r of allResults) {
          const link: string = r.link || r.url || "";
          if (!link.toLowerCase().includes(cfg.key === "booking" ? "booking.com" : `${cfg.key}.com`)) continue;
          // Hard requirement: only accept a URL that resolves to one specific
          // listing. Search/region/category pages and misdirected domain hits
          // never advance. This removes the old "vrbo.com anything" fallback
          // that caused the /es-es/p…vb villa to slip through.
          if (!isListingUrl(link, cfg)) continue;
          const unitInSnippet = snippetMentionsUnit(r, unit.unitNumber, streetTail);
          // For titleMatch we also need the STREET to appear in the snippet.
          // A listing URL + unit-number mention alone is still a "possible
          // match" (shown yellow in the UI), not a confirmed one.
          const streetInSnippet = streetName.length >= 3
            ? resultText(r).includes(streetName.toLowerCase())
            : false;
          // Hard gate: if NEITHER the street nor the unit number actually
          // appears in the snippet, Google's site: search returned a fuzzy
          // match that's probably a different listing entirely — the
          // scenario that produced the Unit 122 / villa false positive.
          // Skip it rather than surface it as a "possible match".
          if (!unitInSnippet && !streetInSnippet) continue;
          const titleMatch = unitInSnippet && streetInSnippet;
          if (titleMatch) return { listed: true, url: link, titleMatch: true };
          if (!bestUrl) { bestUrl = link; bestTitleMatch = false; }
        }
        if (bestUrl) return { listed: true, url: bestUrl, titleMatch: bestTitleMatch };
        return { listed: false, url: null, titleMatch: false };
      } catch { return { listed: null, url: null, titleMatch: false }; }
    };

    // ── Helper: after Google Lens returns a candidate listing URL,
    // verify that URL's page actually mentions OUR unit number.
    // Shared-building listings (3920 Wyllie Rd has ~20 units) are
    // visually similar — unit 2A's photos look enough like unit 9's
    // that Lens cheerfully returns unit 2A's URL when we query with
    // unit 9's photos. This helper reconfirms via a Google site: query
    // scoped to the candidate's path: if that specific listing doesn't
    // mention our unit number with a marker, it's a different unit in
    // the same building → reject.
    const verifyUrlMentionsUnit = async (url: string, unitNumber: string): Promise<boolean> => {
      const n = (unitNumber || "").trim();
      if (!n || !url) return false;
      let parsed: URL;
      try { parsed = new URL(url); } catch { return false; }
      const host = parsed.hostname.replace(/^www\./, "");
      // Strip file extensions (.html, .zh-cn.html) and trailing slashes
      // so Google indexes the listing as one canonical path.
      const pathClean = parsed.pathname.replace(/\.[a-z0-9.-]+$/i, "").replace(/\/+$/, "");
      if (!pathClean) return false;
      const markers = [`"Unit ${n}"`, `"#${n}"`, `"Apt ${n}"`, `"Suite ${n}"`].join(" OR ");
      const q = `site:${host}${pathClean} (${markers})`;
      try {
        const params = new URLSearchParams({ engine: "google", q, api_key: apiKey, num: "3" });
        const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`, {
          headers: { "User-Agent": "NexStay/1.0" },
        });
        if (!resp.ok) return false; // API error → treat as unverified → reject
        const data = await resp.json() as any;
        const results = (data.organic_results || []) as any[];
        return results.length > 0;
      } catch {
        return false;
      }
    };

    // ── Helper: photo reverse image search for a unit (caps at 3 photos) ──────
    type PhotoSignals = Record<string, boolean>; // platform key → found
    type PhotoMatchedUrls = Record<string, string | null>; // platform key → URL of the FIRST listing-page hit
    const photoSearch = async (photoFolder: string, unitNumber: string): Promise<{
      signals: PhotoSignals;
      matchedUrls: PhotoMatchedUrls;
      matchCount: number;
      totalChecked: number;
    }> => {
      const signals: PhotoSignals = { airbnb: false, vrbo: false, booking: false };
      const matchedUrls: PhotoMatchedUrls = { airbnb: null, vrbo: null, booking: null };
      if (!imgbbKey) return { signals, matchedUrls, matchCount: 0, totalChecked: 0 };
      // Empty photoFolder means no local photos available (e.g. a replacement unit) — skip photo check
      if (!photoFolder || photoFolder.trim() === "") return { signals, matchedUrls, matchCount: 0, totalChecked: 0 };
      const folderPath = path.join(photosBase, photoFolder.replace(/[^a-zA-Z0-9_-]/g, ""));
      if (!fs.existsSync(folderPath)) return { signals, matchedUrls, matchCount: 0, totalChecked: 0 };
      const files = fs.readdirSync(folderPath).filter((f: string) => /\.(jpg|jpeg|png)$/i.test(f)).sort().slice(0, 5);
      let matchCount = 0;
      for (const file of files) {
        try {
          const base64 = fs.readFileSync(path.join(folderPath, file)).toString("base64");
          const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `image=${encodeURIComponent(base64)}`,
          });
          if (!imgbbResp.ok) { await new Promise(r => setTimeout(r, 1000)); continue; }
          const imgbbData = await imgbbResp.json() as any;
          const publicUrl = imgbbData?.data?.url;
          if (!publicUrl) { await new Promise(r => setTimeout(r, 1000)); continue; }
          const searchParams = new URLSearchParams({ engine: "google_lens", url: publicUrl, api_key: apiKey });
          const searchResp = await fetch(`https://www.searchapi.io/api/v1/search?${searchParams.toString()}`, {
            headers: { "User-Agent": "NexStay/1.0" },
          });
          if (searchResp.ok) {
            const searchData = await searchResp.json() as any;
            // Keep both the lowercased version (for matching) and the
            // original URL (for the user to click). We were previously
            // throwing away the URL — that's the bug the user hit.
            const sourceLinks = [
              ...(searchData.visual_matches || []),
              ...(searchData.organic_results || []),
              ...(searchData.pages_with_matching_images || []),
              ...(searchData.knowledge_graph ? [searchData.knowledge_graph] : []),
            ].map((r: any) => String(r?.link || r?.url || r?.source || r?.source_url || ""))
              .filter((l) => l);
            for (const cfg of PLATFORM_CONFIGS) {
              const domain = cfg.key === "booking" ? "booking.com" : `${cfg.key}.com`;
              if (signals[cfg.key]) continue;
              // Find the first link that's an actual listing page on this platform.
              const matchedLink = sourceLinks.find((l: string) => {
                const ll = l.toLowerCase();
                if (!ll.includes(domain)) return false;
                return isListingUrl(ll, cfg) || ll.split(domain)[1]?.length > 5;
              });
              if (!matchedLink) continue;
              // Cross-validate: confirm the matched page actually names
              // our unit number. For shared-building addresses the same
              // Lens result set can contain listings for many units —
              // without this check, the first one "wins" even if it's
              // the wrong unit (e.g. 3920 Wyllie Rd unit 2A returned
              // for a unit 9 query). A Google site: scoped to the
              // listing's path must surface an explicit unit marker.
              const verified = await verifyUrlMentionsUnit(matchedLink, unitNumber);
              if (!verified) continue;
              signals[cfg.key] = true;
              matchedUrls[cfg.key] = matchedLink;
              matchCount++;
            }
          }
        } catch { /* best effort */ }
        await new Promise(r => setTimeout(r, 1000));
      }
      return { signals, matchedUrls, matchCount, totalChecked: files.length };
    };

    // ── Combine text + photo signals into a single status per platform ─────────
    type CombinedResult = { status: string; url: string | null; detection: string };
    const combine = (
      text: { listed: boolean | null; url: string | null; titleMatch: boolean },
      photoFound: boolean,
      photoMatchedUrl: string | null,
      photoMatchCount: number,
      totalPhotos: number,
    ): CombinedResult => {
      if (text.listed && text.titleMatch)
        return { status: "confirmed", url: text.url, detection: "Title match confirmed" };
      if (text.listed && !text.titleMatch && photoFound)
        // Text + photo both hit — prefer the text URL (the actual listing
        // we verified) but fall back to the photo-matched one when the
        // text search couldn't pin a specific listing-page URL.
        return { status: "photo-confirmed", url: text.url ?? photoMatchedUrl, detection: "Text found + photos matched" };
      if (!text.listed && photoFound)
        // Photo-only branch — surface the URL where the photo was found
        // so the user can click through and verify the match instead of
        // taking our boolean signal on faith.
        return { status: "photo-only", url: photoMatchedUrl, detection: `Photos matched (${totalPhotos} photo${totalPhotos !== 1 ? "s" : ""} checked) — no text confirmation` };
      if (text.listed && !text.titleMatch && !photoFound)
        return { status: "unconfirmed", url: text.url, detection: "Text found — title unconfirmed, no photo match" };
      if (text.listed === null)
        return { status: "error", url: null, detection: "Could not verify" };
      return { status: "not-listed", url: null, detection: "No signals found" };
    };

    // ── Process each unit: run text searches + photo search concurrently ───────
    const resultUnits = await Promise.all(
      units.map(async (unit) => {
        const [textResults, photoResult] = await Promise.all([
          Promise.all(PLATFORM_CONFIGS.map(cfg => textSearch(unit, cfg))),
          unit.photoFolder ? photoSearch(unit.photoFolder, unit.unitNumber) : Promise.resolve({ signals: { airbnb: false, vrbo: false, booking: false }, matchedUrls: { airbnb: null, vrbo: null, booking: null }, matchCount: 0, totalChecked: 0 }),
        ]);
        const [airbnbText, vrboText, bookingText] = textResults;
        const { signals, matchedUrls, matchCount, totalChecked } = photoResult;

        // Cross-platform correlation: if found on 2+ platforms via text, treat unconfirmed as confirmed
        const textListedCount = [airbnbText, vrboText, bookingText].filter(t => t.listed).length;
        const crossConfirmed = textListedCount >= 2;

        const resolveText = (t: typeof airbnbText) =>
          crossConfirmed && t.listed && !t.titleMatch ? { ...t, titleMatch: true } : t;

        return {
          unitId: unit.unitId,
          unitNumber: unit.unitNumber,
          address: unit.address,
          platforms: {
            airbnb:  combine(resolveText(airbnbText),  signals.airbnb,  matchedUrls.airbnb,  signals.airbnb  ? matchCount : 0, totalChecked),
            vrbo:    combine(resolveText(vrboText),    signals.vrbo,    matchedUrls.vrbo,    signals.vrbo    ? matchCount : 0, totalChecked),
            booking: combine(resolveText(bookingText), signals.booking, matchedUrls.booking, signals.booking ? matchCount : 0, totalChecked),
          },
        };
      }),
    );

    res.json({ units: resultUnits });
  });

  // Photo audit: runs reverse image search on each unit photo to detect platform listings
  app.get("/api/preflight/photo-audit", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    const imgbbKey = process.env.IMGBB_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });
    if (!imgbbKey) return res.status(500).json({ error: "IMGBB_API_KEY not configured" });

    const foldersParam = (req.query.folders as string || "");
    const folders = foldersParam.split(",").map(f => f.replace(/[^a-zA-Z0-9_-]/g, "")).filter(Boolean);
    if (folders.length === 0) return res.status(400).json({ error: "folders is required" });

    const photosBase = path.join(process.cwd(), "client", "public", "photos");
    const PLATFORMS = ["airbnb.com", "vrbo.com", "booking.com"];

    const results: { folder: string; filename: string; url: string; found: boolean | null; platforms: string[]; error?: string }[] = [];

    for (const folder of folders) {
      const folderPath = path.join(photosBase, folder);
      if (!fs.existsSync(folderPath)) continue;
      const files = fs.readdirSync(folderPath).filter((f: string) => /\.(jpg|jpeg|png)$/i.test(f)).sort().slice(0, 5);

      for (const file of files) {
        const localPath = path.join(folderPath, file);
        try {
          const base64Data = fs.readFileSync(localPath).toString("base64");
          const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `image=${encodeURIComponent(base64Data)}`,
          });
          if (!imgbbResp.ok) {
            results.push({ folder, filename: file, url: `/photos/${folder}/${file}`, found: null, platforms: [], error: "Upload failed" });
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          const imgbbData = await imgbbResp.json() as any;
          const publicUrl = imgbbData?.data?.url;
          if (!publicUrl) {
            results.push({ folder, filename: file, url: `/photos/${folder}/${file}`, found: null, platforms: [], error: "No URL from imgbb" });
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          const searchParams = new URLSearchParams({ engine: "google_lens", url: publicUrl, api_key: apiKey });
          const searchResp = await fetch(`https://www.searchapi.io/api/v1/search?${searchParams.toString()}`, {
            headers: { "User-Agent": "NexStay/1.0" },
          });
          if (!searchResp.ok) {
            results.push({ folder, filename: file, url: `/photos/${folder}/${file}`, found: null, platforms: [], error: "Search failed" });
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          const searchData = await searchResp.json() as any;
          const allResults = [
            ...(searchData.visual_matches || []),
            ...(searchData.organic_results || []),
            ...(searchData.pages_with_matching_images || []),
          ];
          const foundPlatforms: string[] = [];
          for (const r of allResults) {
            const link: string = r.link || r.url || r.source_url || "";
            for (const p of PLATFORMS) {
              if (link.includes(p) && !foundPlatforms.includes(p)) foundPlatforms.push(p);
            }
          }
          results.push({ folder, filename: file, url: `/photos/${folder}/${file}`, found: foundPlatforms.length > 0, platforms: foundPlatforms });
        } catch (err: any) {
          results.push({ folder, filename: file, url: `/photos/${folder}/${file}`, found: null, platforms: [], error: err.message });
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    res.json({ results });
  });

  // ========== FIND REPLACEMENT LISTING ==========
  // Searches for a different MLS unit at the same community and returns its photos.
  app.post("/api/photos/find-replacement", async (req, res) => {
    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const { communityFolder, currentZillowUrl } = req.body as {
      communityFolder: string;
      currentZillowUrl?: string;
    };

    const safeFolder = (communityFolder || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const communityName = COMMUNITY_FOLDER_TO_NAME[safeFolder];
    if (!communityName) {
      return res.status(400).json({ error: "Unknown community folder" });
    }

    const knownPrimary = COMMUNITY_SOURCE_URLS[communityName]?.primary || currentZillowUrl || null;

    // Search for Zillow listings at this community using SearchAPI Google search
    let candidateUrls: string[] = [];
    for (const siteQuery of [`site:zillow.com "${communityName}"`, `site:homes.com "${communityName}"`]) {
      try {
        const searchResp = await fetch(
          `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(siteQuery)}&num=8&api_key=${searchApiKey}`,
        );
        if (!searchResp.ok) continue;
        const searchData = await searchResp.json() as any;
        const urls: string[] = (searchData.organic_results || [])
          .map((r: any) => r.link as string)
          .filter((u: string) => (u.includes("zillow.com/homedetails") || u.includes("homes.com/property")) && u !== knownPrimary);
        candidateUrls = [...candidateUrls, ...urls];
        if (candidateUrls.length >= 5) break;
      } catch {}
    }

    candidateUrls = [...new Set(candidateUrls)].slice(0, 5);

    // Try to scrape photos from each candidate (up to 3 attempts)
    let attempts = 0;
    for (const url of candidateUrls) {
      if (attempts >= 3) break;
      attempts++;
      console.log(`[find-replacement] Trying: ${url}`);
      try {
        const photos = await scrapeListingPhotos(url);
        if (photos.length >= 3) {
          // Extract unit identifier from URL path
          const unitMatch = url.match(/apt-([a-z0-9]+)/i)
            || url.match(/unit-([a-z0-9]+)/i)
            || url.match(/-([a-z0-9]+)[-/]?.*zpid/i);
          const unitLabel = unitMatch ? `Unit #${unitMatch[1].toUpperCase()}` : "a different unit";
          return res.json({
            photos: photos.map(p => ({ url: p.url, label: p.title || "Photo" })),
            source: `${communityName} — ${unitLabel}`,
            communityName,
            sourceUrl: url,
          });
        }
      } catch (err: any) {
        console.warn(`[find-replacement] Failed for ${url}:`, err.message);
      }
    }

    return res.json({
      photos: [],
      error: "Could not find a replacement unit automatically — please select photos manually.",
    });
  });

  // ============================================================
  // Fetch Zillow listing photos without Playwright (plain HTTP + parse __NEXT_DATA__)
  // ============================================================
  async function scrapeZillowPhotosFetch(url: string): Promise<{ url: string; title: string }[]> {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          "Referer": "https://www.google.com/",
        },
      });
      console.error(`[scrapeZillow] ${url} → HTTP ${resp.status} ${resp.statusText}`);
      if (!resp.ok) return [];
      const html = await resp.text();
      console.error(`[scrapeZillow] HTML length: ${html.length}, has __NEXT_DATA__: ${html.includes('id="__NEXT_DATA__"')}, has mixedSources: ${html.includes("mixedSources")}`);

      // Extract __NEXT_DATA__ JSON embedded by Next.js SSR
      const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!match) return [];

      let nd: any;
      try { nd = JSON.parse(match[1]); } catch { return []; }

      const urls: string[] = [];
      function walk(obj: any, depth: number): void {
        if (depth > 16 || !obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) { obj.forEach(v => walk(v, depth + 1)); return; }
        if (obj.mixedSources?.jpeg && Array.isArray(obj.mixedSources.jpeg)) {
          const jpegs: Array<{ url: string; width?: number }> = obj.mixedSources.jpeg;
          if (jpegs.length > 0) {
            const biggest = jpegs.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a), jpegs[0]);
            if (biggest.url) urls.push(biggest.url);
          }
          return;
        }
        Object.values(obj).forEach(v => walk(v, depth + 1));
      }
      walk(nd, 0);

      const unique = [...new Set(urls)];
      return unique.map(u => ({ url: u, title: "Zillow photo" }));
    } catch {
      return [];
    }
  }

  // ============================================================
  // Find a replacement unit: Zillow search → Airbnb check → return clean unit
  // ============================================================
  app.post("/api/replacement/find-unit", async (req, res) => {
    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    const imgbbKey = process.env.IMGBB_API_KEY;
    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const { communityFolder, requiredBedrooms, skipUrls = [] } = req.body as {
      communityFolder: string;
      requiredBedrooms?: number;
      skipUrls?: string[];
    };

    const safeFolder = (communityFolder || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const communityName = COMMUNITY_FOLDER_TO_NAME[safeFolder];
    if (!communityName) return res.status(400).json({ error: "Unknown community folder" });

    const communityAddress = COMMUNITY_FOLDER_TO_ADDRESS[safeFolder] || communityName;
    console.error(`[find-unit] Starting: folder=${communityFolder}, name=${communityName}, address=${communityAddress}, bedrooms=${requiredBedrooms}`);

    // Step 1 — Google search for Zillow listing URLs at this community address
    // Google results also include a thumbnail we can use for display (no Zillow scraping needed)
    interface Candidate {
      zillowUrl: string;
      address: string;
      unitNumber: string;  // e.g. "122", "339"
      thumbnail: string;   // Google-provided thumbnail for the result card
    }
    const candidates: Candidate[] = [];

    for (const siteQuery of [
      `site:zillow.com "${communityAddress}"`,
      `site:zillow.com "${communityName}"`,
    ]) {
      try {
        console.error(`[find-unit] Searching: ${siteQuery}`);
        const searchResp = await fetch(
          `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(siteQuery)}&num=10&api_key=${searchApiKey}`,
        );
        if (!searchResp.ok) {
          console.error(`[find-unit] SearchAPI HTTP ${searchResp.status}`);
          continue;
        }
        const searchData = await searchResp.json() as any;
        const results: any[] = searchData.organic_results || [];
        console.error(`[find-unit] Got ${results.length} Google results`);

        for (const r of results) {
          const link: string = r.link || "";
          if (!link.includes("zillow.com/homedetails")) continue;
          if (skipUrls.includes(link)) continue;

          // Extract unit number from URL slug — patterns: "Nehe-Rd-122-", "APT-122-", "Unit-122-"
          const slug = link.match(/homedetails\/([^/]+)\//)?.[1] || "";
          const parts = slug.split("-");
          // First try explicit apt/unit prefix (most reliable)
          const aptMatch = slug.match(/(?:apt|unit)-([a-z0-9]+)/i);
          let unitNumber = aptMatch ? aptMatch[1].toUpperCase() : "";
          if (!unitNumber) {
            // Scan parts backwards, skip index 0 (house number like "4460") and skip zip codes (5+ digits)
            // Unit numbers are 2-4 digits and appear after the street name segments
            for (let i = parts.length - 1; i >= 1; i--) {
              if (/^\d{2,4}$/.test(parts[i]) && parseInt(parts[i]) < 1000) {
                unitNumber = parts[i];
                break;
              }
            }
          }

          const addrDisplay = decodeURIComponent(slug)
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c: string) => c.toUpperCase())
            .replace(/\d{5}$/, "").trim();

          const thumbnail: string = r.thumbnail || r.rich_snippet?.top?.detected_extensions?.thumbnail || "";

          candidates.push({ zillowUrl: link, address: addrDisplay || communityName, unitNumber, thumbnail });
        }
        if (candidates.length >= 6) break;
      } catch (e: any) {
        console.error(`[find-unit] Search error: ${e?.message}`);
      }
    }

    console.error(`[find-unit] Found ${candidates.length} candidate URLs`);

    // Step 2 — Per-candidate platform check across Airbnb, VRBO, and
    // Booking.com. Two complementary queries per platform:
    //   (a) address + unit number — catches listings that include the
    //       street address in their title/snippet (most common case)
    //   (b) community/resort name + unit number — catches listings that
    //       only mention the resort (e.g. "Oceanview Kaha Lani 3BR #228")
    //
    // Each query returns one of three verdicts:
    //   clean   — SearchAPI responded and no platform hits were found
    //   found   — SearchAPI responded and at least one hit matched
    //   unknown — SearchAPI errored / timed out. Previously this was
    //             silently treated as "clean", which is how a live unit
    //             could slip through. We now surface UNKNOWN to the UI
    //             so the user can decide whether to trust the result.
    //
    // Candidates with any FOUND verdict are skipped. Candidates with
    // all CLEAN or a mix of CLEAN/UNKNOWN fall through to the photo
    // and vision gates and are surfaced to the UI with the verdict.
    type PlatformStatus = "clean" | "found" | "unknown";
    type PlatformCheck = { airbnb: PlatformStatus; vrbo: PlatformStatus; bookingCom: PlatformStatus };

    const platformHosts: Array<{ key: keyof PlatformCheck; host: string }> = [
      { key: "airbnb",     host: "airbnb.com" },
      { key: "vrbo",       host: "vrbo.com" },
      { key: "bookingCom", host: "booking.com" },
    ];

    async function runSearch(q: string): Promise<any[] | null> {
      try {
        const resp = await fetch(
          `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(q)}&num=3&api_key=${searchApiKey}`,
        );
        if (!resp.ok) {
          console.error(`[find-unit] SearchAPI HTTP ${resp.status} for "${q}"`);
          return null;
        }
        const data = await resp.json() as any;
        return data.organic_results || [];
      } catch (e: any) {
        console.error(`[find-unit] SearchAPI error for "${q}": ${e?.message}`);
        return null;
      }
    }

    async function checkOnePlatform(host: string, queries: string[]): Promise<PlatformStatus> {
      // Fire both queries in parallel; combine verdicts.
      const hitLists = await Promise.all(queries.map((q) => runSearch(q)));
      let anyResponded = false;
      for (const hits of hitLists) {
        if (hits === null) continue;
        anyResponded = true;
        const matches = hits.filter((h: any) => (h.link || "").toLowerCase().includes(host));
        if (matches.length > 0) return "found";
      }
      // All queries errored → we genuinely don't know.
      return anyResponded ? "clean" : "unknown";
    }

    async function checkAllPlatforms(
      address: string,
      resort: string,
      unit: string,
    ): Promise<PlatformCheck> {
      if (!unit) {
        // Without a unit number there's no way to run a meaningfully
        // specific query — mark every platform as unknown and let the
        // UI surface that to the user.
        return { airbnb: "unknown", vrbo: "unknown", bookingCom: "unknown" };
      }
      const results = await Promise.all(
        platformHosts.map((p) =>
          checkOnePlatform(p.host, [
            `site:${p.host} "${address}" "${unit}"`,
            `site:${p.host} "${resort}" "${unit}"`,
          ]),
        ),
      );
      return {
        airbnb:     results[0],
        vrbo:       results[1],
        bookingCom: results[2],
      };
    }

    for (const candidate of candidates) {
      try {
        const { zillowUrl, address, unitNumber, thumbnail } = candidate;

        const platformCheck = await checkAllPlatforms(communityAddress, communityName, unitNumber);
        console.error(
          `[find-unit] ${zillowUrl} platform check: airbnb=${platformCheck.airbnb}, vrbo=${platformCheck.vrbo}, booking=${platformCheck.bookingCom}`,
        );
        const foundOn = platformHosts.find((p) => platformCheck[p.key] === "found");
        if (foundOn) {
          console.error(`[find-unit] Unit ${unitNumber} found on ${foundOn.host} — skipping`);
          continue;
        }
        // All CLEAN, or a mix of CLEAN and UNKNOWN. Fall through to the
        // photo+vision gates and surface the verdict in the response.

        {
          // Two-stage quality filter before suggesting this candidate:
          //
          //   Stage 1 — photo-count floor (MIN_PHOTOS). Skips sparse
          //   listings outright; avoids the downstream vision probe.
          //
          //   Stage 2 — interior content check via stratified Claude
          //   vision labels on 8 samples. Accepts Bedrooms OR Bathrooms
          //   as positive evidence (bathrooms almost always accompany
          //   bedrooms, so this cuts false-negatives on single-bedroom
          //   listings where our samples might miss the sole bedroom
          //   photo). ~$0.004 per candidate. See probeInteriorCoverage.
          const MIN_PHOTOS = 12;
          let scrapedPhotoUrls: string[] = [];
          try {
            const scraped = await scrapeListingPhotos(zillowUrl);
            scrapedPhotoUrls = scraped.map((p) => p.url);
          } catch { scrapedPhotoUrls = []; }
          const photoCount = scrapedPhotoUrls.length;
          console.error(`[find-unit] ${zillowUrl} → ${photoCount} photos (need ≥${MIN_PHOTOS})`);
          if (photoCount < MIN_PHOTOS) {
            console.error(`[find-unit] Too few photos — skipping to next candidate`);
            continue;
          }

          const anthropicKey = process.env.ANTHROPIC_API_KEY;
          let sampledCategories: string[] = [];
          if (anthropicKey) {
            const probe = await probeInteriorCoverage(scrapedPhotoUrls, anthropicKey);
            console.error(`[find-unit] interior probe verdict=${probe.verdict} categories=[${probe.categories.join(", ")}]`);
            if (probe.verdict === "reject") {
              console.error(`[find-unit] No bedroom/bathroom samples found — skipping to next candidate`);
              continue;
            }
            sampledCategories = probe.categories;
            // "unknown" (no key) or "pass" → fall through to confirm.
          }

          console.error(`[find-unit] Clean unit found: ${zillowUrl}`);
          const photos = thumbnail
            ? [{ url: thumbnail, label: `Unit ${unitNumber || "—"} on Zillow` }]
            : [];
          return res.json({
            unit: {
              url: zillowUrl,
              address,
              unitLabel: unitNumber ? `Unit #${unitNumber}` : "New unit",
              bedrooms: requiredBedrooms ?? null,
              source: "Zillow",
              photos,
              photoCount,
              sampledCategories,
              platformCheck,
            },
          });
        }
      } catch (err: any) {
        console.error(`[find-unit] Candidate error: ${err?.message}`);
      }
    }

    return res.json({
      error: "No eligible replacement units found. Please try again later or adjust your search criteria.",
    });
  });

  // ============================================================
  // Unit Swaps: Record a confirmed replacement unit for the builder
  //
  // If the client passes `photoFolder`, we scrape the Zillow listing
  // (newSourceUrl) and drop its photos into client/public/photos/{photoFolder}/
  // so the builder's Photos tab reflects the real replacement unit, not
  // the original stub folder. Fire-and-forget so the POST stays snappy.
  // ============================================================
  app.post("/api/unit-swaps", async (req, res) => {
    const { photoFolder, ...swapBody } = req.body as any;
    const parsed = insertUnitSwapSchema.safeParse(swapBody);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid unit swap data", details: parsed.error.flatten() });
    }
    const swap = await storage.createUnitSwap(parsed.data);

    if (typeof photoFolder === "string" && /^[\w-]+$/.test(photoFolder)
        && typeof swap.newSourceUrl === "string" && /^https?:\/\//i.test(swap.newSourceUrl)) {
      const url = swap.newSourceUrl;
      const folder = photoFolder;
      void (async () => {
        try {
          const folderPath = path.join(process.cwd(), "client/public/photos", folder);
          const listingFacts: ListingFacts = {};
          const scraped = await scrapeListingPhotos(url, undefined, listingFacts);
          if (!scraped.length) {
            console.warn(`[unit-swap rescrape] ${folder}: scraper returned 0 photos for ${url}`);
            return;
          }

          const result = await downloadAndPrioritize({
            folder,
            folderPath,
            scrapedUrls: scraped.map((s) => s.url),
            maxKeep: 25,
            anthropicKey: process.env.ANTHROPIC_API_KEY,
            kind: inferKindFromFolder(folder),
            requiredBedrooms: listingFacts.bedrooms ?? swap.newBedrooms ?? swap.oldBedrooms ?? undefined,
            requiredBathrooms: listingFacts.bathrooms ?? undefined,
          });

          // Stamp _source.json so the folder's provenance is recorded.
          const sourcePath = path.join(folderPath, "_source.json");
          let sourceDoc: any = {};
          try { sourceDoc = JSON.parse(await fs.promises.readFile(sourcePath, "utf8")); } catch {}
          sourceDoc.sourceListing = {
            url, platform: /zillow/i.test(url) ? "zillow" : "other",
            scrapedDate: new Date().toISOString().slice(0, 10),
          };
          sourceDoc.verificationStatus = "needs-review";
          sourceDoc.verifiedDate = new Date().toISOString().slice(0, 10);
          sourceDoc.verifiedBy = "unit-swap";
          await fs.promises.writeFile(sourcePath, JSON.stringify(sourceDoc, null, 2));

          console.log(`[unit-swap rescrape] ${folder}: kept ${result.kept}/${result.downloaded} photos (${result.bedroomCount} bedrooms, ${result.bathroomCount} bathrooms)`);
        } catch (e: any) {
          console.error(`[unit-swap rescrape] ${folder} failed: ${e?.message ?? e}`);
        }
      })();
    }

    return res.json({ swap });
  });

  app.get("/api/unit-swaps/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId);
    if (isNaN(propertyId)) return res.status(400).json({ error: "Invalid propertyId" });
    const swaps = await storage.getUnitSwaps(propertyId);
    return res.json({ swaps });
  });

  app.delete("/api/unit-swaps/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const ok = await storage.deleteUnitSwap(id);
    return res.json({ ok });
  });

  app.patch("/api/unit-swaps/commit/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId);
    if (isNaN(propertyId)) return res.status(400).json({ error: "Invalid propertyId" });
    await storage.commitUnitSwaps(propertyId);
    return res.json({ ok: true });
  });

  // ============================================================
  // Step 4: Fetch unit photos
  //
  // Two call shapes:
  //   1. { url } — direct: scrape photos from a known listing URL
  //      (the user-found-unit path in Add a New Community).
  //   2. { communityName, city, state, bedrooms } — discovery: when
  //      the algorithm-suggested pairing has no MLS URL, search
  //      Zillow for a real listing matching the community + BR count
  //      and scrape its photos. Returns the source URL alongside the
  //      photos so the UI can credit where they came from. If the
  //      search returns nothing, responds 200 with `photos: []` and
  //      a `note` so the page's "no photos" empty state continues
  //      to apply cleanly.
  // ============================================================
  app.post("/api/community/fetch-unit-photos", async (req, res) => {
    const { url, communityName, streetAddress, city, state, bedrooms, skipUrls } = req.body as {
      url?: string;
      communityName?: string;
      streetAddress?: string;
      city?: string;
      state?: string;
      bedrooms?: number;
      // URLs the caller already has (e.g. from a previous click) so
      // a "Find another" button can skip listings already surfaced.
      skipUrls?: string[];
    };

    let listingUrl: string | undefined = url || undefined;
    let foundVia: "url" | "search" = "url";

    if (!listingUrl) {
      // Discovery path. Need at least the community name to search.
      if (!communityName) {
        return res.status(400).json({ error: "url required (or communityName + bedrooms for discovery)" });
      }
      const searchApiKey = process.env.SEARCHAPI_API_KEY;
      if (!searchApiKey) {
        return res.status(503).json({ error: "Discovery requires SEARCHAPI_API_KEY (only direct url calls work without it)" });
      }
      // Multi-query Zillow discovery. Mirrors the staged-search pattern
      // /api/replacement/find-unit uses: try the most specific query
      // first (street address), then community-name + bedrooms-hint,
      // then bare community name. First query that returns a Zillow
      // /homedetails/ link wins. Earlier single-query version only ran
      // the bedroom-hinted variant, which came up empty on communities
      // whose Zillow listings don't say "N bedroom" in the title — so
      // the preflight ended up with zero photos for everything from
      // the wizard's algorithm-suggested pairings (Caribe Cove etc.).
      const skipSet = new Set((skipUrls ?? []).map((u) => u.toLowerCase()));
      const queries: string[] = [];
      if (streetAddress) {
        queries.push(`site:zillow.com "${streetAddress}"`);
      }
      const brHint = bedrooms ? `${bedrooms} bedroom` : "";
      if (brHint) {
        queries.push(`"${communityName}" ${city ?? ""} ${state ?? ""} ${brHint} site:zillow.com`.replace(/\s+/g, " ").trim());
      }
      queries.push(`site:zillow.com "${communityName}" ${city ?? ""} ${state ?? ""}`.replace(/\s+/g, " ").trim());
      // Last-ditch: bare quoted community name, no city/state. Catches
      // distinctive names ("Pili Mai", "Caribe Cove Resort") that
      // Google indexes well even without geographic disambiguation.
      queries.push(`site:zillow.com "${communityName}"`);

      for (const q of queries) {
        try {
          const resp = await fetch(
            `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(q)}&num=10&api_key=${searchApiKey}`,
          );
          if (!resp.ok) {
            console.warn(`[fetch-unit-photos] SearchAPI ${resp.status} for "${q}"`);
            continue;
          }
          const data = await resp.json() as any;
          const organic = (data.organic_results || []) as Array<{ link?: string; title?: string }>;
          const candidates = organic
            .map((r) => String(r.link ?? ""))
            .filter((l) => /zillow\.com\/homedetails\//i.test(l))
            .filter((l) => !skipSet.has(l.toLowerCase()));
          if (candidates.length > 0) {
            listingUrl = candidates[0];
            foundVia = "search";
            console.log(`[fetch-unit-photos] discovery hit on query "${q}" → ${listingUrl}`);
            break;
          }
        } catch (e: any) {
          console.warn(`[fetch-unit-photos] discovery search failed for "${q}": ${e.message}`);
        }
      }

      if (!listingUrl) {
        // No matching Zillow listing — return empty so the page's
        // empty state covers it. Not an error.
        return res.json({
          photos: [],
          sourceUrl: null,
          foundVia: "search",
          note: `No Zillow listing found for "${communityName}"${bedrooms ? ` (${bedrooms}BR)` : ""}.`,
        });
      }
    }

    try {
      const photos = await scrapeListingPhotos(listingUrl);
      res.json({
        photos: photos.map((p) => ({ url: p.url, label: p.title || "Photo" })),
        sourceUrl: listingUrl,
        foundVia,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Step 4: Platform check on a public image URL (no ImgBB needed — URL is already public)
  app.post("/api/community/check-photo-url", async (req, res) => {
    const { imageUrl } = req.body as { imageUrl: string };
    if (!imageUrl) return res.status(400).json({ error: "imageUrl required" });

    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    try {
      const resp = await fetch(
        `https://www.searchapi.io/api/v1/search?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${searchApiKey}`,
      );
      if (!resp.ok) {
        const errText = await resp.text();
        return res.status(resp.status).json({ error: `SearchAPI error: ${errText}` });
      }
      const data = await resp.json() as any;
      const matches: Array<{ platform: string; url: string }> = [];
      const allLinks = [
        ...(data.visual_matches || []),
        ...(data.organic_results || []),
        ...(data.image_results || []),
      ] as Array<{ link: string; title?: string; source?: string }>;

      for (const r of allLinks) {
        const link = r.link || "";
        if (link.includes("airbnb.com")) matches.push({ platform: "Airbnb", url: link });
        else if (link.includes("vrbo.com")) matches.push({ platform: "VRBO", url: link });
        else if (link.includes("booking.com")) matches.push({ platform: "Booking.com", url: link });
      }

      res.json({ matches, clean: matches.length === 0 });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================================
  // Community Draft CRUD
  // ============================================================
  app.get("/api/community/drafts", async (_req, res) => {
    const drafts = await storage.getCommunityDrafts();
    res.json(drafts);
  });

  app.post("/api/community/save", async (req, res) => {
    const result = insertCommunityDraftSchema.safeParse(req.body);
    if (!result.success) return res.status(400).json({ error: result.error.flatten() });
    // Reject villas / single-family / estates — the business combines two
    // condos or two townhomes in the same building. A "community" of
    // detached homes is not the same product.
    const typeCheck = checkCommunityType(result.data.unitTypes, result.data.researchSummary);
    if (!typeCheck.eligible) {
      return res.status(400).json({
        error: "Community type not supported",
        reason: typeCheck.reason,
        matchedDisqualifier: typeCheck.matchedDisqualifier,
      });
    }
    const draft = await storage.createCommunityDraft(result.data);
    res.json(draft);
  });

  app.patch("/api/community/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const draft = await storage.updateCommunityDraft(id, req.body);
    if (!draft) return res.status(404).json({ error: "Not found" });
    res.json(draft);
  });

  app.delete("/api/community/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const ok = await storage.deleteCommunityDraft(id);
    if (!ok) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  });

  // POST /api/community/:id/persist-photos
  //
  // Body: { unit1Photos: string[], unit2Photos: string[] }
  //
  // The Add a New Community wizard scrapes Zillow / runs a
  // discovery search and surfaces candidate photos in Step 4.
  // Those URLs sit in React state on the wizard — `handleSave`
  // posts the draft metadata to /api/community/save but didn't
  // persist the photos themselves, so a promoted draft opened in
  // builder-preflight had no images. This endpoint pulls each URL
  // down into per-unit folders under /app/client/public/photos/
  // (`draft-${id}-unit-a`, `draft-${id}-unit-b`) and updates the
  // draft row with those folder names. The volume mounted at that
  // path on Railway (Load-Bearing #17) means the files survive
  // deploys.
  //
  // Best-effort: a single bad URL is logged and skipped; the
  // response reports the saved count per unit so the wizard can
  // surface it. Caps at 25 photos/unit to mirror the wizard's
  // existing display cap.
  app.post("/api/community/:id/persist-photos", async (req, res) => {
    const draftId = parseInt(req.params.id, 10);
    if (!Number.isFinite(draftId)) return res.status(400).json({ error: "Invalid id" });

    const body = req.body as { unit1Photos?: string[]; unit2Photos?: string[] };
    const unit1Urls = Array.isArray(body.unit1Photos) ? body.unit1Photos.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)) : [];
    const unit2Urls = Array.isArray(body.unit2Photos) ? body.unit2Photos.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)) : [];

    const PHOTOS_BASE = path.join(process.cwd(), "client/public/photos");
    const MAX_PER_UNIT = 25;

    const downloadOne = async (url: string, folderPath: string, idx: number): Promise<boolean> => {
      try {
        const resp = await fetch(url, { headers: { "User-Agent": "NexStay/1.0" } });
        if (!resp.ok) return false;
        const buf = Buffer.from(await resp.arrayBuffer());
        // Photos.zillowstatic.com URLs end in .jpg/.jpeg/.png/.webp;
        // honor the original extension for content-type accuracy
        // when Express serves the file. Defaults to .jpg when the
        // URL has nothing parseable.
        const ext = (url.match(/\.(jpe?g|png|webp)\b/i)?.[1] ?? "jpg").toLowerCase().replace("jpeg", "jpg");
        const filename = `${String(idx).padStart(2, "0")}.${ext}`;
        await fs.promises.writeFile(path.join(folderPath, filename), buf);
        return true;
      } catch (e: any) {
        console.warn(`[draft-photos] download failed for ${url}: ${e.message}`);
        return false;
      }
    };

    const persistUnit = async (urls: string[], folder: string): Promise<{ folder: string; saved: number } | null> => {
      if (urls.length === 0) return null;
      const folderPath = path.join(PHOTOS_BASE, folder);
      // Wipe any prior contents so re-saving doesn't accumulate.
      // mkdir -p semantics handle the missing-folder case.
      await fs.promises.rm(folderPath, { recursive: true, force: true });
      await fs.promises.mkdir(folderPath, { recursive: true });
      const capped = urls.slice(0, MAX_PER_UNIT);
      const results = await Promise.all(capped.map((u, i) => downloadOne(u, folderPath, i)));
      const saved = results.filter(Boolean).length;
      return { folder, saved };
    };

    try {
      const [u1, u2] = await Promise.all([
        persistUnit(unit1Urls, `draft-${draftId}-unit-a`),
        persistUnit(unit2Urls, `draft-${draftId}-unit-b`),
      ]);
      const update: Record<string, string | null> = {};
      if (u1) update.unit1PhotoFolder = u1.folder;
      if (u2) update.unit2PhotoFolder = u2.folder;
      if (Object.keys(update).length > 0) {
        await storage.updateCommunityDraft(draftId, update);
      }
      console.log(`[draft-photos] draft ${draftId}: unit1 saved ${u1?.saved ?? 0}, unit2 saved ${u2?.saved ?? 0}`);
      res.json({
        ok: true,
        unit1: u1,
        unit2: u2,
      });
    } catch (e: any) {
      console.error(`[draft-photos] draft ${draftId} failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================================
  // Step 2: Research communities in a city/state via SearchAPI + Claude scoring
  // ============================================================
  app.post("/api/community/research", async (req, res) => {
    const { city, state } = req.body as { city: string; state: string };
    if (!city || !state) return res.status(400).json({ error: "city and state required" });

    try {
      const communities = await researchCommunitiesForCity(city, state);
      return res.json({ communities });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/community/scan-top-markets
  // Runs the community finder across a curated list of US vacation-rental
  // hotspots (TOP_MARKET_SEEDS). Streams NDJSON per-market as results come in
  // so the UI can render progressively — the whole sweep takes a few minutes.
  //
  // Body (optional): { markets?: [{city, state}], maxMarkets?: number }
  //   - Defaults to TOP_MARKET_SEEDS
  //   - maxMarkets caps the sweep (for quota conservation)
  //
  // NDJSON events:
  //   {type:"start", markets:[{city,state,tag}]}
  //   {type:"market-start", city, state, tag, index, total}
  //   {type:"market-done", city, state, count, communities:[...]}
  //   {type:"market-error", city, state, error}
  //   {type:"all-done", totalCommunities, topCommunity?}
  app.post("/api/community/scan-top-markets", async (req: Request, res: Response) => {
    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const body = (req.body ?? {}) as {
      markets?: Array<{ city: string; state: string; tag?: string }>;
      maxMarkets?: number;
    };

    const requested = body.markets && body.markets.length > 0 ? body.markets : TOP_MARKET_SEEDS;
    const limit = Math.min(requested.length, Math.max(1, body.maxMarkets ?? 12));
    const markets = requested.slice(0, limit);

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const emit = (o: Record<string, unknown>) => res.write(JSON.stringify(o) + "\n");

    emit({ type: "start", markets });
    console.log(`[scan-top-markets] starting sweep of ${markets.length} cities`);

    let totalCommunities = 0;
    let topCommunity: { score: number; data: any } | null = null;

    for (let i = 0; i < markets.length; i++) {
      const { city, state, tag } = markets[i] as { city: string; state: string; tag?: string };
      emit({ type: "market-start", city, state, tag, index: i + 1, total: markets.length });
      try {
        const communities = await researchCommunitiesForCity(city, state);
        totalCommunities += communities.length;
        for (const c of communities) {
          const score = c.confidenceScore + (c.combinabilityScore ?? 50);
          if (!topCommunity || score > topCommunity.score) {
            topCommunity = { score, data: { ...c, tag } };
          }
        }
        emit({ type: "market-done", city, state, tag, count: communities.length, communities });
        console.log(`[scan-top-markets] ${city}, ${state}: ${communities.length} qualifying`);
      } catch (e: any) {
        console.error(`[scan-top-markets] ${city}, ${state} error:`, e.message);
        emit({ type: "market-error", city, state, tag, error: e.message });
      }
    }

    emit({
      type: "all-done",
      totalCommunities,
      topCommunity: topCommunity?.data ?? null,
      marketCount: markets.length,
    });
    console.log(`[scan-top-markets] done: ${totalCommunities} communities across ${markets.length} markets`);
    res.end();
  });

  // GET /api/community/top-markets/seeds
  // Returns the curated seed list so the UI can show a preview / checkboxes.
  app.get("/api/community/top-markets/seeds", (_req, res) => {
    res.json({ seeds: TOP_MARKET_SEEDS });
  });

  // GET /api/community/city-suggest?state=Florida&query=des
  //
  // City autocomplete for the Add a New Community wizard. Backed by
  // Photon (Komoot's typeahead-tuned OSM service) with a per-state
  // bounding box so prefix matches stay scoped to the picked state
  // — Nominatim's structured `city=` filter and freeform `q=` both
  // failed for short prefixes (Destin missing under `des`, Kapaa
  // missing under `kapa`); Photon's prefix-aware indexing plus a
  // tight `bbox=` returns the right matches in the top-10.
  //
  // Cached in-process for 5 min by `${state}|${query}` so a slow
  // typist doesn't repeatedly hit Photon. Empty / sub-2-char
  // queries short-circuit with no network round-trip.
  //
  // STATE_BBOX values are rough (-min lon, min lat, max lon, max lat).
  // Tight enough that Photon's relevance ranking surfaces the
  // expected state matches at the top, loose enough not to clip
  // border towns. Alaska's range crosses the antimeridian, so the
  // bbox uses a negative-only longitude sweep that catches the
  // mainland portion (Aleutians beyond 179.0 East are not
  // serviceable territory for vacation rentals here).
  const STATE_BBOX: Record<string, [number, number, number, number]> = {
    Alabama:        [-88.473,  30.144,  -84.889,  35.008],
    Alaska:         [-179.148, 51.214,  -129.974, 71.4  ],
    Arizona:        [-114.819, 31.332,  -109.045, 37.004],
    Arkansas:       [-94.618,  33.004,  -89.645,  36.500],
    California:     [-124.482, 32.529,  -114.131, 42.009],
    Colorado:       [-109.060, 36.992,  -102.041, 41.003],
    Connecticut:    [-73.728,  40.989,  -71.787,  42.050],
    Delaware:       [-75.789,  38.451,  -75.049,  39.839],
    Florida:        [-87.635,  24.396,  -79.974,  31.001],
    Georgia:        [-85.605,  30.357,  -80.840,  35.001],
    Hawaii:         [-160.555, 18.910,  -154.806, 22.236],
    Idaho:          [-117.243, 41.988,  -111.043, 49.001],
    Illinois:       [-91.513,  36.971,  -87.494,  42.508],
    Indiana:        [-88.098,  37.771,  -84.785,  41.761],
    Iowa:           [-96.640,  40.376,  -90.140,  43.501],
    Kansas:         [-102.052, 36.993,  -94.589,  40.003],
    Kentucky:       [-89.572,  36.497,  -81.965,  39.147],
    Louisiana:      [-94.043,  28.929,  -88.817,  33.020],
    Maine:          [-71.084,  42.977,  -66.949,  47.460],
    Maryland:       [-79.487,  37.886,  -75.052,  39.722],
    Massachusetts:  [-73.508,  41.240,  -69.900,  42.886],
    Michigan:       [-90.418,  41.696,  -82.122,  48.306],
    Minnesota:      [-97.239,  43.499,  -89.490,  49.385],
    Mississippi:    [-91.655,  30.174,  -88.094,  34.996],
    Missouri:       [-95.774,  35.996,  -89.099,  40.613],
    Montana:        [-116.050, 44.358,  -104.040, 49.001],
    Nebraska:       [-104.054, 39.999,  -95.308,  43.002],
    Nevada:         [-120.005, 35.001,  -114.039, 42.001],
    "New Hampshire":[-72.557,  42.697,  -70.610,  45.305],
    "New Jersey":   [-75.560,  38.928,  -73.894,  41.358],
    "New Mexico":   [-109.050, 31.332,  -103.001, 37.000],
    "New York":     [-79.762,  40.477,  -71.856,  45.016],
    "North Carolina":[-84.322, 33.842,  -75.461,  36.588],
    "North Dakota": [-104.049, 45.935,  -96.554,  49.001],
    Ohio:           [-84.820,  38.404,  -80.518,  41.978],
    Oklahoma:       [-103.002, 33.616,  -94.430,  37.003],
    Oregon:         [-124.566, 41.992,  -116.463, 46.292],
    Pennsylvania:   [-80.520,  39.720,  -74.690,  42.270],
    "Rhode Island": [-71.862,  41.146,  -71.120,  42.019],
    "South Carolina":[-83.354, 32.034,  -78.499,  35.215],
    "South Dakota": [-104.058, 42.480,  -96.436,  45.945],
    Tennessee:      [-90.310,  34.983,  -81.647,  36.679],
    Texas:          [-106.646, 25.837,  -93.508,  36.501],
    Utah:           [-114.052, 36.998,  -109.041, 42.001],
    Vermont:        [-73.438,  42.727,  -71.465,  45.017],
    Virginia:       [-83.675,  36.541,  -75.243,  39.467],
    Washington:     [-124.733, 45.544,  -116.916, 49.002],
    "West Virginia":[-82.644,  37.202,  -77.719,  40.638],
    Wisconsin:      [-92.889,  42.492,  -86.805,  47.080],
    Wyoming:        [-111.056, 40.995,  -104.052, 45.005],
  };

  const cityCache = new Map<string, { cities: string[]; ts: number }>();
  const CITY_CACHE_TTL = 5 * 60 * 1000;

  app.get("/api/community/city-suggest", async (req, res) => {
    const state = String(req.query.state || "").trim();
    const query = String(req.query.query || "").trim();
    if (!state || query.length < 2) return res.json({ cities: [] });

    const cacheKey = `${state.toLowerCase()}|${query.toLowerCase()}`;
    const cached = cityCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CITY_CACHE_TTL) {
      return res.json({ cities: cached.cities });
    }

    const bbox = STATE_BBOX[state];
    if (!bbox) {
      console.warn(`[city-suggest] no bbox for state="${state}"`);
      return res.json({ cities: [] });
    }

    try {
      const url = new URL("https://photon.komoot.io/api/");
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "20");
      url.searchParams.set("bbox", bbox.join(","));
      // `osm_tag=place` keeps the response focused on populated
      // places — drops streets, businesses, POIs that the
      // typeahead would otherwise pull in for a short prefix.
      url.searchParams.set("osm_tag", "place");

      const resp = await fetch(url.toString(), {
        headers: { "User-Agent": "NexStay/1.0 (contact: jamie.greene736@gmail.com)" },
      });
      if (!resp.ok) {
        console.warn(`[city-suggest] Photon ${resp.status} for "${query}" in ${state}`);
        return res.json({ cities: [] });
      }
      const data = await resp.json() as {
        features?: Array<{
          properties?: {
            name?: string;
            country?: string;
            state?: string;
            osm_value?: string;
          };
        }>;
      };

      // Keep populated-place rows only. `osm_value` tells us what
      // kind of place each feature is — drop counties/airports/
      // schools/etc that bbox+osm_tag still let through.
      const PLACE_VALUES = new Set([
        "city", "town", "village", "hamlet", "municipality",
        "borough", "suburb", "locality", "neighbourhood",
      ]);
      const seen = new Set<string>();
      const cities: string[] = [];
      // Photon represents Hawaiian okina with the U+02BB modifier
      // letter ("Kapaʻa"), but the operator is going to type plain
      // ASCII ("kapaa"). Strip the okina (and any other diacritics)
      // for both the surface display and the dedupe key so both
      // forms map to the same suggestion.
      const stripOkina = (s: string) => s.replace(/[ʻʼ'']/g, "").normalize("NFD").replace(/[̀-ͯ]/g, "");
      for (const f of data.features ?? []) {
        const p = f.properties ?? {};
        if ((p.country ?? "") !== "United States") continue;
        if ((p.state ?? "").toLowerCase() !== state.toLowerCase()) continue;
        if (!PLACE_VALUES.has((p.osm_value ?? "").toLowerCase())) continue;
        const raw = (p.name ?? "").trim();
        if (!raw) continue;
        const display = stripOkina(raw);
        const key = display.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        cities.push(display);
        if (cities.length >= 10) break;
      }

      cityCache.set(cacheKey, { cities, ts: Date.now() });
      res.json({ cities });
    } catch (e: any) {
      console.warn(`[city-suggest] error for "${query}" in ${state}: ${e.message}`);
      res.json({ cities: [] });
    }
  });

  // ============================================================
  // Photo listing check (reverse image search across Airbnb/VRBO/Booking.com)
  // ============================================================

  const tryParseJson = (s: string): unknown => {
    try { return JSON.parse(s); } catch { return []; }
  };

  // GET /api/photo-listing-check
  // Returns the latest status row per folder. The dashboard aggregates
  // these by property (one property → many folders → worst status wins).
  app.get("/api/photo-listing-check", async (_req, res) => {
    try {
      const rows = await storage.getAllPhotoListingChecks();
      res.json({
        checks: rows.map((r) => ({
          folder: r.photoFolder,
          airbnbStatus:  r.airbnbStatus,
          vrboStatus:    r.vrboStatus,
          bookingStatus: r.bookingStatus,
          airbnbMatches:  r.airbnbMatches  ? tryParseJson(r.airbnbMatches)  : [],
          vrboMatches:    r.vrboMatches    ? tryParseJson(r.vrboMatches)    : [],
          bookingMatches: r.bookingMatches ? tryParseJson(r.bookingMatches) : [],
          photosChecked: r.photosChecked,
          checkedAt: r.checkedAt,
          errorMessage: r.errorMessage,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Failed to load photo-listing checks" });
    }
  });

  // GET /api/photo-listing-alerts?unacknowledged=1
  // Returns alert rows the scanner wrote when a platform status
  // worsened to "found". Dashboard shows a banner when unacknowledged
  // alerts exist; the operator dismisses each via the acknowledge
  // endpoint below.
  app.get("/api/photo-listing-alerts", async (req, res) => {
    try {
      const onlyUnacked = String(req.query.unacknowledged ?? "") === "1";
      const rows = onlyUnacked
        ? await storage.getUnacknowledgedPhotoListingAlerts()
        : await storage.getRecentPhotoListingAlerts(50);
      res.json({
        alerts: rows.map((r) => ({
          id: r.id,
          folder: r.photoFolder,
          platform: r.platform,
          priorStatus: r.priorStatus,
          newStatus: r.newStatus,
          matchedUrls: r.matchedUrls ? tryParseJson(r.matchedUrls) : [],
          detectedAt: r.detectedAt,
          acknowledgedAt: r.acknowledgedAt,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Failed to load alerts" });
    }
  });

  // POST /api/photo-listing-alerts/:id/acknowledge
  app.post("/api/photo-listing-alerts/:id/acknowledge", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    try {
      const row = await storage.acknowledgePhotoListingAlert(id);
      if (!row) return res.status(404).json({ error: "Alert not found" });
      res.json({ ok: true, alert: row });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Failed to acknowledge alert" });
    }
  });

  // POST /api/photo-listing-check/run
  // Manual "Run now". Body: { folders?: string[] }
  //   - folders omitted → scans every folder with labeled photos in DB
  //   - folders provided → scans exactly those
  // Runs asynchronously (kicks off, returns immediately with the list
  // it's scanning). The dashboard polls GET /api/photo-listing-check.
  app.post("/api/photo-listing-check/run", async (req, res) => {
    try {
      const requested = Array.isArray((req.body as any)?.folders) ? (req.body as any).folders as string[] : null;
      const known = await listScanableFolders();
      const folders = requested && requested.length > 0
        ? requested.filter((f) => known.includes(f))
        : known;
      if (folders.length === 0) {
        return res.status(400).json({ error: "No scanable folders found (no photo labels in DB)" });
      }
      // Fire-and-forget. Completes in the background; status polled via GET.
      void runPhotoListingCheckForFolders(folders);
      res.json({ started: true, folders });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Failed to start photo-listing scan" });
    }
  });


  // ============================================================
  // Step 3: Generate algorithm-based unit pairing suggestions for a community
  // ============================================================
  app.post("/api/community/search-units", async (req, res) => {
    const { communityName, city, state, unitTypes: rawUnitTypes } = req.body as {
      communityName: string; city: string; state: string; unitTypes?: string;
    };
    if (!communityName) return res.status(400).json({ error: "communityName required" });

    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    // ── 1. Find existing Airbnb/VRBO listings at this community ──────────────
    // Two passes:
    //   (a) Google site: searches — counts how many listings exist at this
    //       community at all (powers the "X listings found" telemetry).
    //       We do NOT scrape "$X/night" out of the snippets here; those
    //       numbers are dominated by Airbnb's "from $X/night" headlines for
    //       a 1-night quote, where the cleaning fee inflates the apparent
    //       nightly by ~50%.
    //   (b) SearchAPI airbnb engine — actual priced listings with a 7-night
    //       check_in/check_out window (the assumption being that a typical
    //       vacation-rental booking is a week, so cleaning + service fees
    //       should amortize over 7 nights, not 1). extracted_total_price
    //       includes nightly + cleaning + service, so total/7 is the proper
    //       amortized buy-in cost per night.
    const ratesByBR: Record<number, number[]> = {};
    let airbnbListingCount = 0;

    const listingCountQueries = [
      `"${communityName}" ${city} ${state} site:airbnb.com`,
      `"${communityName}" ${city} ${state} site:vrbo.com`,
    ];
    for (const q of listingCountQueries) {
      try {
        const resp = await fetch(
          `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(q)}&num=8&api_key=${searchApiKey}`,
        );
        if (!resp.ok) continue;
        const data = await resp.json() as any;
        const organic = (data.organic_results || []) as Array<{ link: string }>;
        for (const r of organic) {
          if (r.link?.includes("airbnb.com") || r.link?.includes("vrbo.com")) airbnbListingCount++;
        }
      } catch { /* non-fatal */ }
    }

    // Live priced lookup: a 7-night window 30 days out. We pick 30 days
    // ahead so the calendar is open (Airbnb often blocks last-minute on
    // popular listings) and far enough to dodge the next-7-days surge
    // pricing. The exact dates are arbitrary — the methodology is what
    // matters: total / 7 = amortized nightly inclusive of cleaning/svc.
    const now = new Date(); now.setUTCHours(0, 0, 0, 0);
    const checkInDate = new Date(now); checkInDate.setUTCDate(checkInDate.getUTCDate() + 30);
    const checkOutDate = new Date(checkInDate); checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 7);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    try {
      const sp: Record<string, string> = {
        engine: "airbnb",
        q: `${communityName} ${city} ${state}`,
        check_in_date: ymd(checkInDate),
        check_out_date: ymd(checkOutDate),
        adults: "2",
        type_of_place: "entire_home",
        currency: "USD",
        api_key: searchApiKey,
      };
      const resp = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`);
      if (resp.ok) {
        const data = await resp.json() as any;
        const properties: any[] = Array.isArray(data?.properties) ? data.properties : [];
        const cnameLower = communityName.toLowerCase();
        for (const p of properties) {
          const title = String(p?.name ?? p?.title ?? "");
          const desc = String(p?.description ?? "");
          // Engine bbox is generous — restrict to listings whose title or
          // description actually names this community.
          if (!title.toLowerCase().includes(cnameLower) && !desc.toLowerCase().includes(cnameLower)) continue;
          const total = Number(p?.price?.extracted_total_price);
          const br = typeof p?.bedrooms === "number" ? p.bedrooms : NaN;
          if (!Number.isFinite(total) || total <= 0) continue;
          if (!Number.isFinite(br) || br < 1 || br > 6) continue;
          const nightly = Math.round(total / 7);
          if (nightly < 50 || nightly > 3000) continue;
          if (!ratesByBR[br]) ratesByBR[br] = [];
          ratesByBR[br].push(nightly);
        }
      }
    } catch { /* fall through to per-BR default */ }

    // ── 2. Parse available unit types ─────────────────────────────────────────
    // From research step: e.g. "2BR, 3BR" or "3-bedroom, 2-bedroom"
    const parsedTypes = new Set<number>();
    if (rawUnitTypes) {
      const nums = rawUnitTypes.match(/(\d+)\s*(?:br|bed)/gi) || rawUnitTypes.match(/\d+/g) || [];
      for (const n of nums) {
        const br = parseInt(n);
        if (br >= 1 && br <= 6) parsedTypes.add(br);
      }
    }
    // Also add bedroom types found from Airbnb/VRBO search
    for (const br of Object.keys(ratesByBR)) parsedTypes.add(parseInt(br));
    // Default to 2BR + 3BR if nothing found (most common vacation rental config)
    if (parsedTypes.size === 0) { parsedTypes.add(2); parsedTypes.add(3); }

    const availableTypes = Array.from(parsedTypes).sort((a, b) => a - b);

    // ── 3. Calculate median rate per bedroom type ─────────────────────────────
    const medianRate = (arr: number[]) => {
      if (!arr?.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    // Estimate per-unit nightly rate for each BR type (if not found in search, use location-based estimate)
    const baseRatePerBR: Record<number, number> = {};
    const isHawaii = state === "Hawaii" || state === "HI";
    const isFlorida = state === "Florida" || state === "FL";
    const basePricePerBR = isHawaii ? 160 : isFlorida ? 120 : 100;
    for (const br of availableTypes) {
      const found = medianRate(ratesByBR[br]);
      baseRatePerBR[br] = found ?? (br * basePricePerBR);
    }

    // ── 4. Generate pairing combinations ─────────────────────────────────────
    const MARKUP = 1.38;
    type Pairing = {
      unit1Beds: number; unit2Beds: number; totalBeds: number;
      estimatedUnit1Rate: number; estimatedUnit2Rate: number;
      estimatedSellRate: number; estimatedSellRateHigh: number;
      rationale: string; isTopPick: boolean; matchScore: number;
    };
    const pairings: Pairing[] = [];

    // Generate all valid combinations (including same type twice)
    const typeArr = availableTypes;
    for (let i = 0; i < typeArr.length; i++) {
      for (let j = i; j < typeArr.length; j++) {
        const b1 = typeArr[i], b2 = typeArr[j];
        const total = b1 + b2;
        if (total < 3 || total > 10) continue;
        const r1 = baseRatePerBR[b1] ?? b1 * basePricePerBR;
        const r2 = baseRatePerBR[b2] ?? b2 * basePricePerBR;
        const buyCost = r1 + r2;
        const sellLow = Math.round(buyCost * MARKUP / 25) * 25;
        const sellHigh = Math.round(sellLow * 1.15 / 25) * 25;

        // Score: same-size units are best (guests get symmetric experience), larger is better for demand
        const matchScore = (b1 === b2 ? 2 : 0) + Math.min(total / 2, 3);
        const reasons: string[] = [];
        if (b1 === b2) reasons.push(`Matched unit sizes (${b1}BR + ${b2}BR) — symmetric guest experience`);
        else reasons.push(`Mixed sizes: ${b1}BR + ${b2}BR`);
        if (total >= 6) reasons.push("high-demand large group configuration");
        if (total >= 8) reasons.push("rare 8BR+ inventory");
        if (b1 === b2 && total >= 6) reasons.push("⭐ algorithm top pick");

        pairings.push({
          unit1Beds: b1, unit2Beds: b2, totalBeds: total,
          estimatedUnit1Rate: r1, estimatedUnit2Rate: r2,
          estimatedSellRate: sellLow, estimatedSellRateHigh: sellHigh,
          rationale: reasons.join(" · "),
          isTopPick: b1 === b2 && total >= 6,
          matchScore,
        });
      }
    }

    pairings.sort((a, b) => b.matchScore - a.matchScore);

    console.log(`[search-units] ${communityName}: ${availableTypes.join("BR, ")}BR available, ${pairings.length} pairings, ${airbnbListingCount} listings found`);

    res.json({
      communityProfile: {
        availableTypes,
        airbnbListingCount,
        ratesByBR: Object.fromEntries(
          Object.entries(ratesByBR).map(([k, v]) => [k, { median: medianRate(v), count: v.length }])
        ),
      },
      suggestedPairings: pairings,
      // backward compat
      units: [],
      grouped: {},
    });
  });

  // ============================================================
  // Step 5: Generate listing draft with Claude
  // ============================================================
  app.post("/api/community/generate-listing", async (req, res) => {
    const { communityName, city, state, unit1, unit2, suggestedRate } = req.body as {
      communityName: string;
      city: string;
      state: string;
      unit1: { bedrooms: number; url: string; description?: string; address?: string };
      unit2: { bedrooms: number; url: string; description?: string; address?: string };
      suggestedRate: number;
    };

    if (!communityName || !unit1 || !unit2) {
      return res.status(400).json({ error: "communityName, unit1, unit2 required" });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const combinedBedrooms = (unit1.bedrooms || 0) + (unit2.bedrooms || 0);

    // Best-effort walking distance for the description. Uses geocoded
    // addresses if both units provided one, else falls back to the
    // per-resort default.
    const walk = (unit1.address && unit2.address)
      ? await walkBetween(unit1.address, unit2.address, communityName).catch(() => fallbackWalkForResort(communityName))
      : fallbackWalkForResort(communityName);

    // The builder UI auto-prepends a soft "Please note: this listing
    // combines two units…" disclaimer (LISTING_DISCLOSURE in
    // unit-builder-data.ts) when assembling the summary it pushes to
    // Guesty. So this endpoint must NOT include any disclosure block
    // in the summary / space fields it returns — earlier prompt did,
    // and the result was Caribe Cove showing the disclaimer 3 times
    // (auto-prepend + Claude-written soft version in summary +
    // formal block embedded in space). Keep summary/space free of
    // disclaimer language; the auto-prepend handles it.

    // STR permit format suggestion based on city / state. Each
    // Hawaii county has its own license naming convention; we drop a
    // template the operator can fill in once they have the real
    // permit. Falls back to a generic placeholder for non-HI markets.
    const strPermitSample = (() => {
      const c = (city || "").toLowerCase();
      const s = (state || "").toLowerCase();
      if (s.includes("hawaii") || s === "hi") {
        // Maui County (Maui island)
        if (/(kihei|wailea|lahaina|kaanapali|kapalua|hana|paia|kahului|wailuku|makawao)/i.test(c)) {
          return "STRH-XXXXXXXX (sample — replace with real Maui County permit)";
        }
        // Hawaii County (Big Island)
        if (/(kona|kailua-kona|hilo|waimea|kohala|keauhou|waikoloa|volcano)/i.test(c)) {
          return "STVR-YYYY-XXXXXX (sample — replace with real Hawaii County permit)";
        }
        // Honolulu County (Oahu)
        if (/(honolulu|waikiki|kailua|haleiwa|aiea|pearl|ko olina|koolina|kaneohe|laie)/i.test(c)) {
          return "NUC-XX-XXX-XXXX (sample — replace with real Honolulu permit)";
        }
        // Kauai County — VDA zones (Poipu / Princeville) use TVR;
        // non-VDA / residential zones (Kekaha, Kapaa) use TVNC.
        if (/(poipu|princeville|koloa|kalaheo)/i.test(c)) {
          return "TVR-YYYY-XX (sample — replace with real Kauai VDA permit)";
        }
        if (/(kapaa|kekaha|lihue|wailua|hanalei|anini)/i.test(c)) {
          return "TVNC-XXXX (sample — replace with real Kauai TVNC permit)";
        }
        return "TVR-YYYY-XX or TVNC-XXXX (sample — confirm permit type with the right HI county)";
      }
      if (s.includes("florida") || s === "fl") {
        // Osceola County (Kissimmee, Davenport, Celebration, Poinciana)
        if (/(kissimmee|davenport|celebration|poinciana|st\.?\s*cloud)/i.test(c)) {
          return "LBTR-XXXXXX (sample — Osceola County Local Business Tax Receipt for STR)";
        }
        // Orange County (Orlando, Windermere, Lake Buena Vista)
        if (/(orlando|windermere|lake\s+buena\s+vista|ocoee|apopka)/i.test(c)) {
          return "LBTR-XXXXXX (sample — Orange County Local Business Tax Receipt for STR)";
        }
        // Polk County (Haines City, Davenport-adjacent)
        if (/(haines\s*city|lakeland|winter\s+haven|auburndale)/i.test(c)) {
          return "LBTR-XXXXXX (sample — Polk County Local Business Tax Receipt for STR)";
        }
        return "LBTR-XXXXXX (sample — confirm permit type with the right FL county tax collector)";
      }
      return "STR-XXXX (sample — replace with the actual short-term rental permit number for this county)";
    })();

    if (!anthropicKey) {
      const fallbackTitle = `${communityName} ${combinedBedrooms}BR for ${combinedBedrooms * 2}!`.slice(0, 50);
      const fallbackDescription = `Two condos at ${communityName} in ${city}, ${state}. Unit A is ${unit1.bedrooms}BR, Unit B is ${unit2.bedrooms}BR — ${combinedBedrooms}BR combined. ${walk.description} Guests receive separate access codes per unit at check-in.`;
      return res.json({
        title: fallbackTitle,
        bookingTitle: fallbackTitle,
        propertyType: "Condominium",
        description: fallbackDescription,
        summary: "",
        space: fallbackDescription,
        neighborhood: "",
        transit: "",
        unitA: null,
        unitB: null,
        combinedBedrooms,
        suggestedRate,
        walk,
        strPermitSample,
      });
    }

    // Structured-output prompt. Mirrors the fields the existing
    // Listing Builder's "Descriptions" tab pushes to Guesty (title,
    // summary, space, neighborhood, transit, …) plus the per-unit
    // metadata that Listing Builder's bedding/units tabs need
    // (bedrooms / bathrooms / sqft / sleeps / bedding text). Output
    // shape lines up with `unit-builder-data.ts` so this draft can
    // graduate into a real property entry without reformatting.
    const guestCapacity = combinedBedrooms * 2 + 2; // rough sleeps estimate
    const prompt = `Generate a structured vacation rental listing draft for a bundled multi-unit listing at ${communityName} in ${city}, ${state}.

CONTEXT
- Unit A: ${unit1.bedrooms}-bedroom unit at ${communityName}${unit1.url ? ` (source: ${unit1.url})` : ""}
- Unit B: ${unit2.bedrooms}-bedroom unit at ${communityName}${unit2.url ? ` (source: ${unit2.url})` : ""}
- Combined total: ${combinedBedrooms} bedrooms across two separate units
- Walking distance between units: ${walk.description} (${walk.minutes}-minute walk, source: ${walk.source})

OUTPUT — return ONLY valid JSON with this exact shape:

{
  "title": "Airbnb-style punchy headline, HARD CAP 50 chars (Airbnb truncates beyond that). Format: '<Adjective> <N>BR for <sleeps> <Location>!'. Examples: 'Beautiful 4BR for 10 in Caribe Cove!', 'Spacious 5 Bedroom Condo at Poipu Beach!', 'Gorgeous 6 br for 14 near Disney!'. Always end with !. Use only commas and hyphens for punctuation — Airbnb prefers them over em dashes (—). Count characters and STAY UNDER 50.",
  "bookingTitle": "Booking.com / VRBO style title, ALSO under 50 chars. Format: '<Community> - <N>BR <Type> - Sleeps <X>'. Examples: 'Caribe Cove - 4BR Condos - Sleeps 10', 'Poipu Kai - 7BR Resort - Sleeps 16', 'Princeville - 5BR Condos - Sleeps 14'. Use hyphens (not em dashes) as separators. STAY UNDER 50.",
  "propertyType": "One of: Condominium | Townhouse | House | Villa | Apartment | Estate | Cottage | Bungalow | Loft",
  "summary": "Single paragraph (2-3 sentences) — punchy hook leading with the strongest selling point (proximity, sleeps N, key amenity). Do NOT mention 'two separate units' or 'individually owned' or 'photos representative' here — a separate disclosure block is auto-prepended above this text.",
  "space": "1-2 paragraphs describing the combined property layout — bedroom count across both units, what guests get, why it works for a large group. Mention the units are ${walk.description.toLowerCase()} — use that exact phrasing, do not invent a different distance. Do NOT include any disclosure / 'two separate units' / 'individually owned' language; that block is added automatically.",
  "neighborhood": "1-2 paragraphs about the area immediately around ${communityName} in ${city}, ${state}. Local attractions, beaches, dining, vibe. Specific to this market.",
  "transit": "1 paragraph on getting around — distance to airport, rental car notes, rideshare availability, walkability.",
  "unitA": {
    "bedrooms": ${unit1.bedrooms},
    "bathrooms": "Estimated bathroom count for a ${unit1.bedrooms}BR vacation condo at this complex — return as a string like \\"2\\" or \\"2.5\\"",
    "sqft": "Estimated square footage range like \\"~1,200\\" or \\"~1,500\\"",
    "maxGuests": "Number — how many people can comfortably sleep here, sofa beds counted",
    "bedding": "Concrete bedding plan: e.g. \\"King master, Queen second bedroom, Twin third bedroom, queen sleeper sofa in living area\\". One sentence.",
    "shortDescription": "1 sentence describing this unit specifically — what stands out.",
    "longDescription": "2-3 paragraphs describing this unit in detail. Layout, beds, key amenities."
  },
  "unitB": {
    "bedrooms": ${unit2.bedrooms},
    "bathrooms": "...",
    "sqft": "...",
    "maxGuests": ...,
    "bedding": "...",
    "shortDescription": "...",
    "longDescription": "..."
  }
}

CONSTRAINTS
- title is HARD CAPPED at 50 characters. Count characters. If your draft hits 51+, shorten it.
- bookingTitle is ALSO HARD CAPPED at 50 characters. Same rule.
- Use commas and hyphens (-) only. NO em dashes (—) in either title.
- Be specific about ${city}, ${state} — real local landmarks, beaches, dining. No generic "tropical paradise" copy.
- Don't invent amenities you weren't told about. Describe in terms of what a typical condo at this kind of resort offers.
- summary and space must NOT contain the disclosure block; that's auto-prepended.
- Plain text only inside the strings. No Markdown. No bullet markers. No headers.
- Return ONLY the JSON object — no preamble, no commentary, no \`\`\` fences.`;

    try {
      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          // Sonnet 4.6 — handles this richer JSON-shape task with
          // long prose better than Haiku, and this endpoint runs
          // once per community (not in a hot loop). Previous ID
          // `claude-3-5-sonnet-20241022` is the legacy alias every
          // other endpoint had to migrate off of (PRs #97/98/99/103);
          // the same fix unblocks this endpoint too — without it
          // the catch block silently swallowed errors and Step 5
          // displayed the bare 2-line fallback Jamie was seeing.
          model: "claude-sonnet-4-6",
          max_tokens: 4000,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const claudeData = await claudeResp.json().catch(() => null) as any;

      if (!claudeResp.ok) {
        const upstreamMsg = claudeData?.error?.message ?? claudeData?.error?.type ?? `HTTP ${claudeResp.status}`;
        throw new Error(`Anthropic ${claudeResp.status}: ${upstreamMsg}`);
      }
      if (claudeData?.error) {
        throw new Error(`Anthropic error: ${claudeData.error.message ?? claudeData.error.type ?? "unknown"}`);
      }

      const text: string = claudeData?.content?.[0]?.text ?? "";
      // Tolerate ```json fences — Sonnet sometimes wraps despite
      // the no-Markdown instruction. Strip them before regex-matching.
      const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error(`[community/generate-listing] No JSON in Claude response. Head: ${text.slice(0, 200)}`);
        throw new Error("No JSON in Claude response");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Compose the flat description (used by the Description
      // textarea on Step 5 and stored in `listingDescription`) by
      // gluing the structured fields in reading order. The Step 5
      // form ALSO surfaces each field individually below so the
      // operator can edit them per-section, but the flat one stays
      // so the existing `Save → CommunityDraft` path keeps working
      // unchanged.
      const description = [
        parsed.summary?.trim(),
        parsed.space?.trim(),
        parsed.neighborhood ? `THE NEIGHBORHOOD\n\n${parsed.neighborhood.trim()}` : null,
        parsed.transit ? `GETTING AROUND\n\n${parsed.transit.trim()}` : null,
      ].filter(Boolean).join("\n\n");

      return res.json({
        // Airbnb truncates titles past 50 chars. Booking.com / VRBO
        // tolerate longer but active properties keep both under 50
        // anyway, since the same title is pushed to all channels via
        // bookingTitle. Hard-cap both at 50 so a Claude overshoot
        // doesn't silently push a truncated headline downstream —
        // operator can edit on Step 5.
        title: String(parsed.title ?? "").slice(0, 50),
        bookingTitle: String(parsed.bookingTitle ?? parsed.title ?? "").slice(0, 50),
        propertyType: parsed.propertyType ?? "Condominium",
        description,
        summary: parsed.summary ?? "",
        space: parsed.space ?? "",
        neighborhood: parsed.neighborhood ?? "",
        transit: parsed.transit ?? "",
        unitA: parsed.unitA ?? null,
        unitB: parsed.unitB ?? null,
        combinedBedrooms,
        suggestedRate,
        walk,
        strPermitSample,
      });
    } catch (e: any) {
      console.warn("[community/generate-listing] Claude error:", e.message);
      const fallbackTitle = `${communityName} — ${combinedBedrooms}BR Combined | ${city}, ${state}`.slice(0, 80);
      const fallbackDescription = `${DISCLOSURE}\n\nThis listing combines two units at ${communityName} in ${city}, ${state}. ${walk.description}`;
      return res.json({
        title: fallbackTitle,
        bookingTitle: fallbackTitle,
        propertyType: "Condominium",
        description: fallbackDescription,
        summary: "",
        space: fallbackDescription,
        neighborhood: "",
        transit: "",
        unitA: null,
        unitB: null,
        combinedBedrooms,
        suggestedRate,
        walk,
        strPermitSample,
        warning: `AI draft generation failed (${e.message}). Edit the fields below directly.`,
      });
    }
  });

  // ========== INBOX — Auto-Approve ==========

  app.get("/api/inbox/auto-approve/status", (_req, res) => {
    res.json(getAutoApproveStatus());
  });

  app.post("/api/inbox/auto-approve/toggle", (req, res) => {
    const { enabled } = req.body as { enabled: boolean };
    setAutoApproveEnabled(!!enabled);
    res.json(getAutoApproveStatus());
  });

  app.post("/api/inbox/auto-approve/run", async (_req, res) => {
    try {
      const result = await runAutoApprove();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: "Auto-approve run failed", message: err.message });
    }
  });

  // ========== INBOX — Auto-Reply Agent ==========

  app.get("/api/inbox/auto-reply/status", (_req, res) => {
    res.json(getAutoReplyStatus());
  });

  app.post("/api/inbox/auto-reply/toggle", (req, res) => {
    const { enabled } = req.body as { enabled: boolean };
    setAutoReplyEnabled(!!enabled);
    res.json(getAutoReplyStatus());
  });

  app.post("/api/inbox/auto-reply/run", async (_req, res) => {
    try {
      const result = await runAutoReply();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: "Auto-reply run failed", message: err.message });
    }
  });

  // ── Booking-confirmation auto-send ──
  // Status / toggle / manual-run endpoints. Mirrors the auto-reply
  // shape so the inbox UI can reuse the same patterns. The scheduler
  // runs every 5 minutes from server/index.ts; "run now" lets the
  // operator force a tick (useful right after a fresh deploy or to
  // confirm a recent booking gets greeted without waiting).
  app.get("/api/inbox/booking-confirmations/status", (_req, res) => {
    res.json(getBookingConfirmationStatus());
  });

  app.post("/api/inbox/booking-confirmations/toggle", (req, res) => {
    const { enabled } = req.body as { enabled: boolean };
    setBookingConfirmationEnabled(!!enabled);
    res.json(getBookingConfirmationStatus());
  });

  app.post("/api/inbox/booking-confirmations/run", async (_req, res) => {
    try {
      const result = await runBookingConfirmations();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: "Booking-confirmation run failed", message: err.message });
    }
  });

  app.get("/api/inbox/booking-confirmations/logs", async (req, res) => {
    try {
      const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 200);
      const logs = await storage.getRecentBookingConfirmations(limit);
      res.json(logs);
    } catch (err: any) {
      // Fail-soft on missing table (Postgres 42P01) — keeps the
      // dashboard usable until `npm run db:push` runs on Railway.
      const missingTable = /42P01|does not exist|relation .* does not exist/i.test(err.message || "");
      console.error(`[booking-confirmations/logs] ${missingTable ? "table missing — returning []" : err.message}`);
      res.json([]);
    }
  });

  app.get("/api/inbox/auto-reply/logs", async (req, res) => {
    try {
      const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 200);
      const logs = await storage.getAutoReplyLogs(limit);
      res.json(logs);
    } catch (err: any) {
      // Fail-soft: if the table doesn't exist yet (Postgres 42P01) or any other
      // storage error, return an empty array so the inbox page still renders.
      // The real fix is running `npm run db:push` on Railway to create the table.
      const missingTable = /42P01|does not exist|relation .* does not exist/i.test(err.message || "");
      console.error(`[auto-reply/logs] ${missingTable ? "table missing — returning []" : err.message}`);
      res.json([]);
    }
  });

  app.post("/api/inbox/auto-reply/logs/:id/send", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await sendDraftedReply(id);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to send draft", message: err.message });
    }
  });

  app.post("/api/inbox/auto-reply/logs/:id/dismiss", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await dismissReply(id);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to dismiss", message: err.message });
    }
  });

  // ========== INBOX — Airbnb Pre-Approval / Decline / Special Offer ==========
  //
  // Guesty surfaces Airbnb-specific inquiry actions via several paths; their
  // schema has drifted across API versions so we try known-good URLs in order
  // until one works. This lets the host pre-approve an Airbnb inquiry directly
  // from the inbox without clicking over to Guesty's UI.
  //
  // POST /api/inbox/reservations/:reservationId/airbnb/preapprove
  //      body: {} (nothing required)
  // POST /api/inbox/reservations/:reservationId/airbnb/decline
  //      body: { reason?: string, message?: string }
  // POST /api/inbox/reservations/:reservationId/airbnb/special-offer
  //      body: { price: number, message?: string, expirationDays?: number }

  async function callGuestyAirbnbAction(
    reservationId: string,
    action: "preapprove" | "decline" | "special-offer",
    body: Record<string, unknown> = {},
  ): Promise<{ success: true; via: string; data: any } | { success: false; error: string; attempts: Array<{ path: string; method: string; status?: number; error: string }> }> {
    // Diagnostic on reservation 69e6…1d8c revealed a `preApproveState: false`
    // field and no POST action endpoints. Guesty tracks pre-approval as a
    // writable flag on the reservation document — PUT to update.
    // We keep the POST variants as fallbacks in case any account exposes them.
    //
    // Also added: `/reservations/{id}/preapprove` and PATCH variants that
    // some community threads mention work on specific Guesty tenants.
    const candidates: Record<typeof action, Array<{ method: "POST" | "PUT" | "PATCH"; path: string; body?: Record<string, unknown> }>> = {
      preapprove: [
        // Primary: update the preApproveState field directly
        { method: "PUT",   path: `/reservations/${reservationId}`, body: { preApproveState: true } },
        { method: "PATCH", path: `/reservations/${reservationId}`, body: { preApproveState: true } },
        // Bare verb endpoints reported by some tenants
        { method: "POST",  path: `/reservations/${reservationId}/preapprove` },
        { method: "POST",  path: `/reservations/${reservationId}/pre-approve` },
        // Status-transition pattern
        { method: "PUT",   path: `/reservations/${reservationId}`, body: { status: "preApproved" } },
        // Channel-prefixed fallbacks (already known-404 on your tenant but kept
        // so another account's response doesn't regress)
        { method: "POST",  path: `/airbnb2/reservations/${reservationId}/preapprove` },
        { method: "POST",  path: `/airbnb/reservations/${reservationId}/preapprove` },
      ],
      decline: [
        { method: "PUT",   path: `/reservations/${reservationId}`, body: { status: "declined" } },
        { method: "POST",  path: `/reservations/${reservationId}/decline` },
        { method: "POST",  path: `/airbnb2/reservations/${reservationId}/decline` },
        { method: "POST",  path: `/airbnb/reservations/${reservationId}/decline` },
      ],
      "special-offer": [
        { method: "POST",  path: `/reservations/${reservationId}/special-offer` },
        { method: "POST",  path: `/airbnb2/reservations/${reservationId}/special-offer` },
        { method: "POST",  path: `/airbnb/reservations/${reservationId}/special-offer` },
      ],
    };

    const attempts: Array<{ path: string; method: string; status?: number; error: string }> = [];
    let lastError = "";

    // Expected state-change per action — we check this via GET afterward to
    // confirm Guesty actually applied the change (some endpoints return 200
    // but ignore the field). For special-offer we have no reliable field to
    // verify; null tells the loop below to skip the verify step entirely.
    const verifyExpectations: Record<typeof action, ((r: any) => boolean) | null> = {
      preapprove: (r) => r?.preApproveState === true || r?.status === "preApproved" || r?.status === "accepted",
      decline:    (r) => r?.status === "declined" || r?.status === "canceled",
      "special-offer": null,
    };

    // Verify with up to N attempts, 1s apart, to absorb Guesty's
    // write-then-read consistency lag. Most successful writes show up
    // on the very next GET, but the airbnb2 channel sync can take a
    // beat — without retries we'd reject a real success as no-op and
    // fall through to a fallback URL that "200s" without doing anything.
    const VERIFY_TRIES = 3;
    const VERIFY_DELAY_MS = 1000;
    const verify = verifyExpectations[action];

    for (const c of candidates[action]) {
      try {
        const data = await guestyRequest(c.method, c.path, c.body ?? body);

        // Verify EVERY successful candidate, not just PUT/PATCH. Earlier
        // versions only verified PUT/PATCH to /reservations/{id}, so a
        // POST /reservations/{id}/preapprove that returned 200 — but
        // didn't actually flip preApproveState — propagated as
        // success. The client then optimistically lit the green
        // banner, refetched from Guesty, saw preApproveState still
        // false, and reverted the UI ("button doesn't stick"). The
        // verify-everything pass below is the contract: we only tell
        // the client "success" when we can confirm Guesty actually
        // applied the state change.
        if (verify) {
          let confirmed = false;
          let lastFetched: any = null;
          for (let i = 0; i < VERIFY_TRIES; i++) {
            try {
              lastFetched = await guestyRequest("GET", `/reservations/${reservationId}`) as any;
              if (verify(lastFetched)) { confirmed = true; break; }
            } catch {
              // GET errored — wait and retry; final attempt falls through to no-op
            }
            if (i < VERIFY_TRIES - 1) await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
          }

          if (!confirmed) {
            attempts.push({
              path: c.path,
              method: c.method,
              status: 200,
              error: `${c.method} returned 200 but state did not change after ${VERIFY_TRIES} verify attempts (preApproveState=${lastFetched?.preApproveState}, status=${lastFetched?.status})`,
            });
            console.warn(`[airbnb-action] ${action} via ${c.method} ${c.path} 200 but no-op (verified ${VERIFY_TRIES}x)`);
            continue;
          }
        }

        console.log(`[airbnb-action] ${action} via ${c.method} ${c.path} OK`);
        return { success: true, via: `${c.method} ${c.path}`, data };
      } catch (err: any) {
        lastError = err.message ?? String(err);
        const m = /Guesty\s+(\d{3})/.exec(lastError);
        const status = m ? parseInt(m[1], 10) : undefined;
        attempts.push({ path: c.path, method: c.method, status, error: lastError });
        console.warn(`[airbnb-action] ${action} via ${c.method} ${c.path} failed (${status ?? "?"}): ${lastError}`);
      }
    }

    return { success: false, error: lastError || "No Guesty endpoint accepted the request", attempts };
  }

  // Diagnostic — returns the full Guesty reservation object so we can inspect
  // what actions/URLs/state it exposes. Helpful for figuring out what endpoint
  // pre-approval lives at for a given Guesty account.
  app.get("/api/inbox/reservations/:reservationId/debug", async (req, res) => {
    try {
      const reservation = await guestyRequest("GET", `/reservations/${req.params.reservationId}`) as any;
      return res.json({
        keys: reservation && typeof reservation === "object" ? Object.keys(reservation) : [],
        reservation,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/inbox/reservations/:reservationId/airbnb/preapprove", async (req, res) => {
    const reservationId = req.params.reservationId;
    if (!reservationId) return res.status(400).json({ error: "reservationId required" });
    const result = await callGuestyAirbnbAction(reservationId, "preapprove");
    if (!result.success) return res.status(502).json(result);
    return res.json(result);
  });

  app.post("/api/inbox/reservations/:reservationId/airbnb/decline", async (req, res) => {
    const reservationId = req.params.reservationId;
    if (!reservationId) return res.status(400).json({ error: "reservationId required" });
    const { reason, message } = req.body as { reason?: string; message?: string };
    const result = await callGuestyAirbnbAction(reservationId, "decline", {
      ...(reason ? { reason } : {}),
      ...(message ? { message } : {}),
    });
    if (!result.success) return res.status(502).json(result);
    return res.json(result);
  });

  app.post("/api/inbox/reservations/:reservationId/airbnb/special-offer", async (req, res) => {
    const reservationId = req.params.reservationId;
    if (!reservationId) return res.status(400).json({ error: "reservationId required" });
    const { price, message, expirationDays } = req.body as {
      price?: number; message?: string; expirationDays?: number;
    };
    if (!price || typeof price !== "number" || price <= 0) {
      return res.status(400).json({ error: "price (number > 0) required" });
    }
    const result = await callGuestyAirbnbAction(reservationId, "special-offer", {
      price,
      ...(message ? { message } : {}),
      ...(expirationDays ? { expirationDays } : {}),
    });
    if (!result.success) return res.status(502).json(result);
    return res.json(result);
  });

  // ========== INBOX — Message Templates ==========

  app.get("/api/inbox/templates", async (_req, res) => {
    try {
      const templates = await storage.getMessageTemplates();
      res.json(templates);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch templates", message: err.message });
    }
  });

  app.post("/api/inbox/templates", async (req, res) => {
    try {
      const parsed = insertMessageTemplateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
      const template = await storage.createMessageTemplate(parsed.data);
      res.status(201).json(template);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to create template", message: err.message });
    }
  });

  app.put("/api/inbox/templates/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const template = await storage.updateMessageTemplate(id, req.body);
      if (!template) return res.status(404).json({ error: "Template not found" });
      res.json(template);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to update template", message: err.message });
    }
  });

  app.delete("/api/inbox/templates/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const ok = await storage.deleteMessageTemplate(id);
      if (!ok) return res.status(404).json({ error: "Template not found" });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to delete template", message: err.message });
    }
  });

  // ========== INBOX — AI Draft Reply ==========

  app.post("/api/inbox/ai-draft", async (req, res) => {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(503).json({ error: "AI drafting unavailable (no ANTHROPIC_API_KEY configured)" });

    const { guestMessage, propertyName, guestName, checkIn, checkOut, guestsCount, propertyContext, isHawaii, channel } = req.body as {
      guestMessage: string;
      propertyName?: string;
      guestName?: string;
      checkIn?: string;
      checkOut?: string;
      // Number of guests the booking already specifies (Airbnb date
      // picker, VRBO inquiry, etc.). Optional — only set when the
      // conversation has a reservation attached. The AI uses this to
      // stop asking "how many guests are joining you?" on inquiries
      // that already answer it.
      guestsCount?: number | null;
      // Structured property facts built by the client (inbox.tsx
      // `buildPropertyContextForDraft`). When present, the AI answers
      // from these facts instead of hand-waving. Optional — generic
      // prompt still works for conversations whose listing isn't
      // mapped to a NexStay property.
      propertyContext?: string | null;
      // Client detects HI/Hawaii in the property address. When true,
      // the system prompt picks up a Hawaiian-tone variant (Aloha /
      // mahalo / 'ohana sprinkled in naturally). Non-HI properties
      // stay on the standard friendly+professional voice — avoids
      // bleeding the Hawaii voice onto future mainland listings.
      isHawaii?: boolean;
      // Booking platform the conversation is on (airbnb / vrbo /
      // booking / direct / email / …). Used to make the payment-
      // timing policy reply name the right platform when a guest
      // asks about smaller deposits or paying later. Optional; an
      // empty string falls back to a generic "the booking platform"
      // phrasing.
      channel?: string;
    };

    if (!guestMessage) return res.status(400).json({ error: "guestMessage is required" });

    // Friendly platform name for the payment-timing policy. Guesty
    // uses raw keys like "airbnb2" / "homeaway2" / "bookingCom" — map
    // them to what guests actually see on their reservation.
    const platformName = (() => {
      const c = (channel || "").toLowerCase();
      if (c.includes("airbnb")) return "Airbnb";
      if (c.includes("vrbo") || c.includes("homeaway")) return "VRBO";
      if (c.includes("booking")) return "Booking.com";
      return "the booking platform";
    })();

    // Tone preamble — prepended to whichever grounded/ungrounded
    // system prompt we pick below. Hawaiian tone: warm, familiar,
    // uses a handful of Hawaiian words (Aloha, mahalo, 'ohana,
    // makai/mauka when geographically relevant) but doesn't
    // over-season — sounds like a local host, not a tourist brochure.
    // Standard tone: friendly + professional, no Hawaiian vocabulary.
    //
    // Signature block — same name + company in both variants; only
    // the sign-off word swaps. Hawaii listings close with "Mahalo,"
    // (the Hawaiian word for thank you) instead of "Thank You,",
    // which also avoids two "thank you"s in the same message when the
    // body already thanks the guest.
    const SIGNATURE = isHawaii
      ? `Mahalo,
John Carpenter
Magical Island Rentals`
      : `Thank You,
John Carpenter
Magical Island Rentals`;

    const PLAIN_TEXT_RULES = `FORMATTING RULES (strict — these replies go into email and OTA messaging channels that render plain text):
  - Plain text only. Do NOT use Markdown of any kind — no asterisks for bold or italics, no underscores, no backticks, no bullet markers like "*" or "-" at line starts, no headings.
  - If you need a list, write it as short sentences or a comma-separated line, not as bullets.
  - No em-dashes-with-asterisks or decorative characters. Natural prose.
  - End every reply with exactly this three-line signature (no extra punctuation around it):
${SIGNATURE}`;

    // Human-voice guide. Same warmth and professionalism as before —
    // this just steers the model away from the AI-tells that make
    // drafts read as obviously chatbot-written. Show-don't-tell
    // examples land harder with Haiku than rule lists alone, so we
    // pair the principles with two before/after pairs the model can
    // pattern-match against.
    const HUMAN_VOICE_RULES = `HUMAN VOICE (sound like a real host who just read the message, not a chatbot):
  - Lead with the answer. Skip warm-up phrases — no "I hope this message finds you well", "I'd be happy to help", "What a great question!", "Thank you so much for reaching out!". Guests want their answer, not a preamble.
  - Use contractions: we're, you'll, that's, here's, don't. "We are" reads stiff in a guest message; "we're" reads natural.
  - Vary sentence length. Short sentences for emphasis. Longer ones with a comma or two when there's actual flow. Don't make every sentence the same shape.
  - Skip restating what the guest asked. They wrote it ten seconds ago; they remember.
  - Avoid the AI-stock-phrase tells: "absolutely!", "certainly!", "kindly", "rest assured", "please be advised", "in regards to", "going forward", "at your earliest convenience". Real hosts don't talk that way.
  - Don't end with a sales-y closer like "Looking forward to hosting you!" or "Can't wait to welcome you!" — the signature already closes the message.
  - One small aside or parenthetical is fine when it adds warmth. Use it sparingly — at most once per reply.

Examples (same content, different voice):
  ROBOTIC:  "Thank you so much for your message! I'd be delighted to help with your question. Regarding parking, I can confirm that yes, parking is available for both units at no additional cost."
  HUMAN:    "Yes — parking is included for both units, right next to the building."

  ROBOTIC:  "What a wonderful question! Our two units are situated approximately 3 minutes by foot from each other within the resort grounds."
  HUMAN:    "The two units are about a 3-minute walk apart, easy to move between."`;

    const tonePreamble = isHawaii
      ? `You are writing as a host for Magical Island Rentals in Hawaii. Tone is warm, personable, and professional — the way a longtime local host greets guests. Sprinkle in authentic Hawaiian words naturally where they fit (do not force them into every sentence):
  - Open with "Aloha [Name]," or a similar welcoming phrase
  - Use "'ohana" (family/group) when referring to the guest's party, if natural
  - Use "makai" (toward the ocean) / "mauka" (toward the mountains) only if geographically relevant to the answer
  - Do NOT use "mahalo" in the body — the signature already closes with "Mahalo,", and doubling it up reads as forced. If you need to thank the guest inside the message, use natural English ("Thanks for reaching out", "Appreciate the question", etc.).

Avoid over-using Hawaiian words — one or two per reply max. The goal is authentic local warmth, not a caricature. Write in natural American English for the rest of the message.

${HUMAN_VOICE_RULES}

${PLAIN_TEXT_RULES}`
      : `You are writing as a host for Magical Island Rentals. Tone is warm, personable, and professional.

${HUMAN_VOICE_RULES}

${PLAIN_TEXT_RULES}`;

    // System prompt tells the model HOW to behave. Adjusted to make it
    // ground answers in the provided facts when we have them, and say
    // "let me confirm and follow up" rather than inventing details when
    // a question falls outside the context block.
    const groundingPrompt = propertyContext
      ? `You will be given structured facts about the property (unit breakdown, per-unit layout descriptions, distance between units, parking, amenities, property type). USE THESE FACTS to answer specific questions accurately:
- Per-unit bedroom AND bathroom counts
- Bed types in each bedroom — King, Queen, Twin, sleeper sofa, etc. (the per-unit layout text spells this out)
- Distance between units (in minutes / steps)
- Property type — Townhouse means multi-story with internal stairs; Condominium means single-floor unit. This is critical when guests ask about accessibility, ground-floor sleeping, seniors, mobility, or stairs.
- Parking, pool, AC, kitchen, beach proximity

ANSWER EVERY QUESTION the guest asks. If they ask 4 separate things, address all 4 — don't skip any and don't end with "what other questions can I answer?" instead of answering the ones already on the screen.

If the guest asks something that isn't covered by the provided facts (e.g. they ask if there's a ground-floor bedroom and the layout text doesn't mention it), acknowledge the question and say you'll confirm and follow up — never invent details.

Never mention that units are "combined" or that this is a portfolio listing. Treat each listing as a single property with multiple units.`
      : `Never mention that units are "combined" or that this is a portfolio listing.`;

    // Policies the AI must apply when the guest's message asks about
    // them. Phrased as rules so Haiku follows them literally:
    //
    //   1. Discount asks: cap any offer at 5% off. The AI is allowed
    //      to OFFER the discount in the draft (saves the host a
    //      back-and-forth) but never above 5% — no creative "let me
    //      see if I can do 10%" hedging. Frame it as a one-time
    //      accommodation, not a standing policy, so we're not
    //      anchoring future guests.
    //
    //   2. Payment-timing asks (smaller deposit, pay later, custom
    //      payment plan): we cannot change the schedule. The booking
    //      platform — Airbnb, VRBO, Booking.com — controls when the
    //      guest pays and how it's split. Apologize briefly and
    //      explain the platform sets it. NAME the platform if we
    //      know it (passed in via `channel`); fall back to "the
    //      booking platform" otherwise. Do NOT promise to ask the
    //      platform on the guest's behalf — that's not a thing.
    //
    // Not all guest messages will trigger these. The AI should only
    // apply a policy when the guest's message actually asks about
    // discounts or payment timing. Don't pre-emptively volunteer them.
    const policyPrompt = `POLICIES (apply only when the guest's message asks about them):

DISCOUNTS: If the guest asks for a discount, special rate, or to lower the price, you may offer up to (and no more than) 5% off the listing price. Do not offer 10% or any larger discount under any circumstance. State the percentage clearly in the draft and frame it as a one-time accommodation for them, not a standing offer. If they ask for more than 5%, politely explain that 5% is the most you can offer.

PAYMENT TIMING: If the guest asks for a smaller deposit, to pay later, to split payments differently, or any change to the payment schedule, explain that ${platformName} controls the payment schedule for this booking and we are not able to adjust it on our end. Apologize briefly that this isn't something you can change. Do not offer to "ask ${platformName}" or "look into it" — there is no workaround on our side. Keep the explanation short and warm; don't dwell on it.`;

    const systemPrompt = `${tonePreamble}\n\n${groundingPrompt}\n\n${policyPrompt}`;

    const contextBlock = propertyContext ? `PROPERTY FACTS (ground your answer in these — don't invent beyond them):
${propertyContext}

` : "";

    // Compute nights when both dates exist, so the AI can quote it
    // back if relevant. Pure presentational — no business logic.
    const nights = (checkIn && checkOut)
      ? (() => {
          const d1 = new Date(checkIn).getTime();
          const d2 = new Date(checkOut).getTime();
          if (!Number.isFinite(d1) || !Number.isFinite(d2)) return null;
          const n = Math.round((d2 - d1) / 86_400_000);
          return n > 0 ? n : null;
        })()
      : null;

    // Stitch the booking facts the conversation already has — dates,
    // nights, guest count — into a clearly-labeled "ALREADY KNOWN"
    // block so the AI stops asking for them. Earlier prompt only
    // listed checkIn / checkOut as-is; the model was treating them as
    // "FYI" rather than "this is settled, don't ask". Section header
    // makes the rule explicit.
    const knownLines: string[] = [];
    if (checkIn)        knownLines.push(`- Check-in: ${checkIn}`);
    if (checkOut)       knownLines.push(`- Check-out: ${checkOut}`);
    if (nights)         knownLines.push(`- Nights: ${nights}`);
    if (typeof guestsCount === "number" && guestsCount > 0) {
      knownLines.push(`- Guests on the inquiry: ${guestsCount}`);
    }
    const knownBlock = knownLines.length > 0
      ? `ALREADY KNOWN ABOUT THIS BOOKING (do NOT ask the guest for these — they're already attached to the inquiry):\n${knownLines.join("\n")}\n\n`
      : "";

    // Detect accessibility / floor-plan / mobility concerns in the
    // guest's message. When present, a HARD "must address" instruction
    // gets prepended to the reply rules — Haiku tends to mention bed
    // counts but skip the "stairs?" / "ground floor?" / "seniors"
    // ask unless explicitly required to.
    const ACCESSIBILITY_CUES = /\b(downstair|down\s*stair|ground\s*floor|first\s*floor|main\s*floor|stairs?\b|stair[-\s]?free|elevator|wheelchair|mobility|accessib|senior|elderly|grand(?:parent|ma|pa|mother|father)|cane|walker|knee|hip|surgery|disabilit|step[-\s]?free|single[-\s]?level|one[-\s]?(?:floor|level))\b/i;
    const accessibilityRaised = ACCESSIBILITY_CUES.test(guestMessage);
    const accessibilityMandate = accessibilityRaised
      ? `🚨 ACCESSIBILITY / FLOOR-PLAN ASK — TOP PRIORITY 🚨
The guest's message contains an accessibility, ground-floor, stairs, mobility, or seniors concern. Your reply MUST include a sentence that directly addresses it. The reply will be considered INCOMPLETE if it doesn't contain at least one of these words: "stairs", "floor", "level", "ground", "multi-story", "single-level". Do not skip this. Do not bury it. Write it as its own paragraph or sentence near the end of the body, before the sign-off.

Source priority for the answer (use the FIRST one that applies):

1. If the property facts include a FLOOR PLAN / ACCESSIBILITY block, paraphrase it accurately. That note is authoritative — it captures complex-specific variation (e.g. mix of single-level and multi-level units) the propertyType alone doesn't.

   COMMITMENT — when the FLOOR PLAN / ACCESSIBILITY block says we WILL accommodate by assigning a specific unit type (single-level / ground-floor / Moana plan / etc.), state the commitment FIRMLY in the reply: "We'll ensure the units assigned for your stay are [unit-type the note names]" — NOT softer hedges like "we'll prioritize", "we'll try", "we'll confirm before check-in", or "we'll do our best." The operator already authorized the commitment in the note — pass it through as a firm guarantee. Do NOT invent commitments the note doesn't support.

   TRANSITION TONE — open the accessibility paragraph with a warm, conversational acknowledgment, NOT a clinical or commanding one. Pattern to follow: "Since you mentioned [the specific concern from the guest's message — seniors, mobility, ground-floor preference, etc.] and that you'd prefer [their stated need], here's the good news: ..." Avoid stiff openers like "Here's what matters", "You need", "You have", "Let me address", "Regarding your concern". The "good news" framing fits because we CAN actually accommodate — lead with that warmth, then deliver the firm commitment.

2. Otherwise, fall back to the propertyType:
   - Townhouse → tell the guest the units are multi-story townhomes with internal stairs. If you don't know which floor the masters are on: "we'd confirm the assigned unit's floor plan before booking" — never guess. (This soft-hedge phrasing is ONLY for the no-FLOOR-PLAN-block fallback.)
   - Condominium → confirm units are single-floor (no internal stairs).
   - Other / unknown → say "we'd confirm the specific unit's floor plan before booking."

Do not roll it into a generic "let me know if you have questions" closer.

`
      : "";

    const userPrompt = `${accessibilityMandate}${contextBlock}${knownBlock}Guest name: ${guestName || "Guest"}
Property: ${propertyName || "our property"}

Guest message:
"${guestMessage}"

Write a helpful, polite, BRIEF reply. Polite but to the point. NO conversational fluff.

Structure:
1. A one-line greeting ("Aloha [Name],"). Nothing more — do NOT add "Thanks for reaching out!", "We're excited to host you", "We're thrilled to have you", or any variation. Skip it.
2. Lead straight into answering the guest's questions in the order they asked. One sentence per question when possible.
3. Sign off with the canonical signature block (Mahalo, / John Carpenter / Magical Island Rentals).

Hard rules — every one of these has been a real failure mode:
- Do NOT restate the booking dates ("you've got two beautiful townhomes reserved from December 27th through January 1st"). The guest sent the inquiry; they know their dates.
- Do NOT restate the guest count or party composition. They wrote it; they know it.
- Do NOT add filler — "plenty of space", "perfect for your group", "a great fit", "spacious", "beautiful", "lovely". These add words without adding facts.
- Do NOT use transition phrases like "Here's what you're working with:", "Let me break this down for you:", "Here's the rundown:". Just answer.
- Do NOT end with "If you have any specific questions…", "Is there anything else…", "Feel free to reach out", "Don't hesitate to ask", "Looking forward to hosting you". Stop after the last answer.

Length target: 3-7 sentences of body text (excluding greeting + signature). Multi-part questions can go to 6-9 sentences ONLY IF every sentence is answering a distinct question. If you find yourself padding, cut.

Be specific. Quote concrete bed types, room counts, and distances from the property facts — never paraphrase as "comfortable bedrooms" or "a short walk" if the facts give exact details.

Do NOT ask for facts already shown in the ALREADY KNOWN block (dates, nights, guest count) or already in the guest's own message. If you DO need a clarifying detail (exact arrival time, specific accessibility need), ask for that ONE thing in one sentence — don't blanket re-ask.

Do not include a subject line.`;

    try {
      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          // Haiku 4.5 is plenty for a warm 3-4 sentence reply — fast,
          // cheap, and never rate-limits in our throughput envelope.
          // Previous ID `claude-3-5-sonnet-20241022` was a legacy alias
          // that Anthropic occasionally returned errors for; swap to
          // the current Haiku family so drafts reliably generate.
          model: "claude-haiku-4-5-20251001",
          max_tokens: 700,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      // Old code trusted the body parse without checking status or
      // Anthropic's error envelope — any non-200 or error response
      // silently produced `{draft: ""}`, which hit the client's
      // "AI draft unavailable" toast with NO description. Propagate
      // the real reason so operators can see (key invalid, model
      // deprecated, rate limit, etc.) instead of a blank toast.
      const claudeData = await claudeResp.json().catch(() => null) as any;

      // Return 200 with an `error` field (and empty `draft`) on upstream
      // failures so the client's existing `if (data.draft) ... else
      // toast(..., description: data.error)` flow surfaces the actual
      // reason. apiRequest throws on non-2xx which would swallow the
      // error detail behind a generic "Draft failed: 502: {...}" string.

      if (!claudeResp.ok) {
        const upstreamMsg =
          claudeData?.error?.message ??
          claudeData?.error?.type ??
          `HTTP ${claudeResp.status}`;
        console.error(`[ai-draft] Anthropic ${claudeResp.status}: ${upstreamMsg}`);
        return res.json({ draft: "", error: `Anthropic error: ${upstreamMsg}` });
      }

      if (claudeData?.error) {
        const upstreamMsg = claudeData.error.message ?? claudeData.error.type ?? "unknown";
        console.error(`[ai-draft] Anthropic error envelope: ${upstreamMsg}`);
        return res.json({ draft: "", error: `Anthropic error: ${upstreamMsg}` });
      }

      const rawDraft: string = claudeData?.content?.[0]?.text ?? "";
      if (!rawDraft.trim()) {
        console.error(`[ai-draft] Empty draft from Anthropic — raw response:`, JSON.stringify(claudeData).slice(0, 500));
        return res.json({ draft: "", error: "Anthropic returned an empty response" });
      }

      // Defensive Markdown strip. The system prompt tells the model to
      // return plain text, but Haiku occasionally emits **bold** or
      // bullet "*" prefixes out of habit. The messaging channels we
      // pipe into (Airbnb / VRBO / Booking.com / email) don't render
      // Markdown — asterisks show up literally. Strip them so the
      // draft is clean in the textarea before the host reviews.
      //
      //   1. **bold** / *italic* → inner text only
      //   2. `code` → inner text only
      //   3. "- " or "* " at line starts → stripped bullet prefix
      const draftMarkdownClean = rawDraft
        .replace(/\*\*([^\n*]+?)\*\*/g, "$1")   // **bold** → bold
        .replace(/\*([^\n*]+?)\*/g, "$1")       // *italic* → italic
        .replace(/`([^\n`]+?)`/g, "$1")         // `code` → code
        .replace(/^[ \t]*[*\-•][ \t]+/gm, "")   // bullet line prefixes
        .trim();
      // Humanize: strip the AI tells the prompt can't reliably suppress
      // (em-dashes, "I'm thrilled to help", "Is there anything specific
      // before you book?", etc.). See server/humanize-reply.ts for rules.
      const humanized = humanizeReply(draftMarkdownClean);

      // Deterministic accessibility safety net: when the guest's message
      // raised an accessibility / floor-plan / seniors concern but the
      // AI's reply doesn't include any accessibility-related word
      // ("stairs", "floor", "level", "ground", "multi-story",
      // "single-level", "elevator"), inject a fallback sentence drawn
      // from the property's FLOOR PLAN / ACCESSIBILITY block (or from
      // the propertyType when no block is set). Keeps Haiku honest
      // when it ignores the MANDATORY prompt instruction — the prompt
      // is the soft path, this is the hard guarantee.
      const draft = (() => {
        if (!accessibilityRaised) return humanized;
        const REPLY_HAS_ACCESS_KEYWORD = /\b(stairs?|floor|level|ground|multi-story|multistory|single-level|elevator|stair[-\s]?free)\b/i;
        if (REPLY_HAS_ACCESS_KEYWORD.test(humanized)) return humanized;

        // Build a fallback sentence. Prefer the property's
        // accessibilityNote (passed in propertyContext as
        // "FLOOR PLAN / ACCESSIBILITY: …"); else propertyType-derived.
        let fallback: string;
        const noteMatch = (propertyContext ?? "").match(/FLOOR PLAN \/ ACCESSIBILITY:\s*([^]+?)(?=\n\n|\n[A-Z][A-Z ]+:|$)/);
        if (noteMatch) {
          // Use the operator-authored note verbatim. It's already
          // phrased with the right tone + commitment language. The
          // prefix mirrors the warm "here's the good news" pattern
          // the prompt asks Haiku to use, so even the deterministic
          // fallback doesn't read clinically.
          fallback = `Since you mentioned wanting ground-floor units for the seniors in your group, here's the good news: ${noteMatch[1].trim()}`;
        } else {
          const typeMatch = (propertyContext ?? "").match(/Property type:\s*(\w+)/);
          const propType = typeMatch?.[1];
          if (propType === "Townhouse") {
            fallback = "On the seniors / downstairs question — these units are multi-story townhomes with internal stairs. We'd confirm the assigned unit's floor plan before booking, especially for guests with mobility concerns.";
          } else if (propType === "Condominium") {
            fallback = "On the floor-plan question — these are single-floor condo units with no internal stairs. Building-level access varies (stairs vs. elevator), and we can confirm specifics for the assigned unit before booking.";
          } else {
            fallback = "On the floor-plan question — we'd confirm the specific unit's accessibility before booking.";
          }
        }

        // Insert before the signature block so the sign-off stays at
        // the bottom. Falls back to appending when no signature is
        // detected (rare; humanizeReply normally re-attaches one).
        const sigMatch = humanized.match(/\n\s*(Mahalo|Thank You|Thanks|Best|Regards|Sincerely|Aloha)\s*,\s*\n/i);
        if (sigMatch && sigMatch.index !== undefined) {
          return `${humanized.slice(0, sigMatch.index).trimEnd()}\n\n${fallback}${humanized.slice(sigMatch.index)}`;
        }
        return `${humanized.trimEnd()}\n\n${fallback}`;
      })();

      res.json({ draft });
    } catch (err: any) {
      console.error(`[ai-draft] exception: ${err.message}`);
      res.status(500).json({ error: "AI draft failed", message: err.message });
    }
  });

  return httpServer;
}
