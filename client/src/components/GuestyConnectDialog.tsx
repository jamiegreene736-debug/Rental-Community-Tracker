import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Link as LinkIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { GuestyPropertyMap } from "@shared/schema";

type GuestyListing = {
  _id: string;
  nickname?: string;
  title?: string;
  address?: { full?: string };
};

type Props = {
  propertyId: number | null;
  propertyName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const unwrap = (d: any): GuestyListing[] => {
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.results)) return d.results;
  if (Array.isArray(d?.data)) return d.data;
  if (Array.isArray(d?.data?.results)) return d.data.results;
  return [];
};

export function GuestyConnectDialog({ propertyId, propertyName, open, onOpenChange }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const { data: listingsRaw, isLoading } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/listings?limit=200&fields=_id%20nickname%20title%20address.full"],
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const listings = useMemo(() => unwrap(listingsRaw), [listingsRaw]);

  const { data: propertyMap } = useQuery<GuestyPropertyMap[]>({
    queryKey: ["/api/guesty-property-map"],
    enabled: open,
  });
  const mappedListingIds = useMemo(() => {
    if (!propertyMap) return new Map<string, number>();
    return new Map(propertyMap.map((m) => [m.guestyListingId, m.propertyId]));
  }, [propertyMap]);

  useEffect(() => { if (!open) setQuery(""); }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return listings;
    return listings.filter((l) => {
      const fields = [l.nickname, l.title, l.address?.full].filter(Boolean) as string[];
      return fields.some((f) => f.toLowerCase().includes(q));
    });
  }, [listings, query]);

  const connect = async (listing: GuestyListing) => {
    if (propertyId == null || saving) return;
    setSaving(listing._id);
    try {
      const r = await apiRequest("POST", "/api/guesty-property-map", {
        propertyId,
        guestyListingId: listing._id,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${r.status}`);
      }
      await qc.invalidateQueries({ queryKey: ["/api/guesty-property-map"] });
      await qc.invalidateQueries({ queryKey: ["/api/dashboard/channel-status"] });
      toast({
        title: "Connected to Guesty",
        description: `${propertyName} → ${listing.nickname || listing.title || listing._id}`,
      });
      onOpenChange(false);
    } catch (err: any) {
      toast({
        title: "Connect failed",
        description: err?.message || "Could not save the mapping.",
        variant: "destructive",
      });
    } finally {
      setSaving(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect to a Guesty listing</DialogTitle>
          <DialogDescription>
            Pick the existing Guesty listing for <strong>{propertyName}</strong>. The
            dashboard's G-dot will turn green and channel-status, bookings, and
            inbox will all light up off this mapping.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter by nickname, title, or address…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
            data-testid="input-guesty-connect-search"
          />
        </div>

        <div className="max-h-[60vh] overflow-y-auto rounded-md border">
          {isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading listings…</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              {listings.length === 0 ? "No Guesty listings found." : "No matches for that filter."}
            </div>
          ) : (
            <ul className="divide-y">
              {filtered.map((l) => {
                const name = l.nickname || l.title || l._id;
                const sub = [l.title && l.title !== name ? l.title : null, l.address?.full]
                  .filter(Boolean)
                  .join(" · ");
                const claimedBy = mappedListingIds.get(l._id);
                const claimedByOther = claimedBy != null && claimedBy !== propertyId;
                return (
                  <li key={l._id} className="flex items-center gap-3 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{name}</div>
                      {sub && <div className="text-xs text-muted-foreground truncate">{sub}</div>}
                      {claimedByOther && (
                        <div className="text-[11px] text-amber-700 mt-0.5">
                          Already mapped to property #{claimedBy}. Connecting here adds a
                          second mapping — both properties would share this listing.
                        </div>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1"
                      onClick={() => connect(l)}
                      disabled={saving !== null}
                      data-testid={`button-guesty-connect-${l._id}`}
                    >
                      <LinkIcon className="h-3 w-3" />
                      {saving === l._id ? "Connecting…" : "Connect"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
