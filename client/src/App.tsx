import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import UnitBuilder from "@/pages/unit-builder";
import LodgifyPrep from "@/pages/lodgify-prep";
import BuyInTracker from "@/pages/buy-in-tracker";
import PhotoAudit from "@/pages/photo-audit";
import AvailabilityScanner from "@/pages/availability-scanner";
import CommunityPhotoFinder from "@/pages/community-photo-finder";
import AddCommunity from "@/pages/add-community";
import Builder from "@/pages/builder";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/add-community" component={AddCommunity} />
      <Route path="/builder/:propertyId/:step" component={Builder} />
      <Route path="/unit-builder/:id" component={UnitBuilder} />
      <Route path="/lodgify-prep/:id" component={LodgifyPrep} />
      <Route path="/buy-in-tracker" component={BuyInTracker} />
      <Route path="/photo-audit" component={PhotoAudit} />
      <Route path="/availability-scanner" component={AvailabilityScanner} />
      <Route path="/community-photo-finder" component={CommunityPhotoFinder} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
