import { useEffect, useMemo, useState } from "react";
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
  const { labelFor } = usePhotoLabels(allFolders);

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

    // Community (beginning)
    const communityFiles = folderFiles[property.communityPhotoFolder] ?? property.communityPhotos.map((p) => p.filename);
    // Preserve the "beginning vs end" split the static data defines; for
    // unknown filenames we treat them as "beginning" by default.
    const knownComm = new Map(property.communityPhotos.map((p) => [p.filename, p]));
    const communityBegin = communityFiles.filter((f) => (knownComm.get(f)?.position ?? "beginning") === "beginning");
    const communityEnd   = communityFiles.filter((f) =>  knownComm.get(f)?.position === "end");

    for (const filename of communityBegin) {
      photos.push({
        url: `${origin}/photos/${property.communityPhotoFolder}/${filename}`,
        caption: labelFor(property.communityPhotoFolder, filename) ?? staticLabelFor(property.communityPhotoFolder, filename) ?? "Photo",
        source: `Community — ${property.complexName}`,
      });
    }

    property.units.forEach((u, i) => {
      // Prefer the live folder listing (what's actually on disk after any
      // rescrape), fall back to the static u.photos array.
      const files = folderFiles[u.photoFolder] ?? u.photos.map((p) => p.filename);
      for (const filename of files) {
        photos.push({
          url: `${origin}/photos/${u.photoFolder}/${filename}`,
          caption: labelFor(u.photoFolder, filename) ?? staticLabelFor(u.photoFolder, filename) ?? "Photo",
          source: `Unit ${String.fromCharCode(65 + i)} (${u.bedrooms}BR)`,
        });
      }
    });

    for (const filename of communityEnd) {
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
        space: property.units
          .map((u, i) => `Unit ${String.fromCharCode(65 + i)} (${u.bedrooms}BR): ${u.longDescription}`)
          .join("\n\n"),
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
        cancellationPolicy: "moderate",
        instantBooking: true,
      },
    };
  }, [property, pricing, propertyId, labelFor, folderFiles]);

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
