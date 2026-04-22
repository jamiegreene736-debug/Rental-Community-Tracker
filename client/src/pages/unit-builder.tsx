import { useState } from "react";
import { Link, useParams } from "wouter";
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
  AlertTriangle,
  ClipboardList,
  DollarSign,
} from "lucide-react";
import { getUnitBuilderByPropertyId } from "@/data/unit-builder-data";
import type { Unit, PropertyUnitBuilder } from "@/data/unit-builder-data";
import { usePhotoLabels } from "@/hooks/use-photo-labels";

function PhotoGallery({ unit }: { unit: Unit }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { labelFor } = usePhotoLabels([unit.photoFolder]);

  if (unit.photos.length === 0) {
    return (
      <div className="aspect-[16/10] rounded-md bg-muted flex items-center justify-center">
        <div className="text-center text-muted-foreground p-4">
          <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
          <p className="text-sm font-medium">No photos yet</p>
          <p className="text-xs mt-1">Photos will be added once the unit is identified</p>
        </div>
      </div>
    );
  }

  const photo = unit.photos[currentIndex];
  const photoPath = `/photos/${unit.photoFolder}/${photo.filename}`;
  // Prefer Claude-vision label from DB; fall back to the static label
  // baked into unit-builder-data.ts. Once relabel-all has run, every
  // photo here will show the AI-generated caption instead of the stale
  // hardcoded one.
  const displayLabel = labelFor(unit.photoFolder, photo.filename) ?? photo.label;

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
        {displayLabel}
      </p>

      <div className="flex gap-1.5 mt-3 overflow-x-auto pb-2">
        {unit.photos.map((p, idx) => {
          const thumbLabel = labelFor(unit.photoFolder, p.filename) ?? p.label;
          return (
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
              title={thumbLabel}
            >
              <img
                src={`/photos/${unit.photoFolder}/${p.filename}`}
                alt={thumbLabel}
                className="w-16 h-12 object-cover"
              />
            </div>
          );
        })}
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

function getAllPhotoFolders(property: PropertyUnitBuilder): string[] {
  const folders = new Set<string>();
  for (const unit of property.units) {
    if (unit.photos.length > 0 && unit.photoFolder) {
      folders.add(unit.photoFolder);
    }
  }
  return Array.from(folders);
}

function getDownloadAllUrl(property: PropertyUnitBuilder): string {
  const folders = getAllPhotoFolders(property);
  const name = property.complexName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  let url = `/api/photos/zip-multi?folders=${folders.join(",")}&name=${name}`;
  if (property.communityPhotos && property.communityPhotos.length > 0 && property.communityPhotoFolder) {
    const beginningPhotos = property.communityPhotos.filter(p => p.position === "beginning").map(p => p.filename).join(",");
    const endPhotos = property.communityPhotos.filter(p => p.position === "end").map(p => p.filename).join(",");
    url += `&communityFolder=${property.communityPhotoFolder}&beginningPhotos=${encodeURIComponent(beginningPhotos)}&endPhotos=${encodeURIComponent(endPhotos)}`;
  }
  return url;
}

function UnitCard({ unit, complexName }: { unit: Unit; complexName: string }) {
  return (
    <Card className="overflow-visible">
      <div className="p-4 md:p-6">
        <div className="mb-4">
          <h3 className="text-base font-bold" data-testid={`text-unit-title-${unit.id}`}>
            {complexName} #{unit.unitNumber}
          </h3>
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <PhotoGallery unit={unit} />

          <Tabs defaultValue="title" className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="title" className="flex-1" data-testid={`tab-title-${unit.id}`}>
                Details
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
                  <p className="text-xs text-muted-foreground mb-1">Unit Number</p>
                  <Card className="p-3">
                    <p className="text-sm font-medium" data-testid={`text-unit-number-${unit.id}`}>
                      {unit.unitNumber === "TBD" ? "To be determined" : `#${unit.unitNumber}`}
                    </p>
                  </Card>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Configuration</p>
                  <Card className="p-3">
                    <p className="text-sm">
                      {unit.bedrooms} Bedrooms / {unit.bathrooms} Bathrooms / {unit.sqft} sq ft / Up to {unit.maxGuests} guests
                    </p>
                  </Card>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="short" className="mt-3">
              <div className="space-y-3">
                <Card className="p-3">
                  <p className="text-sm leading-relaxed" data-testid={`text-short-desc-${unit.id}`}>
                    {unit.shortDescription}
                  </p>
                </Card>
                <CopyButton text={unit.shortDescription} label={`short-desc-${unit.id}`} />
              </div>
            </TabsContent>

            <TabsContent value="long" className="mt-3">
              <div className="space-y-3">
                <Card className="p-3 max-h-[400px] overflow-y-auto">
                  <p className="text-sm leading-relaxed whitespace-pre-line" data-testid={`text-long-desc-${unit.id}`}>
                    {unit.longDescription}
                  </p>
                </Card>
                <CopyButton text={unit.longDescription} label={`long-desc-${unit.id}`} />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </Card>
  );
}

export default function UnitBuilder() {
  const params = useParams<{ id: string }>();
  const propertyId = parseInt(params.id || "0", 10);
  const property = getUnitBuilderByPropertyId(propertyId);


  if (!property) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-[1400px] mx-auto px-4 py-6">
          <Link href="/">
            <Button variant="ghost" data-testid="button-back-dashboard">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Button>
          </Link>
          <div className="mt-8 text-center">
            <h1 className="text-xl font-bold">Property not found</h1>
            <p className="text-muted-foreground mt-2">No unit builder data exists for this property.</p>
          </div>
        </div>
      </div>
    );
  }

  const totalUnitPhotos = property.units.reduce((sum, u) => sum + u.photos.length, 0);
  const totalPhotos = totalUnitPhotos + (property.communityPhotos?.length || 0);

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

        <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
              Unit Builder - {property.propertyName}
            </h1>
            <p className="text-muted-foreground mt-1">
              {property.complexName} - {property.units.length} unit{property.units.length > 1 ? "s" : ""} in this listing
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/buy-in-tracker">
              <Button variant="default" data-testid="button-buy-in">
                <DollarSign className="h-4 w-4 mr-2" />
                Buy In
              </Button>
            </Link>
            <Link href={`/builder/${property.propertyId}/preflight`}>
              <Button variant="outline" data-testid="button-build-guesty">
                <ClipboardList className="h-4 w-4 mr-2" />
                Build Listing
              </Button>
            </Link>
            {totalPhotos > 0 && (
              <Button
                variant="outline"
                asChild
                data-testid="button-download-all"
              >
                <a href={getDownloadAllUrl(property)} download>
                  <Download className="h-4 w-4 mr-2" />
                  Download All {totalPhotos} Photos
                </a>
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <Card className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Booking.com Listing Title (max 255 chars)</p>
            <p className="text-sm font-medium" data-testid="text-booking-title">{property.bookingTitle}</p>
            <p className="text-xs text-muted-foreground mt-1">{property.bookingTitle.length} / 255 characters</p>
            <div className="mt-2">
              <CopyButton text={property.bookingTitle} label="title" />
            </div>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Property Address</p>
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <p className="text-sm font-medium" data-testid="text-address">{property.address}</p>
            </div>
            <div className="mt-2">
              <CopyButton text={property.address} label="address" />
            </div>
          </Card>
        </div>

        <Card className="p-4 mb-6">
          <div className="flex items-start gap-3">
            <Info className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium mb-1">Sample Property Disclaimer</p>
              <p className="text-sm text-muted-foreground" data-testid="text-disclaimer">
                {property.sampleDisclaimer}
              </p>
            </div>
          </div>
        </Card>

        {!property.hasPhotos && (
          <Card className="p-4 mb-6 border-dashed">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium mb-1">Placeholder - Units Not Yet Identified</p>
                <p className="text-sm text-muted-foreground">
                  The individual units for this property have not been identified yet. Once specific units are found that are not on Booking.com or VRBO, their details, photos, and descriptions will be populated below.
                </p>
              </div>
            </div>
          </Card>
        )}

        <div className="space-y-6">
          {property.units.map((unit) => (
            <UnitCard key={unit.id} unit={unit} complexName={property.complexName} />
          ))}
        </div>

        <div className="mt-6 text-xs text-muted-foreground text-center">
          NexStay property data. Unit status verified against Booking.com and VRBO.
        </div>
      </div>
    </div>
  );
}
