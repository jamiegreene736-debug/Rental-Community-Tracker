import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  ArrowLeft,
  BedDouble,
  Bath,
  Users,
  Copy,
  Check,
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  ClipboardList,
  Image,
  FileText,
  ListChecks,
  ChevronRight,
  DollarSign,
  TrendingUp,
  Upload,
  AlertCircle,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getUnitBuilderByPropertyId, getMultiUnitPropertyIds } from "@/data/unit-builder-data";
import type { Unit, PropertyUnitBuilder, CommunityPhoto } from "@/data/unit-builder-data";
import {
  LODGIFY_AMENITY_CATEGORIES,
  getDefaultAmenities,
} from "@/data/lodgify-amenities";
import {
  getPropertyPricing,
  getSeasonLabel,
  getSeasonBadgeVariant,
  type PropertyPricing,
} from "@/data/pricing-data";

function CopyField({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          data-testid={`button-copy-${label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Card className="p-3">
        <p className={`text-sm leading-relaxed ${multiline ? "whitespace-pre-line max-h-[300px] overflow-y-auto" : ""}`}
          data-testid={`text-field-${label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {value}
        </p>
      </Card>
    </div>
  );
}

function AmenitiesChecklist({ propertyId }: { propertyId: number }) {
  const defaults = getDefaultAmenities(propertyId);
  const [checked, setChecked] = useState<Set<string>>(new Set(defaults));
  const [copied, setCopied] = useState(false);

  const toggle = (item: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  };

  const copyAmenities = async () => {
    const lines: string[] = [];
    for (const cat of LODGIFY_AMENITY_CATEGORIES) {
      const selected = cat.items.filter((i) => checked.has(i));
      if (selected.length > 0) {
        lines.push(`${cat.name}:`);
        selected.forEach((s) => lines.push(`  - ${s}`));
        lines.push("");
      }
    }
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const selectAll = () => {
    const all = new Set<string>();
    LODGIFY_AMENITY_CATEGORIES.forEach((c) => c.items.forEach((i) => all.add(i)));
    setChecked(all);
  };

  const clearAll = () => setChecked(new Set());
  const resetDefaults = () => setChecked(new Set(defaults));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={copyAmenities} data-testid="button-copy-amenities">
          {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
          {copied ? "Copied" : "Copy Selected Amenities"}
        </Button>
        <Button variant="ghost" size="sm" onClick={selectAll} data-testid="button-select-all-amenities">
          Select All
        </Button>
        <Button variant="ghost" size="sm" onClick={clearAll} data-testid="button-clear-amenities">
          Clear All
        </Button>
        <Button variant="ghost" size="sm" onClick={resetDefaults} data-testid="button-reset-amenities">
          Reset Defaults
        </Button>
        <Badge variant="secondary">{checked.size} selected</Badge>
      </div>

      <Accordion type="multiple" defaultValue={LODGIFY_AMENITY_CATEGORIES.map((c) => c.name)}>
        {LODGIFY_AMENITY_CATEGORIES.map((cat) => {
          const catCount = cat.items.filter((i) => checked.has(i)).length;
          return (
            <AccordionItem key={cat.name} value={cat.name}>
              <AccordionTrigger className="text-sm py-2" data-testid={`accordion-${cat.name.toLowerCase().replace(/\s+/g, "-")}`}>
                <span className="flex items-center gap-2">
                  {cat.name}
                  <Badge variant="secondary" className="text-xs">
                    {catCount}/{cat.items.length}
                  </Badge>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 pl-1">
                  {cat.items.map((item) => (
                    <label
                      key={item}
                      className="flex items-center gap-2 py-1 px-2 rounded cursor-pointer hover-elevate"
                      data-testid={`checkbox-amenity-${item.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked.has(item)}
                        onChange={() => toggle(item)}
                        className="rounded border-muted-foreground"
                      />
                      <span className="text-sm">{item}</span>
                    </label>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}

function PhotoOrderPreview({ unit }: { unit: Unit }) {
  if (unit.photos.length === 0) {
    return (
      <div className="text-sm text-muted-foreground p-4 text-center">
        No photos available for this unit yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          {unit.photos.length} photos in Lodgify upload order (main first, interiors, exteriors)
        </p>
        <Button
          variant="default"
          size="sm"
          asChild
          data-testid={`button-download-photos-${unit.id}`}
        >
          <a href={`/api/photos/zip/${unit.photoFolder}`} download={`${unit.id}-photos.zip`}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Download All Photos (ZIP)
          </a>
        </Button>
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-1.5">
        {unit.photos.map((photo, idx) => (
          <div
            key={photo.filename}
            className="relative group"
            data-testid={`photo-preview-${unit.id}-${idx}`}
          >
            <div className={`aspect-square rounded overflow-hidden border ${idx === 0 ? "border-primary ring-2 ring-primary/30" : "border-transparent"}`}>
              <img
                src={`/photos/${unit.photoFolder}/${photo.filename}`}
                alt={photo.label}
                className="w-full h-full object-cover"
              />
            </div>
            <div className="absolute top-0.5 left-0.5 bg-black/70 text-white text-[10px] px-1 rounded">
              {idx + 1}
            </div>
            <div className="absolute inset-x-0 bottom-0 bg-black/70 text-white text-[9px] px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity truncate visibility-visible">
              {photo.label}
            </div>
            {idx === 0 && (
              <Badge variant="default" className="absolute -top-1.5 -right-1.5 text-[9px] px-1 py-0">
                Main
              </Badge>
            )}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Photos are numbered in optimal order: living/main areas first, then bedrooms/bathrooms, then exterior/community.
        The first photo becomes the main listing image in Lodgify.
      </p>
    </div>
  );
}

function CommunityPhotosSection({ property }: { property: PropertyUnitBuilder }) {
  if (!property.communityPhotos || property.communityPhotos.length === 0) {
    return null;
  }

  const beginningPhotos = property.communityPhotos.filter(p => p.position === "beginning");
  const endPhotos = property.communityPhotos.filter(p => p.position === "end");
  const unitFolders = property.units.map(u => u.photoFolder).join(",");
  const beginningFilenames = beginningPhotos.map(p => p.filename).join(",");
  const endFilenames = endPhotos.map(p => p.filename).join(",");
  const totalUnitPhotos = property.units.reduce((sum, u) => sum + u.photos.length, 0);
  const totalPhotos = totalUnitPhotos + property.communityPhotos.length;

  const downloadUrl = `/api/photos/zip-multi?folders=${unitFolders}&name=${encodeURIComponent(property.propertyName)}&communityFolder=${property.communityPhotoFolder}&beginningPhotos=${encodeURIComponent(beginningFilenames)}&endPhotos=${encodeURIComponent(endFilenames)}`;

  return (
    <Card className="p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div>
          <h3 className="text-sm font-bold flex items-center gap-2" data-testid="text-community-photos-title">
            <Image className="h-4 w-4" />
            Community & Resort Photos
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {property.communityPhotos.length} community photos + {totalUnitPhotos} unit photos = {totalPhotos} total
          </p>
        </div>
        <Button
          variant="default"
          size="sm"
          asChild
          data-testid="button-download-all-photos"
        >
          <a href={downloadUrl} download={`${property.propertyName}-all-photos.zip`}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Download All Photos (ZIP)
          </a>
        </Button>
      </div>

      <div className="space-y-4">
        {beginningPhotos.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Community Photos - Beginning (uploaded first)
            </p>
            <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-1.5">
              {beginningPhotos.map((photo, idx) => (
                <div key={photo.filename} className="relative group" data-testid={`photo-community-begin-${idx}`}>
                  <div className="aspect-square rounded overflow-hidden border border-blue-300 dark:border-blue-700">
                    <img
                      src={`/photos/${property.communityPhotoFolder}/${photo.filename}`}
                      alt={photo.label}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="absolute top-0.5 left-0.5 bg-blue-600/80 text-white text-[10px] px-1 rounded">
                    {idx + 1}
                  </div>
                  <div className="absolute inset-x-0 bottom-0 bg-black/70 text-white text-[9px] px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity truncate visibility-visible">
                    {photo.label}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">
            Unit Photos (middle) - see individual unit tabs below
          </p>
        </div>

        {endPhotos.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Community Photos - End (uploaded last)
            </p>
            <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-1.5">
              {endPhotos.map((photo, idx) => (
                <div key={photo.filename} className="relative group" data-testid={`photo-community-end-${idx}`}>
                  <div className="aspect-square rounded overflow-hidden border border-blue-300 dark:border-blue-700">
                    <img
                      src={`/photos/${property.communityPhotoFolder}/${photo.filename}`}
                      alt={photo.label}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="absolute top-0.5 left-0.5 bg-blue-600/80 text-white text-[10px] px-1 rounded">
                    {beginningPhotos.length + totalUnitPhotos + idx + 1}
                  </div>
                  <div className="absolute inset-x-0 bottom-0 bg-black/70 text-white text-[9px] px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity truncate visibility-visible">
                    {photo.label}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground mt-3">
        Download includes: community photos at beginning, all unit photos in middle, community photos at end.
        Files are numbered sequentially for correct Lodgify upload order.
      </p>
    </Card>
  );
}

function UnitPrepCard({ unit, complexName, propertyId }: { unit: Unit; complexName: string; propertyId: number }) {
  return (
    <Card className="overflow-visible">
      <div className="p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div>
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
            </div>
          </div>
        </div>

        <div className="mb-3">
          <CopyField
            label="Room Configuration"
            value={`${unit.bedrooms} Bedrooms, ${unit.bathrooms} Bathrooms, Sleeps ${unit.maxGuests}, ${unit.sqft} sq ft`}
          />
        </div>

        <Tabs defaultValue="amenities" className="w-full">
          <TabsList className="w-full flex-wrap">
            <TabsTrigger value="amenities" className="flex-1 gap-1" data-testid={`tab-amenities-${unit.id}`}>
              <ListChecks className="h-3.5 w-3.5" />
              Amenities
            </TabsTrigger>
            <TabsTrigger value="photos" className="flex-1 gap-1" data-testid={`tab-photos-${unit.id}`}>
              <Image className="h-3.5 w-3.5" />
              Photos ({unit.photos.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="amenities" className="mt-4">
            <AmenitiesChecklist propertyId={propertyId} />
          </TabsContent>

          <TabsContent value="photos" className="mt-4">
            <PhotoOrderPreview unit={unit} />
          </TabsContent>
        </Tabs>
      </div>
    </Card>
  );
}

function LodgifySyncStatus({ property }: { property: PropertyUnitBuilder }) {
  const { data, isLoading, error } = useQuery<{ count: number | null; items: any[] }>({
    queryKey: ["/api/lodgify/properties"],
  });

  if (isLoading) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking Lodgify sync status...
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <XCircle className="h-4 w-4" />
          Could not connect to Lodgify
        </div>
      </Card>
    );
  }

  const lodgifyProps = data?.items || [];
  const matchingProp = lodgifyProps.find((p: any) => {
    const name = (p.name || "").toLowerCase();
    const complexLower = property.complexName.toLowerCase();
    const propNameLower = property.propertyName.toLowerCase();
    return name.includes(complexLower) || complexLower.includes(name) ||
           name.includes(propNameLower) || propNameLower.includes(name);
  });

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        {matchingProp ? (
          <>
            <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium">Found in Lodgify</p>
              <p className="text-sm text-muted-foreground mt-0.5">
                Matched: "{matchingProp.name}" (ID: {matchingProp.id})
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                You can update this property's details in Lodgify using the copied data below.
              </p>
            </div>
          </>
        ) : (
          <>
            <XCircle className="h-5 w-5 text-orange-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium">Not yet in Lodgify</p>
              <p className="text-sm text-muted-foreground mt-0.5">
                This property needs to be created in Lodgify. Use the data below to set it up.
              </p>
              {lodgifyProps.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Your Lodgify account has {lodgifyProps.length} existing properties.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function LodgifyEntryGuide() {
  return (
    <Card className="p-4">
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
        <ClipboardList className="h-4 w-4" />
        Step-by-Step Lodgify Entry Guide
      </h3>
      <div className="space-y-3">
        {[
          {
            step: 1,
            title: "Create New Property",
            desc: "In Lodgify, go to Properties and click 'Add Property'. Choose 'Apartment' or 'Condo' as the property type.",
          },
          {
            step: 2,
            title: "Set Property Name",
            desc: "Use the Booking Title above as the property name in Lodgify.",
          },
          {
            step: 3,
            title: "Add Description",
            desc: "Go to the Description section. Copy the Combined Property Description above and paste it as the main listing text. This single description covers all units in the listing.",
          },
          {
            step: 4,
            title: "Configure Rooms",
            desc: "Set the number of bedrooms, bathrooms, and max guests. Add bed types for each room using the Room Configuration info.",
          },
          {
            step: 5,
            title: "Select Amenities",
            desc: "Go to Rental Amenities. Use the checklist in the Amenities tab to check off each amenity. Categories match Lodgify's layout.",
          },
          {
            step: 6,
            title: "Upload Photos",
            desc: "Click 'Download Photos to Folder' to save all photos in order. Then drag and drop the entire folder into Lodgify's photo upload area. The first photo (marked 'Main') should be set as the cover image.",
          },
          {
            step: 7,
            title: "Set Location & Pricing",
            desc: "Add the property address, set your nightly rates, cleaning fees, and minimum stay requirements.",
          },
          {
            step: 8,
            title: "Publish",
            desc: "Review all details, then activate the listing. Connect to channels (Airbnb, VRBO, Booking.com) if desired.",
          },
        ].map((item) => (
          <div key={item.step} className="flex gap-3" data-testid={`guide-step-${item.step}`}>
            <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
              {item.step}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">{item.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function PricingSummaryCard({ pricing }: { pricing: PropertyPricing }) {
  return (
    <Card className="p-4">
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
        <DollarSign className="h-4 w-4" />
        Buy-In & Sell Rate Summary
      </h3>
      <p className="text-xs text-muted-foreground mb-4">
        Average Airbnb buy-in rate (including taxes & fees) marked up 20%.
      </p>

      <div className="space-y-3">
        {pricing.units.map((unit) => (
          <div key={unit.unitId} className="flex items-center justify-between gap-4 py-2 border-b last:border-b-0" data-testid={`pricing-unit-${unit.unitId}`}>
            <div className="min-w-0">
              <p className="text-sm font-medium">{unit.unitLabel}</p>
              <p className="text-xs text-muted-foreground">{unit.bedrooms}BR in {unit.community}</p>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-xs text-muted-foreground">Buy-in: ${unit.baseBuyIn}/night</p>
              <p className="text-sm font-bold text-green-700 dark:text-green-400">Sell: ${unit.baseSellRate}/night</p>
            </div>
          </div>
        ))}

        <div className="flex items-center justify-between gap-4 pt-2 border-t-2">
          <div>
            <p className="text-sm font-bold">Combined Total</p>
            <p className="text-xs text-muted-foreground">{pricing.units.length} units</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Buy-in: ${pricing.totalBaseBuyIn}/night</p>
            <p className="text-base font-bold text-green-700 dark:text-green-400">Sell: ${pricing.totalBaseSellRate}/night</p>
          </div>
        </div>
      </div>
    </Card>
  );
}

function SeasonalityTable({ pricing }: { pricing: PropertyPricing }) {
  const months = pricing.units[0]?.monthlyRates || [];

  return (
    <Card className="p-4">
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
        <TrendingUp className="h-4 w-4" />
        24-Month Rate Schedule (Feb 2026 - Jan 2028)
      </h3>
      <p className="text-xs text-muted-foreground mb-4">
        Seasonal rates based on Hawaii vacation rental demand patterns. High season: Dec-Mar & Jul-Aug. Low season: Sep-Nov.
      </p>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 bg-background z-10 min-w-[120px]">Month</TableHead>
              <TableHead className="min-w-[70px]">Season</TableHead>
              {pricing.units.map((unit) => (
                <TableHead key={`buy-${unit.unitId}`} className="min-w-[100px] text-right">
                  {unit.unitLabel} Buy-In
                </TableHead>
              ))}
              {pricing.units.map((unit) => (
                <TableHead key={`sell-${unit.unitId}`} className="min-w-[100px] text-right">
                  {unit.unitLabel} Sell
                </TableHead>
              ))}
              <TableHead className="min-w-[100px] text-right">Total Buy-In</TableHead>
              <TableHead className="min-w-[100px] text-right font-bold">Total Sell</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {months.map((monthData, idx) => {
              const totalBuyIn = pricing.units.reduce((sum, u) => sum + u.monthlyRates[idx].buyInRate, 0);
              const totalSell = pricing.units.reduce((sum, u) => sum + u.monthlyRates[idx].sellRate, 0);

              return (
                <TableRow key={`${monthData.month}-${monthData.year}`} data-testid={`rate-row-${idx}`}>
                  <TableCell className="sticky left-0 bg-background z-10 font-medium text-sm">
                    {monthData.month} {monthData.year}
                  </TableCell>
                  <TableCell>
                    <Badge variant={getSeasonBadgeVariant(monthData.season)} className="text-xs">
                      {getSeasonLabel(monthData.season)}
                    </Badge>
                  </TableCell>
                  {pricing.units.map((unit) => (
                    <TableCell key={`buy-${unit.unitId}`} className="text-right text-sm text-muted-foreground">
                      ${unit.monthlyRates[idx].buyInRate}
                    </TableCell>
                  ))}
                  {pricing.units.map((unit) => (
                    <TableCell key={`sell-${unit.unitId}`} className="text-right text-sm font-medium">
                      ${unit.monthlyRates[idx].sellRate}
                    </TableCell>
                  ))}
                  <TableCell className="text-right text-sm text-muted-foreground">
                    ${totalBuyIn}
                  </TableCell>
                  <TableCell className="text-right text-sm font-bold text-green-700 dark:text-green-400">
                    ${totalSell}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function PushRatesToLodgify({ pricing }: { pricing: PropertyPricing }) {
  const [lodgifyId, setLodgifyId] = useState("");
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const combinedRates = pricing.units[0]?.monthlyRates.map((rate, idx) => {
    const totalSell = pricing.units.reduce((sum, u) => sum + u.monthlyRates[idx].sellRate, 0);
    return {
      month: rate.month,
      year: rate.year,
      sellRate: totalSell,
      season: rate.season,
      minStay: rate.season === "high" ? 7 : 5,
    };
  }) || [];

  const handlePush = async () => {
    if (!lodgifyId.trim()) return;

    setPushing(true);
    setResult(null);

    try {
      const response = await apiRequest("POST", "/api/lodgify/push-rates", {
        lodgifyPropertyId: lodgifyId.trim(),
        rates: combinedRates,
      });

      const data = await response.json();

      if (data.success) {
        const roomSummary = data.results?.map((r: any) => `"${r.roomTypeName}" (${r.periodsSubmitted} periods)`).join(", ") || "";
        setResult({
          success: true,
          message: `Rates pushed to Lodgify property ${lodgifyId}. ${data.roomTypesProcessed} room type(s) updated: ${roomSummary}.`,
        });
      } else {
        const failedRooms = data.results?.filter((r: any) => !r.success).map((r: any) => r.roomTypeName).join(", ") || "";
        setResult({
          success: false,
          message: data.error || `Some room types failed: ${failedRooms}`,
        });
      }
    } catch (err: any) {
      let errorMsg = "Failed to push rates to Lodgify";
      try {
        const errData = JSON.parse(err.message || "{}");
        errorMsg = errData.error || errData.message || errorMsg;
      } catch {
        if (err.message) errorMsg = err.message;
      }
      setResult({ success: false, message: errorMsg });
    } finally {
      setPushing(false);
    }
  };

  return (
    <Card className="p-4">
      <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
        <Upload className="h-4 w-4" />
        Push Rates to Lodgify
      </h3>
      <p className="text-xs text-muted-foreground mb-4">
        Enter your Lodgify property ID and push the current 24-month sell rates directly to Lodgify. This sets nightly rates for each month based on the seasonal schedule above.
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-3">
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Lodgify Property ID
          </label>
          <Input
            type="text"
            placeholder="e.g. 766525"
            value={lodgifyId}
            onChange={(e) => setLodgifyId(e.target.value)}
            data-testid="input-lodgify-property-id"
          />
        </div>
        <Button
          onClick={handlePush}
          disabled={!lodgifyId.trim() || pushing}
          data-testid="button-push-rates"
        >
          {pushing ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Upload className="h-4 w-4 mr-2" />
          )}
          {pushing ? "Pushing..." : "Push Rates to Lodgify"}
        </Button>
      </div>

      {result && (
        <div
          className={`flex items-start gap-2 p-3 rounded-md text-sm ${
            result.success
              ? "bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300"
              : "bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300"
          }`}
          data-testid="text-push-result"
        >
          {result.success ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          )}
          <span>{result.message}</span>
        </div>
      )}

      <div className="mt-3 text-xs text-muted-foreground">
        <p>Combined nightly sell rate being pushed: ${combinedRates[0]?.sellRate || 0} - ${combinedRates[combinedRates.length - 1]?.sellRate || 0}/night (varies by season)</p>
        <p className="mt-1">Minimum stay: 7 nights (high season), 5 nights (mid/low season)</p>
      </div>
    </Card>
  );
}

function getAverageSqft(property: PropertyUnitBuilder): string {
  const nums = property.units.map((u) => {
    const n = parseInt(u.sqft.replace(/[^0-9]/g, ""), 10);
    return isNaN(n) ? 0 : n;
  }).filter((n) => n > 0);
  if (nums.length === 0) return "N/A";
  const avg = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  return `~${avg.toLocaleString()} sq ft`;
}

export default function LodgifyPrep() {
  const params = useParams<{ id: string }>();
  const propertyId = parseInt(params.id || "0", 10);
  const property = getUnitBuilderByPropertyId(propertyId);
  const pricing = getPropertyPricing(propertyId);

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
            <p className="text-muted-foreground mt-2">No data exists for this property.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1400px] mx-auto px-4 py-6">
        <div className="flex flex-wrap items-center gap-2 mb-6">
          <Link href="/">
            <Button variant="ghost" size="sm" data-testid="button-back-dashboard">
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Dashboard
            </Button>
          </Link>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <Link href={`/unit-builder/${propertyId}`}>
            <Button variant="ghost" size="sm" data-testid="button-back-unit-builder">
              Unit Builder
            </Button>
          </Link>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Prepare for Lodgify</span>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
            Prepare for Lodgify
          </h1>
          <p className="text-muted-foreground mt-1">
            {property.propertyName} - {property.complexName}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          <div className="lg:col-span-2">
            <LodgifySyncStatus property={property} />
          </div>
          <div className="space-y-4">
            <CopyField label="Property Address" value={property.address} />
            <CopyField label="Average Square Footage" value={getAverageSqft(property)} />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <div className="lg:col-span-2">
            <CopyField label="Booking Title" value={property.bookingTitle} />
          </div>
          <LodgifyEntryGuide />
        </div>

        <div className="mb-6">
          <CopyField label="Combined Property Description (copy into Lodgify)" value={property.combinedDescription} multiline />
        </div>

        {pricing && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
              <PricingSummaryCard pricing={pricing} />
              <div className="lg:col-span-2">
                <SeasonalityTable pricing={pricing} />
              </div>
            </div>
            <div className="mb-6">
              <PushRatesToLodgify pricing={pricing} />
            </div>
          </>
        )}

        <div className="mb-6">
          <CommunityPhotosSection property={property} />
        </div>

        <div className="space-y-6">
          {property.units.map((unit) => (
            <UnitPrepCard
              key={unit.id}
              unit={unit}
              complexName={property.complexName}
              propertyId={propertyId}
            />
          ))}
        </div>

        <div className="mt-6 text-xs text-muted-foreground text-center">
          Data prepared for manual entry into Lodgify. Use copy buttons to transfer each field.
        </div>
      </div>
    </div>
  );
}
