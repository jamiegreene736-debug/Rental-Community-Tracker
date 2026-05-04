import { useEffect } from "react";
import { Switch, Route } from "wouter";
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
import { setLivePropertyMarketRates, type LivePropertyMarketRateInput } from "@shared/pricing-rates";

function Router() {
  return (
    <>
      <AppHeader />
      <ErrorBoundary>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/add-community" component={AddCommunity} />
          <Route path="/add-single-listing" component={AddSingleListing} />
          <Route path="/builder/:propertyId/preflight" component={BuilderPreflight} />
          <Route path="/builder/:propertyId/:step" component={Builder} />
          <Route path="/unit-builder/:id" component={UnitBuilder} />
          <Route path="/buy-in-tracker" component={BuyInTracker} />
          <Route path="/photo-audit" component={PhotoAudit} />
          <Route path="/availability-scanner" component={AvailabilityScanner} />
          <Route path="/community-photo-finder" component={CommunityPhotoFinder} />
          <Route path="/inbox" component={Inbox} />
          <Route path="/bookings" component={Bookings} />
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
  const { data } = useQuery<LivePropertyMarketRateInput[]>({
    queryKey: ["/api/property/market-rates"],
  });
  useEffect(() => {
    if (Array.isArray(data)) setLivePropertyMarketRates(data);
  }, [data]);
  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <MarketRatesHydrator />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
