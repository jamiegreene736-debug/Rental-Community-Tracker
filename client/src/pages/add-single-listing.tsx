// CODEX NOTE (2026-05-04, claude/single-listing):
// Add-Single-Listing wizard. Mirrors `add-community.tsx` but for a
// STANDALONE condo/townhouse — one unit, not a combo. Reuses the
// same backend endpoints (community/save, community/generate-listing,
// community/fetch-unit-photos, community/persist-photos,
// community/refresh-pricing, community/persist-community-photos)
// with the new `singleListing: true` flag where supported.
//
// Operator-driven differences vs. add-community:
//   - Step 1 is a city-first discovery flow: nationwide city
//     autocomplete (scoped to Hawaii + Florida — see Load-Bearing
//     #35) → top-20 community research scan via
//     /api/community/research → operator picks a community → typed
//     street address for the OTA qualifier.
//   - Step 2 is the OTA-clean QUALIFIER — calls
//     /api/single-listing/qualify to verify the address is NOT
//     listed on Airbnb / VRBO / Booking. If any platform shows a
//     confirmed match, the property doesn't qualify and the wizard
//     hard-blocks save.
//   - Step 3 photos: only Unit A (no Unit B).
//   - Step 4 listing draft: single-unit prompt (no walking distance,
//     no "two units" framing).
//
// Save shape: unit2_* fields stay null. `singleListing: true` is
// persisted on the draft so downstream adapters (home.tsx,
// adapt-draft.ts) know to render it as a single-unit property.

import { useState, useCallback, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ArrowLeft,
  ArrowRight,
  MapPin,
  Search,
  Loader2,
  CheckCircle2,
  XCircle,
  Building2,
  BedDouble,
  Camera,
  FileText,
  ShieldCheck,
  ShieldX,
  ExternalLink,
  Star,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { BUY_IN_RATES, suggestPricingArea } from "@shared/pricing-rates";

// 4 steps. Step 1 collapses location + community research into one
// screen — city autocomplete kicks off /api/community/research and
// the operator picks a top community without leaving the screen.
const STEPS = ["Property", "OTA Check", "Photos", "Listing Draft"];

type CitySuggestion = { city: string; state: string };

type CommunityResult = {
  name: string;
  city: string;
  state: string;
  estimatedLowRate: number | null;
  estimatedHighRate: number | null;
  unitTypes: string;
  confidenceScore: number;
  researchSummary: string;
  sourceUrl: string;
  bedroomMix?: string;
  combinedBedroomsTypical?: number;
  combinabilityScore?: number;
  fromWorldKnowledge?: boolean;
  // CODEX NOTE (2026-05-04, claude/single-listing-bedroom-list):
  // From the single-mode research prompt — the actual bedroom
  // counts this community offers. Wizard uses this to render
  // valid bedroom buttons instead of a generic 1-5 picker.
  availableBedrooms?: number[];
  // CODEX NOTE (2026-05-04, claude/single-listing-cap-10-biggest):
  // Rough total condo/townhouse unit count for the resort.
  // Wizard sorts by this descending and shows the top 10
  // biggest communities per city. Optional — falls back to 0
  // for sort key when missing.
  estimatedTotalUnits?: number;
};

type QualifierPlatformResult = {
  listed: boolean;
  matches: Array<{ url: string; title: string; snippet: string }>;
  // CODEX NOTE (2026-05-04, claude/single-listing-photo-qualifier):
  // photoMatches surfaces Google Lens hits where one of our scraped
  // Zillow photos appears on a competitor's listing page. A platform
  // counts as "listed" when EITHER text matches (address in
  // title/snippet) OR photoMatches (reverse-image-search hit) is
  // non-empty.
  photoMatches: string[];
  query: string;
  error?: string;
};

type QualifierResult = {
  qualifies: boolean;
  platforms: {
    airbnb: QualifierPlatformResult;
    vrbo: QualifierPlatformResult;
    booking: QualifierPlatformResult;
  };
  reason: string;
  photoChecksRun?: number;
};

type PhotoItem = { url: string; label: string };

type UnitDraft = {
  bedrooms: number;
  bathrooms: string;
  sqft: string;
  maxGuests: number;
  bedding: string;
  shortDescription: string;
  longDescription: string;
};

type ListingDraft = {
  title: string;
  bookingTitle?: string;
  propertyType?: string;
  description: string;
  summary?: string;
  space?: string;
  neighborhood?: string;
  transit?: string;
  unitA?: UnitDraft | null;
  combinedBedrooms: number;
  suggestedRate: number;
  strPermitSample?: string;
  warning?: string;
};

export default function AddSingleListing() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState(1);

  // Step 1 — City picker → community research → address
  const [cityInput, setCityInput] = useState("");
  const [pickedCity, setPickedCity] = useState<CitySuggestion | null>(null);
  const [citySuggestions, setCitySuggestions] = useState<CitySuggestion[]>([]);
  const [citySuggestionsLoading, setCitySuggestionsLoading] = useState(false);
  const [showCitySuggestions, setShowCitySuggestions] = useState(false);
  const cityDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cityRequestSeqRef = useRef(0);

  // Top-20 community research for the picked city.
  const [communities, setCommunities] = useState<CommunityResult[]>([]);
  const [researchLoading, setResearchLoading] = useState(false);
  const [selectedCommunity, setSelectedCommunity] = useState<CommunityResult | null>(null);

  // CODEX NOTE (2026-05-04, claude/single-listing-find-unit):
  // streetAddress / propertyName are no longer operator-typed.
  // After picking a community + bedroom count, the wizard calls
  // /api/single-listing/find-clean-unit which auto-discovers a
  // qualifying Zillow listing (matching BR + clean across OTAs)
  // and fills these in. `manualMode` is kept as an escape hatch
  // for cases where the operator wants to type the address by hand
  // (rare — e.g. when a known resort isn't on Zillow yet).
  const [streetAddress, setStreetAddress] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [manualMode, setManualMode] = useState(false);
  // CODEX NOTE (2026-05-05, claude/any-bedroom): "any" is a valid
  // selection that tells find-clean-unit to skip the bedroom-match
  // gate. Used when the operator wants the broadest pool, e.g. for
  // resorts where Claude's typical-mix research came back narrow.
  const [selectedBedrooms, setSelectedBedrooms] = useState<number | "any" | null>(null);
  // CODEX NOTE (2026-05-05, claude/city-wide-search): when true,
  // skip the community picker entirely and search the whole city
  // for any condo. Mutually exclusive with selectedCommunity.
  const [cityWideMode, setCityWideMode] = useState(false);

  // Auto-discovery results from /api/single-listing/find-clean-unit
  type FindAttempt = {
    url: string;
    bedrooms: number | null;
    bathrooms: number | null;
    address: string | null;
    bedroomMatches: boolean;
    qualifies: boolean | null;
    qualifierReason: string | null;
    rejectedBecause: string;
  };
  type FindResult =
    | {
        found: true;
        unit: {
          url: string;
          address: string;
          bedrooms: number;
          bathrooms: number | null;
          photos: Array<{ url: string; label: string }>;
          qualifier: QualifierResult;
          // Legacy flag from the earlier text-only fallback. Current
          // server accepts auto-discovered units only after photos
          // scrape and pass the reverse-image OTA check.
          photoScrapeFailed?: boolean;
        };
        attempts: FindAttempt[];
        attemptCount: number;
        totalCandidates: number;
      }
    | {
        found: false;
        reason: string;
        attempts: FindAttempt[];
        attemptCount: number;
        totalCandidates: number;
      };
  const [findLoading, setFindLoading] = useState(false);
  const [findResult, setFindResult] = useState<FindResult | null>(null);
  const [skipUrls, setSkipUrls] = useState<string[]>([]);
  // CODEX NOTE (2026-05-05, claude/find-eta-cancel): track an
  // AbortController for the active find-clean-unit fetch so the
  // operator can cancel a long city-wide search in flight. Reset
  // to null when the fetch completes / fails / aborts.
  const findAbortRef = useRef<AbortController | null>(null);
  // ETA tracking: timestamp of the search start + per-candidate
  // completion log used to compute average time-per-candidate.
  // Display logic: avg-time-per-processed × candidates-remaining,
  // shown alongside the progress bar.
  const findStartedAtRef = useRef<number | null>(null);
  const candidateCompletionsRef = useRef<number[]>([]);
  const [findEtaMs, setFindEtaMs] = useState<number | null>(null);

  // CODEX NOTE (2026-05-04, claude/find-clean-unit-streaming):
  // Live progress state populated by the NDJSON stream from
  // /api/single-listing/find-clean-unit. Events received:
  //   discovery-start / discovery-done / candidate-start /
  //   candidate-scrape / candidate-rejected / candidate-qualifier /
  //   candidate-qualifier-done / result.
  // Drives the Step 1 progress bar so the operator can see the
  // wizard walk Zillow candidates in real time instead of staring
  // at a generic spinner for 30-180 seconds.
  type CandidateProgress = {
    url: string;
    index: number;
    total: number;
    phase: "scraping" | "checking-ota" | "rejected" | "clean";
    detail?: string;
  };
  const [findProgress, setFindProgress] = useState<{
    // CODEX NOTE (2026-05-04, claude/verify-then-discover): added
    // "ota-indexing" phase + otaIndex / prefilteredCount fields so
    // the progress UI can show the verify-first step as a distinct
    // pre-discovery phase. Falls through to "candidates" once the
    // index is built (or skipped, when feature flag is off).
    phase: "discovering" | "ota-indexing" | "candidates" | "done";
    totalCandidates: number;
    candidatesProcessed: number;
    current: CandidateProgress | null;
    rejected: number;
    prefilteredCount: number;
    otaIndex?: { airbnb: number; vrbo: number; booking: number; addressTokens: number };
    // CODEX NOTE (2026-05-04, claude/single-listing-rejection-tally):
    // Running tally of rejection reasons, bucketed. Shown live
    // during the search so the operator sees WHY candidates are
    // being rejected (e.g. "10 Listed on OTA, 2 Wrong property
    // type") instead of staring at "12 rejected" with no context.
    // Buckets are derived from the reason string via the same
    // regex categorization the post-search diagnostic uses.
    rejectionsByReason: Record<string, number>;
  }>({
    phase: "discovering",
    totalCandidates: 0,
    candidatesProcessed: 0,
    current: null,
    rejected: 0,
    prefilteredCount: 0,
    rejectionsByReason: {},
  });

  // City autocomplete — nationwide endpoint scoped server-side to
  // Hawaii + Florida. Returns { city, state } pairs.
  useEffect(() => {
    if (cityDebounceRef.current) clearTimeout(cityDebounceRef.current);
    if (cityInput.trim().length < 2) {
      setCitySuggestions([]);
      setCitySuggestionsLoading(false);
      return;
    }
    setCitySuggestionsLoading(true);
    const mySeq = ++cityRequestSeqRef.current;
    cityDebounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/community/city-suggest-any?query=${encodeURIComponent(cityInput.trim())}`,
        );
        const data = await r.json();
        if (mySeq !== cityRequestSeqRef.current) return;
        setCitySuggestions(Array.isArray(data?.cities) ? data.cities : []);
      } catch {
        if (mySeq !== cityRequestSeqRef.current) return;
        setCitySuggestions([]);
      } finally {
        if (mySeq === cityRequestSeqRef.current) setCitySuggestionsLoading(false);
      }
    }, 250);
    return () => {
      if (cityDebounceRef.current) clearTimeout(cityDebounceRef.current);
    };
  }, [cityInput]);

  // Picking a city kicks off the top-20 community research call.
  // Mirrors add-community Step 2's research scan, but feeds the
  // single-listing flow instead of the combo flow. We treat the
  // returned CommunityResult.unitTypes as a hint — the operator
  // ultimately confirms the property type on Step 4.
  const pickCity = useCallback(async (s: CitySuggestion) => {
    setPickedCity(s);
    setCityInput(`${s.city}, ${s.state}`);
    setShowCitySuggestions(false);
    setSelectedCommunity(null);
    setCommunities([]);
    setManualMode(false);
    setCityWideMode(false);
    setCommunityInventory(null);
    setSelectedBedrooms(null);
    setFindResult(null);
    setSkipUrls([]);
    setStreetAddress("");
    setResearchLoading(true);
    try {
      const res = await apiRequest("POST", "/api/community/research", {
        city: s.city,
        state: s.state,
        // CODEX NOTE (2026-05-04, claude/single-listing-research):
        // mode=single drops the combinability filter, lifts the
        // world-knowledge cap to 15, and runs on Sonnet so niche
        // named resorts (e.g. Santa Maria Resort in Fort Myers
        // Beach) reliably surface in the top 20.
        mode: "single",
      });
      const data = await res.json();
      // CODEX NOTE (2026-05-04, claude/single-listing-cap-10-biggest):
      // Sort by estimatedTotalUnits desc and slice to top 10 so the
      // operator sees the biggest resorts first. Communities with no
      // unit estimate fall to the bottom (treated as 0).
      const list: CommunityResult[] = Array.isArray(data?.communities)
        ? [...data.communities]
            .sort(
              (a: CommunityResult, b: CommunityResult) =>
                (b.estimatedTotalUnits ?? 0) - (a.estimatedTotalUnits ?? 0),
            )
            .slice(0, 10)
        : [];
      setCommunities(list);
      if (list.length === 0) {
        toast({
          title: "No communities found",
          description: `Couldn't find vacation rental communities in ${s.city}, ${s.state}. You can still proceed by entering the property manually.`,
        });
      }
    } catch (e: any) {
      toast({ title: "Research failed", description: e.message, variant: "destructive" });
    } finally {
      setResearchLoading(false);
    }
  }, [toast]);

  // CODEX NOTE (2026-05-05, claude/community-inventory): inventory
  // state populated when the operator picks a community. Shows the
  // total Zillow listings for that resort so the operator has a
  // sanity check before clicking Find. If a resort has 8 total
  // listings and find-clean-unit rejects all 8, that's a real
  // signal (saturated resort), not a scrape bug.
  const [communityInventory, setCommunityInventory] = useState<{
    count: number;
    // CODEX NOTE (2026-05-05, claude/realtor-source): per-source
    // counts so the wizard can render "Zillow: 23 / Realtor: 18".
    // Optional — older cached responses (pre-2026-05-05) won't
    // have this; the wizard falls back to the combined count.
    byPlatform?: { zillow: number; realtor: number };
    sampleUrls: string[];
    loading: boolean;
  } | null>(null);

  const pickCommunity = useCallback(async (c: CommunityResult) => {
    setSelectedCommunity(c);
    setPropertyName(c.name);
    setManualMode(false);
    setCityWideMode(false);
    // Reset auto-discovery state when switching communities.
    setSelectedBedrooms(null);
    setFindResult(null);
    setSkipUrls([]);
    setStreetAddress("");
    // Kick off the inventory count in the background. Picked-city
    // is required (we need city + state for the search query); if
    // it's somehow missing we just skip the count.
    if (pickedCity) {
      setCommunityInventory({ count: 0, sampleUrls: [], loading: true });
      try {
        const res = await apiRequest("POST", "/api/single-listing/community-inventory", {
          communityName: c.name,
          city: pickedCity.city,
          state: pickedCity.state,
        });
        const data = await res.json();
        setCommunityInventory({
          count: typeof data.count === "number" ? data.count : 0,
          byPlatform: data.byPlatform && typeof data.byPlatform.zillow === "number" && typeof data.byPlatform.realtor === "number"
            ? { zillow: data.byPlatform.zillow, realtor: data.byPlatform.realtor }
            : undefined,
          sampleUrls: Array.isArray(data.sampleUrls) ? data.sampleUrls : [],
          loading: false,
        });
      } catch {
        setCommunityInventory(null);
      }
    } else {
      setCommunityInventory(null);
    }
  }, [pickedCity]);

  // Escape hatch for unit-types that don't show up in the research
  // scan (or markets where the scan returns nothing).
  const enterManualMode = useCallback(() => {
    setManualMode(true);
    setSelectedCommunity(null);
    setPropertyName("");
    setSelectedBedrooms(null);
    setFindResult(null);
    setSkipUrls([]);
  }, []);

  // ── Auto-discover a clean unit ────────────────────────────
  // Calls /api/single-listing/find-clean-unit which:
  //   1. Searches Zillow for {community, city, state, bedrooms}
  //   2. Iterates candidates (skipping any in skipUrlsArg), scrapes each
  //   3. Runs the OTA qualifier on each candidate's address
  //   4. Returns the first clean match (or { found: false, attempts })
  // The wizard advances to Step 2 to display the result.
  const findCleanUnit = useCallback(async (skipUrlsArg: string[] = []) => {
    if (!pickedCity || !selectedBedrooms) {
      toast({ title: "Pick a bedroom count first", variant: "destructive" });
      return;
    }
    if (!cityWideMode && !selectedCommunity) {
      toast({ title: "Pick a community or use 'Search entire city'", variant: "destructive" });
      return;
    }
    setFindLoading(true);
    setFindResult(null);
    setFindProgress({
      phase: "discovering",
      totalCandidates: 0,
      candidatesProcessed: 0,
      current: null,
      rejected: 0,
      rejectionsByReason: {},
      prefilteredCount: 0,
    });
    // Reset ETA tracking + abort controller for this run.
    findStartedAtRef.current = Date.now();
    candidateCompletionsRef.current = [];
    setFindEtaMs(null);
    if (findAbortRef.current) {
      try { findAbortRef.current.abort(); } catch { /* ignore */ }
    }
    findAbortRef.current = new AbortController();
    try {
      // CODEX NOTE (2026-05-04, claude/find-clean-unit-streaming):
      // Endpoint streams NDJSON progress events. We read the body
      // line-by-line, dispatch on event type to update the progress
      // bar state, and capture the terminal `result` event as the
      // FindResult that drives the rest of the wizard. Falls back
      // to whatever events arrived before disconnect if the stream
      // ends without a `result` event (network blip, etc).
      const resp = await fetch("/api/single-listing/find-clean-unit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: findAbortRef.current.signal,
        body: JSON.stringify({
          // CODEX NOTE (2026-05-05, claude/city-wide-search):
          // omit communityName when cityWideMode; server then
          // runs city-wide queries instead of community-anchored.
          ...(cityWideMode
            ? { cityWide: true }
            : { communityName: selectedCommunity?.name }),
          city: pickedCity.city,
          state: pickedCity.state,
          bedrooms: selectedBedrooms,
          skipUrls: skipUrlsArg,
        }),
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finalResult: FindResult | null = null;
      // Track per-URL state across events so we can render a
      // running list of candidates with their current phase.
      const candidateState = new Map<string, CandidateProgress>();

      // CODEX NOTE (2026-05-04, claude/single-listing-rejection-tally):
      // Categorize a rejection reason string into a stable bucket
      // label. Mirrors the post-search diagnostic categorization in
      // routes.ts (scrapeFailures / otaMatches / prefilterMatches /
      // wrongBR / stubs / wrongType / wrongStatus). Keep these
      // labels short — they render in the live progress UI.
      const bucketReason = (reason: string): string => {
        const r = reason || "";
        if (/^Pre-filtered/i.test(r)) return "Pre-filtered (on OTA index)";
        if (/^Listed on OTA/i.test(r)) return "Listed on Airbnb / VRBO / Booking";
        if (/^Wrong bedroom count/i.test(r)) return "Wrong bedroom count";
        if (/^Stub listing/i.test(r)) return "Stub / off-market listing";
        if (/^Wrong property (type|sub-type)/i.test(r)) return "Wrong property type";
        if (/^Listing status is/i.test(r)) return "Sold / auction / pending";
        if (/scrape (returned 0 photos|failed)/i.test(r)) return "Scrape failed";
        if (/Could not parse address/i.test(r)) return "Bad URL slug";
        return "Other";
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.type === "discovery-start") {
            setFindProgress((prev) => ({ ...prev, phase: "discovering" }));
          } else if (evt.type === "discovery-done") {
            setFindProgress((prev) => ({
              ...prev,
              totalCandidates: evt.totalCandidates ?? 0,
              // Phase stays "discovering" until either ota-index-start
              // fires (verify-first on) or we go straight to
              // "candidates" via the first candidate-start event.
            }));
          } else if (evt.type === "ota-index-start") {
            setFindProgress((prev) => ({ ...prev, phase: "ota-indexing" }));
          } else if (evt.type === "ota-index-done") {
            setFindProgress((prev) => ({
              ...prev,
              phase: "candidates",
              otaIndex: {
                airbnb: evt.counts?.airbnb ?? 0,
                vrbo: evt.counts?.vrbo ?? 0,
                booking: evt.counts?.booking ?? 0,
                addressTokens: evt.addressTokens ?? 0,
              },
            }));
          } else if (evt.type === "candidate-prefiltered") {
            // Pre-filter skip — candidate matched the OTA index
            // and was rejected without scraping. Bump processed +
            // rejected + prefilteredCount, surface in current row.
            const cp: CandidateProgress = {
              url: evt.url,
              index: evt.index,
              total: evt.total,
              phase: "rejected",
              detail: `Pre-filtered: ${evt.address ?? "address"} on OTA`,
            };
            candidateState.set(evt.url, cp);
            const bucket = bucketReason(String(evt.reason ?? "Pre-filtered"));
            setFindProgress((prev) => ({
              ...prev,
              phase: "candidates",
              candidatesProcessed: prev.candidatesProcessed + 1,
              rejected: prev.rejected + 1,
              prefilteredCount: prev.prefilteredCount + 1,
              current: cp,
              rejectionsByReason: {
                ...prev.rejectionsByReason,
                [bucket]: (prev.rejectionsByReason[bucket] ?? 0) + 1,
              },
            }));
          } else if (evt.type === "candidate-start") {
            const cp: CandidateProgress = {
              url: evt.url,
              index: evt.index,
              total: evt.total,
              phase: "scraping",
            };
            candidateState.set(evt.url, cp);
            // CODEX NOTE (2026-05-04, claude/single-listing-citywide-progress):
            // Bump phase to "candidates" here. In city-wide mode the
            // verify-first prefilter is OFF (ota-index-done never
            // fires), so without this the phase label is stuck at
            // "Discovering Zillow candidates…" forever even though
            // we're actually walking candidates.
            setFindProgress((prev) => ({
              ...prev,
              phase: "candidates",
              current: cp,
            }));
          } else if (evt.type === "candidate-scrape") {
            const existing = candidateState.get(evt.url);
            if (existing) {
              existing.detail = `Scraped ${evt.photoCount ?? 0} photo${evt.photoCount === 1 ? "" : "s"}`;
              candidateState.set(evt.url, existing);
              setFindProgress((prev) => prev.current?.url === evt.url ? { ...prev, current: { ...existing } } : prev);
            }
          } else if (evt.type === "candidate-rejected") {
            const existing = candidateState.get(evt.url);
            if (existing) {
              existing.phase = "rejected";
              existing.detail = String(evt.reason ?? "rejected");
              candidateState.set(evt.url, existing);
            }
            // CODEX NOTE (2026-05-05, claude/find-eta-cancel):
            // record this candidate's completion time for the
            // ETA calculation. ETA = avg (now - findStartedAt /
            // candidatesProcessed) × candidatesRemaining.
            candidateCompletionsRef.current.push(Date.now());
            const bucket = bucketReason(String(evt.reason ?? "rejected"));
            setFindProgress((prev) => {
              const next = {
                ...prev,
                candidatesProcessed: prev.candidatesProcessed + 1,
                rejected: prev.rejected + 1,
                current: existing ?? prev.current,
                rejectionsByReason: {
                  ...prev.rejectionsByReason,
                  [bucket]: (prev.rejectionsByReason[bucket] ?? 0) + 1,
                },
              };
              if (findStartedAtRef.current && next.totalCandidates > 0 && next.candidatesProcessed > 0) {
                const elapsed = Date.now() - findStartedAtRef.current;
                const avgPerCandidate = elapsed / next.candidatesProcessed;
                const remaining = next.totalCandidates - next.candidatesProcessed;
                setFindEtaMs(remaining > 0 ? Math.round(avgPerCandidate * remaining) : 0);
              }
              return next;
            });
          } else if (evt.type === "candidate-qualifier") {
            const existing = candidateState.get(evt.url);
            if (existing) {
              existing.phase = "checking-ota";
              existing.detail = "Checking Airbnb / VRBO / Booking";
              candidateState.set(evt.url, existing);
              setFindProgress((prev) => prev.current?.url === evt.url ? { ...prev, current: { ...existing } } : prev);
            }
          } else if (evt.type === "candidate-qualifier-done") {
            const existing = candidateState.get(evt.url);
            const listed = evt.listed || {};
            const listedNames = [
              listed.airbnb && "Airbnb",
              listed.vrbo && "VRBO",
              listed.booking && "Booking.com",
            ].filter(Boolean);
            if (existing) {
              existing.phase = evt.qualifies ? "clean" : "rejected";
              existing.detail = evt.qualifies
                ? "Clean of OTA listings"
                : `Listed on ${listedNames.join(", ")}`;
              candidateState.set(evt.url, existing);
            }
            candidateCompletionsRef.current.push(Date.now());
            // CODEX NOTE (2026-05-04, claude/single-listing-rejection-tally):
            // Bump the OTA-listed bucket only when the qualifier
            // came back not-qualifying. Successful qualifications
            // don't bump anything (they advance to the result).
            const otaBucket = !evt.qualifies ? "Listed on Airbnb / VRBO / Booking" : null;
            setFindProgress((prev) => {
              const next = {
                ...prev,
                candidatesProcessed: prev.candidatesProcessed + 1,
                rejected: evt.qualifies ? prev.rejected : prev.rejected + 1,
                current: existing ?? prev.current,
                rejectionsByReason: otaBucket
                  ? {
                      ...prev.rejectionsByReason,
                      [otaBucket]: (prev.rejectionsByReason[otaBucket] ?? 0) + 1,
                    }
                  : prev.rejectionsByReason,
              };
              if (findStartedAtRef.current && next.totalCandidates > 0 && next.candidatesProcessed > 0) {
                const elapsed = Date.now() - findStartedAtRef.current;
                const avgPerCandidate = elapsed / next.candidatesProcessed;
                const remaining = next.totalCandidates - next.candidatesProcessed;
                setFindEtaMs(remaining > 0 ? Math.round(avgPerCandidate * remaining) : 0);
              }
              return next;
            });
          } else if (evt.type === "result") {
            finalResult = evt as FindResult;
          }
        }
      }
      setFindProgress((prev) => ({ ...prev, phase: "done" }));

      if (!finalResult) {
        throw new Error("Stream ended without a result event");
      }
      const data: FindResult = finalResult;
      setFindResult(data);
      if (data.found) {
        // Pre-populate the downstream fields so Step 2/3/4 work without
        // any further operator typing.
        setStreetAddress(data.unit.address);
        setZillowSourceUrl(data.unit.url);
        setZillowFacts({
          bedrooms: data.unit.bedrooms,
          bathrooms: data.unit.bathrooms ?? undefined,
        });
        setQualifierResult(data.unit.qualifier);
        // CODEX NOTE (2026-05-04, claude/single-listing-photo-required):
        // Server-side find-clean-unit now hard-rejects 0-photo
        // candidates, so `data.unit.photos` should always be non-
        // empty when `found: true`. Belt-and-suspenders: if for any
        // reason it IS empty (e.g. an older deploy of the server
        // that didn't yet have the gate, or a future regression),
        // retry the scrape via /api/community/fetch-unit-photos
        // with the discovered URL before falling through to Step
        // 3's manual paste form.
        if (data.unit.photos.length > 0) {
          setUnit1Photos(data.unit.photos);
        } else {
          try {
            const retryRes = await apiRequest("POST", "/api/community/fetch-unit-photos", {
              url: data.unit.url,
            });
            const retry = await retryRes.json();
            const retryPhotos = Array.isArray(retry.photos) ? retry.photos.slice(0, 25) : [];
            setUnit1Photos(retryPhotos);
            // CODEX NOTE (2026-05-04, claude/single-listing-bath-display):
            // fetch-unit-photos returns `facts: { bedrooms?, bathrooms? }`
            // alongside photos (added in Load-Bearing #34's fold-in).
            // If the retry recovered facts the find-clean-unit scrape
            // missed, fold them into zillowFacts so the wizard shows
            // real BR/BA on Step 2 instead of "?".
            if (retry.facts && (retry.facts.bedrooms != null || retry.facts.bathrooms != null)) {
              setZillowFacts((prev) => ({
                bedrooms: retry.facts.bedrooms ?? prev.bedrooms,
                bathrooms: retry.facts.bathrooms ?? prev.bathrooms,
              }));
            }
            if (retryPhotos.length === 0) {
              toast({
                title: "Photos didn't scrape",
                description: "The unit qualifies but Zillow scrape came back empty. You can paste the Zillow URL manually on Step 3 if needed.",
              });
            }
          } catch (e: any) {
            console.warn(`[add-single-listing] photo retry failed: ${e?.message}`);
            setUnit1Photos([]);
          }
        }
        toast({
          title: "Found a clean unit",
          description: `${data.unit.bedrooms}BR at ${data.unit.address} — verified clean of OTA listings by address and photo check.`,
        });
        setStep(2);
      } else {
        toast({
          title: "No clean unit found",
          description: data.reason,
          variant: "destructive",
        });
      }
    } catch (e: any) {
      // CODEX NOTE (2026-05-05, claude/find-eta-cancel): swallow
      // AbortError silently — operator-initiated cancel doesn't
      // need a "Search failed" toast. Other errors still surface.
      if (e?.name === "AbortError") {
        toast({ title: "Search cancelled" });
      } else {
        toast({ title: "Search failed", description: e.message, variant: "destructive" });
      }
    } finally {
      setFindLoading(false);
      findAbortRef.current = null;
    }
  }, [pickedCity, selectedCommunity, selectedBedrooms, cityWideMode, toast]);

  // CODEX NOTE (2026-05-05, claude/find-eta-cancel): cancel handler
  // for the operator-facing "Cancel search" button. Aborts the
  // fetch via AbortController; the catch block surfaces a
  // "Search cancelled" toast and the finally block clears the ref.
  const cancelFind = useCallback(() => {
    if (findAbortRef.current) {
      try { findAbortRef.current.abort(); } catch { /* ignore */ }
    }
  }, []);

  const tryAnotherUnit = useCallback(() => {
    if (findResult?.found) {
      const newSkip = [...skipUrls, findResult.unit.url];
      setSkipUrls(newSkip);
      findCleanUnit(newSkip);
    }
  }, [findResult, skipUrls, findCleanUnit]);

  // Step 2 — OTA qualifier
  const [qualifierLoading, setQualifierLoading] = useState(false);
  const [qualifierResult, setQualifierResult] = useState<QualifierResult | null>(null);

  // Step 3 — Zillow URL + photos
  const [zillowUrl, setZillowUrl] = useState("");
  const [unit1Photos, setUnit1Photos] = useState<PhotoItem[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [zillowFacts, setZillowFacts] = useState<{ bedrooms?: number; bathrooms?: number }>({});
  const [zillowSourceUrl, setZillowSourceUrl] = useState("");
  // CODEX NOTE (2026-05-04, claude/single-listing-step3-prefill):
  // Tracks whether Step 3 already auto-fired a third photo-fetch
  // attempt against the discovered URL. Without this guard, the
  // useEffect below would re-fire on every render and could loop
  // when the scrape persistently fails.
  const [step3AutoRetryFired, setStep3AutoRetryFired] = useState(false);

  // Step 4 — Listing draft
  const [listing, setListing] = useState<ListingDraft | null>(null);
  const [listingLoading, setListingLoading] = useState(false);
  const [editedTitle, setEditedTitle] = useState("");
  const [editedBookingTitle, setEditedBookingTitle] = useState("");
  const [editedPropertyType, setEditedPropertyType] = useState<string>("Condominium");
  const [editedPricingArea, setEditedPricingArea] = useState<string>("");
  const [editedDescription, setEditedDescription] = useState("");
  const [editedNeighborhood, setEditedNeighborhood] = useState("");
  const [editedTransit, setEditedTransit] = useState("");
  const [editedUnitA, setEditedUnitA] = useState<UnitDraft | null>(null);
  const [strPermit, setStrPermit] = useState("");
  const [saving, setSaving] = useState(false);

  const bedrooms = zillowFacts.bedrooms ?? 0;
  // Same NET margin math as add-community.tsx — see that file for
  // the rationale (target 20% net after Airbnb's 15.5% take, hence
  // a ~1.42 sell markup).
  const NET_MARGIN_TARGET = 0.20;
  const AIRBNB_FEE = 0.155;
  const SELL_MARKUP = (1 + NET_MARGIN_TARGET) / (1 - AIRBNB_FEE);
  // Suggested base rate from a per-bedroom assumption — replaces
  // the combo flow's per-unit-Zillow-price math since a single
  // standalone has just one unit. 250/BR is a reasonable starting
  // point (matches Hawaii fallback in shared/pricing-rates).
  const baseRate = bedrooms > 0 ? bedrooms * 250 : 0;
  const suggestedRate = baseRate > 0 ? Math.round(baseRate * SELL_MARKUP) : 0;

  // ── Step 2: OTA qualifier ──────────────────────────────────
  const runQualifier = useCallback(async () => {
    if (!streetAddress.trim() || !pickedCity) {
      toast({ title: "Enter the full street address, city, and state first", variant: "destructive" });
      return;
    }
    setQualifierLoading(true);
    setQualifierResult(null);
    try {
      const res = await apiRequest("POST", "/api/single-listing/qualify", {
        address: streetAddress.trim(),
        city: pickedCity.city,
        state: pickedCity.state,
      });
      const data: QualifierResult = await res.json();
      setQualifierResult(data);
      if (data.qualifies) {
        toast({ title: "Qualifies as a standalone listing", description: "No matches on Airbnb, VRBO, or Booking.com." });
      } else {
        toast({
          title: "Does not qualify",
          description: data.reason,
          variant: "destructive",
        });
      }
    } catch (e: any) {
      toast({ title: "Qualifier check failed", description: e.message, variant: "destructive" });
    } finally {
      setQualifierLoading(false);
    }
  }, [streetAddress, pickedCity, toast]);

  // ── Step 3: Fetch photos from Zillow ───────────────────────
  const fetchZillowPhotos = useCallback(async () => {
    if (!zillowUrl.trim()) {
      toast({ title: "Paste a Zillow URL first", variant: "destructive" });
      return;
    }
    setPhotosLoading(true);
    setUnit1Photos([]);
    try {
      const res = await apiRequest("POST", "/api/community/fetch-unit-photos", {
        url: zillowUrl.trim(),
      });
      const data = await res.json();
      setUnit1Photos((data.photos || []).slice(0, 25));
      setZillowSourceUrl(data.sourceUrl || zillowUrl.trim());
      if (data.facts && (data.facts.bedrooms != null || data.facts.bathrooms != null)) {
        setZillowFacts((prev) => ({
          bedrooms: data.facts.bedrooms ?? prev.bedrooms,
          bathrooms: data.facts.bathrooms ?? prev.bathrooms,
        }));
      }
      if ((data.photos || []).length === 0) {
        toast({ title: "No photos found", description: "Zillow returned no photos for that URL.", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Photo fetch failed", description: e.message, variant: "destructive" });
    } finally {
      setPhotosLoading(false);
    }
  }, [zillowUrl, toast]);

  // CODEX NOTE (2026-05-04, claude/single-listing-step3-prefill):
  // When the operator lands on Step 3 with photos still empty AND
  // we have a Zillow URL from the auto-discovery, pre-fill the URL
  // input and fire one more fetch attempt. This is the THIRD retry
  // (1: find-clean-unit's scrape, 2: findCleanUnit's belt-and-
  // suspenders fetch-unit-photos, 3: this one). Each attempt hits
  // the same Apify→ScrapingBee chain but at slightly different
  // times — sometimes one of them wins on a different cache state.
  // Guarded by step3AutoRetryFired so the effect doesn't loop.
  useEffect(() => {
    if (step !== 3) return;
    if (unit1Photos.length > 0) return;
    if (!zillowSourceUrl) return;
    if (step3AutoRetryFired) return;
    if (photosLoading) return;
    setStep3AutoRetryFired(true);
    setZillowUrl(zillowSourceUrl);
    // Defer the fetch so the URL state lands first; fetchZillowPhotos
    // reads `zillowUrl` from its closure.
    setTimeout(() => {
      (async () => {
        setPhotosLoading(true);
        try {
          const res = await apiRequest("POST", "/api/community/fetch-unit-photos", { url: zillowSourceUrl });
          const data = await res.json();
          const photos = Array.isArray(data.photos) ? data.photos.slice(0, 25) : [];
          setUnit1Photos(photos);
          if (data.facts && (data.facts.bedrooms != null || data.facts.bathrooms != null)) {
            setZillowFacts((prev) => ({
              bedrooms: data.facts.bedrooms ?? prev.bedrooms,
              bathrooms: data.facts.bathrooms ?? prev.bathrooms,
            }));
          }
        } catch (e: any) {
          console.warn(`[add-single-listing] Step 3 auto-retry failed: ${e?.message}`);
        } finally {
          setPhotosLoading(false);
        }
      })();
    }, 50);
  }, [step, unit1Photos.length, zillowSourceUrl, step3AutoRetryFired, photosLoading]);

  // ── Step 4: Generate listing draft ─────────────────────────
  const handleGenerateListing = useCallback(async () => {
    if (!propertyName.trim() && !streetAddress.trim()) {
      toast({ title: "Need a property name or address before generating", variant: "destructive" });
      return;
    }
    if (!pickedCity) {
      toast({ title: "Pick a city first", variant: "destructive" });
      return;
    }
    setListingLoading(true);
    try {
      const res = await apiRequest("POST", "/api/community/generate-listing", {
        // CODEX NOTE: `singleListing: true` flips the prompt + fallback
        // shape on the server — see /api/community/generate-listing.
        singleListing: true,
        communityName: propertyName.trim() || streetAddress.trim(),
        city: pickedCity.city,
        state: pickedCity.state,
        unit1: {
          bedrooms: bedrooms || 2,
          url: zillowSourceUrl,
          address: streetAddress.trim(),
        },
        suggestedRate,
      });
      const data: ListingDraft = await res.json();
      setListing(data);
      setEditedTitle(data.title || "");
      setEditedBookingTitle(data.bookingTitle || data.title || "");
      setEditedPropertyType(data.propertyType || "Condominium");
      setEditedDescription(data.description || "");
      setEditedNeighborhood(data.neighborhood || "");
      setEditedTransit(data.transit || "");
      setEditedUnitA(data.unitA ?? null);
      // Seed pricing-area suggestion from city/state (same logic as combo flow).
      if (!editedPricingArea) {
        const suggested = suggestPricingArea(pickedCity.city, pickedCity.state);
        if (suggested) setEditedPricingArea(suggested);
      }
      if (!strPermit && data.strPermitSample) {
        setStrPermit(data.strPermitSample);
      }
      if (data.warning) {
        toast({ title: "AI draft incomplete", description: data.warning, variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Listing generation failed", description: e.message, variant: "destructive" });
    } finally {
      setListingLoading(false);
    }
  }, [propertyName, streetAddress, pickedCity, bedrooms, zillowSourceUrl, suggestedRate, editedPricingArea, strPermit, toast]);

  // ── Save to dashboard ──────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!pickedCity) {
      toast({ title: "Missing city/state", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const saveResp = await apiRequest("POST", "/api/community/save", {
        // CODEX NOTE: standalone single-listing draft. unit2_* fields
        // intentionally null. `singleListing: true` flag tells the
        // dashboard adapter (home.tsx) and builder adapter
        // (adapt-draft.ts) to skip Unit B and render this as a
        // single-unit property.
        singleListing: true,
        name: propertyName.trim() || streetAddress.trim() || `${pickedCity.city} listing`,
        city: pickedCity.city,
        state: pickedCity.state,
        // Pass a unitTypes hint that satisfies checkCommunityType
        // (must contain "condo" or "townhouse"). The operator picks
        // the actual property type below; we tag the draft as a
        // condo by default since that's the most common standalone
        // case for this business.
        unitTypes: editedPropertyType?.toLowerCase().includes("townhouse") ? "townhouse" : "condominium",
        sourceUrl: zillowSourceUrl || null,
        unit1Url: zillowSourceUrl || null,
        unit1Bedrooms: bedrooms || null,
        unit1Bathrooms: editedUnitA?.bathrooms ?? (zillowFacts.bathrooms ? String(zillowFacts.bathrooms) : null),
        unit1Sqft: editedUnitA?.sqft ?? null,
        unit1MaxGuests: editedUnitA?.maxGuests ?? null,
        unit1Bedding: editedUnitA?.bedding ?? null,
        unit1ShortDescription: editedUnitA?.shortDescription ?? null,
        unit1LongDescription: editedUnitA?.longDescription ?? null,
        // unit2_* explicitly null — see CODEX NOTE above.
        unit2Url: null,
        unit2Bedrooms: null,
        unit2Bathrooms: null,
        unit2Sqft: null,
        unit2MaxGuests: null,
        unit2Bedding: null,
        unit2ShortDescription: null,
        unit2LongDescription: null,
        // For singles, "combinedBedrooms" == the single unit's bedrooms.
        // The dashboard adapter reads it via the same code path as combos.
        combinedBedrooms: bedrooms || null,
        suggestedRate: suggestedRate || null,
        listingTitle: editedTitle || null,
        bookingTitle: editedBookingTitle || null,
        propertyType: editedPropertyType || null,
        pricingArea: editedPricingArea || null,
        streetAddress: streetAddress.trim() || null,
        listingDescription: editedDescription || null,
        neighborhood: editedNeighborhood || null,
        transit: editedTransit || null,
        strPermit: strPermit.trim() || null,
        status: "draft_ready",
      });
      const saved = await saveResp.json().catch(() => null) as { id?: number } | null;
      const draftId = saved?.id;
      // Persist Step 3 photos to the draft's unit-a folder so the
      // builder Photos tab has them on first load.
      if (draftId && unit1Photos.length > 0) {
        try {
          await apiRequest("POST", `/api/community/${draftId}/persist-photos`, {
            unit1Photos: unit1Photos.map((p) => p.url),
            unit2Photos: [], // explicit empty array — no Unit B photos for singles
          });
        } catch (e: any) {
          console.warn(`[add-single-listing] photo persist failed: ${e?.message}`);
          toast({
            title: "Saved (photos pending)",
            description: "Listing saved, but the photos didn't persist. Edit + re-save to retry.",
          });
        }
      }
      // Auto-fetch resort/community-level photos + per-BR live market
      // rates (same pattern as add-community.tsx). Best-effort.
      if (draftId) {
        apiRequest("POST", `/api/community/${draftId}/persist-community-photos`, {})
          .catch((e: any) => console.warn(`[add-single-listing] community-photos persist failed: ${e?.message}`));
        apiRequest("POST", `/api/community/${draftId}/refresh-pricing`, {})
          .catch((e: any) => console.warn(`[add-single-listing] refresh-pricing failed: ${e?.message}`));
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/community/drafts"] });
      toast({ title: "Single listing saved to dashboard!" });
      navigate("/");
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [propertyName, streetAddress, pickedCity, editedPropertyType, zillowSourceUrl, bedrooms, zillowFacts, editedUnitA, suggestedRate, editedTitle, editedBookingTitle, editedPricingArea, editedDescription, editedNeighborhood, editedTransit, strPermit, unit1Photos, queryClient, toast, navigate]);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" data-testid="button-back-home">
              <ArrowLeft className="h-4 w-4 mr-1" /> Dashboard
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Add a Single Listing</h1>
            <p className="text-sm text-muted-foreground">Standalone condo or townhouse — verified clean of existing OTA listings</p>
          </div>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-1" aria-label={`Step ${step} of ${STEPS.length}`}>
          {STEPS.map((label, i) => {
            const stepNum = i + 1;
            const isActive = step === stepNum;
            const isDone = step > stepNum;
            return (
              <div key={label} className="flex items-center gap-2 shrink-0">
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  isActive ? "bg-primary text-primary-foreground" :
                  isDone ? "bg-primary/20 text-primary" :
                  "bg-muted text-muted-foreground"
                }`}>
                  {isDone ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="w-4 h-4 text-center leading-4">{stepNum}</span>}
                  {label}
                </div>
                {i < STEPS.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />}
              </div>
            );
          })}
        </div>
        <p className="text-sm text-muted-foreground mb-6">Step {step} of {STEPS.length}: {STEPS[step - 1]}</p>

        {/* ── STEP 1: City → community → address ──────────
            Three-substage screen:
              1. City autocomplete (Hawaii + Florida only)
              2. Top-20 community research scan kicked off automatically on city pick
              3. Operator selects a community OR enters manual mode, then types
                 the unit's specific street address (still required for the OTA
                 qualifier on Step 2).
            CODEX NOTE (2026-05-04, claude/single-listing): replaces the
            original 4-field property-details form. Operator directive
            was: "type a city → drop down list of cities → top 20 best
            vacation rental communities to choose from." */}
        {step === 1 && (
          <Card className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <MapPin className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Step 1: Pick a city &amp; community</h2>
            </div>
            <p className="text-muted-foreground text-sm mb-6">
              Start by typing the city. We'll find the top vacation rental communities there
              for you to pick from. (Currently scoped to Hawaii and Florida.)
            </p>

            {/* — City autocomplete — */}
            <div className="mb-6">
              <label className="text-sm font-medium mb-1.5 block">City</label>
              <div className="relative">
                <Input
                  placeholder="Start typing — e.g. Lihue, Kissimmee, Princeville…"
                  value={cityInput}
                  onChange={(e) => {
                    setCityInput(e.target.value);
                    setShowCitySuggestions(true);
                    // Typing again after a city was picked clears the
                    // research and the unit-level fields so the operator
                    // doesn't carry stale state across cities.
                    if (pickedCity) {
                      setPickedCity(null);
                      setSelectedCommunity(null);
                      setCommunities([]);
                      setPropertyName("");
                    }
                  }}
                  onFocus={() => setShowCitySuggestions(true)}
                  onBlur={() => setTimeout(() => setShowCitySuggestions(false), 200)}
                  data-testid="input-city"
                  autoComplete="off"
                />
                {showCitySuggestions && (citySuggestionsLoading || citySuggestions.length > 0) && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-card border rounded-md shadow-lg z-20 max-h-60 overflow-auto">
                    {citySuggestionsLoading && citySuggestions.length === 0 && (
                      <div className="px-3 py-2 text-xs text-muted-foreground italic">Looking up cities…</div>
                    )}
                    {citySuggestions.map((s) => (
                      <button
                        key={`${s.city}|${s.state}`}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          pickCity(s);
                        }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                        data-testid={`city-suggestion-${s.city.replace(/\s+/g, "-")}`}
                      >
                        {s.city}, {s.state}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {pickedCity && (
                <p className="text-xs text-muted-foreground mt-1">
                  Selected: <strong>{pickedCity.city}, {pickedCity.state}</strong>
                </p>
              )}
            </div>

            {/* — Community research results — */}
            {researchLoading && (
              <div className="text-center py-8 text-muted-foreground border rounded-lg mb-6">
                <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                Finding top vacation rental communities in {pickedCity?.city}…
              </div>
            )}

            {/* CODEX NOTE (2026-05-05, claude/city-wide-search):
                "Search entire city" prominent button — bypasses
                community selection. Operator picks a city, hits
                this, picks a bedroom count (or Any), and the
                wizard runs find-clean-unit with cityWide=true:
                discovery queries are condo+city instead of
                community-anchored, OTA prefilter is skipped (no
                community anchor), per-candidate qualifier still
                runs. Useful when the operator can't find a usable
                resort or wants the broadest candidate pool. */}
            {pickedCity && !cityWideMode && !manualMode && communities.length > 0 && (
              <div className="mb-3 p-3 rounded-lg border border-primary/40 bg-primary/5">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-sm font-semibold">Or search the entire city</div>
                    <div className="text-xs text-muted-foreground">
                      Skip the resort picker. We'll search every condo listing in {pickedCity.city} and verify each.
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => {
                      setCityWideMode(true);
                      setSelectedCommunity(null);
                      setCommunityInventory(null);
                      setManualMode(false);
                      setSelectedBedrooms(null);
                      setFindResult(null);
                      setSkipUrls([]);
                      setStreetAddress("");
                    }}
                    data-testid="button-city-wide"
                  >
                    Search all of {pickedCity.city}
                  </Button>
                </div>
              </div>
            )}
            {pickedCity && cityWideMode && (
              <div className="mb-3 p-3 rounded-lg border border-primary/60 bg-primary/10 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold">City-wide search active</div>
                    <div className="text-xs text-muted-foreground">
                      Searching all condo listings in {pickedCity.city}, {pickedCity.state}.
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setCityWideMode(false);
                      setSelectedBedrooms(null);
                      setFindResult(null);
                    }}
                  >
                    Pick a community instead
                  </Button>
                </div>
              </div>
            )}

            {!researchLoading && communities.length > 0 && !cityWideMode && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold">
                    Top {communities.length} biggest {communities.length === 1 ? "community" : "communities"} in {pickedCity?.city}
                  </h3>
                  <button
                    type="button"
                    onClick={enterManualMode}
                    className="text-xs text-blue-700 hover:underline"
                  >
                    None of these — enter manually
                  </button>
                </div>
                <div className="space-y-2 max-h-96 overflow-auto pr-1">
                  {communities.map((c, i) => {
                    const isSelected = selectedCommunity?.name === c.name && selectedCommunity?.city === c.city;
                    return (
                      <Card
                        key={`${c.name}-${i}`}
                        className={`p-3 cursor-pointer transition-colors ${
                          isSelected ? "border-primary bg-primary/5" : "hover:border-muted-foreground/40"
                        }`}
                        onClick={() => pickCommunity(c)}
                        data-testid={`community-card-${i}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                              <p className="font-semibold text-sm">{c.name}</p>
                              {c.fromWorldKnowledge && (
                                <Badge variant="outline" className="text-[10px]">AI knowledge</Badge>
                              )}
                              <Badge variant="secondary" className="text-[10px]">
                                <Star className="h-2.5 w-2.5 mr-0.5" />
                                {c.confidenceScore}
                              </Badge>
                              {/* CODEX NOTE (2026-05-04, claude/single-listing-cap-10-biggest):
                                  Rough total unit count from Claude's research prompt.
                                  Helps the operator gauge resort size. Hidden when
                                  estimatedTotalUnits is missing. */}
                              {typeof c.estimatedTotalUnits === "number" && c.estimatedTotalUnits > 0 && (
                                <Badge variant="outline" className="text-[10px]">
                                  ~{c.estimatedTotalUnits.toLocaleString()} resort units
                                </Badge>
                              )}
                            </div>
                            {c.unitTypes && (
                              <p className="text-xs text-muted-foreground mt-1 italic">{c.unitTypes}</p>
                            )}
                            {c.researchSummary && (
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{c.researchSummary}</p>
                            )}
                            {(c.estimatedLowRate || c.estimatedHighRate) && (
                              <p className="text-xs mt-1">
                                <span className="text-muted-foreground">Est. nightly:</span>{" "}
                                <span className="font-medium">
                                  {c.estimatedLowRate ? `$${c.estimatedLowRate}` : "?"}
                                  {c.estimatedHighRate ? ` – $${c.estimatedHighRate}` : ""}
                                </span>
                              </p>
                            )}
                          </div>
                          {isSelected && <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {!researchLoading && pickedCity && communities.length === 0 && !manualMode && (
              <div className="mb-6 p-4 border border-amber-300 bg-amber-50/50 rounded-lg text-sm">
                <p className="mb-2">No communities found for {pickedCity.city}, {pickedCity.state}.</p>
                <Button size="sm" variant="outline" onClick={enterManualMode}>
                  Enter property manually
                </Button>
              </div>
            )}

            {/* — Bedroom selector + auto-discovery trigger. Shown once
                  a community is picked. CODEX NOTE
                  (2026-05-04, claude/single-listing-find-unit): replaced
                  the operator-typed propertyName + streetAddress fields
                  with a bedroom-count picker. The /find-clean-unit
                  endpoint discovers the address + Zillow URL + photos
                  automatically, so the operator only picks the BR. — */}
            {(selectedCommunity || cityWideMode) && (() => {
              // CODEX NOTE (2026-05-05, codex/resort-bedroom-options):
              // Resort mode should render ONLY the bedroom counts
              // returned for that resort. Showing generic 1-5BR
              // buttons caused operators to pick sizes a resort
              // does not offer, which then made per-resort lookup
              // look broken. City-wide mode remains broad because
              // it is not anchored to one resort. "Any" still
              // exists as the explicit escape hatch.
              const confirmedBedrooms = !cityWideMode
                ? Array.from(new Set(selectedCommunity?.availableBedrooms ?? []))
                    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12)
                    .sort((a, b) => a - b)
                : [];
              const bedroomOptions = cityWideMode
                ? [1, 2, 3, 4, 5]
                : confirmedBedrooms.length > 0
                  ? confirmedBedrooms
                  : [2, 3, 4];
              return (
                <div className="space-y-4 border-t pt-5 mb-6">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <h3 className="text-sm font-semibold">
                      How many bedrooms?
                      {cityWideMode && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          (searching all of {pickedCity?.city})
                        </span>
                      )}
                    </h3>
                    {/* CODEX NOTE (2026-05-05, claude/community-inventory):
                        Total Zillow listings count for the picked
                        community. Surfaces "this resort has 23 total
                        listings on Zillow" so the operator has a
                        sanity check before clicking Find. If find-
                        clean-unit later returns 0 clean units AND
                        this count is also low, the resort is
                        saturated (real signal). If the count is high
                        but find-clean-unit returns 0, the OTA index
                        is the culprit. */}
                    {communityInventory?.loading && (
                      <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        counting Zillow inventory…
                      </span>
                    )}
                    {communityInventory && !communityInventory.loading && (
                      <div
                        className="flex items-center gap-1 flex-wrap"
                        title="This is the count of property-listing URLs we could find on Zillow + Realtor.com across multiple queries — NOT the total unit count at the resort. Most condo units never appear on either site (owner-occupied, long-term rentals). For-sale + recently-sold + indexed off-market listings make up the count."
                      >
                        {communityInventory.byPlatform ? (
                          <>
                            <Badge
                              variant={communityInventory.byPlatform.zillow > 0 ? "secondary" : "outline"}
                              className="text-[11px]"
                            >
                              ~{communityInventory.byPlatform.zillow} Zillow
                            </Badge>
                            <Badge
                              variant={communityInventory.byPlatform.realtor > 0 ? "secondary" : "outline"}
                              className="text-[11px]"
                            >
                              ~{communityInventory.byPlatform.realtor} Realtor
                            </Badge>
                          </>
                        ) : (
                          <Badge
                            variant={communityInventory.count > 0 ? "secondary" : "outline"}
                            className="text-[11px]"
                          >
                            ~{communityInventory.count} listing{communityInventory.count === 1 ? "" : "s"} indexed
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground -mt-2">
                    {cityWideMode ? (
                      <>
                        We'll search Zillow + Realtor.com for any condo in {pickedCity?.city}, {pickedCity?.state} (size: {typeof selectedBedrooms === "number" ? `${selectedBedrooms}BR` : selectedBedrooms === "any" ? "any" : "?"}),
                        then auto-verify each isn't already listed on Airbnb, VRBO, or Booking.com.
                      </>
                    ) : (
                      <>
                        We'll search Zillow + Realtor.com for a {typeof selectedBedrooms === "number" ? `${selectedBedrooms}BR` : selectedBedrooms === "any" ? "any-size" : "?"} unit at {selectedCommunity?.name},
                        then auto-verify it isn't already listed on Airbnb, VRBO, or Booking.com.
                        If the first candidate is listed somewhere, we'll automatically try another.
                      </>
                    )}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {bedroomOptions.map((br) => {
                      const active = selectedBedrooms === br;
                      return (
                        <button
                          key={br}
                          type="button"
                          onClick={() => setSelectedBedrooms(br)}
                          title={!cityWideMode && confirmedBedrooms.length > 0 ? `${selectedCommunity?.name} offers ${br}BR units` : undefined}
                          className={`px-4 py-2 rounded-md border text-sm font-medium transition-colors ${
                            active
                              ? "bg-primary text-primary-foreground border-primary"
                              : !cityWideMode && confirmedBedrooms.length > 0
                                ? "bg-card border-primary/40 ring-1 ring-primary/20 hover:border-primary"
                                : "bg-card hover:border-primary/50"
                          }`}
                          data-testid={`button-bedrooms-${br}`}
                        >
                          {br}BR
                        </button>
                      );
                    })}
                    {/* "Any" button — operator wants the broadest pool */}
                    <button
                      type="button"
                      onClick={() => setSelectedBedrooms("any")}
                      title="Skip the bedroom-count filter — accept any unit at this resort/city"
                      className={`px-4 py-2 rounded-md border text-sm font-medium transition-colors ${
                        selectedBedrooms === "any"
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-card hover:border-primary/50"
                      }`}
                      data-testid="button-bedrooms-any"
                    >
                      Any
                    </button>
                  </div>
                  {!cityWideMode && confirmedBedrooms.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Showing the confirmed bedroom sizes for {selectedCommunity?.name}. Pick "Any" to search all sizes.
                    </p>
                  )}
                  {confirmedBedrooms.length === 0 && !cityWideMode && (
                    <p className="text-xs text-amber-700">
                      We don't have a confirmed bedroom mix for this community — use "Any" for the safest search, or pick a common condo size.
                    </p>
                  )}
                </div>
              );
            })()}

            {/* — Manual mode: keep the typed-address path as escape
                  hatch for resorts not on Zillow. — */}
            {manualMode && (
              <div className="space-y-4 border-t pt-5 mb-6">
                <h3 className="text-sm font-semibold">Manual entry</h3>
                <p className="text-xs text-muted-foreground -mt-2">
                  Couldn't find your resort? Type the unit's name + street address manually.
                  We'll still verify it's not on Airbnb/VRBO/Booking.com on the next step.
                </p>
                <div>
                  <label className="text-sm font-medium mb-1.5 block">Property / building name</label>
                  <Input
                    placeholder="e.g. The Surfrider, Building 4 Unit 12, …"
                    value={propertyName}
                    onChange={(e) => setPropertyName(e.target.value)}
                    data-testid="input-property-name"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1.5 block">Street address</label>
                  <Input
                    placeholder="e.g. 4460 Nehe Rd #122"
                    value={streetAddress}
                    onChange={(e) => setStreetAddress(e.target.value)}
                    data-testid="input-street-address"
                  />
                </div>
              </div>
            )}

            {/* Continue button:
                  - Auto-discovery path: picks community + BR → "Find a clean unit" calls the API
                  - Manual path: requires typed address → "Continue to OTA check" advances normally */}
            {(selectedCommunity || cityWideMode) && !findLoading && (
              <Button
                onClick={() => findCleanUnit([])}
                disabled={!selectedBedrooms}
                data-testid="button-find-clean-unit"
              >
                <Search className="h-4 w-4 mr-2" />
                {(() => {
                  const sizeLabel =
                    typeof selectedBedrooms === "number"
                      ? `${selectedBedrooms}BR`
                      : selectedBedrooms === "any"
                        ? "any-size"
                        : "?";
                  const scopeLabel = cityWideMode
                    ? `in ${pickedCity?.city ?? "this city"}`
                    : "unit";
                  return `Find a clean ${sizeLabel} ${scopeLabel}`;
                })()}
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            )}

            {/* CODEX NOTE (2026-05-04, claude/find-clean-unit-streaming):
                Progress bar — drives off `findProgress` state which is
                populated by the NDJSON stream from
                /api/single-listing/find-clean-unit. Shows phase label
                ("Discovering candidates" → "Walking N/M") + a per-
                candidate detail line ("Scraping…" / "Checking
                Airbnb/VRBO/Booking" / "Listed on VRBO" / "Clean ✓"). */}
            {/* CODEX NOTE (2026-05-04, claude/single-listing-citywide-progress):
                Was previously gated to `selectedCommunity && findLoading`
                only. Bug: in city-wide mode the operator clicked Find,
                the button vanished (gated on `!findLoading`), but the
                progress block never rendered — so the page looked
                completely dead. Now gated on
                `(selectedCommunity || cityWideMode) && findLoading`
                so the progress bar covers both paths. */}
            {(selectedCommunity || cityWideMode) && findLoading && (
              <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  {findProgress.phase === "discovering" && "Discovering Zillow candidates…"}
                  {findProgress.phase === "ota-indexing" && "Indexing OTA listings (Airbnb / VRBO / Booking)…"}
                  {findProgress.phase === "candidates" && (
                    <>
                      Walking candidate{" "}
                      <span className="font-mono">
                        {findProgress.current?.index ?? 0}/{findProgress.totalCandidates}
                      </span>
                    </>
                  )}
                  {findProgress.phase === "done" && "Wrapping up…"}
                </div>
                {/* CODEX NOTE (2026-05-04, claude/verify-then-discover):
                    OTA index summary line — shows after the OTA-indexing
                    phase completes. Tells the operator how many existing
                    OTA listings the prefilter is screening Zillow
                    candidates against. */}
                {findProgress.otaIndex && (
                  <div className="text-[11px] text-muted-foreground">
                    OTA index built: airbnb {findProgress.otaIndex.airbnb} · vrbo {findProgress.otaIndex.vrbo} · booking {findProgress.otaIndex.booking} · {findProgress.otaIndex.addressTokens} address{findProgress.otaIndex.addressTokens === 1 ? "" : "es"} extracted
                  </div>
                )}
                {/* Progress bar */}
                <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-300"
                    style={{
                      width: findProgress.totalCandidates > 0
                        ? `${Math.min(100, (findProgress.candidatesProcessed / findProgress.totalCandidates) * 100)}%`
                        : findProgress.phase === "discovering" ? "10%" : "0%",
                    }}
                  />
                </div>
                {/* Per-candidate detail */}
                {findProgress.current && (
                  <div className="text-xs text-muted-foreground space-y-1">
                    <div className="flex items-center gap-2">
                      {findProgress.current.phase === "scraping" && (
                        <Loader2 className="h-3 w-3 animate-spin text-blue-600" />
                      )}
                      {findProgress.current.phase === "checking-ota" && (
                        <ShieldCheck className="h-3 w-3 text-amber-600" />
                      )}
                      {findProgress.current.phase === "rejected" && (
                        <XCircle className="h-3 w-3 text-red-600" />
                      )}
                      {findProgress.current.phase === "clean" && (
                        <CheckCircle2 className="h-3 w-3 text-green-700" />
                      )}
                      <span className="truncate flex-1">
                        {findProgress.current.detail ?? "Starting…"}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground/70 truncate">
                      {findProgress.current.url.replace(/^https?:\/\/(www\.)?/, "")}
                    </div>
                  </div>
                )}
                {/* CODEX NOTE (2026-05-04, claude/single-listing-rejection-tally):
                    Live breakdown of WHY candidates were rejected,
                    bucketed. So when the operator sees "12/12
                    rejected" they immediately see "10 listed on
                    Airbnb, 2 wrong property type" instead of
                    wondering whether the checks are even working.
                    Sorted desc so the dominant bucket appears
                    first. */}
                {Object.keys(findProgress.rejectionsByReason).length > 0 && (
                  <div className="text-[11px] text-muted-foreground border-l-2 border-amber-300 pl-2 space-y-0.5">
                    <div className="font-medium text-foreground">Why rejected so far:</div>
                    {Object.entries(findProgress.rejectionsByReason)
                      .sort((a, b) => b[1] - a[1])
                      .map(([reason, count]) => (
                        <div key={reason} className="flex items-center gap-1.5">
                          <span className="font-mono tabular-nums">{count}×</span>
                          <span>{reason}</span>
                        </div>
                      ))}
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-[11px] text-muted-foreground">
                    {findProgress.candidatesProcessed} processed
                    {findProgress.rejected > 0 && ` · ${findProgress.rejected} rejected`}
                    {findProgress.prefilteredCount > 0 && ` (${findProgress.prefilteredCount} pre-filtered, no scrape needed)`}
                  </div>
                  {/* CODEX NOTE (2026-05-05, claude/find-eta-cancel):
                      ETA = avg time per processed candidate ×
                      candidates remaining. Only shown after the
                      first candidate completes (so the avg is real
                      data, not a guess). Falls back to "calculating"
                      while the first candidate is still in flight. */}
                  {findEtaMs !== null && findEtaMs > 0 && (
                    <span className="text-[11px] text-muted-foreground">
                      ~{findEtaMs >= 60_000
                        ? `${Math.ceil(findEtaMs / 60_000)} min`
                        : `${Math.ceil(findEtaMs / 1000)}s`} remaining
                    </span>
                  )}
                  {findEtaMs === null && findProgress.candidatesProcessed === 0 && findProgress.totalCandidates > 0 && (
                    <span className="text-[11px] text-muted-foreground italic">
                      ETA calculating…
                    </span>
                  )}
                </div>
                <div className="flex justify-end pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={cancelFind}
                    className="text-xs"
                    data-testid="button-cancel-find"
                  >
                    <XCircle className="h-3 w-3 mr-1" />
                    Cancel search
                  </Button>
                </div>
              </div>
            )}

            {/* CODEX NOTE (2026-05-05, claude/no-unit-diagnostic):
                Render the diagnostic breakdown when find-clean-unit
                returned found:false. Shows the operator WHY no
                candidate qualified (saturation vs scrape-failure
                vs wrong-bedroom etc) so they can decide whether to
                try a different bedroom count, a different resort,
                or come back later when scrapers recover. The
                per-candidate list is the same data as Step 2's
                "Why we skipped" disclosure but surfaced in-line so
                it's visible without expanding. */}
            {/* CODEX NOTE (2026-05-04, claude/single-listing-citywide-progress):
                Same fix as the progress block above — was gated on
                selectedCommunity only, now `selectedCommunity ||
                cityWideMode` so the no-unit-found diagnostic also
                renders for city-wide searches. */}
            {(selectedCommunity || cityWideMode) && !findLoading && findResult && !findResult.found && (
              <div className="border border-red-300 bg-red-50/30 rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2 font-semibold text-red-900">
                  <ShieldX className="h-4 w-4" />
                  No clean unit found
                </div>
                <p className="text-sm text-red-900">{findResult.reason}</p>
                {findResult.attempts.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-red-800 hover:text-red-900">
                      Show all {findResult.attempts.length} candidate{findResult.attempts.length === 1 ? "" : "s"} we checked
                    </summary>
                    <ul className="mt-2 space-y-1 pl-3">
                      {findResult.attempts.map((a, i) => (
                        <li key={`${a.url}-${i}`} className="text-muted-foreground">
                          <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">
                            #{i + 1}
                          </a>
                          {a.address && <span className="text-foreground"> {a.address}</span>}
                          : {a.rejectedBecause || "skipped"}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => { setFindResult(null); findCleanUnit([]); }}>
                    Try again
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setSelectedBedrooms(null); setFindResult(null); }}>
                    Pick different bedroom count
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setSelectedCommunity(null); setFindResult(null); setSelectedBedrooms(null); setCommunityInventory(null); }}>
                    Pick different community
                  </Button>
                </div>
              </div>
            )}

            {manualMode && (
              <Button
                onClick={() => setStep(2)}
                disabled={!pickedCity || !streetAddress.trim()}
                data-testid="button-step-1-next"
              >
                Continue to OTA Check
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            )}
          </Card>
        )}

        {/* ── STEP 2: Auto-discovered unit + OTA results ───
            CODEX NOTE (2026-05-04, claude/single-listing-find-unit):
            replaces the manual "type-an-address-and-run-OTA-check"
            screen. Now it just renders whatever
            /api/single-listing/find-clean-unit returned for the
            picked community + bedroom count, plus a "Try another
            unit" button that re-runs the search with the current
            URL appended to skipUrls. Manual mode (operator-typed
            address) still calls runQualifier and shows the same
            per-platform breakdown. — */}
        {step === 2 && (
          <Card className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Step 2: OTA cross-listing check</h2>
            </div>

            {/* Auto-discovery path */}
            {findResult?.found && qualifierResult && (
              <>
                <div className="mb-4 p-3 rounded-lg bg-muted/50 text-sm space-y-1">
                  <div><strong>Auto-discovered unit:</strong></div>
                  <div className="text-foreground">{streetAddress}, {pickedCity?.city}, {pickedCity?.state}</div>
                  <div className="text-xs text-muted-foreground">
                    {/* CODEX NOTE (2026-05-04, claude/single-listing-bath-display):
                        Show "—" instead of "?" when the Zillow scrape didn't
                        return bathrooms — looks intentional rather than broken.
                        The Listing Draft step (Step 4) fills this in with a
                        Claude-generated estimate, so this is just a transient
                        display while the scrape is partial. */}
                    {zillowFacts.bedrooms ?? findResult.unit.bedrooms} BR
                    {zillowFacts.bathrooms != null ? ` · ${zillowFacts.bathrooms} BA` : " · BA TBD"}
                    {" · sourced from "}
                    <a href={findResult.unit.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline inline-flex items-center gap-1">
                      Zillow <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  {zillowFacts.bathrooms == null && (
                    <div className="text-[11px] text-muted-foreground italic">
                      Bathroom count wasn't returned by the Zillow scrape — Claude will estimate it on Step 4 (you can edit there).
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Walked {findResult.attemptCount} of {findResult.totalCandidates} Zillow candidate{findResult.totalCandidates === 1 ? "" : "s"} through the OTA cross-listing check before picking this one.
                  </div>
                </div>

                <div className={`p-4 rounded-lg mb-4 border ${qualifierResult.qualifies ? "border-green-500 bg-green-50/40" : "border-red-500 bg-red-50/40"}`}>
                  <div className="flex items-center gap-2 font-semibold">
                    {qualifierResult.qualifies ? (
                      <><ShieldCheck className="h-5 w-5 text-green-700" /> <span className="text-green-900">Qualifies as a standalone listing</span></>
                    ) : (
                      <><ShieldX className="h-5 w-5 text-red-700" /> <span className="text-red-900">Does not qualify</span></>
                    )}
                  </div>
                  <p className="text-sm mt-1">{qualifierResult.reason}</p>
                </div>

                <div className="space-y-2">
                  {(["airbnb", "vrbo", "booking"] as const).map((key) => {
                    const r = qualifierResult.platforms[key];
                    const label = key === "airbnb" ? "Airbnb" : key === "vrbo" ? "VRBO" : "Booking.com";
                    const totalHits = r.matches.length + (r.photoMatches?.length ?? 0);
                    return (
                      <Card key={key} className={`p-3 ${r.listed ? "border-red-300 bg-red-50/30" : "border-green-200 bg-green-50/30"}`}>
                        <div className="font-semibold text-sm flex items-center gap-2 flex-wrap">
                          {r.listed ? <XCircle className="h-4 w-4 text-red-700" /> : <CheckCircle2 className="h-4 w-4 text-green-700" />}
                          {label}
                          <Badge variant={r.listed ? "destructive" : "secondary"}>
                            {r.listed ? `${totalHits} match${totalHits === 1 ? "" : "es"}` : "Clean"}
                          </Badge>
                          {r.matches.length > 0 && <Badge variant="outline" className="text-[10px]">{r.matches.length} address</Badge>}
                          {(r.photoMatches?.length ?? 0) > 0 && <Badge variant="outline" className="text-[10px]">{r.photoMatches.length} photo</Badge>}
                        </div>
                      </Card>
                    );
                  })}
                </div>
                {(qualifierResult.photoChecksRun ?? 0) > 0 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Reverse-image-searched {qualifierResult.photoChecksRun} photo{qualifierResult.photoChecksRun === 1 ? "" : "s"} via Google Lens (same methodology as the combo-listing pre-flight check).
                  </p>
                )}

                <div className="flex flex-wrap gap-2 mt-6">
                  <Button variant="outline" onClick={() => setStep(1)}>
                    <ArrowLeft className="h-4 w-4 mr-2" /> Back
                  </Button>
                  <Button variant="outline" onClick={tryAnotherUnit} disabled={findLoading}>
                    {findLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
                    Try another unit
                  </Button>
                  <Button
                    onClick={() => setStep(3)}
                    disabled={!qualifierResult.qualifies}
                    data-testid="button-step-2-next"
                  >
                    Continue to Photos
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>

                {(() => {
                  // CODEX NOTE (2026-05-04, claude/single-listing-bath-display):
                  // Filter the disclosure to attempts whose URL doesn't
                  // match the picked unit. Earlier slice(0, -1) was wrong
                  // when retries or expanded candidate pools mean the
                  // matched candidate isn't the final attempt.
                  const matchedUrl = findResult.unit.url.toLowerCase();
                  const skipped = findResult.attempts.filter((a) => a.url.toLowerCase() !== matchedUrl);
                  if (skipped.length === 0) return null;
                  return (
                    <details className="mt-4 text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        Why we skipped {skipped.length} other candidate{skipped.length === 1 ? "" : "s"}
                      </summary>
                      <ul className="mt-2 space-y-1 pl-3">
                        {skipped.map((a, i) => (
                          <li key={`${a.url}-${i}`} className="text-muted-foreground">
                            <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">
                              Candidate {i + 1}
                            </a>: {a.rejectedBecause || "skipped"}
                          </li>
                        ))}
                      </ul>
                    </details>
                  );
                })()}
              </>
            )}

            {/* Manual mode path: typed address, manual OTA check */}
            {!findResult?.found && !qualifierLoading && !qualifierResult && (
              <>
                <p className="text-muted-foreground text-sm mb-6">
                  For a standalone unit to qualify, it must NOT already be listed on Airbnb, VRBO, or Booking.com.
                  We'll search each platform for your address and show what we find.
                </p>
                <div className="mb-4 p-3 rounded-lg bg-muted/50 text-sm">
                  <strong>Address being checked:</strong>
                  <div className="mt-1">{streetAddress || "—"}, {pickedCity?.city || "—"}, {pickedCity?.state || "—"}</div>
                </div>
                <Button
                  onClick={runQualifier}
                  disabled={qualifierLoading}
                  data-testid="button-run-qualifier"
                >
                  {qualifierLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
                  {qualifierLoading ? "Checking Airbnb / VRBO / Booking…" : "Run OTA check"}
                </Button>
              </>
            )}
            {qualifierLoading && (
              <div className="text-center py-6 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                Checking Airbnb, VRBO, and Booking.com…
              </div>
            )}
            {!findResult?.found && !qualifierLoading && qualifierResult && (
              <>
                <div className={`p-4 rounded-lg mb-4 border ${qualifierResult.qualifies ? "border-green-500 bg-green-50/40" : "border-red-500 bg-red-50/40"}`}>
                  <div className="flex items-center gap-2 font-semibold">
                    {qualifierResult.qualifies ? (
                      <><ShieldCheck className="h-5 w-5 text-green-700" /> <span className="text-green-900">Qualifies as a standalone listing</span></>
                    ) : (
                      <><ShieldX className="h-5 w-5 text-red-700" /> <span className="text-red-900">Does not qualify</span></>
                    )}
                  </div>
                  <p className="text-sm mt-1">{qualifierResult.reason}</p>
                </div>
                <div className="flex gap-2 mt-4">
                  <Button variant="outline" onClick={() => setQualifierResult(null)}>
                    Re-run check
                  </Button>
                  <Button onClick={() => setStep(3)} disabled={!qualifierResult.qualifies}>
                    Continue to Photos
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>
              </>
            )}
          </Card>
        )}

        {/* ── STEP 3: Auto-loaded photos ──────────────────
            CODEX NOTE (2026-05-04, claude/single-listing-find-unit):
            in the auto-discovery flow, photos are already loaded
            from the find-clean-unit response. This step now just
            displays them and lets the operator continue. The manual-
            mode "paste a Zillow URL" path is kept for the escape
            hatch — when no Zillow listing was auto-discovered yet. — */}
        {step === 3 && (
          <Card className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <Camera className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Step 3: Photos</h2>
            </div>

            {/* Auto-discovered unit already has its photos loaded. */}
            {unit1Photos.length > 0 && zillowSourceUrl && (
              <p className="text-muted-foreground text-sm mb-4">
                Photos auto-loaded from{" "}
                <a href={zillowSourceUrl} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline inline-flex items-center gap-1">
                  Zillow <ExternalLink className="h-3 w-3" />
                </a>{" "}
                — review and continue, or re-fetch if needed.
              </p>
            )}

            {/* CODEX NOTE (2026-05-04, claude/single-listing-step3-prefill):
                Three modes for the empty-photos state:
                  (a) Auto-retry running — show spinner + "scraping Zillow"
                  (b) Auto-retry done, still empty, URL known — show
                      "Scrape failed N times" message, pre-filled URL,
                      a Re-try button, and a Skip Photos for Now button
                  (c) No URL known (manual mode operator) — show the
                      original "Paste a Zillow URL" form */}
            {unit1Photos.length === 0 && photosLoading && (
              <div className="text-center py-8 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                Scraping Zillow for photos…
              </div>
            )}
            {unit1Photos.length === 0 && !photosLoading && zillowSourceUrl && step3AutoRetryFired && (
              <>
                <div className="mb-4 p-4 rounded-lg border border-amber-300 bg-amber-50/40 text-sm space-y-2">
                  <div className="font-semibold text-amber-900">Zillow photo scrape kept coming back empty</div>
                  <div className="text-amber-900">
                    We tried 3 times against{" "}
                    <a href={zillowSourceUrl} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline inline-flex items-center gap-1">
                      this listing <ExternalLink className="h-3 w-3" />
                    </a>{" "}
                    but Apify and ScrapingBee both returned no photos.
                  </div>
                  <div className="text-amber-900">
                    Common causes: Apify rate-limited or out of credits, ScrapingBee not configured, or Zillow temporarily blocking the scraper for this listing. The unit still qualifies as standalone; you can re-try here, or skip and add photos manually in the builder.
                  </div>
                </div>
                <div className="space-y-3 mb-4">
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">Zillow URL (pre-filled from auto-discovery)</label>
                    <Input
                      value={zillowUrl}
                      onChange={(e) => setZillowUrl(e.target.value)}
                      data-testid="input-zillow-url"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={fetchZillowPhotos} disabled={photosLoading || !zillowUrl.trim()}>
                      {photosLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
                      {photosLoading ? "Scraping…" : "Re-try scrape"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        // Skip photos: jump to Step 4. The operator will
                        // get the listing draft generated and can save the
                        // unit without photos. Photos can be added later
                        // via the builder's Photos tab.
                        setStep(4);
                        handleGenerateListing();
                      }}
                      data-testid="button-skip-photos"
                    >
                      Skip photos for now <ArrowRight className="h-4 w-4 ml-2" />
                    </Button>
                  </div>
                </div>
              </>
            )}
            {/* Manual mode: no URL was discovered (operator entered manually on Step 1) */}
            {unit1Photos.length === 0 && !photosLoading && !zillowSourceUrl && (
              <>
                <p className="text-muted-foreground text-sm mb-4">
                  Paste the Zillow listing URL for this property. We'll grab the photos and basic facts (bedrooms, bathrooms).
                </p>
                <div className="space-y-3 mb-4">
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">Zillow URL</label>
                    <Input
                      placeholder="https://www.zillow.com/homedetails/…"
                      value={zillowUrl}
                      onChange={(e) => setZillowUrl(e.target.value)}
                      data-testid="input-zillow-url"
                    />
                  </div>
                  <Button onClick={fetchZillowPhotos} disabled={photosLoading || !zillowUrl.trim()}>
                    {photosLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
                    {photosLoading ? "Scraping Zillow…" : "Fetch photos"}
                  </Button>
                </div>
              </>
            )}

            {(zillowFacts.bedrooms != null || zillowFacts.bathrooms != null) && (
              <div className="mb-4 p-3 rounded-lg bg-muted/50 text-sm">
                <strong>Zillow facts:</strong> {zillowFacts.bedrooms ?? "?"} BR / {zillowFacts.bathrooms ?? "?"} BA
              </div>
            )}

            {unit1Photos.length > 0 && (
              <>
                <h3 className="text-sm font-semibold mb-2">{unit1Photos.length} photo{unit1Photos.length === 1 ? "" : "s"} found</h3>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-6 max-h-96 overflow-y-auto">
                  {unit1Photos.map((p, idx) => (
                    <img
                      key={`${p.url}-${idx}`}
                      src={p.url}
                      alt={p.label}
                      className="w-full h-24 object-cover rounded border"
                      loading="lazy"
                    />
                  ))}
                </div>
              </>
            )}

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(2)}>
                <ArrowLeft className="h-4 w-4 mr-2" /> Back
              </Button>
              <Button
                onClick={() => { setStep(4); handleGenerateListing(); }}
                disabled={unit1Photos.length === 0}
                data-testid="button-step-3-next"
              >
                Continue to Listing Draft
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </Card>
        )}

        {/* ── STEP 4: Listing draft ──────────────────────── */}
        {step === 4 && (
          <Card className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <FileText className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Step 4: Review listing draft</h2>
            </div>

            {listingLoading && (
              <div className="text-center py-8 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
                Generating listing draft with Claude…
              </div>
            )}

            {!listingLoading && listing && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">Airbnb title (≤50 chars)</label>
                    <Input
                      value={editedTitle}
                      onChange={(e) => setEditedTitle(e.target.value.slice(0, 50))}
                      data-testid="input-title"
                    />
                    <p className="text-xs text-muted-foreground mt-1">{editedTitle.length}/50</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">Booking/VRBO title (≤50 chars)</label>
                    <Input
                      value={editedBookingTitle}
                      onChange={(e) => setEditedBookingTitle(e.target.value.slice(0, 50))}
                      data-testid="input-booking-title"
                    />
                    <p className="text-xs text-muted-foreground mt-1">{editedBookingTitle.length}/50</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">Property type</label>
                    <Select value={editedPropertyType} onValueChange={setEditedPropertyType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["Condominium","Townhouse","House","Apartment","Cottage","Bungalow","Loft"].map((t) => (
                          <SelectItem key={t} value={t}>{t}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">Pricing area</label>
                    <Select value={editedPricingArea || "__none"} onValueChange={(v) => setEditedPricingArea(v === "__none" ? "" : v)}>
                      <SelectTrigger><SelectValue placeholder="Select pricing area…" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">— No area / use default —</SelectItem>
                        {Object.keys(BUY_IN_RATES).map((a) => (
                          <SelectItem key={a} value={a}>{a}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium mb-1.5 block">Description</label>
                  <Textarea
                    value={editedDescription}
                    onChange={(e) => setEditedDescription(e.target.value)}
                    rows={6}
                    data-testid="textarea-description"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">Neighborhood</label>
                    <Textarea
                      value={editedNeighborhood}
                      onChange={(e) => setEditedNeighborhood(e.target.value)}
                      rows={4}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">Transit / getting around</label>
                    <Textarea
                      value={editedTransit}
                      onChange={(e) => setEditedTransit(e.target.value)}
                      rows={4}
                    />
                  </div>
                </div>

                {editedUnitA && (
                  <Card className="p-4 bg-muted/30">
                    <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
                      <BedDouble className="h-4 w-4" /> Unit details
                    </h3>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <label className="text-xs font-medium mb-1 block">Bedrooms</label>
                        <Input
                          type="number"
                          value={editedUnitA.bedrooms}
                          onChange={(e) => setEditedUnitA({ ...editedUnitA, bedrooms: parseInt(e.target.value) || 0 })}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium mb-1 block">Bathrooms</label>
                        <Input
                          value={editedUnitA.bathrooms}
                          onChange={(e) => setEditedUnitA({ ...editedUnitA, bathrooms: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium mb-1 block">Sqft</label>
                        <Input
                          value={editedUnitA.sqft}
                          onChange={(e) => setEditedUnitA({ ...editedUnitA, sqft: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium mb-1 block">Max guests</label>
                        <Input
                          type="number"
                          value={editedUnitA.maxGuests}
                          onChange={(e) => setEditedUnitA({ ...editedUnitA, maxGuests: parseInt(e.target.value) || 0 })}
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs font-medium mb-1 block">Bedding plan</label>
                        <Input
                          value={editedUnitA.bedding}
                          onChange={(e) => setEditedUnitA({ ...editedUnitA, bedding: e.target.value })}
                        />
                      </div>
                    </div>
                  </Card>
                )}

                <div>
                  <label className="text-sm font-medium mb-1.5 block">STR permit</label>
                  <Input
                    value={strPermit}
                    onChange={(e) => setStrPermit(e.target.value)}
                    placeholder="e.g. TVR-2024-099"
                  />
                </div>

                {suggestedRate > 0 && (
                  <div className="p-3 rounded-lg bg-muted/50 text-sm">
                    <strong>Suggested nightly rate:</strong> ${suggestedRate} (target ~20% net after Airbnb fees)
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <Button variant="outline" onClick={() => setStep(3)}>
                    <ArrowLeft className="h-4 w-4 mr-2" /> Back
                  </Button>
                  <Button onClick={handleGenerateListing} variant="outline" disabled={listingLoading}>
                    Re-generate
                  </Button>
                  <Button onClick={handleSave} disabled={saving} data-testid="button-save">
                    {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                    {saving ? "Saving…" : "Save to dashboard"}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
