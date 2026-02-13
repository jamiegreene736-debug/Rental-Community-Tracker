import { useState } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft,
  BedDouble,
  Bath,
  Users,
  MapPin,
  Download,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Info,
  Copy,
  Check,
  Square,
  Ruler,
} from "lucide-react";
import JSZip from "jszip";

type UnitPhoto = {
  filename: string;
  label: string;
  category: string;
};

type UnitData = {
  id: string;
  unitNumber: string;
  title: string;
  bedrooms: number;
  bathrooms: string;
  sqft: string;
  maxGuests: number;
  shortDescription: string;
  longDescription: string;
  photos: UnitPhoto[];
  photoFolder: string;
};

const GENERIC_ADDRESS = "1831 Poipu Road, Koloa, HI 96756";
const COMPLEX_NAME = "Regency at Poipu Kai";
const SAMPLE_DISCLAIMER = "Photos shown are representative samples of units within the Regency at Poipu Kai complex. Individual units may vary in decor, furnishings, and layout. Actual unit assigned will be of comparable quality and configuration.";

const units: UnitData[] = [
  {
    id: "unit-423",
    unitNumber: "423",
    title: "Regency at Poipu Kai - Spacious 3BR Condo with Lanai, Pool and Tennis in Sunny Poipu, Kauai",
    bedrooms: 3,
    bathrooms: "2.5",
    sqft: "~1,800",
    maxGuests: 8,
    shortDescription: "Spacious 3-bedroom, 2.5-bath condo at the Regency at Poipu Kai resort. Features a covered dining lanai, open-plan living with great room, fully equipped kitchen with breakfast bar, master suite with private lanai and en-suite bath, plus two additional guest bedrooms including a loft. Steps to pool, tennis courts, and three Poipu beaches.",
    longDescription: `Welcome to this beautifully appointed 3-bedroom, 2.5-bathroom condominium at the prestigious Regency at Poipu Kai resort on Kauai's sunny south shore.

This spacious approximately 1,800 sq ft condo features an inviting open floor plan with a generous great room that flows seamlessly from the living area through the dining space to the fully equipped kitchen. The covered dining lanai is perfect for enjoying tropical breezes and morning coffee.

The kitchen boasts modern appliances, ample counter space, and a breakfast bar for casual dining. The main living area offers comfortable seating with direct lanai access and abundant natural light.

The master bedroom suite includes a private lanai, walk-in closet, and en-suite bathroom with separate shower. The second guest bedroom provides a comfortable retreat, while the third bedroom is a charming open loft space with its own adjacent bath.

Located within the Regency at Poipu Kai complex, guests enjoy access to resort amenities including swimming pool, tennis courts, and beautifully maintained tropical gardens. The property is just steps from three stunning Poipu beaches including Shipwreck Beach and Poipu Beach Park.

The complex is ideally situated near shops, restaurants, and the Poipu Athletic Club. Whether you are looking to surf, snorkel, hike, or simply relax, this condo offers the perfect home base for your Kauai vacation.`,
    photoFolder: "unit-423",
    photos: [
      { filename: "01-covered-dining-lanai.jpg", label: "Covered Dining Lanai", category: "Living Areas" },
      { filename: "02-living-room-lanai.jpg", label: "Living Room and Lanai", category: "Living Areas" },
      { filename: "03-living-room-great-room.jpg", label: "Living Room Great Room", category: "Living Areas" },
      { filename: "04-dining-living-great-room.jpg", label: "Dining and Living Great Room", category: "Living Areas" },
      { filename: "05-dining-area-entry.jpg", label: "Dining Area and Entry", category: "Living Areas" },
      { filename: "06-kitchen-breakfast-bar.jpg", label: "Kitchen and Breakfast Bar", category: "Kitchen" },
      { filename: "07-fully-equipped-kitchen.jpg", label: "Fully Equipped Kitchen", category: "Kitchen" },
      { filename: "08-kitchen-dining-area.jpg", label: "Kitchen and Dining Area", category: "Kitchen" },
      { filename: "09-master-bedroom-suite-lanai.jpg", label: "Master Bedroom Suite Lanai", category: "Bedrooms" },
      { filename: "10-master-bedroom-suite.jpg", label: "Master Bedroom Suite", category: "Bedrooms" },
      { filename: "11-master-bath.jpg", label: "Master Bedroom Suite Bath", category: "Bathrooms" },
      { filename: "12-master-bath-shower.jpg", label: "Master Bedroom Suite Bath and Shower", category: "Bathrooms" },
      { filename: "13-second-guest-bedroom.jpg", label: "Second Guest Bedroom", category: "Bedrooms" },
      { filename: "14-third-bedroom-loft.jpg", label: "Third Guest Bedroom Open Loft", category: "Bedrooms" },
      { filename: "15-third-bedroom-loft-bath.jpg", label: "Third Guest Bedroom Open Loft and Bath", category: "Bathrooms" },
      { filename: "16-guest-shared-bath.jpg", label: "Second Guest Shared Bath", category: "Bathrooms" },
      { filename: "17-guest-half-bath.jpg", label: "Guest Half Bath", category: "Bathrooms" },
    ],
  },
  {
    id: "unit-621",
    unitNumber: "621",
    title: "Regency at Poipu Kai - Beautiful 3BR Condo with Garden View, Pool and Tennis in Poipu, Kauai",
    bedrooms: 3,
    bathrooms: "3",
    sqft: "~1,800",
    maxGuests: 8,
    shortDescription: "Beautiful 3-bedroom, 3-bath condo at the Regency at Poipu Kai resort. Features garden views from the living room and lanai, open-concept kitchen with breakfast bar, primary bedroom suite with private lanai and en-suite bath with walk-in shower, plus two additional guest bedrooms each with their own bath. Steps to pool, tennis courts, and three Poipu beaches.",
    longDescription: `Welcome to this stunning 3-bedroom, 3-bathroom condominium at the sought-after Regency at Poipu Kai resort on Kauai's beautiful south shore.

This approximately 1,800 sq ft condo offers a light-filled open floor plan with lovely garden views from the main living area and lanai. The spacious great room seamlessly connects the living, dining, and kitchen areas for an ideal entertaining layout.

The fully equipped kitchen features modern appliances, generous counter space, and a breakfast bar perfect for casual meals. The open layout allows the cook to stay connected with family and guests while preparing meals.

The primary bedroom suite is a true retreat, featuring a private lanai overlooking the gardens, an en-suite bathroom with walk-in shower, and ample closet space. The second guest bedroom also enjoys garden views and has its own adjacent bathroom. The third bedroom is located in an upper loft area with its own bath, providing additional privacy.

Guests enjoy full access to the Regency at Poipu Kai resort amenities including a swimming pool, tennis courts, and lushly landscaped tropical gardens. The complex is a short walk to three of Poipu's finest beaches, including world-famous Poipu Beach Park and Shipwreck Beach.

Located on Kauai's sunny south shore, the area offers excellent dining, shopping, snorkeling, surfing, and hiking opportunities. This condo is perfectly positioned for experiencing the best of Kauai.`,
    photoFolder: "unit-621",
    photos: [
      { filename: "01-living-room-seating-lanai.jpg", label: "Living Room Seating and Lanai", category: "Living Areas" },
      { filename: "02-main-seating-lanai.jpg", label: "Main Seating and Lanai", category: "Living Areas" },
      { filename: "03-garden-view-living-room.jpg", label: "Garden View Living Room", category: "Living Areas" },
      { filename: "04-dining-living-great-room.jpg", label: "Dining and Living Great Room", category: "Living Areas" },
      { filename: "05-dining-kitchen-living-room.jpg", label: "Dining Kitchen and Living Room", category: "Living Areas" },
      { filename: "06-kitchen-dining-entry.jpg", label: "Kitchen Dining and Entry", category: "Kitchen" },
      { filename: "07-kitchen-breakfast-bar.jpg", label: "Kitchen and Breakfast Bar", category: "Kitchen" },
      { filename: "08-fully-equipped-kitchen.jpg", label: "Fully Equipped Kitchen", category: "Kitchen" },
      { filename: "09-primary-bedroom-lanai.jpg", label: "Primary Bedroom Lanai", category: "Bedrooms" },
      { filename: "10-primary-bedroom-suite.jpg", label: "Primary Bedroom Suite and Lanai", category: "Bedrooms" },
      { filename: "11-primary-bath.jpg", label: "Primary Bedroom Suite Bath", category: "Bathrooms" },
      { filename: "12-primary-bath-shower.jpg", label: "Primary Bedroom Suite Bath and Shower", category: "Bathrooms" },
      { filename: "13-second-guest-bedroom-garden.jpg", label: "Second Guest Bedroom and Garden View", category: "Bedrooms" },
      { filename: "14-second-guest-bedroom.jpg", label: "Second Guest Bedroom", category: "Bedrooms" },
      { filename: "15-second-guest-bath.jpg", label: "Second Guest Bedroom Bath", category: "Bathrooms" },
      { filename: "16-third-bedroom-loft.jpg", label: "Third Guest Bedroom Loft", category: "Bedrooms" },
      { filename: "17-third-bedroom-loft-bath.jpg", label: "Third Guest Bedroom Loft and Bath", category: "Bathrooms" },
      { filename: "18-third-bedroom-bath.jpg", label: "Third Guest Bedroom Bath", category: "Bathrooms" },
    ],
  },
];

function PhotoGallery({ unit }: { unit: UnitData }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const photo = unit.photos[currentIndex];
  const photoPath = `/photos/${unit.photoFolder}/${photo.filename}`;

  const goNext = () => setCurrentIndex((prev) => (prev + 1) % unit.photos.length);
  const goPrev = () => setCurrentIndex((prev) => (prev - 1 + unit.photos.length) % unit.photos.length);

  return (
    <div>
      <div className="relative group">
        <div className="aspect-[16/10] overflow-hidden rounded-md bg-muted">
          <img
            src={photoPath}
            alt={photo.label}
            className="w-full h-full object-cover"
            data-testid={`img-photo-${unit.id}`}
          />
        </div>
        <Button
          size="icon"
          variant="secondary"
          className="absolute left-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          onClick={goPrev}
          aria-label="Previous photo"
          data-testid={`button-prev-photo-${unit.id}`}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          onClick={goNext}
          aria-label="Next photo"
          data-testid={`button-next-photo-${unit.id}`}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          onClick={() => setIsFullscreen(true)}
          aria-label="View fullscreen"
          data-testid={`button-fullscreen-${unit.id}`}
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-3 py-1 rounded-full" data-testid={`text-photo-counter-${unit.id}`}>
          {currentIndex + 1} / {unit.photos.length}
        </div>
      </div>
      <p className="text-sm text-muted-foreground mt-2 text-center" data-testid={`text-photo-label-${unit.id}`}>
        {photo.label}
      </p>

      <div className="flex gap-1.5 mt-3 overflow-x-auto pb-2">
        {unit.photos.map((p, idx) => (
          <div
            key={p.filename}
            onClick={() => setCurrentIndex(idx)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setCurrentIndex(idx); }}
            className={`flex-shrink-0 rounded overflow-hidden border-2 transition-colors cursor-pointer ${
              idx === currentIndex ? "border-primary" : "border-transparent"
            }`}
            data-testid={`button-thumbnail-${unit.id}-${idx}`}
          >
            <img
              src={`/photos/${unit.photoFolder}/${p.filename}`}
              alt={p.label}
              className="w-16 h-12 object-cover"
            />
          </div>
        ))}
      </div>

      {isFullscreen && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
          onClick={() => setIsFullscreen(false)}
          data-testid={`modal-fullscreen-${unit.id}`}
        >
          <Button
            size="icon"
            variant="secondary"
            className="absolute top-4 right-4"
            onClick={() => setIsFullscreen(false)}
            data-testid={`button-close-fullscreen-${unit.id}`}
          >
            <Square className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="secondary"
            className="absolute left-4 top-1/2 -translate-y-1/2"
            onClick={(e) => { e.stopPropagation(); goPrev(); }}
            aria-label="Previous photo"
            data-testid={`button-fullscreen-prev-${unit.id}`}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <img
            src={photoPath}
            alt={photo.label}
            className="max-w-[90vw] max-h-[85vh] object-contain"
            onClick={(e) => e.stopPropagation()}
            data-testid={`img-fullscreen-${unit.id}`}
          />
          <Button
            size="icon"
            variant="secondary"
            className="absolute right-4 top-1/2 -translate-y-1/2"
            onClick={(e) => { e.stopPropagation(); goNext(); }}
            aria-label="Next photo"
            data-testid={`button-fullscreen-next-${unit.id}`}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-sm">
            {photo.label} ({currentIndex + 1} / {unit.photos.length})
          </div>
        </div>
      )}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button variant="outline" onClick={handleCopy} data-testid={`button-copy-${label}`}>
      {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
      {copied ? "Copied" : `Copy ${label}`}
    </Button>
  );
}

async function downloadAllPhotos(unit: UnitData) {
  const zip = new JSZip();
  const folder = zip.folder(`${unit.id}-photos`);
  if (!folder) return;

  for (const photo of unit.photos) {
    const response = await fetch(`/photos/${unit.photoFolder}/${photo.filename}`);
    const blob = await response.blob();
    folder.file(photo.filename, blob);
  }

  const content = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(content);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${unit.id}-photos.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

function UnitCard({ unit }: { unit: UnitData }) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await downloadAllPhotos(unit);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card className="overflow-visible">
      <div className="p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
          <div>
            <h2 className="text-lg font-bold" data-testid={`text-unit-title-${unit.id}`}>
              {COMPLEX_NAME} #{unit.unitNumber}
            </h2>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <Badge variant="secondary">
                <BedDouble className="h-3 w-3 mr-1" />
                {unit.bedrooms} BR
              </Badge>
              <Badge variant="secondary">
                <Bath className="h-3 w-3 mr-1" />
                {unit.bathrooms} BA
              </Badge>
              <Badge variant="secondary">
                <Users className="h-3 w-3 mr-1" />
                {unit.maxGuests} Guests
              </Badge>
              <Badge variant="secondary">
                <Ruler className="h-3 w-3 mr-1" />
                {unit.sqft} sq ft
              </Badge>
            </div>
          </div>
          <Button
            variant="default"
            onClick={handleDownload}
            disabled={downloading}
            data-testid={`button-download-${unit.id}`}
          >
            <Download className="h-4 w-4 mr-2" />
            {downloading ? "Zipping..." : `Download All ${unit.photos.length} Photos`}
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <PhotoGallery unit={unit} />

          <Tabs defaultValue="title" className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="title" className="flex-1" data-testid={`tab-title-${unit.id}`}>
                Listing Title
              </TabsTrigger>
              <TabsTrigger value="short" className="flex-1" data-testid={`tab-short-${unit.id}`}>
                Short Desc
              </TabsTrigger>
              <TabsTrigger value="long" className="flex-1" data-testid={`tab-long-${unit.id}`}>
                Full Desc
              </TabsTrigger>
            </TabsList>

            <TabsContent value="title" className="mt-3">
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Booking.com Compliant Title (max 255 chars)</p>
                  <Card className="p-3">
                    <p className="text-sm font-medium" data-testid={`text-booking-title-${unit.id}`}>
                      {unit.title}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {unit.title.length} / 255 characters
                    </p>
                  </Card>
                </div>
                <CopyButton text={unit.title} label="title" />
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Property Address</p>
                  <Card className="p-3">
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <p className="text-sm" data-testid={`text-address-${unit.id}`}>{GENERIC_ADDRESS}</p>
                    </div>
                  </Card>
                </div>
                <CopyButton text={GENERIC_ADDRESS} label="address" />
              </div>
            </TabsContent>

            <TabsContent value="short" className="mt-3">
              <div className="space-y-3">
                <Card className="p-3">
                  <p className="text-sm leading-relaxed" data-testid={`text-short-desc-${unit.id}`}>
                    {unit.shortDescription}
                  </p>
                </Card>
                <CopyButton text={unit.shortDescription} label="short-description" />
              </div>
            </TabsContent>

            <TabsContent value="long" className="mt-3">
              <div className="space-y-3">
                <Card className="p-3 max-h-[400px] overflow-y-auto">
                  <p className="text-sm leading-relaxed whitespace-pre-line" data-testid={`text-long-desc-${unit.id}`}>
                    {unit.longDescription}
                  </p>
                </Card>
                <CopyButton text={unit.longDescription} label="full-description" />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </Card>
  );
}

export default function UnitBuilder() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1400px] mx-auto px-4 py-6">
        <div className="mb-6">
          <Link href="/">
            <Button variant="ghost" data-testid="button-back-dashboard">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Button>
          </Link>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
            Unit Builder - Poipu Kai 6BR Listing
          </h1>
          <p className="text-muted-foreground mt-1">
            Booking.com-ready listing content for two 3BR Regency at Poipu Kai condos (not currently on Booking.com or VRBO)
          </p>
        </div>

        <Card className="p-4 mb-6">
          <div className="flex items-start gap-3">
            <Info className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium mb-1">Sample Property Disclaimer</p>
              <p className="text-sm text-muted-foreground" data-testid="text-disclaimer">
                {SAMPLE_DISCLAIMER}
              </p>
            </div>
          </div>
        </Card>

        <div className="space-y-6">
          {units.map((unit) => (
            <UnitCard key={unit.id} unit={unit} />
          ))}
        </div>

        <div className="mt-6 text-xs text-muted-foreground text-center">
          Property data sourced from Parrish Kauai. Units #423 and #621 are not currently listed on Booking.com or VRBO.
        </div>
      </div>
    </div>
  );
}
