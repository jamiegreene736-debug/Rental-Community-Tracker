// Locks the preflight photo location-confirmation helper: it confirms WHAT STATE
// (and city) a community/unit is in, and flags a Bay-Watch-style mis-location.
import {
  confirmCommunityLocation,
  parseStateFromText,
  parseCityStateFromAddress,
  citiesEquivalent,
} from "../shared/photo-location-confirmation";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("photo-location-confirmation: state/city confirmation for preflight photos");

// ── parseStateFromText ──────────────────────────────────────────────────────
check("full name", parseStateFromText("Located in South Carolina") === "South Carolina");
check("abbrev in address", parseStateFromText("123 Ocean Blvd, Myrtle Beach, SC 29572") === "South Carolina");
check("longest-match (West Virginia not Virginia)", parseStateFromText("Charleston, West Virginia") === "West Virginia");
check("embedded word is NOT a state (Indianapolis ≠ Indiana)", parseStateFromText("Indianapolis") === null);
check("embedded word is NOT a state (foregone ≠ Oregon)", parseStateFromText("a foregone conclusion") === null);
check("real state with surrounding text", parseStateFromText("Reunion Resort, Florida 34747") === "Florida");
check("none", parseStateFromText("just some text") === null);
check("blank", parseStateFromText("") === null && parseStateFromText(null) === null);

// ── parseCityStateFromAddress ───────────────────────────────────────────────
const a1 = parseCityStateFromAddress("8000 Palms Dr, Kissimmee, FL 34747");
check("address → city", a1.city === "Kissimmee", a1);
check("address → state", a1.state === "Florida", a1);
const a2 = parseCityStateFromAddress("Myrtle Beach, South Carolina");
check("two-part address → city/state", a2.city === "Myrtle Beach" && a2.state === "South Carolina", a2);

// ── citiesEquivalent ────────────────────────────────────────────────────────
check("equal cities", citiesEquivalent("Kissimmee", "kissimmee"));
check("containment", citiesEquivalent("St Pete Beach", "St Pete Beach FL"));
check("different cities", !citiesEquivalent("Naples", "Destin"));

// ── confirmCommunityLocation: the Bay Watch case (curated guard) ────────────
const bayFl = confirmCommunityLocation({ communityName: "Bay Watch", expectedState: "Florida", expectedCity: "Destin" });
check("Bay Watch expected FL → state MISMATCH", bayFl.stateStatus === "mismatch" && bayFl.status === "mismatch", bayFl);
check("Bay Watch confirmedState = South Carolina", bayFl.confirmedState === "South Carolina", bayFl);
check("Bay Watch note names the real state", /South Carolina/.test(bayFl.note) && /not Florida/.test(bayFl.note), bayFl.note);

const baySc = confirmCommunityLocation({ communityName: "Bay Watch", expectedState: "SC", expectedCity: "Myrtle Beach" });
check("Bay Watch expected SC → state MATCH", baySc.stateStatus === "match" && baySc.status === "match", baySc);

// ── observed-state mismatch (e.g. Claude reports a different state) ──────────
const obsMismatch = confirmCommunityLocation({
  communityName: "Some Resort", expectedState: "Florida", observedState: "Alabama",
});
check("observed Alabama vs expected FL → mismatch", obsMismatch.stateStatus === "mismatch", obsMismatch);
check("observed mismatch confirmedState = Alabama", obsMismatch.confirmedState === "Alabama", obsMismatch);

// ── observed-state agreement ────────────────────────────────────────────────
const obsMatch = confirmCommunityLocation({
  communityName: "Reunion Resort", expectedState: "FL", observedState: "Florida", expectedCity: "Kissimmee", observedCity: "Kissimmee",
});
check("observed FL == expected FL → match", obsMatch.stateStatus === "match" && obsMatch.cityStatus === "match" && obsMatch.status === "match", obsMatch);

// ── unknown community, only expected state → unconfirmed (recall-safe) ───────
const unconf = confirmCommunityLocation({ communityName: "Mystery Condos", expectedState: "Florida", expectedCity: "Naples" });
check("unknown community → unconfirmed (no false mismatch)", unconf.stateStatus === "unconfirmed" && unconf.status === "unconfirmed", unconf);
check("unconfirmed still reports the expected state", unconf.confirmedState === "Florida", unconf);

// ── city mismatch only ──────────────────────────────────────────────────────
const cityBad = confirmCommunityLocation({
  communityName: "Reunion Resort", expectedState: "Florida", observedState: "Florida", expectedCity: "Kissimmee", observedCity: "Orlando",
});
check("same state, different city → mismatch overall", cityBad.cityStatus === "mismatch" && cityBad.status === "mismatch", cityBad);

// ── nothing to compare ──────────────────────────────────────────────────────
const empty = confirmCommunityLocation({ communityName: "Whatever" });
check("no expected/observed → unconfirmed", empty.status === "unconfirmed", empty);

console.log(`\nphoto-location-confirmation: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
