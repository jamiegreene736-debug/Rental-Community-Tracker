import { useState } from "react";
import { useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, FileSignature, Loader2, ShieldCheck } from "lucide-react";

type RentalAgreement = {
  id: number;
  token: string;
  status: string;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  propertyName: string;
  channel: string;
  checkIn?: string | null;
  checkOut?: string | null;
  nights?: number | null;
  bookingTotal?: string | null;
  confirmationCode?: string | null;
  agreementText: string;
  cancellationPolicy?: string | null;
  signedName?: string | null;
  signerEmail?: string | null;
  signerPhone?: string | null;
  signerIp?: string | null;
  signerUserAgent?: string | null;
  signedAt?: string | null;
};

type AgreementResponse = {
  agreement: RentalAgreement;
  viewerIp?: string | null;
};

function money(value?: string | null): string {
  if (!value) return "As shown in reservation";
  return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value?: string | null): string {
  if (!value) return "As shown in reservation";
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function parseAgreement(text: string) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    acknowledgments: lines.filter((line) => /^\d+\./.test(line)).map((line) => line.replace(/^\d+\.\s*/, "")),
  };
}

export default function AgreementPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [signedName, setSignedName] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [signerPhone, setSignerPhone] = useState("");
  const [accepted, setAccepted] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<AgreementResponse>({
    queryKey: ["/api/rental-agreements", token],
    enabled: !!token,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/rental-agreements/${token}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });
  const agreement = data?.agreement;

  const signMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/rental-agreements/${token}/sign`, {
        signedName,
        signerEmail,
        signerPhone,
        accepted: true,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.message || body?.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => refetch(),
  });

  const signed = agreement?.status === "signed";
  const parsed = parseAgreement(agreement?.agreementText ?? "");

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,hsl(var(--brand-teal)/0.08),hsl(var(--background))_220px)]">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:py-10">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <img
            src="/brand/vacation-rental-expertz-horizontal-transparent.png"
            alt="VacationRentalExpertz"
            className="h-14 w-auto object-contain"
          />
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">Rental Agreement</h1>
            <p className="text-sm text-muted-foreground">VacationRentalExpertz</p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading agreement...
          </div>
        ) : error || !agreement ? (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            This agreement link could not be found. Please contact us for a new link.
          </div>
        ) : (
          <div className="space-y-6">
            <section className="rounded-lg border bg-white p-5 shadow-sm">
              <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">{agreement.propertyName}</h2>
                  <p className="text-sm text-muted-foreground">Please review the stay details and agreement before signing.</p>
                </div>
                <Badge variant={signed ? "default" : "outline"}>{signed ? "Signed" : "Pending signature"}</Badge>
              </div>
              <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                <span className="block text-xs uppercase text-muted-foreground">Guest</span>
                <span className="font-medium">{agreement.guestName}</span>
              </div>
              <div>
                <span className="block text-xs uppercase text-muted-foreground">Source</span>
                <span className="font-medium">{agreement.channel}</span>
              </div>
              <div>
                <span className="block text-xs uppercase text-muted-foreground">Dates</span>
                <span className="font-medium">{formatDate(agreement.checkIn)} - {formatDate(agreement.checkOut)}</span>
              </div>
              <div>
                <span className="block text-xs uppercase text-muted-foreground">Total</span>
                <span className="font-medium">{money(agreement.bookingTotal)}</span>
              </div>
                {agreement.confirmationCode && (
                  <div>
                    <span className="block text-xs uppercase text-muted-foreground">Confirmation</span>
                    <span className="font-mono text-sm font-medium">{agreement.confirmationCode}</span>
                  </div>
                )}
                {agreement.nights && (
                  <div>
                    <span className="block text-xs uppercase text-muted-foreground">Nights</span>
                    <span className="font-medium">{agreement.nights}</span>
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-lg border bg-white p-5 shadow-sm">
              <h2 className="mb-3 text-lg font-semibold">Important Stay Acknowledgment</h2>
              <p className="mb-4 text-sm leading-6 text-muted-foreground">
                This reservation may be fulfilled using two separate nearby units rather than one single connected unit. Exact interiors, furnishings, views, entrances, parking, and layouts can vary by assigned unit, while the stay will match the booked bedroom count, guest capacity, dates, and overall property standard.
              </p>
              {agreement.cancellationPolicy && (
                <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
                  <strong>Cancellation policy:</strong> {agreement.cancellationPolicy.replace(/^Cancellation policy:\s*/i, "")}
                </div>
              )}
              <ol className="space-y-3 text-sm leading-6">
                {parsed.acknowledgments.map((item, index) => (
                  <li key={item} className="flex gap-3">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {index + 1}
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ol>
            </section>

            <section className="rounded-lg border bg-white p-5 text-sm shadow-sm">
              <div className="mb-2 flex items-center gap-2 font-semibold">
                <ShieldCheck className="h-4 w-4 text-primary" />
                Signature audit trail
              </div>
              <div className="grid gap-2 text-muted-foreground sm:grid-cols-2">
                <div>
                  <span className="block text-xs uppercase">IP address {signed ? "recorded" : "to be recorded"}</span>
                  <span className="font-mono text-foreground">{agreement.signerIp || data?.viewerIp || "Captured at signing"}</span>
                </div>
                <div>
                  <span className="block text-xs uppercase">Browser/device</span>
                  <span className="text-foreground">{signed ? (agreement.signerUserAgent || "Recorded") : "Captured at signing"}</span>
                </div>
              </div>
            </section>

            {signed ? (
              <div className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-900">
                <div className="flex items-center gap-2 font-semibold">
                  <CheckCircle2 className="h-4 w-4" />
                  Agreement signed
                </div>
                <div className="mt-1">
                  Signed by {agreement.signedName} {agreement.signedAt ? `on ${new Date(agreement.signedAt).toLocaleString()}` : ""}.
                </div>
                {(agreement.signerEmail || agreement.signerPhone) && (
                  <div className="mt-1 text-green-800">
                    {agreement.signerEmail}{agreement.signerEmail && agreement.signerPhone ? " · " : ""}{agreement.signerPhone}
                  </div>
                )}
              </div>
            ) : (
              <section className="space-y-4 rounded-lg border bg-white p-5 shadow-sm">
                <div className="flex items-center gap-2 font-semibold">
                  <FileSignature className="h-4 w-4 text-primary" />
                  Sign electronically
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Label htmlFor="signed-name">Typed signature</Label>
                    <Input id="signed-name" value={signedName} onChange={(e) => setSignedName(e.target.value)} placeholder={agreement.guestName} />
                  </div>
                  <div>
                    <Label htmlFor="signer-email">Email</Label>
                    <Input id="signer-email" value={signerEmail} onChange={(e) => setSignerEmail(e.target.value)} placeholder={agreement.guestEmail || "you@example.com"} />
                  </div>
                  <div>
                    <Label htmlFor="signer-phone">Phone</Label>
                    <Input id="signer-phone" value={signerPhone} onChange={(e) => setSignerPhone(e.target.value)} placeholder={agreement.guestPhone || "(808) 000-0000"} />
                  </div>
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={accepted} onCheckedChange={(value) => setAccepted(value === true)} />
                  <span>I have read and agree to the rental agreement above, including the two-separate-units acknowledgment.</span>
                </label>
                {signMutation.error && (
                  <div className="text-sm text-red-700">{(signMutation.error as Error).message}</div>
                )}
                <Button
                  className="w-full sm:w-auto"
                  disabled={signMutation.isPending || !accepted || !signedName.trim()}
                  onClick={() => signMutation.mutate()}
                >
                  {signMutation.isPending ? "Submitting..." : "Sign agreement"}
                </Button>
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
