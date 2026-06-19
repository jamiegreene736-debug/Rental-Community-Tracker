import { useEffect, useMemo, useState } from "react";
import { fallbackWalkForResort, type WalkResult } from "@shared/walking-distance";
import { orderGallery } from "@shared/photo-order";
import { useParams, useLocation } from "wouter";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import GuestyListingBuilder from "@/components/GuestyListingBuilder";
import {
  getUnitBuilderByPropertyId,
  LISTING_DISCLOSURE,
  REPRESENTATIVE_ACCOMMODATIONS_DISCLOSURE,
  SINGLE_LISTING_SAMPLE_DISCLOSURE,
  type PropertyUnitBuilder,
} from "@/data/unit-builder-data";
import { getPropertyPricing, type PropertyPricing } from "@/data/pricing-data";
import { getGuestyAmenities } from "@/data/guesty-amenities";
import { buildListingRooms, parseSqft } from "@/data/guesty-listing-config";
import { occupancyForBedrooms } from "@/data/bedding-config";
import { usePhotoLabels } from "@/hooks/use-photo-labels";
import { loadDraftFullDataByNegativeId } from "@/data/adapt-draft";
import type { GuestyPropertyData } from "@/services/guestyService";
import { replacementPhotoFolderForUnit } from "@shared/unit-swap-photos";

type BuilderUnitSwap = {
  oldUnitId: string;
  newUnitLabel: string;
  newAddress: string;
  newBedrooms?: number | null;
  newSourceUrl: string;
  committed?: boolean;
  photoFolder?: string;
};

const SUMMARY_SEPARATOR = "\n\n---\n\n";
const COMBO_TOP_DISCLOSURE = LISTING_DISCLOSURE.replace(/\s*---\s*$/i, "").trim();
function isComboUnitDisclosure(text: string): boolean {
  return /combines\s+two\s+units\s+within\s+the\s+same\s+community/i.test(text);
}

function isRepresentativePhotoDisclosure(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("photos are representative")
    || lower.includes("sample unit")
    || lower.includes("representative accommodations")
    || lower.includes("unit assignment note")
    || lower.includes("specific unit assigned")
    || lower.includes("specific accommodation");
}

function stripDisclosureParagraphs(text: string): string {
  return String(text ?? "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .filter((paragraph) => !/^-{3,}$/.test(paragraph))
    .filter((paragraph) => !isComboUnitDisclosure(paragraph))
    .filter((paragraph) => !isRepresentativePhotoDisclosure(paragraph))
    .join("\n\n")
    .replace(/^(?:\s*-{3,}\s*)+/, "")
    .trim();
}

function buildGuestySummary(property: PropertyUnitBuilder, units: PropertyUnitBuilder["units"]): string {
  const body = stripDisclosureParagraphs(property.combinedDescription);
  const isSingle = units.length === 1;
  const bottomDisclosure = isSingle
    ? SINGLE_LISTING_SAMPLE_DISCLOSURE
    : REPRESENTATIVE_ACCOMMODATIONS_DISCLOSURE;

  return [
    !isSingle ? COMBO_TOP_DISCLOSURE : "",
    body,
    bottomDisclosure,
  ].filter(Boolean).join(SUMMARY_SEPARATOR);
}

// ─── Parse "City, ST ZIPCODE" from address string ─────────────────────────────
function parseAddress(addr: string) {
  const parts = addr.split(",").map((s) => s.trim());
  const full = addr;
  let city = "";
  let state = "";
  let zipcode = "";

  if (parts.length >= 3) {
    const last = parts[parts.length - 1];
    const stateZip = last.split(" ").filter(Boolean);
    if (stateZip.length >= 2) {
      state = stateZip[0];
      zipcode = stateZip[1];
    } else if (stateZip.length === 1) {
      state = stateZip[0];
    }
    city = parts[parts.length - 2].replace(/^(bldg|unit|apt|#)\s*\d+/i, "").trim() || parts[parts.length - 2];
  } else if (parts.length === 2) {
    city = parts[0];
    state = parts[1];
  }

  return { full, city, state, zipcode, country: "US" };
}

function captionFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/^\d+[-_]/, "");
  if (!stem) return "Photo";
  return stem
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Builder page ─────────────────────────────────────────────────────────────
export default function Builder() {
  const { propertyId: pidStr } = useParams<{ propertyId: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const propertyId = parseInt(pidStr ?? "0", 10);
  const staticProperty = getUnitBuilderByPropertyId(propertyId);

  // Promoted-draft fallback: when the static lookup misses AND id is
  // negative (the synthetic -draftId convention from the dashboard),
  // fetch /api/community/drafts and adapt the matching draft into the
  // PropertyUnitBuilder shape + draft-derived pricing + bedding
  // defaults. Mirrors the pattern in builder-preflight.tsx so "Continue
  // to Builder" doesn't dead-end on "Property #-N not found".
  const [draftProperty, setDraftProperty] = useState<PropertyUnitBuilder | null>(null);
  const [draftPricing, setDraftPricing] = useState<PropertyPricing | null>(null);
  const [draftLoading, setDraftLoading] = useState<boolean>(!staticProperty && propertyId < 0);
  useEffect(() => {
    if (staticProperty || propertyId >= 0) return;
    setDraftLoading(true);
    loadDraftFullDataByNegativeId(propertyId)
      .then((data) => {
        if (data) {
          setDraftProperty(data.property);
          setDraftPricing(data.pricing);
        }
      })
      .catch(() => { /* leave draftProperty null → renders the not-found state */ })
      .finally(() => setDraftLoading(false));
  }, [propertyId, staticProperty]);
  const baseProperty = staticProperty ?? draftProperty;
  const [unitSwaps, setUnitSwaps] = useState<Record<string, BuilderUnitSwap>>({});
  useEffect(() => {
    if (!baseProperty || !Number.isFinite(propertyId)) {
      setUnitSwaps({});
      return;
    }

    let cancelled = false;
    fetch(`/api/unit-swaps/${propertyId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { swaps?: BuilderUnitSwap[] } | null) => {
        if (cancelled) return;
        const next: Record<string, BuilderUnitSwap> = {};
        for (const swap of data?.swaps ?? []) {
          if (!swap?.oldUnitId || swap.committed === false) continue;
          if (next[swap.oldUnitId]) continue;
          next[swap.oldUnitId] = swap;
        }
        setUnitSwaps(next);
      })
      .catch(() => {
        if (!cancelled) setUnitSwaps({});
      });
    return () => { cancelled = true; };
  }, [baseProperty, propertyId]);

  const property = useMemo<PropertyUnitBuilder | null>(() => {
    if (!baseProperty) return null;
    if (!Object.keys(unitSwaps).length) return baseProperty;

    return {
      ...baseProperty,
      units: baseProperty.units.map((unit) => {
        const swap = unitSwaps[unit.id];
        if (!swap) return unit;
        const unitNumber = swap.newUnitLabel.replace(/^Unit\s*#?/i, "").trim() || unit.unitNumber;
        return {
          ...unit,
          unitNumber,
          bedrooms: swap.newBedrooms ?? unit.bedrooms,
          photoFolder: swap.photoFolder ?? replacementPhotoFolderForUnit(propertyId, unit.id),
          photos: [],
        };
      }),
    };
  }, [baseProperty, propertyId, unitSwaps]);

  // For active properties, pricing comes from the static
  // PROPERTY_UNIT_CONFIGS-based generator. For promoted drafts, the
  // 24-month schedule is generated from the draft's pricingArea (or
  // estimatedLowRate fallback) so the Pricing tab renders something
  // editable instead of being blank. The Pricing tab inside
  // GuestyListingBuilder additionally hydrates a per-(property,
  // bedrooms) live-buy-in cache and re-derives the seasonal rates
  // from it — so the value here is the day-zero render, and live
  // medians take over once the fetch lands. See `marketRatesVersion`
  // inside the component.
  const pricing = staticProperty
    ? getPropertyPricing(propertyId)
    : draftPricing;

  // Pull Claude-generated labels for every photo folder we'll render.
  // Override the static unit-builder-data.ts labels with these when present;
  // fall back to the static label so empty DB doesn't blank out the UI.
  const allFolders = useMemo<string[]>(() => {
    if (!property) return [];
    const folders = new Set<string>();
    if (property.communityPhotoFolder) folders.add(property.communityPhotoFolder);
    for (const u of property.units) if (u.photoFolder) folders.add(u.photoFolder);
    return Array.from(folders);
  }, [property]);
  const { labelFor, isHidden, categoryFor, sortOrderFor, refresh: refreshPhotoLabels } = usePhotoLabels(allFolders);

  // Walking-distance between units. Only meaningful for multi-unit
  // properties. Uses the shared fallback (per-resort minute defaults)
  // until the geocoded result from /api/tools/walk-between arrives —
  // so the description renders something reasonable immediately.
  const [walkResult, setWalkResult] = useState<WalkResult | null>(null);
  useEffect(() => {
    if (!property || property.units.length < 2) { setWalkResult(null); return; }
    // Immediate fallback so the UI has a sensible default before the
    // geocoder resolves.
    setWalkResult(fallbackWalkForResort(property.complexName));
    // Upgrade to the geocoded value if we can. All units share the
    // property.address today, so send the same address twice — the
    // endpoint will fall back to the resort-default-minutes path.
    // When per-unit addresses exist (e.g. from swaps), swap them in.
    const addrA = property.address;
    const addrB = property.address;
    if (addrA === addrB) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/tools/walk-between?a=${encodeURIComponent(addrA)}&b=${encodeURIComponent(addrB)}&resort=${encodeURIComponent(property.complexName)}`,
        );
        if (!r.ok) return;
        const data = await r.json() as WalkResult;
        if (!cancelled) setWalkResult(data);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [property]);

  // Fetch the actual file list for each unit/community folder instead of
  // relying on the hardcoded u.photos array. This is what makes rescraped
  // photos (from the Apify swap path) show up — the static array only ever
  // had 8 filenames, so a 30-photo rescrape was invisible to the builder.
  const [folderFiles, setFolderFiles] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, string[]> = {};
      await Promise.all(allFolders.map(async (f) => {
        try {
          const r = await fetch(`/api/photos/community/${encodeURIComponent(f)}`);
          if (!r.ok) return;
          const data = await r.json() as Array<{ filename: string }>;
          if (Array.isArray(data)) out[f] = data.map((d) => d.filename);
        } catch {}
      }));
      if (!cancelled) setFolderFiles(out);
    })();
    return () => { cancelled = true; };
  }, [allFolders]);

  // Fetch the source URL (Zillow / Airbnb / VRBO) stamped into each
  // folder's _source.json by the last rescrape. PhotoCurator renders a
  // "View source listing" link per section so the user can cross-check
  // the photo set against the upstream page directly.
  const [sourceUrlsByFolder, setSourceUrlsByFolder] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, string> = {};
      await Promise.all(allFolders.map(async (f) => {
        try {
          const r = await fetch(`/api/builder/photo-source/${encodeURIComponent(f)}`);
          if (!r.ok) return;
          const data = await r.json() as { source?: { sourceListing?: { url?: string } } | null };
          const url = data?.source?.sourceListing?.url;
          if (url) out[f] = url;
        } catch {}
      }));
      if (!cancelled) setSourceUrlsByFolder(out);
    })();
    return () => { cancelled = true; };
  }, [allFolders]);

  const propertyData = useMemo<GuestyPropertyData | null>(() => {
    if (!property) return null;

    const units = Array.isArray(property.units) ? property.units : [];
    const communityPhotos = Array.isArray(property.communityPhotos) ? property.communityPhotos : [];
    const getLabel = typeof labelFor === "function" ? labelFor : (() => null);
    const hidden = typeof isHidden === "function" ? isHidden : (() => false);

    const totalGuests = units.reduce((s, u) => s + (Number(u.maxGuests) || 0), 0);
    const totalSqft = units.reduce((s, u) => s + parseSqft(String(u.sqft ?? "")), 0);
    const totalBedrooms = units.reduce((s, u) => s + (Number(u.bedrooms) || 0), 0);
    const totalBathrooms = units.reduce((s, u) => s + (parseFloat(String(u.bathrooms ?? "")) || 0), 0);
    const listingRooms = buildListingRooms(propertyId);

    const basePrice = pricing?.totalBaseSellRate ?? 0;

    const guestyAmenities = getGuestyAmenities(propertyId);

    const origin = typeof window !== "undefined" ? window.location.origin : "";
    // Static-label lookup: fall back to hardcoded captions only for photos
    // that were in the original static list. New rescraped photos rely on
    // Claude labels via labelFor().
    const staticLabelFor = (folder: string, filename: string): string | undefined => {
      const inCommunity = communityPhotos.find((p) => p.filename === filename && folder === property.communityPhotoFolder);
      if (inCommunity) return inCommunity.label;
      for (const u of units) {
        if (u.photoFolder !== folder) continue;
        const unitPhotos = Array.isArray(u.photos) ? u.photos : [];
        const hit = unitPhotos.find((p) => p.filename === filename);
        if (hit) return hit.label;
      }
      return undefined;
    };

    // Assemble the push/display photo order the operator asked for
    // (2026-06-19): cover collage (pushed separately as the Guesty cover) →
    // Unit A → Unit B → … → Community. WITHIN each gallery the photos default
    // to a hero-first order (living / view / kitchen → bedrooms → baths → …
    // for a unit; pool / beach / exterior → grounds → amenities → … for the
    // community) and the operator can drag to reorder on the Photos tab — a
    // manual order (photo_labels.sort_order) wins over the heuristic. The
    // grouping (units-then-community) intentionally replaces the older
    // community-opener / between-units interleave. See shared/photo-order.ts.
    const getCategory = typeof categoryFor === "function" ? categoryFor : (() => null);
    const getSortOrder = typeof sortOrderFor === "function" ? sortOrderFor : (() => null);

    type PhotoEntry = {
      url: string;
      caption: string;
      source: string;
      text: string;            // ranking signal for the hero-first default
      sortOrder: number | null;
    };
    const entryFor = (folder: string, filename: string, source: string): PhotoEntry => {
      const caption = getLabel(folder, filename) ?? staticLabelFor(folder, filename) ?? captionFromFilename(filename);
      return {
        url: `${origin}/photos/${folder}/${filename}`,
        caption,
        source,
        // Combine caption + labeler category + filename for the best chance
        // at a meaningful category match in the hero-first default sort.
        text: [caption, getCategory(folder, filename), filename].filter(Boolean).join(" "),
        sortOrder: getSortOrder(folder, filename),
      };
    };
    // Prefer the live folder listing (what's actually on disk after any
    // rescrape), fall back to the static array. Hidden photos are dropped.
    const visibleFiles = (folder: string, fallback: string[]): string[] => {
      const live = folderFiles[folder];
      return (Array.isArray(live) ? live : fallback).filter((f) => !hidden(folder, f));
    };

    const photos: Array<{ url: string; caption: string; source: string }> = [];

    // Units first, in unit order (A, B, …). Each unit gallery is ordered
    // independently (hero-first by default; a manual drag wins).
    units.forEach((u, i) => {
      const source = `Unit ${String.fromCharCode(65 + i)} (${u.bedrooms}BR)`;
      const unitPhotos = Array.isArray(u.photos) ? u.photos : [];
      const files = visibleFiles(u.photoFolder, unitPhotos.map((p) => p.filename));
      const entries = files.map((f) => entryFor(u.photoFolder, f, source));
      for (const e of orderGallery(entries, "unit")) {
        photos.push({ url: e.url, caption: e.caption, source: e.source });
      }
    });

    // Community last — one gallery, ordered the same way.
    const communityFolder = property.communityPhotoFolder;
    if (communityFolder) {
      const communitySource = `Community — ${property.complexName}`;
      const files = visibleFiles(communityFolder, communityPhotos.map((p) => p.filename));
      const entries = files.map((f) => entryFor(communityFolder, f, communitySource));
      for (const e of orderGallery(entries, "community")) {
        photos.push({ url: e.url, caption: e.caption, source: e.source });
      }
    }

    const parsedAddr = parseAddress(property.address);

    return {
      nickname: property.bookingTitle.slice(0, 40).trimEnd(),
      title: property.bookingTitle,
      address: {
        full: parsedAddr.full,
        city: parsedAddr.city,
        state: parsedAddr.state,
        zipcode: parsedAddr.zipcode,
        country: parsedAddr.country,
      },
      // On creation, `accommodates` follows the single headline occupancy rule
      // (occupancyForBedrooms) keyed on bedroom count, so a new listing matches
      // the title/summary/dashboard — NOT the sum of per-unit maxGuests, which
      // drifted higher (e.g. 7+6+6=19 vs the rule's 18). Falls back to the
      // maxGuests sum only if bedroom count is somehow 0.
      accommodates: occupancyForBedrooms(totalBedrooms) || totalGuests,
      bedrooms: totalBedrooms || undefined,
      bathrooms: totalBathrooms || undefined,
      // Pull from per-property config in unit-builder-data.ts. Fallback
      // "Condominium" preserves behavior for older properties that haven't
      // been explicitly typed yet — Pili Mai (32, 33) set it to
      // "Townhouse" explicitly because they're two-story townhomes, not
      // flat condos. The TSDoc on `PropertyUnitBuilder.propertyType`
      // tells future onboards to set this deliberately per property.
      propertyType: property.propertyType ?? "Condominium",
      roomType: "Entire home/apt",
      otaRoomType: "Holiday home",
      amenities: guestyAmenities,
      checkInTime: "15:00",
      checkOutTime: "11:00",
      timezone: "Pacific/Honolulu",
      areaSquareFeet: totalSqft || undefined,
      listingRooms: listingRooms.length > 0 ? listingRooms : undefined,
      taxMapKey: property.taxMapKey,
      tatLicense: property.tatLicense,
      getLicense: property.getLicense,
      strPermit: property.strPermit,
      dbprLicense: property.dbprLicense,
      touristTaxAccount: property.touristTaxAccount,
      descriptions: {
        title: property.bookingTitle,
        summary: buildGuestySummary(property, units),
        space: [
          units
            .map((u, i) => `Unit ${String.fromCharCode(65 + i)} (${u.bedrooms}BR): ${u.longDescription}`)
            .join("\n\n"),
          units.length >= 2 && walkResult
            ? `\n\n${walkResult.description}`
            : "",
        ].join(""),
        neighborhood: property.neighborhood,
        transit: property.transit,
        houseRules:
          units.length === 1
            ? "No smoking. No parties or events. Must be 25+ years old to book. Quiet hours 10pm–8am."
            : "No smoking. No parties or events. Must be 25+ years old to book. Quiet hours 10pm–8am. Two separate unit keys provided at check-in.",
      },
      photos,
      pricing: {
        basePrice,
        currency: "USD",
      },
      bookingSettings: {
        minNights: 4,
        maxNights: 60,
        // Must match the default in GuestyListingBuilder's bookingRules
        // state so the Pricing-tab form and the full-build push can't diverge.
        advanceNotice: 7,
        // Per-channel cancellation policies — must match the defaults in
        // GuestyListingBuilder's bookingRules state. "30+ days notice for
        // full refund, 50%+ penalty for late cancellation" where each
        // channel's vocabulary allows it.
        cancellationPolicies: {
          airbnb: "firm",
          vrbo: "FIRM",
          booking: "strict",
        },
        instantBooking: true,
      },
    };
  }, [property, pricing, propertyId, labelFor, isHidden, categoryFor, sortOrderFor, folderFiles, walkResult]);

  if (!property) {
    if (draftLoading) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <p className="text-muted-foreground text-sm">Loading promoted draft…</p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <p className="text-muted-foreground">Property #{propertyId} not found.</p>
        <Button variant="outline" onClick={() => navigate("/")}>Back to Dashboard</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <div style={{ borderBottom: "1px solid #e5e7eb", padding: "10px 20px", display: "flex", alignItems: "center", gap: 10, background: "#f9fafb" }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/builder/${propertyId}/preflight`)}
          className="text-muted-foreground"
          style={{ fontSize: 12, gap: 6 }}
          data-testid="btn-back-to-preflight"
        >
          <ArrowLeft className="h-3 w-3" />
          Pre-Flight
        </Button>
        <span className="text-muted-foreground" style={{ fontSize: 12 }}>·</span>
        <span className="text-muted-foreground" style={{ fontSize: 12 }}>
          {property.propertyName}
        </span>
      </div>

      <GuestyListingBuilder
        propertyData={propertyData}
        propertyId={propertyId}
        sourceUrlsByFolder={sourceUrlsByFolder}
        isSingleListing={property.units.length === 1}
        onPhotoOverridesChanged={refreshPhotoLabels}
        onBuildComplete={(result) => {
          if (result.listingId) {
            toast({
              title: "Listing created on Guesty",
              description: `Listing ID: ${result.listingId}`,
            });
          }
        }}
        onUpdateComplete={(result) => {
          if (result.listingId) {
            toast({
              title: "Listing updated on Guesty",
              description: `Listing ID: ${result.listingId}`,
            });
          }
        }}
      />
    </div>
  );
}
