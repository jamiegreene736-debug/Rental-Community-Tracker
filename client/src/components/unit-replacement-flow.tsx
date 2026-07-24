import { useEffect, useRef, useState } from "react";
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  ShieldAlert,
  Home,
  BedDouble,
  ExternalLink,
  Search as SearchIcon,
  Repeat2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { OperationFailureActions } from "@/components/OperationFailureActions";
import { useToast } from "@/hooks/use-toast";

type PreflightReplacementFindJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  message: string;
  progress: number;
  error: string | null;
  unit: ReplacementUnitData | null;
  // A0: every clean unit the search surfaced (element 0 === `unit`), so the
  // operator can pick from several options instead of one. Absent on older jobs.
  units?: ReplacementUnitData[] | null;
  diagnostic?: Record<string, unknown> | null;
  // Server marker: the search died mid-run and exhausted its SERVER resume
  // budget (deploy burst). Terminal "failed" — but the client may still
  // transparently relaunch it (its own cap/window), exactly like the old 404.
  stuckUnresumable?: boolean;
};

const replacementJobStoragePrefix = (propertyId: number) => `preflight.replacementFindJob.v2:${propertyId}:`;
const replacementJobStorageKey = (propertyId: number, targetUnitId: string) =>
  `${replacementJobStoragePrefix(propertyId)}${encodeURIComponent(targetUnitId)}`;
const legacyReplacementJobStorageKey = (propertyId: number) => `preflight.replacementFindJob.v1:${propertyId}`;
// NOTE FOR CODEX: the find-unit job lives ONLY in server memory
// (preflight-background-jobs.ts `replacementFindJobs` Map). Railway recycles the
// process on every deploy / idle-cycle / crash, which evicts the in-flight job —
// the poll then 404s even though the UI promised "Safe to leave this tab — search
// continues on server". So we persist the START PAYLOAD alongside the jobId so a
// 404 can transparently re-launch the SAME search instead of dead-ending the
// operator. `lastAliveAt` (refreshed on every successful poll) anchors the
// freshness window — NOT `startedAt` — so an actively-watched long search stays
// resumable while a days-stale reopen ages out. `resumeCount` is DURABLE (lives
// in localStorage, not a per-mount ref) so the restart cap survives the
// close/reopen remount and a crash-looping server can't keep earning fresh
// budget. All of payload/startedAt/lastAliveAt/resumeCount are optional so a ref
// written by an older client still parses.
//   NOTE: auto-resume is a FULL RESTART, not a progress-preserving resume — the
//   evicted job's `diagnostic` (uncheckedCandidates) died with the process, so
//   unlike the OperationFailureActions "continue-search" playbook we re-run
//   discovery from scratch; the operator sees the bar reset (we surface a
//   "resuming after server restart" line so it doesn't read as a regression).
type ReplacementJobRef = {
  jobId: string;
  targetUnitId: string;
  payload?: Record<string, unknown>;
  startedAt?: number;
  lastAliveAt?: number;
  resumeCount?: number;
};
const parseReplacementJobRef = (raw: string | null): ReplacementJobRef | null => {
  try {
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReplacementJobRef>;
    if (parsed?.jobId && parsed?.targetUnitId) {
      return {
        jobId: parsed.jobId,
        targetUnitId: parsed.targetUnitId,
        payload: parsed.payload && typeof parsed.payload === "object" ? parsed.payload : undefined,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : undefined,
        lastAliveAt: typeof parsed.lastAliveAt === "number" ? parsed.lastAliveAt : undefined,
        resumeCount: typeof parsed.resumeCount === "number" ? parsed.resumeCount : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
};

const loadReplacementJobRef = (propertyId: number, targetUnitId: string): ReplacementJobRef | null => {
  try {
    const current = parseReplacementJobRef(
      localStorage.getItem(replacementJobStorageKey(propertyId, targetUnitId)),
    );
    if (current) return current;

    // One-time migration from the property-wide key. Only the matching unit may
    // claim it; sibling panels must never attach to the same job.
    const legacyKey = legacyReplacementJobStorageKey(propertyId);
    const legacy = parseReplacementJobRef(localStorage.getItem(legacyKey));
    if (!legacy || legacy.targetUnitId !== targetUnitId) return null;
    localStorage.setItem(replacementJobStorageKey(propertyId, targetUnitId), JSON.stringify(legacy));
    localStorage.removeItem(legacyKey);
    return legacy;
  } catch {
    return null;
  }
};

const loadReplacementJobRefsForProperty = (propertyId: number): ReplacementJobRef[] => {
  const refs: ReplacementJobRef[] = [];
  try {
    const prefix = replacementJobStoragePrefix(propertyId);
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const ref = parseReplacementJobRef(localStorage.getItem(key));
      if (ref) refs.push(ref);
    }
    const legacy = parseReplacementJobRef(localStorage.getItem(legacyReplacementJobStorageKey(propertyId)));
    if (legacy) refs.push(legacy);
  } catch { /* ignore */ }
  return refs;
};

const saveReplacementJobRef = (
  propertyId: number,
  targetUnitId: string,
  ref: ReplacementJobRef | null,
) => {
  try {
    const key = replacementJobStorageKey(propertyId, targetUnitId);
    if (!ref) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(ref));
  } catch { /* ignore */ }
};
// Refresh the persisted "last known alive" stamp on every successful poll so the
// freshness window measures time-since-last-alive, not time-since-first-click —
// a long search the operator is actively watching never ages out of resumability.
const markReplacementJobRefAlive = (propertyId: number, targetUnitId: string) => {
  const ref = loadReplacementJobRef(propertyId, targetUnitId);
  if (!ref) return;
  saveReplacementJobRef(propertyId, targetUnitId, { ...ref, lastAliveAt: Date.now() });
};

// Only auto-resume a recently-alive search. A stale localStorage ref (e.g. the
// operator reopens the flow days later) must NOT silently launch a fresh,
// SearchAPI-billed search — show the expired error and let them re-click.
const REPLACEMENT_AUTO_RESUME_WINDOW_MS = 45 * 60 * 1000;

// Most-recently-alive replacement search across a set of properties, if any is
// still inside the auto-resume window. The dashboard uses this on mount to
// auto-reopen the Replace-photos dialog after the operator left Safari (iOS
// reloads the tab, wiping the dialog state while the job keeps running
// server-side) — without it they had to remember to re-click "Replace photos"
// to pick up the finished search.
export function findLiveReplacementJobRef(
  propertyIds: number[],
): { propertyId: number; targetUnitId: string } | null {
  let best: { propertyId: number; targetUnitId: string; aliveAt: number } | null = null;
  for (const propertyId of propertyIds) {
    for (const ref of loadReplacementJobRefsForProperty(propertyId)) {
      const aliveAt = ref.lastAliveAt ?? ref.startedAt ?? 0;
      if (!aliveAt || Date.now() - aliveAt > REPLACEMENT_AUTO_RESUME_WINDOW_MS) continue;
      if (!best || aliveAt > best.aliveAt) {
        best = { propertyId, targetUnitId: ref.targetUnitId, aliveAt };
      }
    }
  }
  return best ? { propertyId: best.propertyId, targetUnitId: best.targetUnitId } : null;
}
// Hard cap on transparent restarts for ONE search (durable via `resumeCount`, so
// it survives close/reopen remounts) — a crash-looping server can't keep driving
// find-unit + its SearchAPI budget. A fresh operator-initiated search() resets it.
const MAX_REPLACEMENT_AUTO_RESUMES = 3;
// attemptAutoResume outcome: a concurrent poll that finds the eviction already
// being handled must NOT surface the dead-end — it's "in-progress", not "cannot".
type AutoResumeOutcome = "resumed" | "in-progress" | "cannot";

function isTransientReplacementJobPollStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function humanizeApiError(err: unknown, fallback: string) {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const stripped = raw.replace(/^\d+:\s*/, "").trim();
  if (!stripped) return fallback;

  try {
    const parsed = JSON.parse(stripped);
    if (typeof parsed?.message === "string" && parsed.message.trim()) return parsed.message;
    if (typeof parsed?.error === "string" && parsed.error.trim()) return parsed.error;
  } catch {
    // Not a JSON error body; use the server's text as-is.
  }

  return stripped || fallback;
}

export type UnitStub = {
  id: string;
  unitNumber: string;
  bedrooms: number;
  photoFolder?: string;
  // Display metadata — optional, used to disambiguate units in the dropdown.
  positionLabel?: string;      // e.g. "Unit A", "Unit B" — their position in the property.
  replacementLabel?: string;   // e.g. "Unit #13D" — set if this unit already has an active swap.
  replacementSourceUrl?: string;
};

// Per-platform verdict from the server's SERP-based availability check.
//   clean   — SearchAPI responded and no matching listing was found
//   found   — SearchAPI responded and a listing for this unit was found
//             (candidates with `found` are rejected server-side and never
//             reach the UI, so in practice this value will not appear)
//   unknown — the SearchAPI call errored, so we genuinely don't know.
//             Previously treated as "clean" silently; now surfaced.
export type PlatformStatus = "clean" | "found" | "unknown";
export type PlatformCheck = {
  airbnb: PlatformStatus;
  vrbo: PlatformStatus;
  bookingCom: PlatformStatus;
};

export type ReplacementUnitData = {
  url: string;
  address: string;
  unitLabel: string;
  bedrooms: number | null;
  source: string;
  photos: { url: string; label: string }[];
  // FULL find-phase scraped gallery (https URLs) — `photos` above is often
  // just the SERP thumbnail (can be a base64 data: URI). This is what the
  // unit-swap commit sends as the hydration fallback so a bot-walled
  // commit-time re-scrape can't lose a find-proven gallery.
  photoUrls?: string[];
  photoFolder?: string;
  // Count of full-size photos the Apify scraper found on the source
  // listing. Server only returns candidates with >= 12 photos, but we
  // surface the exact number so the user can see they're picking a
  // listing with a rich gallery (e.g. 25 vs 13).
  photoCount?: number;
  expandedSearch?: boolean;
  relaxedPhotoFloor?: boolean;
  // Room categories detected by the interior-content probe (Claude
  // Haiku vision on 8 stratified samples). If Bedrooms isn't in here,
  // the server would have already rejected the candidate — we surface
  // this so the UI can show a "✓ Bedrooms · ✓ Bathrooms" style badge
  // as proof the listing actually has interior photography.
  sampledCategories?: string[];
  platformCheck?: PlatformCheck;
  // Set when the operator opted into "Include units already on Airbnb/VRBO"
  // (allowOtaListed) and this unit was kept despite being listed on that host.
  // Its real-estate photos were still verified as not reused on the OTA.
  otaListedOn?: string | null;
};

export function UnitReplacementFlow({
  unit,
  allUnits,
  communityFolder,
  communityName,
  propertyAddress,
  streetAddress,
  city,
  state,
  propertyId,
  skipUrls = [],
  lockUnitSelection = false,
  onClose,
  onUnitReplaced,
}: {
  unit: UnitStub;
  allUnits: UnitStub[];
  communityFolder: string;
  communityName?: string;
  propertyAddress?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  propertyId: number;
  skipUrls?: string[];
  lockUnitSelection?: boolean;
  onClose?: () => void;
  onUnitReplaced?: (oldUnitId: string, newUnit: ReplacementUnitData, swapId: number) => void;
}) {
  const { toast } = useToast();
  const [selectedUnitId, setSelectedUnitId] = useState(unit.id);
  const [stage, setStage] = useState<"idle" | "searching" | "checking" | "found" | "replacing" | "error">("idle");
  const [result, setResult] = useState<ReplacementUnitData | null>(null);
  // A0: all clean units the search surfaced. `result` is the currently-selected
  // one (defaults to options[0]); the operator can pick a different option.
  const [resultOptions, setResultOptions] = useState<ReplacementUnitData[]>([]);
  const [swapError, setSwapError] = useState<string | null>(null);
  // Operator opt-in for STVR-saturated communities (e.g. Waikoloa Beach Villas):
  // include units that are already listed on Airbnb/VRBO/Booking.com instead of
  // requiring a fully-clean unit. Photos are still sourced only from real-estate
  // sites and checked for OTA reuse, so this never reuses OTA photos.
  const [allowOtaListed, setAllowOtaListed] = useState(false);
  const [searchStartedAt, setSearchStartedAt] = useState<number | null>(null);
  const [progressTick, setProgressTick] = useState(0);
  const [lastSearchExpanded, setLastSearchExpanded] = useState(false);
  // URLs the user explicitly skipped via "Try another" — fed back into
  // the next find-unit call so we don't surface the same listing again.
  const [extraSkipUrls, setExtraSkipUrls] = useState<string[]>([]);
  const [replacementJobId, setReplacementJobId] = useState<string | null>(() =>
    loadReplacementJobRef(propertyId, unit.id)?.jobId ?? null,
  );
  const [replacementJob, setReplacementJob] = useState<PreflightReplacementFindJob | null>(null);
  const lastSearchPayloadRef = useRef<Record<string, unknown> | null>(null);
  // Per-mount guard: which evicted jobIds we've already begun resuming from, so
  // overlapping poll ticks (and the post-success re-render window where the old
  // jobId is still in the effect closure) don't double-launch. The DURABLE
  // spend cap lives in the localStorage ref's `resumeCount`, not here.
  const autoResumedFromRef = useRef<Set<string>>(new Set());
  // True only for the brief window after a transparent restart, so the searching
  // UI can reassure the operator instead of looking like the search reset itself.
  const [resumedAfterRestart, setResumedAfterRestart] = useState(false);

  const selectedUnit = allUnits.find(u => u.id === selectedUnitId) || unit;
  const hasActiveReplacement = allUnits.some(u => Boolean(u.replacementSourceUrl));

  // When the last failed search shows its candidates were overwhelmingly already
  // listed on an OTA (skipped-found is the dominant verdict) and the operator hasn't
  // opted into OTA-listed units yet, surface a one-click re-run that includes them —
  // for a short-term-rental-saturated community that's the cheapest, most effective
  // fix (scanning MORE units just finds more already-listed ones). The diagnostic
  // breakdown rides along on the failed job (replacementJob.diagnostic.breakdown).
  const failedBreakdown = (replacementJob?.diagnostic as { breakdown?: Record<string, number> } | null | undefined)?.breakdown ?? null;
  const skippedFoundCount = failedBreakdown?.["skipped-found"] ?? 0;
  const otaSaturatedFailure = !allowOtaListed
    && skippedFoundCount > 0
    && Object.entries(failedBreakdown ?? {}).every(([key, n]) => key === "skipped-found" || (n ?? 0) <= skippedFoundCount);

  const applyReplacementJob = (job: PreflightReplacementFindJob, restored = false) => {
    setReplacementJob(job);
    if (job.status === "queued" || job.status === "running") {
      setStage(job.phase === "checking" ? "checking" : "searching");
      if (!searchStartedAt) setSearchStartedAt(Date.now());
      return;
    }
    setSearchStartedAt(null);
    saveReplacementJobRef(propertyId, selectedUnit.id, null);
    setReplacementJobId(null);
    if (job.status === "completed" && job.unit) {
      setStage("found");
      const options = Array.isArray(job.units) && job.units.length > 0
        ? job.units
        : [job.unit];
      setResultOptions(options);
      setResult(options[0]);
      setSwapError(null);
      return;
    }
    if (job.status === "completed" || job.status === "failed") {
      setStage("error");
      setResult(null);
      if (!restored) {
        setSwapError(
          job.error
            || job.message
            || (job.status === "completed"
              ? "Search finished without a replacement unit. Please try again or expand the search."
              : "Search failed. Please try again."),
        );
      }
    }
  };

  useEffect(() => {
    const stored = loadReplacementJobRef(propertyId, selectedUnitId);
    if (!stored?.jobId) return;
    if (stored.targetUnitId !== selectedUnitId) return;
    // Rehydrate the payload so a 404 (or the error-state remediation) can
    // re-launch the same search after a remount, not just within the session
    // that called search().
    if (stored.payload && !lastSearchPayloadRef.current) {
      lastSearchPayloadRef.current = stored.payload;
    }
    setReplacementJobId(stored.jobId);
    setSearchStartedAt((prev) => prev ?? Date.now());
    setStage("searching");
  }, [propertyId, selectedUnitId]);

  // Transparent restart: the persisted job was evicted by a server restart
  // (poll 404). Re-launch the SAME search from the persisted payload so the
  // operator never sees a dead "session expired" screen — bounded by a freshness
  // window (keyed on last-known-alive) and a DURABLE restart cap.
  //   "resumed"     — a fresh job took over; caller should stop the old poll.
  //   "in-progress" — this eviction is already being resumed (a concurrent tick,
  //                   or the post-success window); caller must NOT show the error.
  //   "cannot"      — resume is impossible (stale/cap/no-payload/POST failed);
  //                   caller falls through to the dead-end error.
  const attemptAutoResume = async (evictedJobId: string): Promise<AutoResumeOutcome> => {
    // Synchronous claim BEFORE any await: serialises overlapping poll ticks and
    // the brief re-render window where the old jobId is still polled, so a given
    // eviction launches at most once. The claim is KEPT on success (to block the
    // post-success-window double-launch) but RELEASED on failure below, so a
    // failed start-POST can't strand the UI on a permanent "in-progress" spinner.
    if (autoResumedFromRef.current.has(evictedJobId)) return "in-progress";

    const stored = loadReplacementJobRef(propertyId, selectedUnit.id);
    const payload = lastSearchPayloadRef.current ?? stored?.payload ?? null;
    if (!payload || !payload.communityFolder) return "cannot";
    const aliveAt = stored?.lastAliveAt ?? stored?.startedAt ?? Date.now();
    if (Date.now() - aliveAt > REPLACEMENT_AUTO_RESUME_WINDOW_MS) return "cannot";
    const priorResumes = stored?.resumeCount ?? 0;
    if (priorResumes >= MAX_REPLACEMENT_AUTO_RESUMES) return "cannot";

    autoResumedFromRef.current.add(evictedJobId);
    try {
      const resp = await apiRequest("POST", "/api/preflight/replacement-find-jobs", payload);
      const data = await resp.json();
      // Only spend a resume slot on a CONFIRMED restart — a failed start POST
      // (transient 502 mid-redeploy) must not erode the durable cap. Release the
      // claim so the next poll tick can re-attempt or fall through to the error,
      // rather than being stuck on "in-progress" forever.
      if (!data?.job?.id) {
        autoResumedFromRef.current.delete(evictedJobId);
        return "cannot";
      }
      const targetUnitId = typeof payload.targetUnitId === "string" ? payload.targetUnitId : selectedUnit.id;
      saveReplacementJobRef(propertyId, targetUnitId, {
        jobId: data.job.id,
        targetUnitId,
        payload,
        startedAt: stored?.startedAt ?? Date.now(), // carry forward original click time
        lastAliveAt: Date.now(),
        resumeCount: priorResumes + 1,              // durable; incremented only on success
      });
      setSwapError(null);
      setResult(null);
      setResumedAfterRestart(true);
      setStage("searching");
      setSearchStartedAt(Date.now());
      setProgressTick(0);
      setReplacementJobId(data.job.id as string);
      applyReplacementJob(data.job as PreflightReplacementFindJob);
      return "resumed";
    } catch {
      autoResumedFromRef.current.delete(evictedJobId);
      return "cannot";
    }
  };

  useEffect(() => {
    if (!replacementJobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const resp = await fetch(`/api/preflight/replacement-find-jobs/${encodeURIComponent(replacementJobId)}`, {
          credentials: "include",
        });
        if (!resp.ok) {
          // Railway can return 502/503/504 while find-unit holds the process for
          // several minutes; the in-memory job keeps running — keep polling.
          if (isTransientReplacementJobPollStatus(resp.status)) return;
          if (cancelled) return;
          // 404 == the server-memory job is gone (restart/idle-cycle/crash).
          // Try to transparently re-launch the same search before surfacing the
          // dead-end.
          if (resp.status === 404) {
            const outcome = await attemptAutoResume(replacementJobId);
            if (cancelled) return;          // effect torn down during the resume POST
            if (outcome === "resumed") {
              // The new jobId starts its own poll loop; neutralise this (old) one
              // so a stale tick can't clobber the resume with an error.
              cancelled = true;
              return;
            }
            // A concurrent tick is already resuming this eviction — keep waiting,
            // do NOT surface the dead-end (it would race the in-flight resume).
            if (outcome === "in-progress") return;
            // outcome === "cannot" → fall through to the error below.
          }
          saveReplacementJobRef(propertyId, selectedUnit.id, null);
          setReplacementJobId(null);
          setSearchStartedAt(null);
          setStage("error");
          setSwapError(
            resp.status === 404
              ? "Replacement search session expired (server restarted or job not found). Please run Find Replacement Unit again."
              : `Could not check search status (HTTP ${resp.status}). Please try again.`,
          );
          return;
        }
        const data = await resp.json();
        if (cancelled) return;
        if (data.job) {
          const job = data.job as PreflightReplacementFindJob;
          // A stuck-unresumable record (the SERVER gave up resuming after a
          // deploy burst) used to surface as a 404 here — keep the transparent
          // client relaunch for it before falling back to the honest error.
          if (job.status === "failed" && job.stuckUnresumable === true) {
            const outcome = await attemptAutoResume(replacementJobId);
            if (cancelled) return;
            if (outcome === "resumed") {
              cancelled = true;
              return;
            }
            if (outcome === "in-progress") return;
            // outcome === "cannot" → fall through: applyReplacementJob surfaces
            // the server's "interrupted by server restarts" failure.
          }
          // Refresh the freshness anchor while the job is genuinely alive, so a
          // long actively-watched search never ages out of auto-resume.
          if (job.status === "queued" || job.status === "running") {
            markReplacementJobRefAlive(propertyId, selectedUnit.id);
          }
          applyReplacementJob(job);
        }
      } catch {
        // keep polling
      }
    };
    poll();
    const terminal = replacementJob?.status === "completed" || replacementJob?.status === "failed";
    if (terminal) return () => { cancelled = true; };
    const interval = window.setInterval(poll, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replacementJobId, replacementJob?.status, propertyId, selectedUnitId]);

  const isWorking = stage === "searching" || stage === "checking";
  useEffect(() => {
    if (!isWorking) return;
    const id = window.setInterval(() => setProgressTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [isWorking]);

  async function search(opts: { extraSkip?: string | string[]; expanded?: boolean; allowOtaListed?: boolean } = {}) {
    const expanded = opts.expanded === true;
    // Allow a one-shot override (the "Include OTA-listed & retry" action) without
    // waiting for the checkbox's setState to flush. Also reflect it in the checkbox
    // so subsequent manual searches keep the operator's choice.
    const useAllowOtaListed = opts.allowOtaListed ?? allowOtaListed;
    if (opts.allowOtaListed === true && !allowOtaListed) setAllowOtaListed(true);
    // A fresh operator-initiated search resets the durable resume budget and the
    // per-mount eviction guard, so a new search gets its own restart allowance.
    autoResumedFromRef.current = new Set();
    setResult(null);
    setResultOptions([]);
    setSwapError(null);
    setResumedAfterRestart(false);
    setLastSearchExpanded(expanded);
    setSearchStartedAt(Date.now());
    setProgressTick(0);
    setStage("searching");
    const extraSkipList = Array.isArray(opts.extraSkip)
      ? opts.extraSkip.filter(Boolean)
      : opts.extraSkip ? [opts.extraSkip] : [];
    const nextExtra = extraSkipList.length ? Array.from(new Set([...extraSkipUrls, ...extraSkipList])) : extraSkipUrls;
    if (extraSkipList.length) setExtraSkipUrls(nextExtra);
    const startPayload = {
      communityFolder,
      communityName,
      propertyAddress,
      streetAddress,
      city,
      state,
      propertyId,
      targetUnitId: selectedUnit.id,
      requiredBedrooms: selectedUnit.bedrooms,
      skipUrls: [...skipUrls, ...nextExtra],
      expandedSearch: expanded,
      allowOtaListed: useAllowOtaListed,
      // Interactive searches should return the first fully verified unit. The
      // server still supports exhaustive mode for batch callers, but making the
      // operator wait for 12 options kept this dialog at 94% long after a safe
      // result had already been found.
      collectAllOptions: false,
    };
    lastSearchPayloadRef.current = startPayload;
    try {
      const resp = await apiRequest("POST", "/api/preflight/replacement-find-jobs", startPayload);
      const data = await resp.json();
      if (!data?.job?.id) throw new Error("Replacement search did not start");
      setReplacementJobId(data.job.id as string);
      saveReplacementJobRef(propertyId, selectedUnit.id, {
        jobId: data.job.id,
        targetUnitId: selectedUnit.id,
        payload: startPayload,
        startedAt: Date.now(),
        lastAliveAt: Date.now(),
        resumeCount: 0,
      });
      applyReplacementJob(data.job as PreflightReplacementFindJob);
    } catch (err) {
      setStage("error");
      setSwapError(humanizeApiError(err, "Failed to connect. Please try again."));
      setSearchStartedAt(null);
    }
  }

  async function handleReplaceUnit() {
    if (!result) return;
    setStage("replacing");
    setSwapError(null);
    try {
      const resp = await apiRequest("POST", "/api/unit-swaps", {
        propertyId,
        communityFolder,
        oldUnitId: selectedUnit.id,
        oldUnitNumber: selectedUnit.unitNumber,
        oldBedrooms: selectedUnit.bedrooms,
        newAddress: result.address,
        newUnitLabel: result.unitLabel,
        newBedrooms: result.bedrooms,
        newSourceUrl: result.url,
        thumbnailUrl: result.photos[0]?.url || null,
        // Find-phase gallery URLs — the server's hydration fallback when the
        // commit-time re-scrape hits a bot-wall/quota outage. Prefer the full
        // proven gallery (photoUrls); result.photos is only the display
        // thumbnail, often a base64 data: URI the server filter drops.
        photoUrls: (result.photoUrls?.length
          ? result.photoUrls
          : result.photos.map((p) => p.url)
        ).filter(Boolean),
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || "Failed to record unit swap");
      }
      const data = await resp.json();
      const swapId: number = data?.swap?.id ?? 0;
      const photoFolder = typeof data?.photoFolder === "string" ? data.photoFolder : undefined;
      // Warn when the pulled photos cover fewer distinct bedrooms than the
      // listing claims — e.g. a 3BR where only 2 bedrooms were actually
      // photographed (the same-room scan no longer masks this as 3/3).
      const shortfall = Number(data?.coverage?.bedroomsShortfall ?? 0);
      if (shortfall > 0) {
        const found = Number(data?.coverage?.bedroomsFound ?? data?.bedroomsFound ?? 0);
        const expected = Number(data?.coverage?.bedroomsExpected ?? result.bedrooms ?? 0);
        toast({
          title: "Replacement saved — but a bedroom may be missing photos",
          description: `Only ${found} of ${expected} bedrooms have distinct photos in this listing. Review the Photos tab and re-pull or pick a richer source if a bedroom is missing.`,
          duration: 12000,
        });
      }
      saveReplacementJobRef(propertyId, selectedUnit.id, null);
      setReplacementJobId(null);
      setReplacementJob(null);
      setSearchStartedAt(null);
      // Notify parent to apply the replacement and re-run the platform check
      onUnitReplaced?.(selectedUnit.id, { ...result, photoFolder }, swapId);
      onClose?.();
    } catch (err: any) {
      setSwapError(humanizeApiError(err, "Failed to record swap. Please try again."));
      setStage("found");
    }
  }

  const steps = ["Search Zillow", "Check platforms", "Confirm Clean"];
  const stepDone = stage === "checking"
    ? [true, false, false]
    : (stage === "found" || stage === "replacing")
      ? [true, true, true]
      : [false, false, false];
  const stepActive = stage === "searching"
    ? [true, false, false]
    : stage === "checking"
      ? [false, true, false]
      : [false, false, false];
  const elapsedSeconds = searchStartedAt
    ? Math.max(progressTick, Math.floor((Date.now() - searchStartedAt) / 1000))
    : 0;
  const progressPercent = replacementJob && (replacementJob.status === "queued" || replacementJob.status === "running")
    ? Math.min(94, Math.max(8, replacementJob.progress))
    : stage === "searching"
      ? Math.min(42, 10 + elapsedSeconds * 2.2)
      : stage === "checking"
        ? Math.min(94, 42 + Math.max(0, elapsedSeconds - 2) * 0.75)
        : stage === "found"
          ? 100
          : 0;
  const elapsedLabel = elapsedSeconds >= 60
    ? `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`
    : `${elapsedSeconds}s`;

  return (
    <div className="rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />
          Find a New Unit
        </p>
        {onClose && (
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onClose} data-testid="button-close-replacement-flow">
            <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        )}
      </div>

      {/* Unit selector + search */}
      {(stage === "idle" || stage === "searching" || stage === "checking") && (
        <>
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Which unit would you like to replace?</p>
            <Select
              value={selectedUnitId}
              onValueChange={setSelectedUnitId}
              disabled={stage !== "idle" || lockUnitSelection}
            >
              <SelectTrigger className="h-8 text-xs" data-testid="select-replacement-unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allUnits.map(u => {
                  const prefix = u.positionLabel ?? `Unit #${u.unitNumber}`;
                  const tail = u.positionLabel ? ` — ${u.bedrooms} BR (${u.unitNumber})` : ` — ${u.bedrooms} BR`;
                  return (
                    <SelectItem key={u.id} value={u.id} className="text-xs">
                      {prefix}{tail}
                      {u.replacementLabel ? ` · currently: ${u.replacementLabel}` : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {stage === "idle" && (
            <div className="space-y-2">
              <Button
                size="sm"
                className="w-full"
                onClick={() => search({ expanded: hasActiveReplacement })}
                data-testid="button-start-unit-search"
              >
                <SearchIcon className="h-3.5 w-3.5 mr-1.5" />
                Find Replacement Unit
              </Button>
              <label
                className="flex items-start gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none"
                data-testid="toggle-allow-ota-listed"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-3 w-3 cursor-pointer accent-primary"
                  checked={allowOtaListed}
                  onChange={(e) => setAllowOtaListed(e.target.checked)}
                />
                <span>
                  Include units already on Airbnb/VRBO
                  <span className="block text-[10px] opacity-80">
                    For heavily-rented communities (e.g. Waikoloa Beach Villas) where most units are already short-term rentals. Photos still come only from real-estate sites and are checked for reuse.
                  </span>
                </span>
              </label>
            </div>
          )}

          {(stage === "searching" || stage === "checking") && (
            <div className="space-y-2">
              {resumedAfterRestart && (
                <div
                  className="flex items-start gap-1.5 rounded border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] text-sky-800 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300"
                  data-testid="replacement-resumed-after-restart"
                >
                  <RefreshCw className="h-3 w-3 mt-0.5 flex-shrink-0" />
                  <span>Server restarted — your search resumed automatically (it restarts from the top, so the progress bar reset).</span>
                </div>
              )}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span>
                  {replacementJob?.message
                    || (stage === "searching"
                      ? lastSearchExpanded
                        ? "Expanded search across Zillow, Realtor, Redfin, and Homes.com…"
                        : "Searching Zillow, Realtor, and Redfin…"
                      : "Checking Airbnb, VRBO, and Booking.com for conflicts…")}
                </span>
              </div>
              <div className="space-y-1.5">
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-amber-100 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progressPercent)}
                  aria-label="Replacement search progress"
                  data-testid="replacement-search-progress"
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-teal-500 to-blue-700 transition-all duration-700"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>{Math.round(progressPercent)}% · {elapsedLabel}</span>
                  <span className="text-right">
                    {replacementJobId
                      ? "Safe to leave this tab — search continues on server"
                      : stage === "searching"
                        ? lastSearchExpanded
                          ? "Finding more real-estate candidates"
                          : "Finding real-estate candidates"
                        : elapsedSeconds > 90
                          ? "Still checking candidates; this can take a few minutes"
                          : "Verifying candidate is not already listed"}
                  </span>
                </div>
              </div>
              <div className="flex gap-1.5">
                {steps.map((label, i) => (
                  <div
                    key={label}
                    className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border ${
                      stepDone[i]
                        ? "border-green-400 text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/30"
                        : stepActive[i]
                          ? "border-primary text-primary"
                          : "border-border text-muted-foreground"
                    }`}
                  >
                    {stepDone[i]
                      ? <CheckCircle2 className="h-2.5 w-2.5" />
                      : stepActive[i]
                        ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        : <div className="h-2.5 w-2.5 rounded-full border border-current opacity-40" />}
                    {label}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Error state */}
      {stage === "error" && (
        <div className="space-y-2">
          <p className="text-xs text-red-600 dark:text-red-400 flex items-start gap-1.5">
            <XCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            {swapError || "Search failed. Please try again."}
          </p>
          {otaSaturatedFailure && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5" data-testid="replacement-ota-saturated-hint">
              <ShieldAlert className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              <span>
                {skippedFoundCount} of the listings found are already on Airbnb/VRBO/Booking.com — this community is heavily rented, so few or no fully-clean units remain. Include OTA-listed units to use one (its real-estate photos are still checked, so duplicate photos are never reused).
              </span>
            </p>
          )}
          <div className="flex flex-wrap gap-2 items-center">
            {otaSaturatedFailure && (
              <Button
                size="sm"
                onClick={() => search({ allowOtaListed: true, expanded: lastSearchExpanded })}
                data-testid="button-include-ota-listed-retry"
              >
                <ShieldAlert className="h-3.5 w-3.5 mr-1.5" />
                Include OTA-listed units &amp; retry
              </Button>
            )}
            <OperationFailureActions
              jobType="replacement-find"
              jobId={replacementJobId}
              startPayload={lastSearchPayloadRef.current ?? undefined}
              onRemediated={({ job }) => {
                if (job && typeof job === "object" && "id" in job) {
                  const next = job as PreflightReplacementFindJob;
                  // Operator-initiated retry: fresh resume budget + eviction guard.
                  autoResumedFromRef.current = new Set();
                  setResumedAfterRestart(false);
                  setReplacementJobId(next.id);
                  saveReplacementJobRef(propertyId, selectedUnit.id, {
                    jobId: next.id,
                    targetUnitId: selectedUnit.id,
                    payload: lastSearchPayloadRef.current ?? undefined,
                    startedAt: Date.now(),
                    lastAliveAt: Date.now(),
                    resumeCount: 0,
                  });
                  applyReplacementJob(next, false);
                  setStage("searching");
                  setSearchStartedAt(Date.now());
                }
              }}
            />
            <Button size="sm" variant="outline" onClick={() => { setStage("idle"); setSwapError(null); }} data-testid="button-retry-unit-search">
              Try Again
            </Button>
            <Button size="sm" onClick={() => search({ expanded: true })} data-testid="button-expand-unit-search">
              <SearchIcon className="h-3.5 w-3.5 mr-1.5" />
              Expand Search
            </Button>
          </div>
        </div>
      )}

      {/* Found unit — confirm replacement */}
      {(stage === "found" || stage === "replacing") && result && (() => {
        // Platform-check header: all three platforms must report
        // "clean" for a full green shield. Any "unknown" downgrades to
        // amber (SearchAPI couldn't confirm on that platform, so the
        // user should treat the result as "probably clean, not proven").
        // Normally we never surface "found" — but when the operator opted into
        // "Include units already on Airbnb/VRBO" (allowOtaListed), the server
        // returns an OTA-listed unit flagged via `otaListedOn`; surface that
        // distinctly so the green "clean" shield never lies.
        const pc = result.platformCheck;
        const otaListedHost = result.otaListedOn;
        const statuses: Array<[label: string, key: keyof PlatformCheck]> = [
          ["Airbnb",      "airbnb"],
          ["VRBO",        "vrbo"],
          ["Booking.com", "bookingCom"],
        ];
        const allClean = !otaListedHost && (pc ? statuses.every(([, k]) => pc[k] === "clean") : false);
        const anyUnknown = pc ? statuses.some(([, k]) => pc[k] === "unknown") : true;
        const headerTone = otaListedHost
          ? "amber"
          : allClean
            ? "green"
            : anyUnknown
              ? "amber"
              : "green"; // no platformCheck field at all → treat as old-behavior green
        // Bedroom confirmation: the search is constrained to the replaced unit's
        // bedroom count (requiredBedrooms), but the operator asked to SEE the
        // found unit's bedroom count confirmed every time it surfaces a
        // replacement — including when the scraper couldn't detect it
        // (foundBedrooms null) or when it doesn't match what we searched for.
        const requiredBedrooms = selectedUnit.bedrooms;
        const foundBedrooms = result.bedrooms;
        const bedroomsKnown = typeof foundBedrooms === "number" && foundBedrooms > 0;
        const bedroomsMatch = bedroomsKnown && foundBedrooms === requiredBedrooms;
        return (
        <div className="space-y-2.5">
          {/* A0: when the search surfaced several clean units, let the operator
              pick which one to replace with. Selecting an option swaps `result`,
              so the verdict header, bedroom confirmation, photos, and the
              "Replace" action below all reflect the chosen unit. */}
          {resultOptions.length > 1 && (
            <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2 space-y-1.5" data-testid="replacement-options">
              <p className="text-[11px] font-semibold text-foreground">
                {resultOptions.length} clean options found — pick one to replace with:
              </p>
              <div className="space-y-1">
                {resultOptions.map((opt, i) => {
                  const selected = opt.url === result.url;
                  return (
                    <button
                      key={opt.url || i}
                      type="button"
                      onClick={() => { setResult(opt); setSwapError(null); }}
                      className={`w-full text-left rounded border px-2 py-1.5 flex items-center justify-between gap-2 transition ${
                        selected
                          ? "border-primary bg-primary/10"
                          : "border-border bg-background hover:bg-muted"
                      }`}
                      data-testid={`replacement-option-${i}`}
                    >
                      <span className="min-w-0">
                        <span className="text-[11px] font-medium text-foreground block truncate">{opt.unitLabel}</span>
                        <span className="text-[10px] text-muted-foreground block truncate">
                          {opt.source}
                          {typeof opt.bedrooms === "number" && opt.bedrooms > 0 ? ` · ${opt.bedrooms} BR` : ""}
                          {opt.otaListedOn ? ` · on ${opt.otaListedOn}` : ""}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5 flex-shrink-0">
                        {typeof opt.photoCount === "number" && (
                          <span className="text-[10px] text-muted-foreground">📷 {opt.photoCount}</span>
                        )}
                        {selected && <span className="text-primary text-xs font-bold">✓</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <p
              className={`text-xs font-medium flex items-center gap-1.5 ${
                headerTone === "green"
                  ? "text-green-700 dark:text-green-400"
                  : "text-amber-700 dark:text-amber-400"
              }`}
            >
              {headerTone === "green" ? (
                <ShieldCheck className="h-3.5 w-3.5" />
              ) : (
                <ShieldAlert className="h-3.5 w-3.5" />
              )}
              {otaListedHost
                ? `Already listed on ${otaListedHost} — kept by your "include OTA-listed" setting`
                : allClean
                  ? "Clean on Airbnb, VRBO, and Booking.com"
                  : anyUnknown
                    ? "Partial check — one or more platforms couldn't be verified"
                    : "Clean replacement found"}
            </p>
            {otaListedHost && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400" data-testid="replacement-ota-listed-note">
                This unit is already a short-term rental on {otaListedHost}. Its real-estate photos were verified as not reused on the OTA, so they're safe to use.
              </p>
            )}
            {pc && (
              <div className="flex items-center gap-1 flex-wrap">
                {statuses.map(([label, key]) => {
                  const s = pc[key];
                  const cls =
                    s === "clean"
                      ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                      : s === "found"
                        ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                        : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
                  const glyph = s === "clean" ? "✓" : s === "found" ? "✗" : "⚠";
                  const title =
                    s === "clean"
                      ? `${label}: no listing found`
                      : s === "found"
                        ? `${label}: listing found`
                        : `${label}: SearchAPI error — could not verify`;
                  return (
                    <span
                      key={key}
                      title={title}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}
                      data-testid={`platform-status-${key}`}
                    >
                      {glyph} {label}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          {/* Bedroom confirmation — the operator explicitly wants to see how many
              bedrooms the found replacement has, every time. Always shown: green
              when it matches the unit being replaced, amber when it differs or
              couldn't be auto-detected (so the count is never silently assumed). */}
          <div
            className={`rounded-md border px-3 py-2 flex items-start gap-2 ${
              bedroomsMatch
                ? "border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300"
                : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
            }`}
            data-testid="replacement-bedroom-confirm"
          >
            <BedDouble className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div className="text-xs leading-snug">
              {bedroomsKnown ? (
                bedroomsMatch ? (
                  <p className="font-semibold">
                    Confirmed: this replacement has {foundBedrooms} bedroom{foundBedrooms === 1 ? "" : "s"} — matches the {requiredBedrooms}-bedroom unit you're replacing.
                  </p>
                ) : (
                  <>
                    <p className="font-semibold">
                      This replacement has {foundBedrooms} bedroom{foundBedrooms === 1 ? "" : "s"}, but the unit you're replacing has {requiredBedrooms}.
                    </p>
                    <p className="text-[11px] mt-0.5">Open the listing and verify the bedroom count before confirming the swap.</p>
                  </>
                )
              ) : (
                <>
                  <p className="font-semibold">
                    Bedroom count couldn't be auto-detected for this replacement.
                  </p>
                  <p className="text-[11px] mt-0.5">
                    The search targeted {requiredBedrooms} bedroom{requiredBedrooms === 1 ? "" : "s"} — open the listing below to confirm it has {requiredBedrooms} before replacing.
                  </p>
                </>
              )}
            </div>
          </div>
          <div className="rounded border border-border bg-background px-3 py-2.5 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0">
                <Home className="h-3.5 w-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold leading-snug">{result.unitLabel}</p>
                  <p className="text-[11px] text-muted-foreground leading-snug">{result.address}</p>
                  <p className="text-[11px] text-muted-foreground">Source: {result.source}</p>
                  {result.bedrooms && (
                    <p className="text-[11px] text-muted-foreground">
                      {result.bedrooms} Bedroom{result.bedrooms > 1 ? "s" : ""}
                    </p>
                  )}
                </div>
              </div>
                  {typeof result.photoCount === "number" && (
                <div
                  className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold flex items-center gap-1 ${
                    result.photoCount >= 20
                      ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                      : result.photoCount >= 12
                        ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                        : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                  }`}
                  title={
                    result.photoCount >= 20
                      ? "Rich gallery — bedrooms, bathrooms, kitchen likely all covered"
                      : result.photoCount >= 12
                        ? "Adequate gallery — check for bedrooms before confirming"
                        : "Sparse gallery — likely missing interior shots"
                  }
                >
                  📷 {result.photoCount} photos
                </div>
              )}
            </div>
            {result.relaxedPhotoFloor && (
              <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                Expanded search accepted this smaller gallery. Review the source photos before confirming.
              </div>
            )}
            {result.photos.length > 0 && (
              <div className="grid grid-cols-6 gap-1">
                {result.photos.map((photo, i) => (
                  <div key={i} className="aspect-square rounded overflow-hidden border border-border">
                    <img
                      src={photo.url}
                      alt={photo.label}
                      className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  </div>
                ))}
              </div>
            )}
            {/* Vision probe categories — shown as chips so the user can
                verify the listing actually contains bedroom/bathroom photos,
                not just exterior/aerial. Empty array means the probe didn't
                run (no Anthropic key) — hide the row entirely in that case. */}
            {Array.isArray(result.sampledCategories) && result.sampledCategories.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap pt-1">
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Detected:</span>
                {Array.from(new Set(result.sampledCategories)).map((cat) => {
                  const hot = cat === "Bedrooms" || cat === "Bathrooms";
                  return (
                    <span
                      key={cat}
                      className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        hot
                          ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {hot && "✓ "}
                      {cat}
                    </span>
                  );
                })}
              </div>
            )}
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-primary hover:underline flex items-center gap-1"
              data-testid="link-replacement-unit-source"
            >
              View on {result.source}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          </div>

          {/* What will change */}
          <div className="rounded bg-muted/50 border border-border px-2.5 py-2 text-[11px] text-muted-foreground space-y-0.5">
            <p className="font-medium text-foreground text-xs mb-1">What this replaces:</p>
            <p><span className="line-through text-muted-foreground">Unit #{selectedUnit.unitNumber} ({selectedUnit.bedrooms} BR)</span> → <span className="font-medium text-foreground">{result.unitLabel} ({bedroomsKnown ? `${foundBedrooms} BR` : "bedrooms unconfirmed"})</span></p>
            <p className="text-[10px]">Address, unit number, bedroom count, and photo source will all update. Platform check will re-run automatically.</p>
          </div>

          {swapError && (
            <p className="text-[11px] text-red-600 dark:text-red-400">{swapError}</p>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleReplaceUnit}
              className="flex-1"
              disabled={stage === "replacing"}
              data-testid="button-push-to-builder"
            >
              {stage === "replacing" ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Replacing…</>
              ) : (
                <><Repeat2 className="h-3.5 w-3.5 mr-1.5" />Yes, Replace Unit</>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={stage === "replacing"}
              onClick={() => {
                // Skip every option currently shown (not just the selected one)
                // and immediately re-search, so "Try Another" surfaces units the
                // operator hasn't seen yet rather than re-offering this batch.
                const skipAll = (resultOptions.length > 0 ? resultOptions : [result])
                  .map((u) => u.url)
                  .filter(Boolean);
                const expanded = result.expandedSearch === true;
                setResult(null);
                setResultOptions([]);
                setSwapError(null);
                search({ extraSkip: skipAll, expanded });
              }}
              data-testid="button-try-another-unit"
            >
              {resultOptions.length > 1 ? "Find Different Units" : "Try Another"}
            </Button>
          </div>
        </div>
        );
      })()}
    </div>
  );
}
