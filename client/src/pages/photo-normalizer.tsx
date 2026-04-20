// Bulk normalize photos across every Guesty listing.
// Fetches each listing's existing Guesty pictures, runs them through the server
// validator (landscape/1920×1080/JPEG/≤4MB), and PUTs the fixed ones back.
// Live NDJSON progress stream — no timeouts possible.
import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { ArrowLeft, Images, Play, Square, CheckCircle2, AlertTriangle } from "lucide-react";

type LogLine =
  | { kind: "start"; listingCount: number }
  | { kind: "listing-start"; id: string; name: string; photoCount: number }
  | { kind: "photo"; listingId: string; index: number; total: number; success: boolean; fixed?: boolean; skipped?: boolean; changes?: string[]; originalWidth?: number; originalHeight?: number; finalWidth?: number; finalHeight?: number; error?: string }
  | { kind: "listing-done"; id: string; name: string; fixedCount: number; skippedCount: number; totalCount: number }
  | { kind: "listing-error"; id: string; name?: string; error: string }
  | { kind: "all-done"; listingCount: number; globalFixed: number; globalSkipped: number; globalFailed: number };

export default function PhotoNormalizer() {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [currentListing, setCurrentListing] = useState<string | null>(null);
  const [listingProgress, setListingProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const [photoProgress, setPhotoProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const [summary, setSummary] = useState<{ listingCount: number; globalFixed: number; globalSkipped: number; globalFailed: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const appendLog = (line: LogLine) => setLog((prev) => [...prev, line]);

  const start = async (all: boolean) => {
    setLog([]);
    setSummary(null);
    setListingProgress({ current: 0, total: 0 });
    setPhotoProgress({ current: 0, total: 0 });
    setCurrentListing(null);
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let listingsSeen = 0;

    try {
      const resp = await fetch("/api/builder/normalize-photos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        appendLog({ kind: "listing-error", id: "-", error: `HTTP ${resp.status}` });
        setRunning(false);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try { evt = JSON.parse(line); } catch { continue; }

          if (evt.type === "start") {
            setListingProgress({ current: 0, total: evt.listingCount });
            appendLog({ kind: "start", listingCount: evt.listingCount });
          } else if (evt.type === "listing-start") {
            listingsSeen++;
            setCurrentListing(evt.name);
            setListingProgress({ current: listingsSeen, total: listingProgress.total || evt.listingCount || 0 });
            setPhotoProgress({ current: 0, total: evt.photoCount });
            appendLog({ kind: "listing-start", id: evt.id, name: evt.name, photoCount: evt.photoCount });
          } else if (evt.type === "photo") {
            setPhotoProgress({ current: evt.index, total: evt.total });
            appendLog({ kind: "photo", ...evt });
          } else if (evt.type === "listing-done") {
            appendLog({ kind: "listing-done", id: evt.id, name: evt.name, fixedCount: evt.fixedCount, skippedCount: evt.skippedCount, totalCount: evt.totalCount });
          } else if (evt.type === "listing-error") {
            appendLog({ kind: "listing-error", id: evt.id, name: evt.name, error: evt.error });
          } else if (evt.type === "all-done") {
            setSummary({ listingCount: evt.listingCount, globalFixed: evt.globalFixed, globalSkipped: evt.globalSkipped, globalFailed: evt.globalFailed });
            appendLog({ kind: "all-done", ...evt });
          }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        appendLog({ kind: "listing-error", id: "-", error: e.message });
      }
    } finally {
      setRunning(false);
      setCurrentListing(null);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const fixedCount = log.filter((l) => l.kind === "photo" && l.success && l.fixed).length;
  const skippedCount = log.filter((l) => l.kind === "photo" && l.success && l.skipped).length;
  const errorCount = log.filter((l) => l.kind === "photo" && !l.success).length;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <Link href="/">
              <Button variant="ghost" size="sm" className="mb-2">
                <ArrowLeft className="h-4 w-4 mr-2" /> Home
              </Button>
            </Link>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Images className="h-6 w-6" /> Photo Normalizer
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Rotate portraits → landscape, resize to 1920×1080, compress to ≤4MB, JPEG.
              Fixes photos already uploaded to Guesty so Booking.com, Airbnb, and Vrbo stop rejecting them.
            </p>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Run</CardTitle>
            <CardDescription>
              Bulk mode iterates every mapped Guesty listing sequentially. Compliant photos are left
              untouched. Only fixed photos are re-uploaded to ImgBB and PUT back to Guesty.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 mb-4">
              {!running ? (
                <Button onClick={() => start(true)} data-testid="button-normalize-all">
                  <Play className="h-4 w-4 mr-2" /> Normalize ALL listings
                </Button>
              ) : (
                <Button onClick={stop} variant="destructive" data-testid="button-stop">
                  <Square className="h-4 w-4 mr-2" /> Stop
                </Button>
              )}
            </div>

            {running && (
              <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm space-y-1">
                <div>
                  <b>Listing {listingProgress.current}/{listingProgress.total}:</b>{" "}
                  {currentListing || "starting…"}
                </div>
                {photoProgress.total > 0 && (
                  <div className="text-xs text-gray-700">
                    Photo {photoProgress.current}/{photoProgress.total}
                    <div className="mt-1 h-1.5 bg-blue-100 rounded overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${(photoProgress.current / Math.max(photoProgress.total, 1)) * 100}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {!running && (log.length > 0 || summary) && (
              <div className="grid grid-cols-4 gap-3">
                <div className="p-3 rounded bg-green-50 border border-green-200">
                  <div className="text-xs text-green-700 uppercase font-semibold">Fixed</div>
                  <div className="text-2xl font-bold text-green-800">{summary?.globalFixed ?? fixedCount}</div>
                </div>
                <div className="p-3 rounded bg-gray-50 border border-gray-200">
                  <div className="text-xs text-gray-600 uppercase font-semibold">Already OK</div>
                  <div className="text-2xl font-bold">{summary?.globalSkipped ?? skippedCount}</div>
                </div>
                <div className="p-3 rounded bg-red-50 border border-red-200">
                  <div className="text-xs text-red-700 uppercase font-semibold">Errors</div>
                  <div className="text-2xl font-bold text-red-800">{summary?.globalFailed ?? errorCount}</div>
                </div>
                <div className="p-3 rounded bg-blue-50 border border-blue-200">
                  <div className="text-xs text-blue-700 uppercase font-semibold">Listings</div>
                  <div className="text-2xl font-bold text-blue-800">{summary?.listingCount ?? 0}</div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {log.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-[500px] overflow-y-auto font-mono text-xs space-y-1">
                {log.map((line, i) => {
                  if (line.kind === "start") {
                    return <div key={i} className="text-blue-700 font-semibold">▸ Starting {line.listingCount} listings</div>;
                  }
                  if (line.kind === "listing-start") {
                    return <div key={i} className="text-gray-900 font-semibold mt-2">📁 {line.name} — {line.photoCount} photos</div>;
                  }
                  if (line.kind === "photo") {
                    if (!line.success) {
                      return <div key={i} className="text-red-700 pl-4">✗ #{line.index} — {line.error}</div>;
                    }
                    if (line.skipped) {
                      return <div key={i} className="text-gray-500 pl-4">○ #{line.index} — already compliant ({line.finalWidth}×{line.finalHeight})</div>;
                    }
                    if (line.fixed) {
                      return (
                        <div key={i} className="text-green-700 pl-4">
                          ✓ #{line.index} — {line.originalWidth}×{line.originalHeight} → {line.finalWidth}×{line.finalHeight}
                          {line.changes && line.changes.length > 0 && (
                            <span className="text-gray-600 ml-2">[{line.changes.join(", ")}]</span>
                          )}
                        </div>
                      );
                    }
                  }
                  if (line.kind === "listing-done") {
                    return (
                      <div key={i} className="text-gray-700 pl-2 flex items-center gap-2">
                        <CheckCircle2 className="h-3 w-3 text-green-600" />
                        <span>{line.name}: {line.fixedCount} fixed, {line.skippedCount} unchanged of {line.totalCount}</span>
                      </div>
                    );
                  }
                  if (line.kind === "listing-error") {
                    return (
                      <div key={i} className="text-red-700 pl-2 flex items-center gap-2">
                        <AlertTriangle className="h-3 w-3" />
                        <span>{line.name || line.id}: {line.error}</span>
                      </div>
                    );
                  }
                  if (line.kind === "all-done") {
                    return (
                      <div key={i} className="text-blue-700 font-semibold mt-3 pt-2 border-t">
                        ✓ Done — {line.globalFixed} fixed, {line.globalSkipped} unchanged, {line.globalFailed} failed across {line.listingCount} listings
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
