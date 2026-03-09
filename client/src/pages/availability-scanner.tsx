import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Loader2,
  Play,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  CalendarSearch,
  Shield,
  BarChart3,
  RefreshCw,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ScannerRun, AvailabilityScan } from "@shared/schema";

type ScannerStatus = {
  running: boolean;
  latestRun: ScannerRun | null;
};

function formatDateTime(dateStr: string | Date | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getNextMonday(): string {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  next.setDate(next.getDate() + daysUntilMonday);
  return formatDateTime(next);
}

export default function AvailabilityScanner() {
  const [communityFilter, setCommunityFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedRunId, setSelectedRunId] = useState<string>("latest");
  const { toast } = useToast();

  const statusQuery = useQuery<ScannerStatus>({
    queryKey: ["/api/scanner/status"],
    refetchInterval: 5000,
  });

  const runsQuery = useQuery<ScannerRun[]>({
    queryKey: ["/api/scanner/runs"],
    refetchInterval: 10000,
  });

  const resultsQuery = useQuery<AvailabilityScan[]>({
    queryKey: ["/api/scanner/results", selectedRunId, communityFilter, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedRunId !== "latest" && selectedRunId !== "all") {
        params.set("runId", selectedRunId);
      } else if (selectedRunId === "latest" && statusQuery.data?.latestRun) {
        params.set("runId", String(statusQuery.data.latestRun.id));
      }
      if (communityFilter !== "all") params.set("community", communityFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/scanner/results?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch results");
      return res.json();
    },
    enabled: !!statusQuery.data,
  });

  const triggerScan = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/scanner/run");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Scan started", description: "Searching Airbnb & VRBO for availability across 52 weeks. Blocking Lodgify when empty." });
      queryClient.invalidateQueries({ queryKey: ["/api/scanner/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scanner/runs"] });
    },
    onError: (err: any) => {
      toast({ title: "Could not start scan", description: err.message, variant: "destructive" });
    },
  });

  const status = statusQuery.data;
  const runs = runsQuery.data || [];
  const results = resultsQuery.data || [];

  const communities = [...new Set(results.map(r => r.community))].sort();
  const blockedResults = results.filter(r => r.status === "blocked");
  const availableResults = results.filter(r => r.status === "available");
  const errorResults = results.filter(r => r.status === "error");

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-4 sm:p-6">
        <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="sm" data-testid="button-back-home">
                <ArrowLeft className="h-4 w-4 mr-1" /> Dashboard
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <CalendarSearch className="h-6 w-6" />
                Availability Scanner
              </h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Searches Airbnb & VRBO every 7 days for 12 months per listing. Auto-blocks Lodgify when no buy-in inventory.
              </p>
            </div>
          </div>
          <Button
            onClick={() => triggerScan.mutate()}
            disabled={triggerScan.isPending || status?.running}
            data-testid="button-run-scan"
          >
            {status?.running ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Scan Running...</>
            ) : (
              <><Play className="h-4 w-4 mr-2" /> Run Scan Now</>
            )}
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <Card className="p-4" data-testid="card-status">
            <div className="flex items-center gap-2 mb-1">
              {status?.running ? (
                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              )}
              <p className="text-xs text-muted-foreground font-medium">Scanner Status</p>
            </div>
            <p className="text-lg font-bold" data-testid="text-scanner-status">
              {status?.running ? "Running" : "Idle"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Next auto-scan: {getNextMonday()}
            </p>
          </Card>

          <Card className="p-4" data-testid="card-last-run">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs text-muted-foreground font-medium">Last Scan</p>
            </div>
            <p className="text-lg font-bold">
              {status?.latestRun ? formatDateTime(status.latestRun.completedAt || status.latestRun.startedAt) : "Never"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {status?.latestRun?.totalWeeksScanned || 0} community-weeks scanned
            </p>
          </Card>

          <Card className="p-4" data-testid="card-blocked-count">
            <div className="flex items-center gap-2 mb-1">
              <Shield className="h-4 w-4 text-red-500" />
              <p className="text-xs text-muted-foreground font-medium">Weeks Blocked</p>
            </div>
            <p className="text-lg font-bold text-red-600 dark:text-red-400">
              {status?.latestRun?.totalBlocked || 0}
            </p>
            <p className="text-xs text-muted-foreground mt-1">Lodgify calendar auto-blocked</p>
          </Card>

          <Card className="p-4" data-testid="card-available-count">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              <p className="text-xs text-muted-foreground font-medium">Weeks Available</p>
            </div>
            <p className="text-lg font-bold text-green-600 dark:text-green-400">
              {status?.latestRun?.totalAvailable || 0}
            </p>
            <p className="text-xs text-muted-foreground mt-1">Buy-in inventory exists</p>
          </Card>
        </div>

        {status?.running && status?.latestRun && (
          <Card className="p-4 mb-6 border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/30" data-testid="card-scan-progress">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
              <div>
                <p className="font-medium">Scan in progress...</p>
                <p className="text-sm text-muted-foreground">
                  {status.latestRun.totalWeeksScanned} community-weeks scanned so far.
                  {status.latestRun.totalBlocked > 0 && ` ${status.latestRun.totalBlocked} blocked.`}
                  {status.latestRun.totalAvailable > 0 && ` ${status.latestRun.totalAvailable} available.`}
                </p>
              </div>
            </div>
          </Card>
        )}

        <Tabs defaultValue="results" className="space-y-4">
          <TabsList>
            <TabsTrigger value="results" data-testid="tab-results">
              <BarChart3 className="h-4 w-4 mr-1" /> Scan Results
            </TabsTrigger>
            <TabsTrigger value="history" data-testid="tab-history">
              <Clock className="h-4 w-4 mr-1" /> Run History
            </TabsTrigger>
          </TabsList>

          <TabsContent value="results">
            <Card className="p-4">
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <div className="min-w-[180px]">
                  <Select value={communityFilter} onValueChange={v => setCommunityFilter(v)}>
                    <SelectTrigger data-testid="select-community-filter">
                      <SelectValue placeholder="Filter by community" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Communities</SelectItem>
                      {communities.map(c => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-[150px]">
                  <Select value={statusFilter} onValueChange={v => setStatusFilter(v)}>
                    <SelectTrigger data-testid="select-status-filter">
                      <SelectValue placeholder="Filter by status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Statuses</SelectItem>
                      <SelectItem value="available">Available</SelectItem>
                      <SelectItem value="blocked">Blocked</SelectItem>
                      <SelectItem value="error">Error</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {runs.length > 0 && (
                  <div className="min-w-[200px]">
                    <Select value={selectedRunId} onValueChange={v => setSelectedRunId(v)}>
                      <SelectTrigger data-testid="select-run-filter">
                        <SelectValue placeholder="Select scan run" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="latest">Latest Run</SelectItem>
                        {runs.map(r => (
                          <SelectItem key={r.id} value={String(r.id)}>
                            Run #{r.id} - {formatDateTime(r.startedAt)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    queryClient.invalidateQueries({ queryKey: ["/api/scanner/results"] });
                    queryClient.invalidateQueries({ queryKey: ["/api/scanner/status"] });
                  }}
                  data-testid="button-refresh-results"
                >
                  <RefreshCw className="h-4 w-4 mr-1" /> Refresh
                </Button>
              </div>

              {resultsQuery.isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : results.length === 0 ? (
                <div className="text-center py-12">
                  <CalendarSearch className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                  <p className="text-muted-foreground">No scan results yet. Run a scan to check availability.</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3 mb-3 flex-wrap">
                    <Badge variant="secondary">{results.length} results</Badge>
                    {blockedResults.length > 0 && (
                      <Badge variant="destructive">{blockedResults.length} blocked</Badge>
                    )}
                    {availableResults.length > 0 && (
                      <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                        {availableResults.length} available
                      </Badge>
                    )}
                    {errorResults.length > 0 && (
                      <Badge variant="outline" className="text-amber-600">{errorResults.length} errors</Badge>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Community</TableHead>
                          <TableHead>Week</TableHead>
                          <TableHead>Bedrooms</TableHead>
                          <TableHead className="text-center">Airbnb</TableHead>
                          <TableHead className="text-center">VRBO/Other</TableHead>
                          <TableHead className="text-center">Total</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Lodgify</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {results.map((scan) => (
                          <TableRow key={scan.id} data-testid={`row-scan-${scan.id}`}>
                            <TableCell className="font-medium text-sm">{scan.community}</TableCell>
                            <TableCell className="text-sm">
                              {formatDate(scan.checkIn)} — {formatDate(scan.checkOut)}
                            </TableCell>
                            <TableCell className="text-sm">
                              {(() => {
                                try {
                                  const configs = JSON.parse(scan.bedroomConfig);
                                  return configs.map((b: number) => `${b}BR`).join(", ");
                                } catch {
                                  return scan.bedroomConfig;
                                }
                              })()}
                            </TableCell>
                            <TableCell className="text-center text-sm">{scan.airbnbResults}</TableCell>
                            <TableCell className="text-center text-sm">{scan.vrboResults}</TableCell>
                            <TableCell className="text-center text-sm font-medium">{scan.totalResults}</TableCell>
                            <TableCell>
                              {scan.status === "blocked" ? (
                                <Badge variant="destructive" className="text-xs">
                                  <XCircle className="h-3 w-3 mr-1" /> Blocked
                                </Badge>
                              ) : scan.status === "available" ? (
                                <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 text-xs">
                                  <CheckCircle2 className="h-3 w-3 mr-1" /> Available
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-xs text-amber-600">
                                  <AlertTriangle className="h-3 w-3 mr-1" /> Error
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-sm">
                              {scan.lodgifyBlockIds ? (
                                <Badge variant="secondary" className="text-xs">
                                  <Shield className="h-3 w-3 mr-1" /> Pushed
                                </Badge>
                              ) : scan.status === "blocked" ? (
                                <span className="text-xs text-muted-foreground">Pending</span>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="history">
            <Card className="p-4">
              {runs.length === 0 ? (
                <div className="text-center py-12">
                  <Clock className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                  <p className="text-muted-foreground">No scan runs yet.</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Run #</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Completed</TableHead>
                      <TableHead className="text-center">Scanned</TableHead>
                      <TableHead className="text-center">Available</TableHead>
                      <TableHead className="text-center">Blocked</TableHead>
                      <TableHead className="text-center">Errors</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map(run => (
                      <TableRow
                        key={run.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setSelectedRunId(String(run.id))}
                        data-testid={`row-run-${run.id}`}
                      >
                        <TableCell className="font-medium">#{run.id}</TableCell>
                        <TableCell className="text-sm">{formatDateTime(run.startedAt)}</TableCell>
                        <TableCell className="text-sm">{formatDateTime(run.completedAt)}</TableCell>
                        <TableCell className="text-center">{run.totalWeeksScanned}</TableCell>
                        <TableCell className="text-center text-green-600 dark:text-green-400">{run.totalAvailable}</TableCell>
                        <TableCell className="text-center text-red-600 dark:text-red-400">{run.totalBlocked}</TableCell>
                        <TableCell className="text-center text-amber-600 dark:text-amber-400">{run.totalErrors}</TableCell>
                        <TableCell>
                          {run.status === "running" ? (
                            <Badge variant="secondary"><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Running</Badge>
                          ) : run.status === "completed" ? (
                            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Completed</Badge>
                          ) : (
                            <Badge variant="destructive">Failed</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
