import { useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import GuestyListingBuilder from "@/components/GuestyListingBuilder";
import { getUnitBuilderByPropertyId, LISTING_DISCLOSURE } from "@/data/unit-builder-data";
import { getPropertyPricing } from "@/data/pricing-data";
import { getGuestyAmenities } from "@/data/guesty-amenities";
import { buildListingRooms, parseSqft } from "@/data/guesty-listing-config";
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
    const photos = [
      ...property.communityPhotos
        .filter((p) => p.position === "beginning")
        .map((p) => ({
          url: `${origin}/photos/${property.communityPhotoFolder}/${p.filename}`,
          caption: p.label,
          source: `Community — ${property.complexName}`,
        })),
      ...property.units.flatMap((u, i) =>
        u.photos.map((p) => ({
          url: `${origin}/photos/${u.photoFolder}/${p.filename}`,
          caption: p.label,
          source: `Unit ${String.fromCharCode(65 + i)} (${u.bedrooms}BR)`,
        }))
      ),
      ...property.communityPhotos
        .filter((p) => p.position === "end")
        .map((p) => ({
          url: `${origin}/photos/${property.communityPhotoFolder}/${p.filename}`,
          caption: p.label,
          source: `Community — ${property.complexName}`,
        })),
    ];

    const parsedAddr = parseAddress(property.address);

    return {
      nickname: property.propertyName.slice(0, 40).trimEnd(),
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
  }, [property, pricing, propertyId]);

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
