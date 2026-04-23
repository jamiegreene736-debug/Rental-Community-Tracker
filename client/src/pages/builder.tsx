import { useEffect, useMemo, useState } from "react";
import { fallbackWalkForResort, type WalkResult } from "@shared/walking-distance";
import { useParams, useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import GuestyListingBuilder from "@/components/GuestyListingBuilder";
import { getUnitBuilderByPropertyId, LISTING_DISCLOSURE } from "@/data/unit-builder-data";
import { getPropertyPricing } from "@/data/pricing-data";
import { getGuestyAmenities } from "@/data/guesty-amenities";
import { buildListingRooms, parseSqft } from "@/data/guesty-listing-config";
import { usePhotoLabels } from "@/hooks/use-photo-labels";
import type { GuestyPropertyData } from "@/services/guestyService";

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
    }
    city = parts[parts.length - 2].replace(/^(bldg|unit|apt|#)\s*\d+/i, "").trim() || parts[parts.length - 2];
  }

  return { full, city, state, zipcode, country: "US" };
}

// ─── Builder page ─────────────────────────────────────────────────────────────
export default function Builder() {
  const { propertyId: pidStr } = useParams<{ propertyId: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const propertyId = parseInt(pidStr ?? "0", 10);
  const property = getUnitBuilderByPropertyId(propertyId);
  const pricing = getPropertyPricing(propertyId);

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
  const { labelFor, isHidden, refresh: refreshPhotoLabels } = usePhotoLabels(allFolders);

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

    const totalGuests = property.units.reduce((s, u) => s + u.maxGuests, 0);
    const totalSqft = property.units.reduce((s, u) => s + parseSqft(u.sqft), 0);
    const totalBedrooms = property.units.reduce((s, u) => s + u.bedrooms, 0);
    const totalBathrooms = property.units.reduce((s, u) => s + parseFloat(u.bathrooms), 0);
    const listingRooms = buildListingRooms(propertyId);

    const basePrice = pricing?.totalBaseSellRate ?? 0;

    const guestyAmenities = getGuestyAmenities(propertyId);

    const origin = typeof window !== "undefined" ? window.location.origin : "";
    // Static-label lookup: fall back to hardcoded captions only for photos
    // that were in the original static list. New rescraped photos rely on
    // Claude labels via labelFor().
    const staticLabelFor = (folder: string, filename: string): string | undefined => {
      const inCommunity = property.communityPhotos.find((p) => p.filename === filename && folder === property.communityPhotoFolder);
      if (inCommunity) return inCommunity.label;
      for (const u of property.units) {
        if (u.photoFolder !== folder) continue;
        const hit = u.photos.find((p) => p.filename === filename);
        if (hit) return hit.label;
      }
      return undefined;
    };

    const photos: Array<{ url: string; caption: string; source: string }> = [];

    // Community photo bucket. Split into begin / end based on the static
    // position hint (when we have one) and partition the "begin" list so we
    // can thread one community tile between each unit's run — the published
    // channels render better with a visual break between unit A and unit B.
    const communityFiles = folderFiles[property.communityPhotoFolder] ?? property.communityPhotos.map((p) => p.filename);
    const knownComm = new Map(property.communityPhotos.map((p) => [p.filename, p]));
    const communityBeginAll = communityFiles.filter((f) => (knownComm.get(f)?.position ?? "beginning") === "beginning");
    const communityEnd      = communityFiles.filter((f) =>  knownComm.get(f)?.position === "end");
    const communityBeginVisible = communityBeginAll.filter((f) => !isHidden(property.communityPhotoFolder, f));

    // Reserve N-1 tiles to sit between units (one separator per gap), and
    // put the rest up-front as the "community opener" block. For the common
    // 2-unit case with 6 community photos, that's 5 opener + 1 separator.
    const unitCount = property.units.length;
    const separatorsNeeded = Math.max(0, unitCount - 1);
    const communityOpenerCount = Math.max(0, communityBeginVisible.length - separatorsNeeded);
    const communityOpener    = communityBeginVisible.slice(0, communityOpenerCount);
    const communitySeparators = communityBeginVisible.slice(communityOpenerCount);

    const pushCommunity = (filename: string, bandLabel: string) => {
      photos.push({
        url: `${origin}/photos/${property.communityPhotoFolder}/${filename}`,
        caption: labelFor(property.communityPhotoFolder, filename) ?? staticLabelFor(property.communityPhotoFolder, filename) ?? "Photo",
        source: bandLabel,
      });
    };

    // Opener: community photos before the first unit.
    for (const filename of communityOpener) {
      pushCommunity(filename, `Community — ${property.complexName}`);
    }

    property.units.forEach((u, i) => {
      // Prefer the live folder listing (what's actually on disk after any
      // rescrape), fall back to the static u.photos array.
      const files = folderFiles[u.photoFolder] ?? u.photos.map((p) => p.filename);
      for (const filename of files) {
        if (isHidden(u.photoFolder, filename)) continue;
        photos.push({
          url: `${origin}/photos/${u.photoFolder}/${filename}`,
          caption: labelFor(u.photoFolder, filename) ?? staticLabelFor(u.photoFolder, filename) ?? "Photo",
          source: `Unit ${String.fromCharCode(65 + i)} (${u.bedrooms}BR)`,
        });
      }
      // After each unit (except the last one), insert one community
      // separator so the published feed has a visual break between units.
      if (i < property.units.length - 1 && communitySeparators[i]) {
        pushCommunity(communitySeparators[i], `Community — ${property.complexName}`);
      }
    });

    for (const filename of communityEnd) {
      if (isHidden(property.communityPhotoFolder, filename)) continue;
      photos.push({
        url: `${origin}/photos/${property.communityPhotoFolder}/${filename}`,
        caption: labelFor(property.communityPhotoFolder, filename) ?? staticLabelFor(property.communityPhotoFolder, filename) ?? "Photo",
        source: `Community — ${property.complexName}`,
      });
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
      accommodates: totalGuests,
      bedrooms: totalBedrooms || undefined,
      bathrooms: totalBathrooms || undefined,
      propertyType: "Condominium",
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
      descriptions: {
        title: property.bookingTitle,
        summary: `${LISTING_DISCLOSURE}\n\n${property.combinedDescription}`,
        space: [
          property.units
            .map((u, i) => `Unit ${String.fromCharCode(65 + i)} (${u.bedrooms}BR): ${u.longDescription}`)
            .join("\n\n"),
          property.units.length >= 2 && walkResult
            ? `\n\n${walkResult.description}`
            : "",
        ].join(""),
        neighborhood: property.neighborhood,
        transit: property.transit,
        houseRules:
          "No smoking. No parties or events. Must be 25+ years old to book. Quiet hours 10pm–8am. Two separate unit keys provided at check-in.",
      },
      photos,
      pricing: {
        basePrice,
        currency: "USD",
      },
      bookingSettings: {
        minNights: 4,
        maxNights: 60,
        // 60-day advance notice: matches the portfolio's buy-in safety
        // window. Must match the default in GuestyListingBuilder's
        // bookingRules state so the Pricing-tab form and the full-build
        // push can't diverge.
        advanceNotice: 60,
        // Per-channel cancellation policies — must match the defaults in
        // GuestyListingBuilder's bookingRules state. "30+ days notice for
        // full refund, 50%+ penalty for late cancellation" where each
        // channel's vocabulary allows it.
        cancellationPolicies: {
          airbnb: "firm",
          vrbo: "FIRM",
          booking: "non_refundable",
        },
        instantBooking: true,
      },
    };
  }, [property, pricing, propertyId, labelFor, isHidden, folderFiles, walkResult]);

  if (!property) {
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
