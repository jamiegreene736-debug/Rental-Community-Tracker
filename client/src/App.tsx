import { useEffect } from "react";
import type React from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppHeader from "@/components/AppHeader";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import UnitBuilder from "@/pages/unit-builder";
import BuyInTracker from "@/pages/buy-in-tracker";
import PhotoAudit from "@/pages/photo-audit";
import AvailabilityScanner from "@/pages/availability-scanner";
import CommunityPhotoFinder from "@/pages/community-photo-finder";
import AddCommunity from "@/pages/add-community";
// CODEX NOTE (2026-05-04, claude/single-listing): standalone-unit
// counterpart to AddCommunity. Same downstream save flow (community_drafts
// table, builder, preflight) — just one unit instead of two combined.
import AddSingleListing from "@/pages/add-single-listing";
import Builder from "@/pages/builder";
import BuilderPreflight from "@/pages/builder-preflight";
import Inbox from "@/pages/inbox";
import Bookings from "@/pages/bookings";
import Agreement from "@/pages/agreement";
import { setLivePropertyMarketRates, type LivePropertyMarketRateInput } from "@shared/pricing-rates";
import { usePortalSession } from "@/lib/auth";

function AgentRouteGate({ children }: { children: React.ReactNode }) {
  const { data: session, isLoading } = usePortalSession();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && session?.role === "agent") {
      setLocation("/");
    }
  }, [isLoading, session?.role, setLocation]);

  if (isLoading) return null;
  if (session?.role === "agent") return null;
  return <>{children}</>;
}

function Router() {
  const [location] = useLocation();
  if (location.startsWith("/agreement/") || location.startsWith("/admin/agreement/")) {
    return (
      <ErrorBoundary>
        <Switch>
          <Route path="/agreement/:token" component={Agreement} />
          <Route path="/admin/agreement/:token" component={Agreement} />
          <Route component={NotFound} />
        </Switch>
      </ErrorBoundary>
    );
  }

  return (
    <>
      <AppHeader />
      <ErrorBoundary>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/listing-queue">{() => <AgentRouteGate><AddCommunity /></AgentRouteGate>}</Route>
          <Route path="/add-community">{() => <AgentRouteGate><AddCommunity /></AgentRouteGate>}</Route>
          <Route path="/add-single-listing">{() => <AgentRouteGate><AddSingleListing /></AgentRouteGate>}</Route>
          <Route path="/builder/:propertyId/preflight">{() => <AgentRouteGate><BuilderPreflight /></AgentRouteGate>}</Route>
          <Route path="/builder/:propertyId/:step">{() => <AgentRouteGate><Builder /></AgentRouteGate>}</Route>
          <Route path="/unit-builder/:id">{() => <AgentRouteGate><UnitBuilder /></AgentRouteGate>}</Route>
          <Route path="/buy-in-tracker">{() => <AgentRouteGate><BuyInTracker /></AgentRouteGate>}</Route>
          <Route path="/photo-audit">{() => <AgentRouteGate><PhotoAudit /></AgentRouteGate>}</Route>
          <Route path="/availability-scanner">{() => <AgentRouteGate><AvailabilityScanner /></AgentRouteGate>}</Route>
          <Route path="/community-photo-finder">{() => <AgentRouteGate><CommunityPhotoFinder /></AgentRouteGate>}</Route>
          <Route path="/inbox" component={Inbox} />
          <Route path="/bookings">{() => <AgentRouteGate><Bookings /></AgentRouteGate>}</Route>
          <Route path="/agreement/:token" component={Agreement} />
          <Route path="/admin/agreement/:token" component={Agreement} />
          <Route component={NotFound} />
        </Switch>
      </ErrorBoundary>
    </>
  );
}

// Hydrates the shared live-buy-in cache (`shared/pricing-rates.ts →
// _liveBuyIns`) once per app load. Both the dashboard
// (`home.tsx → computeBaseRate`) and the Builder Pricing tab read
// from this cache via `getBuyInRate(community, bedrooms, propertyId)`,
// so it has to land before either renders. Uses `useQuery` so the
// request is deduped with `home.tsx`'s same-key subscription —
// react-query's cache holds the response and any consumer using the
// same key sees the data without a second network call.
function MarketRatesHydrator() {
  const { data: session } = usePortalSession();
  const { data } = useQuery<LivePropertyMarketRateInput[]>({
    queryKey: ["/api/property/market-rates"],
    enabled: session?.role === "admin",
  });
  useEffect(() => {
    if (Array.isArray(data)) setLivePropertyMarketRates(data);
  }, [data]);
  return null;
}

function App() {
  const [location] = useLocation();
  const isAgreementRoute = location.startsWith("/agreement/") || location.startsWith("/admin/agreement/");

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        {!isAgreementRoute && <MarketRatesHydrator />}
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
