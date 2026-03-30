import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Search, Copy, ExternalLink, ImageOff, CheckSquare, Square, FolderDown, Loader2 } from "lucide-react";

const COMMUNITIES = [
  "Regency at Poipu Kai",
  "Kekaha Beachfront Estate",
  "Keauhou Estates",
  "Mauna Kai Princeville",
  "Kaha Lani Resort",
  "Lae Nani Resort",
  "Poipu Brenneckes Beachside",
  "Kaiulani of Princeville",
  "Poipu Brenneckes Oceanfront",
  "Pili Mai",
];

const COMMUNITY_FOLDERS: Record<string, string> = {
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

interface PhotoResult {
  url: string;
  thumbnail: string;
  title: string;
  source: string;
  sourceLink: string;
  width?: number;
  height?: number;
  score: number;
}

export default function CommunityPhotoFinder() {
  const { toast } = useToast();
  const [selectedCommunity, setSelectedCommunity] = useState<string>("");
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<PhotoResult[]>([]);
  const [checkedCommunity, setCheckedCommunity] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ saved: number; failed: number } | null>(null);
  const [photoSource, setPhotoSource] = useState<"listing" | "search" | null>(null);

  async function handleSearch() {
    if (!selectedCommunity) return;
    setIsSearching(true);
    setResults([]);
    setSelected(new Set());
    setFailedImages(new Set());
    setSaveResult(null);
    setPhotoSource(null);

    try {
      const params = new URLSearchParams({ communityName: selectedCommunity });
      const resp = await fetch(`/api/community-photos/search?${params.toString()}`);
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || "Search failed");
      }
      const data = await resp.json();
      setResults(data.results || []);
      setCheckedCommunity(selectedCommunity);
      setPhotoSource(data.source === "listing" ? "listing" : "search");
      if ((data.results || []).length === 0) {
        toast({ title: "No results found", description: "Try a different community or refine your search.", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Search failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSearching(false);
    }
  }

  function toggleSelect(url: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(results.map(r => r.url)));
  }

  function clearAll() {
    setSelected(new Set());
  }

  function copySelectedUrls() {
    const urls = results.filter(r => selected.has(r.url)).map(r => r.url).join("\n");
    navigator.clipboard.writeText(urls).then(() => {
      toast({ title: `Copied ${selected.size} URL${selected.size !== 1 ? "s" : ""}`, description: "URLs copied to clipboard." });
    });
  }

  function openSelected() {
    results.filter(r => selected.has(r.url)).forEach(r => {
      window.open(r.url, "_blank", "noopener");
    });
  }

  async function saveToProject() {
    if (!checkedCommunity || selected.size === 0) return;
    const folder = COMMUNITY_FOLDERS[checkedCommunity];
    if (!folder) {
      toast({ title: "No folder mapped for this community", variant: "destructive" });
      return;
    }
    setIsSaving(true);
    setSaveResult(null);
    try {
      const imageUrls = results.filter(r => selected.has(r.url)).map(r => r.url);
      const resp = await fetch("/api/community-photos/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ communityFolder: folder, imageUrls }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Save failed");
      setSaveResult({ saved: data.saved.length, failed: data.failed.length });
      toast({
        title: `Saved ${data.saved.length} photo${data.saved.length !== 1 ? "s" : ""} to project`,
        description: data.failed.length > 0 ? `${data.failed.length} photo(s) could not be downloaded.` : "Community folder updated successfully.",
      });
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  }

  function markImageFailed(url: string) {
    setFailedImages(prev => new Set(prev).add(url));
  }

  const visibleResults = results.filter(r => !failedImages.has(r.url));

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-6">

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link href="/">
            <Button variant="ghost" size="sm" data-testid="button-back-home">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Home
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
              Community Photo Finder
            </h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              Find accurate resort community photos — pools, grounds, buildings, aerial views
            </p>
          </div>
        </div>

        {/* Search controls */}
        <Card className="p-4 mb-6">
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
            <div className="flex-1">
              <label className="text-sm font-medium mb-1.5 block">Resort Community</label>
              <Select value={selectedCommunity} onValueChange={setSelectedCommunity}>
                <SelectTrigger data-testid="select-community" className="w-full">
                  <SelectValue placeholder="Select a community..." />
                </SelectTrigger>
                <SelectContent>
                  {COMMUNITIES.map(c => (
                    <SelectItem key={c} value={c} data-testid={`option-community-${c.toLowerCase().replace(/\s+/g, "-")}`}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={handleSearch}
              disabled={!selectedCommunity || isSearching}
              data-testid="button-search"
              className="sm:w-auto w-full"
            >
              {isSearching ? (
                <>
                  <div className="h-4 w-4 mr-2 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  Searching...
                </>
              ) : (
                <>
                  <Search className="h-4 w-4 mr-2" />
                  Find Photos
                </>
              )}
            </Button>
          </div>
          {isSearching && (
            <p className="text-sm text-muted-foreground mt-3" data-testid="text-search-status">
              Running 3 targeted searches for {selectedCommunity} — pool/grounds, aerial/exterior, amenities...
            </p>
          )}
        </Card>

        {/* Results */}
        {visibleResults.length > 0 && (
          <>
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <span className="text-sm font-medium" data-testid="text-result-count">
                {visibleResults.length} photos found for <strong>{checkedCommunity}</strong>
              </span>
              {photoSource === "listing" && (
                <Badge variant="secondary" className="text-xs" data-testid="badge-photo-source-listing">
                  Sourced from listing URL
                </Badge>
              )}
              {photoSource === "search" && (
                <Badge variant="outline" className="text-xs" data-testid="badge-photo-source-search">
                  Sourced from image search
                </Badge>
              )}
              <div className="ml-auto flex gap-2 flex-wrap">
                <Button variant="outline" size="sm" onClick={selectAll} data-testid="button-select-all">
                  <CheckSquare className="h-4 w-4 mr-1" />
                  Select All
                </Button>
                <Button variant="outline" size="sm" onClick={clearAll} data-testid="button-clear-all">
                  <Square className="h-4 w-4 mr-1" />
                  Clear
                </Button>
                {selected.size > 0 && (
                  <>
                    <Button
                      size="sm"
                      onClick={saveToProject}
                      disabled={isSaving}
                      data-testid="button-save-to-project"
                      className={saveResult ? "bg-green-600 hover:bg-green-700 text-white" : ""}
                    >
                      {isSaving ? (
                        <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Saving...</>
                      ) : saveResult ? (
                        <><FolderDown className="h-4 w-4 mr-1" />Saved {saveResult.saved} photos</>
                      ) : (
                        <><FolderDown className="h-4 w-4 mr-1" />Save {selected.size} to Project</>
                      )}
                    </Button>
                    <Button variant="outline" size="sm" onClick={copySelectedUrls} data-testid="button-copy-urls">
                      <Copy className="h-4 w-4 mr-1" />
                      Copy URLs
                    </Button>
                    <Button variant="outline" size="sm" onClick={openSelected} data-testid="button-open-selected">
                      <ExternalLink className="h-4 w-4 mr-1" />
                      Open
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3" data-testid="photo-grid">
              {visibleResults.map((photo, idx) => {
                const isSelected = selected.has(photo.url);
                return (
                  <div
                    key={photo.url}
                    className={`relative rounded-lg overflow-hidden border-2 cursor-pointer transition-all hover:shadow-md ${
                      isSelected ? "border-primary shadow-md" : "border-transparent"
                    }`}
                    onClick={() => toggleSelect(photo.url)}
                    data-testid={`photo-card-${idx}`}
                  >
                    {/* Checkbox overlay */}
                    <div className="absolute top-2 left-2 z-10">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleSelect(photo.url)}
                        className="bg-white/90 border-white shadow"
                        data-testid={`checkbox-photo-${idx}`}
                        onClick={e => e.stopPropagation()}
                      />
                    </div>

                    {/* Score badge */}
                    {photo.score >= 80 && (
                      <Badge className="absolute top-2 right-2 z-10 bg-green-600 text-white text-xs px-1.5 py-0.5">
                        Top
                      </Badge>
                    )}

                    {/* Thumbnail */}
                    <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden">
                      <img
                        src={photo.thumbnail}
                        alt={photo.title}
                        className="w-full h-full object-cover"
                        onError={() => markImageFailed(photo.url)}
                        data-testid={`img-photo-${idx}`}
                      />
                    </div>

                    {/* Info */}
                    <div className="p-2 bg-background">
                      <p className="text-xs font-medium leading-tight line-clamp-2 mb-1" title={photo.title} data-testid={`text-photo-title-${idx}`}>
                        {photo.title}
                      </p>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs text-muted-foreground truncate" data-testid={`text-photo-source-${idx}`}>
                          {photo.source}
                        </span>
                        <a
                          href={photo.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground shrink-0"
                          onClick={e => e.stopPropagation()}
                          data-testid={`link-photo-open-${idx}`}
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                      {photo.width && photo.height && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {photo.width}×{photo.height}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Empty state after search */}
        {!isSearching && checkedCommunity && visibleResults.length === 0 && results.length === 0 && (
          <div className="text-center py-16 text-muted-foreground" data-testid="text-no-results">
            <ImageOff className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">No community photos found</p>
            <p className="text-sm mt-1">The search couldn't locate verified photos for this community. Try again or choose a different community.</p>
          </div>
        )}

        {/* Intro empty state */}
        {!isSearching && !checkedCommunity && (
          <div className="text-center py-16 text-muted-foreground" data-testid="text-intro">
            <Search className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">Select a community and click Find Photos</p>
            <p className="text-sm mt-1 max-w-sm mx-auto">
              The tool searches for pool areas, grounds, building exteriors, and aerial views — not unit interiors or generic beach shots.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
