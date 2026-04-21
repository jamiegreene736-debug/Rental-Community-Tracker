import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, MessageSquare, Calendar, Zap, Send, Sparkles, Plus, Pencil,
  Trash2, CheckCircle, XCircle, RefreshCw, Clock, User, Building2, AlertCircle,
  ToggleRight, Bot, Flag, X,
} from "lucide-react";
import type { MessageTemplate } from "@shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GuestyConversation {
  _id: string;
  guestId?: string;
  guestName?: string;
  listingId?: string;
  listingNickname?: string;
  reservationId?: string;
  lastMessageAt?: string;
  unread?: boolean;
  posts?: GuestyPost[];
  lastPost?: GuestyPost;
  status?: string;
  module?: GuestyModule;      // channel the conversation is on
  integration?: { platform?: string };
}

type GuestyModule = { type?: string; [k: string]: unknown };

interface GuestyPost {
  _id: string;
  body?: string;
  text?: string;
  sentAt?: string;
  postedAt?: string;
  authorType?: string;
  authorRole?: string;
  module?: GuestyModule;
}

interface GuestyReservation {
  _id: string;
  status: string;
  guestName?: string;
  listingNickname?: string;
  checkIn?: string;
  checkInDateLocalized?: string;
  checkOut?: string;
  checkOutDateLocalized?: string;
  money?: { totalPaid?: number; totalPrice?: number; currency?: string };
  integration?: { platform?: string };
  source?: string;
  confirmationCode?: string;
  nightsCount?: number;
}

const TRIGGER_OPTIONS = [
  { value: "booking_confirmed",    label: "When booking is confirmed" },
  { value: "days_before_checkin",  label: "X days before check-in" },
  { value: "day_of_checkin",       label: "Day of check-in" },
  { value: "days_before_checkout", label: "X days before check-out" },
  { value: "days_after_checkout",  label: "X days after check-out" },
];

const MERGE_TAGS = [
  "{guest_name}", "{property_name}", "{check_in_date}", "{check_out_date}",
  "{confirmation_code}", "{num_nights}",
];

const DEFAULT_TEMPLATES: Omit<MessageTemplate, "id" | "createdAt">[] = [
  {
    name: "Booking Confirmed",
    trigger: "booking_confirmed",
    daysOffset: 0,
    isActive: true,
    body: `Aloha {guest_name}! 🌺

We're so excited to host you at {property_name}! Your reservation is confirmed for {check_in_date} through {check_out_date} ({num_nights} nights).

We'll send check-in details 3 days before your arrival. In the meantime, please don't hesitate to reach out with any questions — we're always happy to help.

Can't wait to welcome you to Hawaii!
The NexStay Team`,
  },
  {
    name: "Pre-Arrival (3 days before)",
    trigger: "days_before_checkin",
    daysOffset: 3,
    isActive: true,
    body: `Aloha {guest_name}!

Your stay at {property_name} is just 3 days away — so exciting! Here's everything you need for a smooth arrival:

📍 Address: [INSERT ADDRESS]
🔑 Check-in: [INSERT CHECK-IN TIME & ACCESS INSTRUCTIONS]
🅿️ Parking: [INSERT PARKING DETAILS]
📶 WiFi: [INSERT WIFI DETAILS]

Your confirmation code is {confirmation_code}. If anything comes up before you arrive, we're just a message away.

See you soon!
The NexStay Team`,
  },
  {
    name: "Check-out Reminder",
    trigger: "days_before_checkout",
    daysOffset: 1,
    isActive: true,
    body: `Aloha {guest_name}!

We hope you're having an amazing time! Just a friendly reminder that check-out is tomorrow.

⏰ Check-out time: 10:00 AM
🗝️ Please leave the key/lockbox as you found it and feel free to leave used towels in the bathroom.

We'd love to know how your stay has been — feel free to share any feedback!

Mahalo for choosing NexStay. 🤙
The NexStay Team`,
  },
  {
    name: "Post-Stay Review Request",
    trigger: "days_after_checkout",
    daysOffset: 2,
    isActive: true,
    body: `Aloha {guest_name}!

It was such a pleasure having you at {property_name}! We hope you had an unforgettable time in Hawaii.

If you have a moment, we'd really appreciate a review — it means the world to small hosts like us and helps future guests find a great place to stay.

We hope to see you again on your next Hawaii adventure! 🌊
Mahalo nui loa,
The NexStay Team`,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function triggerLabel(trigger: string, daysOffset: number): string {
  switch (trigger) {
    case "booking_confirmed": return "On booking confirmation";
    case "days_before_checkin": return daysOffset === 0 ? "Day of check-in" : `${daysOffset} day${daysOffset > 1 ? "s" : ""} before check-in`;
    case "day_of_checkin": return "Day of check-in";
    case "days_before_checkout": return `${daysOffset} day${daysOffset > 1 ? "s" : ""} before check-out`;
    case "days_after_checkout": return `${daysOffset} day${daysOffset > 1 ? "s" : ""} after check-out`;
    default: return trigger;
  }
}

function formatDate(d?: string) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function platformBadge(res: GuestyReservation) {
  const src = (res.integration?.platform ?? res.source ?? "").toLowerCase();
  if (src.includes("airbnb")) return <Badge className="bg-[#FF5A5F] text-white text-[10px]">Airbnb</Badge>;
  if (src.includes("vrbo") || src.includes("homeaway")) return <Badge className="bg-blue-600 text-white text-[10px]">VRBO</Badge>;
  if (src.includes("booking")) return <Badge className="bg-blue-800 text-white text-[10px]">Booking</Badge>;
  return <Badge variant="outline" className="text-[10px]">{src || "Direct"}</Badge>;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TemplateEditor({
  template,
  onSave,
  onClose,
}: {
  template: Partial<MessageTemplate> | null;
  onSave: (data: Omit<MessageTemplate, "id" | "createdAt">) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [trigger, setTrigger] = useState(template?.trigger ?? "booking_confirmed");
  const [daysOffset, setDaysOffset] = useState(template?.daysOffset ?? 0);
  const [body, setBody] = useState(template?.body ?? "");
  const [isActive, setIsActive] = useState(template?.isActive ?? true);
  const needsDays = trigger === "days_before_checkin" || trigger === "days_before_checkout" || trigger === "days_after_checkout";

  const insertTag = (tag: string) => setBody(b => b + tag);

  return (
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{template?.id ? "Edit Template" : "New Template"}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label>Template Name</Label>
          <Input
            data-testid="input-template-name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Check-in Instructions"
            className="mt-1"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Send When</Label>
            <Select value={trigger} onValueChange={setTrigger}>
              <SelectTrigger className="mt-1" data-testid="select-template-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGER_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {needsDays && (
            <div>
              <Label>Days</Label>
              <Input
                data-testid="input-template-days"
                type="number"
                min={0}
                max={30}
                value={daysOffset}
                onChange={e => setDaysOffset(parseInt(e.target.value) || 0)}
                className="mt-1"
              />
            </div>
          )}
        </div>
        <div>
          <Label>Message Body</Label>
          <div className="flex flex-wrap gap-1 mt-1 mb-1">
            {MERGE_TAGS.map(tag => (
              <button
                key={tag}
                onClick={() => insertTag(tag)}
                className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded hover:bg-primary hover:text-primary-foreground transition-colors"
                data-testid={`button-merge-tag-${tag}`}
              >
                {tag}
              </button>
            ))}
          </div>
          <Textarea
            data-testid="textarea-template-body"
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={12}
            className="font-mono text-sm"
            placeholder="Write your message here. Click tags above to insert merge fields."
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="template-active"
            checked={isActive}
            onCheckedChange={setIsActive}
            data-testid="switch-template-active"
          />
          <Label htmlFor="template-active">Active (will be sent automatically)</Label>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} data-testid="button-template-cancel">Cancel</Button>
        <Button
          onClick={() => onSave({ name, trigger, daysOffset, body, isActive })}
          disabled={!name || !body}
          data-testid="button-template-save"
        >
          Save Template
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function InboxPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [draftLoading, setDraftLoading] = useState(false);
  const [templateDialog, setTemplateDialog] = useState<{ open: boolean; template: Partial<MessageTemplate> | null }>({ open: false, template: null });
  const threadRef = useRef<HTMLDivElement>(null);

  // ── Conversations ──
  // Guesty Open API mounts conversations under /communication/ — see
  // https://open-api-docs.guesty.com/reference/get_communication-conversations
  const { data: convData, isLoading: convLoading, error: convError } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/communication/conversations"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/guesty-proxy/communication/conversations?limit=30");
      if (!r.ok) throw new Error(`Guesty returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 60_000,
  });
  // Guesty may return several shapes:
  //   {results: [...]}          (legacy)
  //   {data: [...]}             (new, plain array)
  //   {data: {results: [...]}}  (new, wrapped)
  //   {error: "..."}            (our proxy on failure)
  // Normalize to always an array — anything else becomes [] so .find/.map/.filter
  // never throw and blank the page.
  const conversations: GuestyConversation[] = (() => {
    const d = convData;
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.results)) return d.results;
    if (Array.isArray(d?.data)) return d.data;
    if (Array.isArray(d?.data?.results)) return d.data.results;
    return [];
  })();

  const selectedConv = conversations.find(c => c._id === selectedConvId) ?? null;

  const { data: threadData, isLoading: threadLoading } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/communication/conversations", selectedConvId],
    enabled: !!selectedConvId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/guesty-proxy/communication/conversations/${selectedConvId}`);
      if (!r.ok) throw new Error(`Guesty returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const posts: GuestyPost[] = threadData?.posts ?? threadData?.data?.posts ?? selectedConv?.posts ?? [];

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [posts.length]);

  const sendMessage = useMutation({
    // /posts adds a message to the thread but doesn't deliver it to the guest —
    // /send-message does both. Guesty requires a `module` describing the channel.
    mutationFn: async () => {
      if (!selectedConv) throw new Error("No conversation selected");
      const lastPostModule = [...(posts ?? [])].reverse().find(p => p.module)?.module;
      const mod: GuestyModule = selectedConv.module ?? lastPostModule ?? { type: "email" };
      const r = await apiRequest(
        "POST",
        `/api/guesty-proxy/communication/conversations/${selectedConvId}/send-message`,
        { body: replyText, module: mod },
      );
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        throw new Error(errBody.error ?? errBody.message ?? `Guesty returned HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      setReplyText("");
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations", selectedConvId] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations"] });
      toast({ title: "Message sent!" });
    },
    onError: (e: any) => toast({ title: "Failed to send", description: e.message, variant: "destructive" }),
  });

  const generateDraft = async () => {
    if (!selectedConv) return;
    setDraftLoading(true);
    const lastGuestPost = [...posts].reverse().find(p => p.authorType !== "host" && p.authorRole !== "host");
    try {
      const r = await apiRequest("POST", "/api/inbox/ai-draft", {
        guestMessage: lastGuestPost?.body ?? lastGuestPost?.text ?? "",
        guestName: selectedConv.guestName,
        propertyName: selectedConv.listingNickname,
      });
      const data = await r.json();
      if (data.draft) setReplyText(data.draft);
      else toast({ title: "AI draft unavailable", description: data.error, variant: "destructive" });
    } catch (e: any) {
      toast({ title: "Draft failed", description: e.message, variant: "destructive" });
    } finally {
      setDraftLoading(false);
    }
  };

  // ── Reservations ──
  const { data: pendingData, isLoading: pendingLoading } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/reservations/pending"],
    queryFn: () =>
      apiRequest("GET", "/api/guesty-proxy/reservations?limit=50")
        .then(r => r.json())
        .then(d => {
          const rows = Array.isArray(d?.results) ? d.results
            : Array.isArray(d?.data) ? d.data
            : Array.isArray(d?.data?.results) ? d.data.results
            : [];
          return {
            results: rows.filter((r: any) =>
              r.status === "inquiry" || r.status === "awaitingPayment" || r.status === "pending"
            ),
          };
        })
        .catch(() => ({ results: [] })),
    refetchInterval: 60_000,
  });
  const pendingRes: GuestyReservation[] = Array.isArray(pendingData?.results)
    ? pendingData.results
    : Array.isArray(pendingData?.data)
      ? pendingData.data
      : Array.isArray(pendingData?.data?.results)
        ? pendingData.data.results
        : [];

  const { data: upcomingData } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/reservations/upcoming"],
    queryFn: () => {
      const today = new Date().toISOString().split("T")[0];
      return apiRequest("GET", `/api/guesty-proxy/reservations?limit=50&sort=checkIn`)
        .then(r => r.json())
        .then(d => {
          const rows = Array.isArray(d?.results) ? d.results
            : Array.isArray(d?.data) ? d.data
            : Array.isArray(d?.data?.results) ? d.data.results
            : [];
          return {
            results: rows.filter((r: any) => {
              const checkIn = r.checkInDateLocalized ?? r.checkIn ?? "";
              return (r.status === "confirmed" || r.status === "checked_in") && checkIn >= today;
            }),
          };
        })
        .catch(() => ({ results: [] }));
    },
    refetchInterval: 120_000,
  });
  const upcomingRes: GuestyReservation[] = Array.isArray(upcomingData?.results)
    ? upcomingData.results
    : Array.isArray(upcomingData?.data)
      ? upcomingData.data
      : Array.isArray(upcomingData?.data?.results)
        ? upcomingData.data.results
        : [];

  const { data: autoApproveStatus, isLoading: autoLoading } = useQuery<any>({
    queryKey: ["/api/inbox/auto-approve/status"],
    refetchInterval: 30_000,
  });

  const toggleAutoApprove = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest("POST", "/api/inbox/auto-approve/toggle", { enabled }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/inbox/auto-approve/status"] }),
  });

  const runAutoApprove = useMutation({
    mutationFn: () => apiRequest("POST", "/api/inbox/auto-approve/run").then(r => r.json()),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/inbox/auto-approve/status"] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/reservations/pending"] });
      toast({ title: data.message ?? "Auto-approve complete" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  // ── Auto-Reply Agent ──
  const { data: autoReplyStatus } = useQuery<any>({
    queryKey: ["/api/inbox/auto-reply/status"],
    refetchInterval: 30_000,
  });

  const { data: autoReplyLogs = [], isLoading: logsLoading } = useQuery<any[]>({
    queryKey: ["/api/inbox/auto-reply/logs"],
    refetchInterval: 60_000,
  });

  const toggleAutoReply = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest("POST", "/api/inbox/auto-reply/toggle", { enabled }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/inbox/auto-reply/status"] }),
  });

  const runAutoReply = useMutation({
    mutationFn: () => apiRequest("POST", "/api/inbox/auto-reply/run").then(r => r.json()),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/inbox/auto-reply/status"] });
      qc.invalidateQueries({ queryKey: ["/api/inbox/auto-reply/logs"] });
      toast({ title: data.message ?? "Auto-reply complete" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const sendDraftReply = useMutation({
    mutationFn: (id: number) =>
      apiRequest("POST", `/api/inbox/auto-reply/logs/${id}/send`).then(r => r.json()),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/inbox/auto-reply/logs"] });
      if (data.ok) toast({ title: "Reply sent to guest" });
      else toast({ title: "Send failed", description: data.error, variant: "destructive" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const dismissDraft = useMutation({
    mutationFn: (id: number) =>
      apiRequest("POST", `/api/inbox/auto-reply/logs/${id}/dismiss`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/inbox/auto-reply/logs"] });
      toast({ title: "Dismissed" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const approveReservation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("PUT", `/api/guesty-proxy/reservations/${id}/confirm`, {}).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/reservations/pending"] });
      toast({ title: "Reservation approved!" });
    },
    onError: (e: any) => toast({ title: "Failed to approve", description: e.message, variant: "destructive" }),
  });

  const declineReservation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("PUT", `/api/guesty-proxy/reservations/${id}`, { status: "declined" }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/reservations/pending"] });
      toast({ title: "Reservation declined" });
    },
    onError: (e: any) => toast({ title: "Failed to decline", description: e.message, variant: "destructive" }),
  });

  // ── Templates ──
  const { data: templates = [], isLoading: templatesLoading } = useQuery<MessageTemplate[]>({
    queryKey: ["/api/inbox/templates"],
  });

  const createTemplate = useMutation({
    mutationFn: (data: Omit<MessageTemplate, "id" | "createdAt">) =>
      apiRequest("POST", "/api/inbox/templates", data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/inbox/templates"] }); setTemplateDialog({ open: false, template: null }); toast({ title: "Template saved!" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const updateTemplate = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<MessageTemplate> }) =>
      apiRequest("PUT", `/api/inbox/templates/${id}`, data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/inbox/templates"] }); setTemplateDialog({ open: false, template: null }); toast({ title: "Template updated!" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const deleteTemplate = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/inbox/templates/${id}`).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/inbox/templates"] }); toast({ title: "Template deleted" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const toggleTemplate = (t: MessageTemplate) =>
    updateTemplate.mutate({ id: t.id, data: { isActive: !t.isActive } });

  const saveTemplate = (data: Omit<MessageTemplate, "id" | "createdAt">) => {
    if (templateDialog.template?.id) {
      updateTemplate.mutate({ id: templateDialog.template.id, data });
    } else {
      createTemplate.mutate(data);
    }
  };

  const addDefaultTemplates = () => {
    DEFAULT_TEMPLATES.forEach(t => createTemplate.mutate(t));
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card px-6 py-4 flex items-center gap-4">
        <Link href="/">
          <Button variant="ghost" size="sm" className="gap-1" data-testid="button-back-home">
            <ArrowLeft className="h-4 w-4" /> Dashboard
          </Button>
        </Link>
        <div className="h-5 w-px bg-border" />
        <div>
          <h1 className="font-semibold text-lg leading-tight">Guest Inbox</h1>
          <p className="text-xs text-muted-foreground">Messages · Reservations · Auto-Messages</p>
        </div>
        {pendingRes.length > 0 && (
          <Badge className="ml-auto bg-amber-500 text-white" data-testid="badge-pending-count">
            {pendingRes.length} pending request{pendingRes.length > 1 ? "s" : ""}
          </Badge>
        )}
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        <Tabs defaultValue="messages">
          <TabsList className="mb-6" data-testid="tabs-inbox">
            <TabsTrigger value="messages" data-testid="tab-messages">
              <MessageSquare className="h-4 w-4 mr-1.5" /> Messages
            </TabsTrigger>
            <TabsTrigger value="reservations" data-testid="tab-reservations">
              <Calendar className="h-4 w-4 mr-1.5" /> Reservations
              {pendingRes.length > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-500 text-white text-[10px] w-4 h-4 flex items-center justify-center">
                  {pendingRes.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="auto-messages" data-testid="tab-auto-messages">
              <Zap className="h-4 w-4 mr-1.5" /> Auto-Messages
            </TabsTrigger>
            <TabsTrigger value="auto-reply" data-testid="tab-auto-reply">
              <Bot className="h-4 w-4 mr-1.5" /> Auto-Reply
              {autoReplyLogs.filter((l: any) => l.status === "flagged" || (l.status === "drafted" && !l.replySent)).length > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-500 text-white text-[10px] w-4 h-4 flex items-center justify-center">
                  {autoReplyLogs.filter((l: any) => l.status === "flagged" || (l.status === "drafted" && !l.replySent)).length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ── MESSAGES TAB ── */}
          <TabsContent value="messages">
            <div className="grid grid-cols-[320px_1fr] gap-4 h-[calc(100vh-240px)] min-h-[500px]">
              {/* Conversation List */}
              <div className="border rounded-lg bg-card overflow-y-auto">
                <div className="px-4 py-3 border-b flex items-center justify-between">
                  <span className="text-sm font-medium">Conversations</span>
                  {convLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
                </div>
                {convError && !convLoading && (
                  <div className="p-6 text-center text-sm text-destructive">
                    <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    Couldn't load conversations
                    <div className="mt-1 text-xs font-mono opacity-70">{(convError as Error).message}</div>
                  </div>
                )}
                {!convError && conversations.length === 0 && !convLoading && (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    No conversations yet
                  </div>
                )}
                {conversations.map(c => {
                  const preview = c.lastPost?.body ?? c.lastPost?.text ?? "";
                  const active = c._id === selectedConvId;
                  return (
                    <button
                      key={c._id}
                      data-testid={`conversation-item-${c._id}`}
                      onClick={() => setSelectedConvId(c._id)}
                      className={`w-full text-left px-4 py-3 border-b hover:bg-muted/50 transition-colors ${active ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <User className="h-3.5 w-3.5 text-primary" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">{c.guestName ?? "Guest"}</p>
                            <p className="text-xs text-muted-foreground truncate">{c.listingNickname ?? "—"}</p>
                          </div>
                        </div>
                        {c.unread && <div className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1" />}
                      </div>
                      {preview && (
                        <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2 ml-9">{preview}</p>
                      )}
                      {c.lastMessageAt && (
                        <p className="text-[10px] text-muted-foreground mt-1 ml-9">
                          {new Date(c.lastMessageAt).toLocaleDateString()}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Thread + Reply */}
              <div className="border rounded-lg bg-card flex flex-col">
                {!selectedConvId ? (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <MessageSquare className="h-12 w-12 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">Select a conversation to read and reply</p>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Thread header */}
                    <div className="px-5 py-3 border-b">
                      <p className="font-medium">{selectedConv?.guestName ?? "Guest"}</p>
                      <p className="text-xs text-muted-foreground">{selectedConv?.listingNickname ?? "—"}</p>
                    </div>

                    {/* Messages */}
                    <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                      {threadLoading && (
                        <div className="text-center text-xs text-muted-foreground py-4">Loading messages…</div>
                      )}
                      {posts.map(p => {
                        const isHost = p.authorType === "host" || p.authorRole === "host";
                        return (
                          <div key={p._id} className={`flex ${isHost ? "justify-end" : "justify-start"}`}>
                            <div
                              className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                                isHost
                                  ? "bg-primary text-primary-foreground rounded-br-sm"
                                  : "bg-muted text-foreground rounded-bl-sm"
                              }`}
                              data-testid={`message-${p._id}`}
                            >
                              {p.body ?? p.text ?? ""}
                              <div className={`text-[10px] mt-1 ${isHost ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                                {new Date(p.sentAt ?? p.postedAt ?? "").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Reply compose */}
                    <div className="border-t px-4 py-3 space-y-2">
                      <Textarea
                        data-testid="textarea-reply"
                        placeholder="Write a reply…"
                        value={replyText}
                        onChange={e => setReplyText(e.target.value)}
                        rows={3}
                        className="resize-none"
                        onKeyDown={e => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && replyText.trim()) {
                            sendMessage.mutate();
                          }
                        }}
                      />
                      <div className="flex items-center gap-2 justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={generateDraft}
                          disabled={draftLoading}
                          data-testid="button-ai-draft"
                        >
                          <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                          {draftLoading ? "Drafting…" : "AI Draft"}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => sendMessage.mutate()}
                          disabled={!replyText.trim() || sendMessage.isPending}
                          data-testid="button-send-reply"
                        >
                          <Send className="h-3.5 w-3.5 mr-1.5" />
                          Send
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </TabsContent>

          {/* ── RESERVATIONS TAB ── */}
          <TabsContent value="reservations" className="space-y-6">
            {/* Auto-approve banner */}
            <Card>
              <CardContent className="py-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center ${autoApproveStatus?.enabled ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"}`}>
                      <Zap className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="font-medium text-sm">Auto-Approve Airbnb Requests</p>
                      <p className="text-xs text-muted-foreground">
                        {autoApproveStatus?.enabled
                          ? `Active · Checks every 15 min${autoApproveStatus?.lastRunAt ? ` · Last run: ${new Date(autoApproveStatus.lastRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`
                          : "Paused — new Airbnb requests will not be auto-confirmed"}
                      </p>
                      {autoApproveStatus?.lastRunResult?.message && (
                        <p className="text-xs text-muted-foreground mt-0.5 italic">{autoApproveStatus.lastRunResult.message}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Switch
                      id="auto-approve-toggle"
                      checked={autoApproveStatus?.enabled ?? true}
                      onCheckedChange={v => toggleAutoApprove.mutate(v)}
                      disabled={autoLoading}
                      data-testid="switch-auto-approve"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => runAutoApprove.mutate()}
                      disabled={runAutoApprove.isPending}
                      data-testid="button-run-auto-approve"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${runAutoApprove.isPending ? "animate-spin" : ""}`} />
                      Run Now
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Pending requests */}
            <div>
              <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-500" />
                Pending Requests
                {pendingRes.length > 0 && <Badge className="bg-amber-500 text-white">{pendingRes.length}</Badge>}
              </h2>
              {pendingLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
              {!pendingLoading && pendingRes.length === 0 && (
                <div className="border rounded-lg p-6 text-center text-sm text-muted-foreground bg-card">
                  <CheckCircle className="h-8 w-8 mx-auto mb-2 text-green-500 opacity-60" />
                  No pending requests — you're all caught up!
                </div>
              )}
              <div className="space-y-3">
                {pendingRes.map(r => (
                  <Card key={r._id} data-testid={`reservation-pending-${r._id}`}>
                    <CardContent className="py-4">
                      <div className="flex items-center justify-between gap-4 flex-wrap">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <p className="font-medium">{r.guestName ?? "Guest"}</p>
                            {platformBadge(r)}
                          </div>
                          <p className="text-sm text-muted-foreground">{r.listingNickname ?? "—"}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(r.checkInDateLocalized ?? r.checkIn)} → {formatDate(r.checkOutDateLocalized ?? r.checkOut)}
                            {r.nightsCount ? ` · ${r.nightsCount} nights` : ""}
                          </p>
                          {r.confirmationCode && (
                            <p className="text-xs font-mono text-muted-foreground">#{r.confirmationCode}</p>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-600 border-red-200 hover:bg-red-50"
                            onClick={() => declineReservation.mutate(r._id)}
                            disabled={declineReservation.isPending}
                            data-testid={`button-decline-${r._id}`}
                          >
                            <XCircle className="h-3.5 w-3.5 mr-1" /> Decline
                          </Button>
                          <Button
                            size="sm"
                            className="bg-green-600 hover:bg-green-700 text-white"
                            onClick={() => approveReservation.mutate(r._id)}
                            disabled={approveReservation.isPending}
                            data-testid={`button-approve-${r._id}`}
                          >
                            <CheckCircle className="h-3.5 w-3.5 mr-1" /> Approve
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>

            {/* Upcoming confirmed */}
            <div>
              <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Clock className="h-4 w-4 text-blue-500" />
                Upcoming Confirmed Reservations
              </h2>
              {upcomingRes.length === 0 && (
                <div className="border rounded-lg p-6 text-center text-sm text-muted-foreground bg-card">
                  No upcoming reservations found
                </div>
              )}
              <div className="space-y-2">
                {upcomingRes.map(r => (
                  <Card key={r._id} data-testid={`reservation-upcoming-${r._id}`}>
                    <CardContent className="py-3">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                            <User className="h-3.5 w-3.5 text-blue-600" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium text-sm">{r.guestName ?? "Guest"}</p>
                              {platformBadge(r)}
                            </div>
                            <p className="text-xs text-muted-foreground">{r.listingNickname ?? "—"}</p>
                          </div>
                        </div>
                        <div className="text-right text-xs text-muted-foreground">
                          <p>{formatDate(r.checkInDateLocalized ?? r.checkIn)} → {formatDate(r.checkOutDateLocalized ?? r.checkOut)}</p>
                          {r.nightsCount && <p>{r.nightsCount} nights</p>}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* ── AUTO-MESSAGES TAB ── */}
          <TabsContent value="auto-messages" className="space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">Automated Message Templates</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Templates are sent automatically based on reservation events. Use merge tags like <code className="text-xs bg-muted px-1 rounded">{"{guest_name}"}</code> for personalization.
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                {templates.length === 0 && !templatesLoading && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addDefaultTemplates}
                    data-testid="button-add-defaults"
                  >
                    <Zap className="h-3.5 w-3.5 mr-1.5" /> Load Defaults
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => setTemplateDialog({ open: true, template: {} })}
                  data-testid="button-new-template"
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> New Template
                </Button>
              </div>
            </div>

            {/* Merge tag reference */}
            <Card className="bg-muted/30">
              <CardContent className="py-3">
                <p className="text-xs font-medium mb-1.5">Available Merge Tags:</p>
                <div className="flex flex-wrap gap-1.5">
                  {MERGE_TAGS.map(tag => (
                    <code key={tag} className="text-[11px] bg-background border px-1.5 py-0.5 rounded font-mono">{tag}</code>
                  ))}
                </div>
              </CardContent>
            </Card>

            {templatesLoading && <p className="text-sm text-muted-foreground">Loading templates…</p>}

            {!templatesLoading && templates.length === 0 && (
              <div className="border rounded-lg p-8 text-center bg-card">
                <Zap className="h-10 w-10 mx-auto mb-3 opacity-20" />
                <p className="font-medium mb-1">No templates yet</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Load the default templates to get started, or create your own.
                </p>
                <Button onClick={addDefaultTemplates} data-testid="button-load-defaults-empty">
                  <Zap className="h-4 w-4 mr-1.5" /> Load Default Templates
                </Button>
              </div>
            )}

            <div className="space-y-3">
              {templates.map(t => (
                <Card key={t.id} data-testid={`template-card-${t.id}`} className={!t.isActive ? "opacity-60" : ""}>
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3 min-w-0">
                        <Switch
                          checked={t.isActive}
                          onCheckedChange={() => toggleTemplate(t)}
                          data-testid={`switch-template-${t.id}`}
                        />
                        <div className="min-w-0">
                          <p className="font-medium text-sm">{t.name}</p>
                          <Badge variant="outline" className="text-[10px] mt-0.5">
                            <Clock className="h-2.5 w-2.5 mr-1" />
                            {triggerLabel(t.trigger, t.daysOffset)}
                          </Badge>
                          <p className="text-xs text-muted-foreground mt-2 line-clamp-2 whitespace-pre-wrap">
                            {t.body}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setTemplateDialog({ open: true, template: t })}
                          data-testid={`button-edit-template-${t.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-red-500 hover:text-red-600"
                          onClick={() => deleteTemplate.mutate(t.id)}
                          data-testid={`button-delete-template-${t.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* ── AUTO-REPLY TAB ── */}
          <TabsContent value="auto-reply" className="space-y-6">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Bot className="h-5 w-5" /> AI Auto-Reply Agent
                    </CardTitle>
                    <CardDescription className="mt-1">
                      Polls Guesty every 5 minutes. Uses Claude with listing/reservation tools to draft and send replies automatically. Risky messages (refund, cancel, damage, medical, legal) are drafted for human review instead of auto-sent.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="auto-reply-toggle"
                      checked={!!autoReplyStatus?.enabled}
                      onCheckedChange={(v) => toggleAutoReply.mutate(v)}
                      data-testid="switch-auto-reply"
                    />
                    <Label htmlFor="auto-reply-toggle" className="text-sm cursor-pointer">
                      {autoReplyStatus?.enabled ? "Enabled" : "Disabled"}
                    </Label>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runAutoReply.mutate()}
                    disabled={runAutoReply.isPending}
                    data-testid="button-run-auto-reply"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${runAutoReply.isPending ? "animate-spin" : ""}`} />
                    Run Now
                  </Button>
                  {autoReplyStatus?.lastRunAt && (
                    <span className="text-xs text-muted-foreground">
                      Last run: {new Date(autoReplyStatus.lastRunAt).toLocaleString()}
                      {autoReplyStatus.lastRunResult?.message && ` — ${autoReplyStatus.lastRunResult.message}`}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>

            <div>
              <h3 className="font-semibold mb-3">Recent Activity</h3>
              {logsLoading && <p className="text-sm text-muted-foreground">Loading logs…</p>}
              {!logsLoading && autoReplyLogs.length === 0 && (
                <div className="border rounded-lg p-8 text-center bg-card">
                  <Bot className="h-10 w-10 mx-auto mb-3 opacity-20" />
                  <p className="font-medium mb-1">No activity yet</p>
                  <p className="text-sm text-muted-foreground">
                    The agent will log every reply attempt here. Click "Run Now" to trigger a poll.
                  </p>
                </div>
              )}
              <div className="space-y-3">
                {autoReplyLogs.map((log: any) => (
                  <Card key={log.id} data-testid={`auto-reply-log-${log.id}`}>
                    <CardContent className="py-4">
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{log.guestName ?? "Guest"}</span>
                            {log.channel && (
                              <Badge variant="outline" className="text-[10px]">{log.channel}</Badge>
                            )}
                            {log.status === "sent" && (
                              <Badge className="bg-green-600 text-white text-[10px]">
                                <CheckCircle className="h-2.5 w-2.5 mr-1" /> Sent
                              </Badge>
                            )}
                            {log.status === "drafted" && (
                              <Badge className="bg-blue-600 text-white text-[10px]">
                                <Pencil className="h-2.5 w-2.5 mr-1" /> Drafted
                              </Badge>
                            )}
                            {log.status === "flagged" && (
                              <Badge className="bg-amber-500 text-white text-[10px]">
                                <Flag className="h-2.5 w-2.5 mr-1" /> Flagged
                              </Badge>
                            )}
                            {log.status === "dismissed" && (
                              <Badge variant="secondary" className="text-[10px]">Dismissed</Badge>
                            )}
                            {log.status === "error" && (
                              <Badge variant="destructive" className="text-[10px]">
                                <AlertCircle className="h-2.5 w-2.5 mr-1" /> Error
                              </Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {log.createdAt ? new Date(log.createdAt).toLocaleString() : ""}
                            {log.listingId && ` · listing ${log.listingId}`}
                          </p>
                        </div>
                      </div>

                      <div className="space-y-2 text-sm">
                        <div>
                          <p className="text-[11px] font-medium text-muted-foreground mb-0.5">GUEST SAID</p>
                          <p className="bg-muted/40 rounded px-3 py-2 whitespace-pre-wrap text-[13px]">{log.guestMessage}</p>
                        </div>

                        {log.replyDraft && (
                          <div>
                            <p className="text-[11px] font-medium text-muted-foreground mb-0.5">
                              {log.replySent ? "REPLY SENT" : "DRAFT"}
                            </p>
                            <p className="bg-primary/5 border border-primary/20 rounded px-3 py-2 whitespace-pre-wrap text-[13px]">{log.replyDraft}</p>
                          </div>
                        )}

                        {log.flagReason && (
                          <p className="text-xs text-amber-700 dark:text-amber-400">
                            <Flag className="h-3 w-3 inline mr-1" /> {log.flagReason}
                          </p>
                        )}
                        {log.errorMessage && (
                          <p className="text-xs text-red-600 dark:text-red-400">
                            <AlertCircle className="h-3 w-3 inline mr-1" /> {log.errorMessage}
                          </p>
                        )}
                      </div>

                      {!log.replySent && log.replyDraft && log.status !== "dismissed" && (
                        <div className="flex gap-2 mt-3 pt-3 border-t">
                          <Button
                            size="sm"
                            onClick={() => sendDraftReply.mutate(log.id)}
                            disabled={sendDraftReply.isPending}
                            data-testid={`button-send-draft-${log.id}`}
                          >
                            <Send className="h-3.5 w-3.5 mr-1.5" /> Send Reply
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => dismissDraft.mutate(log.id)}
                            disabled={dismissDraft.isPending}
                            data-testid={`button-dismiss-draft-${log.id}`}
                          >
                            <X className="h-3.5 w-3.5 mr-1.5" /> Dismiss
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Template editor dialog */}
      <Dialog open={templateDialog.open} onOpenChange={open => !open && setTemplateDialog({ open: false, template: null })}>
        <TemplateEditor
          template={templateDialog.template}
          onSave={saveTemplate}
          onClose={() => setTemplateDialog({ open: false, template: null })}
        />
      </Dialog>
    </div>
  );
}
