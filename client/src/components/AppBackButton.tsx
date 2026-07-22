import { useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { backNavigationPlan } from "@/lib/app-nav-history";

// The ONE page-header back control. It goes to the browser's PREVIOUS page
// when the previous history entry is inside this app, and falls back to
// navigating to `fallbackHref` (the dashboard) on deep links / fresh tabs —
// so "Back" never exits the portal and never silently does nothing.
// Home/dashboard navigation is the header logo's job (link-brand-home), not
// this button's — don't relabel it back to "Dashboard".
export default function AppBackButton({
  fallbackHref = "/",
  iconOnly = false,
  className,
  testId = "button-back-previous",
}: {
  fallbackHref?: string;
  iconOnly?: boolean;
  className?: string;
  testId?: string;
}) {
  const [, navigate] = useLocation();
  const goBack = () => {
    // Skip pass-through dashboard hops: Back lands on the previous WORK page
    // (e.g. Operations/All Reservations), because the header logo already owns
    // navigation to the dashboard. See backNavigationPlan for the rules.
    const plan = backNavigationPlan();
    if (plan.kind === "steps") {
      window.history.go(-plan.delta);
    } else {
      navigate(fallbackHref);
    }
  };
  return (
    <Button
      variant="ghost"
      size={iconOnly ? "icon" : "sm"}
      className={className ?? (iconOnly ? undefined : "gap-1")}
      onClick={goBack}
      aria-label="Back to previous page"
      title="Back to previous page"
      data-testid={testId}
    >
      <ArrowLeft className="h-4 w-4" />
      {!iconOnly && "Back"}
    </Button>
  );
}
