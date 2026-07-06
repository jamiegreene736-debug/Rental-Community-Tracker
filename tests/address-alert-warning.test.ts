import assert from "node:assert";
import {
  ADDRESS_ALERT_PLATFORMS,
  formatAddressAlertPlatforms,
  addressFoundPlatforms,
  addressAlertWarningSignature,
  collectAddressAlertLinks,
} from "../shared/address-alert-warning";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("address-alert-warning: dashboard address-alert popup helpers");

// ---- addressFoundPlatforms --------------------------------------------------
check(
  "reports only FOUND platforms in canonical order",
  JSON.stringify(addressFoundPlatforms({ airbnb: "found", vrbo: "clean", booking: "found" })) ===
    JSON.stringify(["airbnb", "booking"]),
);
check("no found → empty", addressFoundPlatforms({ airbnb: "clean", vrbo: "unknown" }).length === 0);
check("missing/undefined status → not found", addressFoundPlatforms({}).length === 0);

// ---- formatAddressAlertPlatforms --------------------------------------------
check("labels platforms", formatAddressAlertPlatforms(["airbnb", "booking"]) === "Airbnb / Booking.com");

// ---- addressAlertWarningSignature -------------------------------------------
check("empty units → empty signature", addressAlertWarningSignature([]) === "");
{
  const a = addressAlertWarningSignature([
    { folder: "unit-a", platforms: ["vrbo", "airbnb"], checkedAt: "2026-07-06T00:00:00Z" },
    { folder: "unit-b", platforms: ["booking"], checkedAt: null },
  ]);
  const b = addressAlertWarningSignature([
    { folder: "unit-b", platforms: ["booking"], checkedAt: null },
    { folder: "unit-a", platforms: ["airbnb", "vrbo"], checkedAt: "2026-07-06T00:00:00Z" },
  ]);
  check("signature is order-independent (units + platforms)", a === b);
  const c = addressAlertWarningSignature([
    { folder: "unit-a", platforms: ["vrbo", "airbnb"], checkedAt: "2026-07-07T00:00:00Z" }, // fresher scan
    { folder: "unit-b", platforms: ["booking"], checkedAt: null },
  ]);
  check("a fresher scan (new checkedAt) changes the signature", a !== c);
}

// ---- collectAddressAlertLinks -----------------------------------------------
{
  const { links, more } = collectAddressAlertLinks([
    { platform: "vrbo", url: "https://www.vrbo.com/4567890", title: "Poipu Kai 3BR", snippet: "1831 Poipu Rd" },
    { platform: "airbnb", url: "https://www.airbnb.com/rooms/12345", title: "Sunny Condo", snippet: "" },
  ]);
  check("platform-ordered (Airbnb before VRBO)", links.length === 2 && links[0].platform === "airbnb" && links[1].platform === "vrbo");
  check("no overflow", more === 0);
  check("title falls back to url when blank", collectAddressAlertLinks([{ platform: "airbnb", url: "https://www.airbnb.com/rooms/9", title: "" }]).links[0].title === "https://www.airbnb.com/rooms/9");
}
check(
  "de-dupes the same listing across query/slash variants",
  collectAddressAlertLinks([
    { platform: "vrbo", url: "https://www.vrbo.com/4567890?x=1", title: "a" },
    { platform: "vrbo", url: "https://www.vrbo.com/4567890/", title: "b" },
  ]).links.length === 1,
);
check(
  "skips non-http and unknown-platform rows",
  collectAddressAlertLinks([
    { platform: "airbnb", url: "javascript:alert(1)", title: "x" },
    { platform: "zillow", url: "https://www.zillow.com/1", title: "y" },
    { platform: "airbnb", url: "", title: "z" },
  ]).links.length === 0,
);
check("null matches → no links", collectAddressAlertLinks(null).links.length === 0);
{
  const many = Array.from({ length: 9 }, (_v, i) => ({ platform: "booking" as const, url: `https://www.booking.com/hotel/us/x${i}.html`, title: `h${i}` }));
  const { links, more } = collectAddressAlertLinks(many, 6);
  check("caps at limit and reports the overflow count", links.length === 6 && more === 3);
}

console.log(`\naddress-alert-warning: ${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, "address-alert-warning tests failed");
