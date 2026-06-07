// Community knowledge export — feeds the Quo (formerly OpenPhone) Sona AI
// voice agent's knowledge base.
//
// WHY THIS EXISTS
// ---------------
// Quo's public REST API only exposes messaging / contacts / calls / webhooks —
// there is NO endpoint for the Sona AI agent's knowledge base. Sona is trained
// in the Quo UI three ways: (1) point it at a website URL it crawls, (2) upload
// documents, or (3) paste manual "knowledge pages" (20,000-char cap each). This
// module is how we feed Sona "everything we know about our communities" without
// a Quo knowledge API:
//   - it COMPILES one guest-safe knowledge document per community from the same
//     data the rest of the portal uses (unit-builder-data + the curated,
//     fact-checked community blurbs), and
//   - it RENDERS that document as both Markdown (for upload/paste) and clean,
//     crawlable HTML (so the operator can hand Quo a public URL and let Sona
//     re-crawl on edits).
// The public HTML pages live under /community-info/* (see the route + the
// matching PUBLIC_PATH allowlist entry in server/auth.ts).
//
// GUEST-COPY SAFETY (load-bearing — mirrors the /alternatives guest page stack)
// ----------------------------------------------------------------------------
// These pages are PUBLIC and crawled by a third party, so they carry ONLY
// guest-facing facts. Deliberately EXCLUDED, do NOT add:
//   - Compliance / licensing numbers (taxMapKey / TMK, tatLicense, getLicense,
//     strPermit, dbprLicense, touristTaxAccount). TMK in particular is treated
//     as contact-like info (AGENTS.md Load-Bearing #20) and must never leak.
//   - Buy-in cost basis / margins (shared/pricing-rates BUY_IN_RATES) and any
//     internal nightly rate. A phone AI quoting a stale wholesale number is a
//     real hazard — pricing stays a human/transfer task on purpose.
//   - Exact unit / building numbers (we run a representative-accommodations
//     model — the curated blurbs and disclosures already omit them).
//   - Owner names or any operator-internal identifiers.
// The community overview prose comes from CURATED_COMMUNITY_DESCRIPTIONS, which
// is already adversarially fact-checked to never claim an amenity a community
// lacks — that property is exactly what we want a voice agent repeating.

import {
  unitBuilderData,
  REPRESENTATIVE_ACCOMMODATIONS_DISCLOSURE,
  type PropertyUnitBuilder,
  type Unit,
} from "../client/src/data/unit-builder-data";
import { resolveCuratedCommunityDescription } from "./community-descriptions";

export type CommunityUnitType = {
  bedrooms: number;
  bathrooms: string;
  sqft: string;
  maxGuests: number;
  /** Richest available description for this bedroom count (already OTA-published copy). */
  longDescription: string;
};

export type CommunityKnowledge = {
  slug: string;
  name: string;
  /** Resort-level street/city/state (building + unit tokens stripped). */
  location: string;
  city: string;
  state: string;
  propertyType: string;
  /** Curated, fact-checked guest-facing blurb. */
  overview: string;
  neighborhood?: string;
  transit?: string;
  /** One representative unit per distinct bedroom count, largest first. */
  unitTypes: CommunityUnitType[];
  bedroomCounts: number[];
  /** Largest single combined listing (sum of its units' bedrooms / guests). */
  maxCombinedBedrooms: number;
  maxCombinedGuests: number;
  listingCount: number;
  unitAssignmentPolicy: string;
};

const MAX_KNOWLEDGE_DOC_CHARS = 20000; // Quo Sona knowledge-page hard limit.
// Leave headroom under the cap so the "(trimmed)" note + Markdown scaffolding
// never push a generated page over Quo's limit.
const SAFE_DOC_CHARS = 19000;

export function slugifyCommunity(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Drop building / unit / apartment tokens from a stored address so the public
// page shows the RESORT's location, never a specific owned unit.
function cleanResortLocation(address: string): string {
  const parts = String(address ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^(bldg|building|unit|apt|apartment|#|ste|suite)\b/i.test(p));
  return parts.join(", ");
}

function cityStateFromLocation(location: string): { city: string; state: string } {
  const parts = location.split(",").map((p) => p.trim()).filter(Boolean);
  // Typical tail: ["<street>", "Koloa", "HI 96756"]
  const tail = parts[parts.length - 1] ?? "";
  const stateMatch = tail.match(/\b([A-Z]{2})\b/);
  const state = stateMatch ? stateMatch[1] : "";
  const city = parts.length >= 2 ? parts[parts.length - 2] : "";
  return { city, state };
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const t = (v ?? "").trim();
    if (t) return t;
  }
  return undefined;
}

function representativeUnitTypes(units: Unit[]): CommunityUnitType[] {
  const byBedrooms = new Map<number, CommunityUnitType>();
  for (const u of units) {
    const beds = Number(u.bedrooms) || 0;
    const candidate: CommunityUnitType = {
      bedrooms: beds,
      bathrooms: u.bathrooms,
      sqft: u.sqft,
      maxGuests: Number(u.maxGuests) || 0,
      longDescription: (u.longDescription ?? u.shortDescription ?? "").trim(),
    };
    const existing = byBedrooms.get(beds);
    // Keep the richest (longest) description as the representative for this size.
    if (!existing || candidate.longDescription.length > existing.longDescription.length) {
      byBedrooms.set(beds, candidate);
    }
  }
  return Array.from(byBedrooms.values()).sort((a, b) => b.bedrooms - a.bedrooms);
}

/**
 * Aggregate the portal's per-listing unit-builder data into one knowledge
 * record per community (keyed by complexName), deduping unit types and pulling
 * the curated, fact-checked overview blurb.
 */
export function buildCommunityKnowledge(): CommunityKnowledge[] {
  const groups = new Map<string, PropertyUnitBuilder[]>();
  for (const p of unitBuilderData) {
    const key = (p.complexName ?? "").trim();
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }

  const records: CommunityKnowledge[] = [];
  for (const [name, listings] of Array.from(groups.entries())) {
    const location = cleanResortLocation(listings[0]?.address ?? "");
    const { city, state } = cityStateFromLocation(location);
    const allUnits: Unit[] = listings.flatMap((l: PropertyUnitBuilder) => l.units ?? []);
    const unitTypes = representativeUnitTypes(allUnits);

    // Largest single combined listing — what a big group can book at once.
    let maxCombinedBedrooms = 0;
    let maxCombinedGuests = 0;
    for (const l of listings) {
      const beds = (l.units ?? []).reduce((s: number, u: Unit) => s + (Number(u.bedrooms) || 0), 0);
      const guests = (l.units ?? []).reduce((s: number, u: Unit) => s + (Number(u.maxGuests) || 0), 0);
      if (beds > maxCombinedBedrooms) maxCombinedBedrooms = beds;
      if (guests > maxCombinedGuests) maxCombinedGuests = guests;
    }

    const overview =
      resolveCuratedCommunityDescription(name) ??
      // Fallback: first paragraph of an existing published combined description.
      firstNonEmpty(listings.map((l: PropertyUnitBuilder) => (l.combinedDescription ?? "").split("\n\n")[0])) ??
      "";

    records.push({
      slug: slugifyCommunity(name),
      name,
      location,
      city,
      state,
      propertyType: listings[0]?.propertyType ?? "Condominium",
      overview,
      neighborhood: firstNonEmpty(listings.map((l) => l.neighborhood)),
      transit: firstNonEmpty(listings.map((l) => l.transit)),
      unitTypes,
      bedroomCounts: unitTypes.map((u) => u.bedrooms),
      maxCombinedBedrooms,
      maxCombinedGuests,
      listingCount: listings.length,
      unitAssignmentPolicy: REPRESENTATIVE_ACCOMMODATIONS_DISCLOSURE,
    });
  }

  return records.sort((a, b) => a.name.localeCompare(b.name));
}

export function getCommunityKnowledgeBySlug(slug: string): CommunityKnowledge | undefined {
  const want = slugifyCommunity(slug);
  return buildCommunityKnowledge().find((r) => r.slug === want);
}

// ── Renderers ───────────────────────────────────────────────────────────────

function accommodationLine(u: CommunityUnitType): string {
  const bits = [
    `${u.bedrooms}-bedroom`,
    u.bathrooms ? `${u.bathrooms}-bath` : "",
    u.sqft ? `approx. ${u.sqft.replace(/^~\s*/, "")} sq ft` : "",
    u.maxGuests ? `sleeps up to ${u.maxGuests}` : "",
  ].filter(Boolean);
  return bits.join(", ");
}

/** Markdown knowledge page for one community — ready to paste/upload into Sona. */
export function renderCommunityMarkdown(rec: CommunityKnowledge): string {
  const lines: string[] = [];
  lines.push(`# ${rec.name}`);
  lines.push("");
  if (rec.location) lines.push(`**Location:** ${rec.location}`);
  if (rec.propertyType) lines.push(`**Property type:** ${rec.propertyType}`);
  lines.push("");

  if (rec.overview) {
    lines.push(`## Overview`);
    lines.push(rec.overview);
    lines.push("");
  }

  if (rec.unitTypes.length) {
    lines.push(`## Accommodations we offer`);
    for (const u of rec.unitTypes) {
      lines.push(`- ${accommodationLine(u)}`);
    }
    if (rec.maxCombinedBedrooms > rec.bedroomCounts[0]) {
      lines.push(
        `- For larger groups we can combine units within the community for up to ${rec.maxCombinedBedrooms} bedrooms` +
          (rec.maxCombinedGuests ? ` (sleeping up to ${rec.maxCombinedGuests} guests)` : "") +
          `.`,
      );
    }
    lines.push("");
  }

  if (rec.neighborhood) {
    lines.push(`## The neighborhood & nearby attractions`);
    lines.push(rec.neighborhood);
    lines.push("");
  }

  if (rec.transit) {
    lines.push(`## Getting around`);
    lines.push(rec.transit);
    lines.push("");
  }

  if (rec.unitTypes.length) {
    lines.push(`## What a typical unit is like`);
    for (const u of rec.unitTypes) {
      if (!u.longDescription) continue;
      lines.push(`### Typical ${u.bedrooms}-bedroom unit`);
      lines.push(u.longDescription);
      lines.push("");
    }
  }

  lines.push(`## Unit assignment`);
  lines.push(rec.unitAssignmentPolicy);
  lines.push("");

  let doc = lines.join("\n").trim() + "\n";
  if (doc.length > MAX_KNOWLEDGE_DOC_CHARS) {
    doc = doc.slice(0, SAFE_DOC_CHARS).trimEnd() + "\n\n_(Content trimmed to fit the knowledge-page limit.)_\n";
  }
  return doc;
}

/** Combined Markdown bundle of every community (one document per section). */
export function renderAllCommunitiesMarkdown(records: CommunityKnowledge[] = buildCommunityKnowledge()): string {
  const header = [
    `# Community knowledge base`,
    "",
    `These are the vacation-rental communities we manage. Each section below can ` +
      `also be loaded as its own Quo Sona knowledge page.`,
    "",
    `---`,
    "",
  ].join("\n");
  // Per-community docs already cap themselves; the combined file is for download
  // only (not pasted as a single Sona page), so no global cap is applied.
  return header + records.map((r) => renderCommunityMarkdown(r)).join("\n---\n\n");
}

const esc = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

const PAGE_CSS = `
  :root { color-scheme: light; }
  body { font-family: Georgia, "Times New Roman", serif; max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; color: #1f2937; line-height: 1.6; background: #fff; }
  header { border-bottom: 2px solid #e5e7eb; margin-bottom: 24px; padding-bottom: 12px; }
  h1 { font-size: 28px; margin: 0 0 6px; color: #0f172a; }
  h2 { font-size: 20px; margin: 28px 0 8px; color: #0f172a; }
  h3 { font-size: 16px; margin: 18px 0 4px; color: #334155; }
  .meta { font-size: 14px; color: #475569; margin: 2px 0; }
  ul { padding-left: 20px; }
  li { margin: 4px 0; }
  a { color: #2563eb; }
  .policy { font-size: 14px; color: #475569; background: #f8fafc; border-left: 3px solid #cbd5e1; padding: 10px 14px; }
  nav a { display: block; padding: 6px 0; }
`;

function htmlShell(title: string, description: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index, follow">
<style>${PAGE_CSS}</style>
</head><body>
${body}
</body></html>`;
}

/** Clean, crawlable HTML page for one community (Quo can ingest the URL). */
export function renderCommunityKnowledgeHtml(rec: CommunityKnowledge): string {
  const parts: string[] = [];
  parts.push(`<header><h1>${esc(rec.name)}</h1>`);
  if (rec.location) parts.push(`<p class="meta">Location: ${esc(rec.location)}</p>`);
  if (rec.propertyType) parts.push(`<p class="meta">Property type: ${esc(rec.propertyType)}</p>`);
  parts.push(`</header>`);

  if (rec.overview) {
    parts.push(`<h2>Overview</h2>${paragraphs(rec.overview)}`);
  }

  if (rec.unitTypes.length) {
    parts.push(`<h2>Accommodations we offer</h2><ul>`);
    for (const u of rec.unitTypes) parts.push(`<li>${esc(accommodationLine(u))}</li>`);
    if (rec.maxCombinedBedrooms > (rec.bedroomCounts[0] ?? 0)) {
      const guests = rec.maxCombinedGuests ? ` (sleeping up to ${rec.maxCombinedGuests} guests)` : "";
      parts.push(
        `<li>For larger groups we can combine units within the community for up to ${rec.maxCombinedBedrooms} bedrooms${esc(guests)}.</li>`,
      );
    }
    parts.push(`</ul>`);
  }

  if (rec.neighborhood) {
    parts.push(`<h2>The neighborhood &amp; nearby attractions</h2>${paragraphs(rec.neighborhood)}`);
  }
  if (rec.transit) {
    parts.push(`<h2>Getting around</h2>${paragraphs(rec.transit)}`);
  }

  if (rec.unitTypes.some((u) => u.longDescription)) {
    parts.push(`<h2>What a typical unit is like</h2>`);
    for (const u of rec.unitTypes) {
      if (!u.longDescription) continue;
      parts.push(`<h3>Typical ${u.bedrooms}-bedroom unit</h3>${paragraphs(u.longDescription)}`);
    }
  }

  parts.push(`<h2>Unit assignment</h2><p class="policy">${esc(rec.unitAssignmentPolicy)}</p>`);

  const desc = rec.overview ? rec.overview.slice(0, 200) : `${rec.name} — ${rec.location}`;
  return htmlShell(`${rec.name} — Community guide`, desc, parts.join("\n"));
}

/** Index page linking every community page — a single crawl entry point for Quo. */
export function renderCommunityKnowledgeIndexHtml(records: CommunityKnowledge[] = buildCommunityKnowledge()): string {
  const items = records
    .map(
      (r) =>
        `<li><a href="/community-info/${esc(r.slug)}">${esc(r.name)}</a>` +
        (r.location ? ` — <span class="meta">${esc(r.location)}</span>` : "") +
        `</li>`,
    )
    .join("\n");
  const body = `<header><h1>Community guides</h1>
<p class="meta">Reference information on the vacation-rental communities we manage.</p></header>
<nav><ul>${items}</ul></nav>`;
  return htmlShell(
    "Community guides",
    "Reference information on the vacation-rental communities we manage.",
    body,
  );
}
