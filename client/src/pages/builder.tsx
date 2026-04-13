import { useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import GuestyListingBuilder from "@/components/GuestyListingBuilder";
import { getUnitBuilderByPropertyId, LISTING_DISCLOSURE } from "@/data/unit-builder-data";
import { getPropertyPricing } from "@/data/pricing-data";
import { getDefaultAmenities } from "@/data/lodgify-amenities";
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

// ─── Map Lodgify amenity keys → Guesty amenity strings ───────────────────────
const AMENITY_MAP: Record<string, string> = {
  wifi: "WIFI",
  internet: "WIFI",
  pool: "POOL",
  "swimming pool": "POOL",
  "air conditioning": "AIR_CONDITIONING",
  ac: "AIR_CONDITIONING",
  kitchen: "KITCHEN",
  washer: "WASHER",
  dryer: "DRYER",
  "washer/dryer": "WASHER",
  parking: "FREE_PARKING_ON_PREMISES",
  "free parking": "FREE_PARKING_ON_PREMISES",
  gym: "GYM",
  fitness: "GYM",
  "hot tub": "HOT_TUB",
  jacuzzi: "HOT_TUB",
  "bbq grill": "BBQ_GRILL",
  barbecue: "BBQ_GRILL",
  balcony: "PATIO_OR_BALCONY",
  lanai: "PATIO_OR_BALCONY",
  patio: "PATIO_OR_BALCONY",
  dishwasher: "DISHWASHER",
  tv: "TV",
  cable: "CABLE_TV",
  "cable tv": "CABLE_TV",
  elevator: "ELEVATOR",
  "beach access": "BEACH_ESSENTIALS",
  "beach nearby": "BEACH_ESSENTIALS",
  "ocean view": "OCEAN_VIEW",
  tennis: "TENNIS_COURT",
  "tennis court": "TENNIS_COURT",
  shampoo: "SHAMPOO",
  "hair dryer": "HAIR_DRYER",
  iron: "IRON",
  "smoke alarm": "SMOKE_ALARM",
  "carbon monoxide alarm": "CARBON_MONOXIDE_ALARM",
  "fire extinguisher": "FIRE_EXTINGUISHER",
  "first aid kit": "FIRST_AID_KIT",
};

function toGuestyAmenities(lodgifyAmenities: string[]): string[] {
  const result = new Set<string>();
  for (const a of lodgifyAmenities) {
    const key = a.toLowerCase().trim();
    const mapped = AMENITY_MAP[key];
    if (mapped) result.add(mapped);
    else result.add(a.toUpperCase().replace(/[\s/]+/g, "_"));
  }
  return Array.from(result);
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
    const totalBedrooms = property.units.reduce((s, u) => s + u.bedrooms, 0);
    const totalSqft = property.units.reduce((s, u) => s + (parseInt(u.sqft) || 0), 0);

    const basePrice = pricing?.totalBaseSellRate
      ? Math.round(pricing.totalBaseSellRate / 30)
      : 0;

    const cleaningFee = Math.round(basePrice * 0.4);

    const lodgifyAmenities = getDefaultAmenities(propertyId);
    const guestyAmenities = toGuestyAmenities(lodgifyAmenities);

    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const photos = [
      ...property.communityPhotos
        .filter((p) => p.position === "beginning")
        .map((p) => ({
          url: `${origin}/photos/${property.communityPhotoFolder}/${p.filename}`,
          caption: p.label,
        })),
      ...property.units.flatMap((u) =>
        u.photos.map((p) => ({
          url: `${origin}/photos/${u.photoFolder}/${p.filename}`,
          caption: p.label,
        }))
      ),
      ...property.communityPhotos
        .filter((p) => p.position === "end")
        .map((p) => ({
          url: `${origin}/photos/${property.communityPhotoFolder}/${p.filename}`,
          caption: p.label,
        })),
    ];

    const parsedAddr = parseAddress(property.address);

    return {
      nickname: property.propertyName,
      title: property.bookingTitle,
      address: {
        full: parsedAddr.full,
        city: parsedAddr.city,
        state: parsedAddr.state,
        zipcode: parsedAddr.zipcode,
        country: parsedAddr.country,
      },
      accommodates: totalGuests,
      propertyType: "Condominium",
      roomType: "Entire home/apartment",
      otaRoomType: "holiday_home",
      amenities: guestyAmenities,
      checkInTime: "15:00",
      checkOutTime: "11:00",
      timezone: "Pacific/Honolulu",
      areaSquareFeet: totalSqft || undefined,
      descriptions: {
        title: property.bookingTitle,
        summary: `${LISTING_DISCLOSURE}\n\n${property.combinedDescription}`,
        space: property.units
          .map((u) => `Unit ${u.unitNumber} (${u.bedrooms}BR): ${u.longDescription}`)
          .join("\n\n"),
        houseRules:
          "No smoking. No parties or events. Must be 25+ years old to book. Quiet hours 10pm–8am. Two separate unit keys provided at check-in.",
      },
      photos,
      pricing: {
        basePrice,
        weekendBasePrice: Math.round(basePrice * 1.15),
        cleaningFee,
        securityDeposit: Math.round(basePrice * 1.5),
        extraPersonFee: 25,
        guestsIncluded: Math.max(2, totalBedrooms * 2),
        currency: "USD",
        weeklyDiscount: 0.92,
        monthlyDiscount: 0.85,
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
