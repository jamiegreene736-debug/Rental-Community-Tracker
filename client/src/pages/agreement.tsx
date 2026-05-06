import { useState } from "react";
import { useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckCircle2, FileText, Loader2 } from "lucide-react";

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
  signedName?: string | null;
  signedAt?: string | null;
};

export default function AgreementPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [signedName, setSignedName] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [signerPhone, setSignerPhone] = useState("");
  const [accepted, setAccepted] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<{ agreement: RentalAgreement }>({
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

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded border bg-muted">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">Rental Agreement</h1>
            <p className="text-sm text-muted-foreground">Magical Island Rentals</p>
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
            <section className="grid gap-2 rounded border bg-muted/20 p-4 text-sm sm:grid-cols-2">
              <div>
                <span className="block text-xs uppercase text-muted-foreground">Guest</span>
                <span className="font-medium">{agreement.guestName}</span>
              </div>
              <div>
                <span className="block text-xs uppercase text-muted-foreground">Booking channel</span>
                <span className="font-medium">{agreement.channel}</span>
              </div>
              <div>
                <span className="block text-xs uppercase text-muted-foreground">Property</span>
                <span className="font-medium">{agreement.propertyName}</span>
              </div>
              <div>
                <span className="block text-xs uppercase text-muted-foreground">Total</span>
                <span className="font-medium">
                  {agreement.bookingTotal ? `$${Number(agreement.bookingTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "As shown in reservation"}
                </span>
              </div>
            </section>

            <section>
              <pre className="whitespace-pre-wrap rounded border bg-white p-4 text-sm leading-6 text-foreground shadow-sm">
                {agreement.agreementText}
              </pre>
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
              </div>
            ) : (
              <section className="space-y-4 rounded border p-4">
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
