import assert from "node:assert/strict";
import {
  buildMarketReconSearchQueries,
  detectMarketReconPortal,
  marketReconLooksAnchored,
} from "../shared/market-recon-discovery";

const cocoaInput = {
  streetAddress: "220 Young Ave, Cocoa Beach, FL",
  communityName: "Cocoa Beach Tower",
  city: "Cocoa Beach",
  state: "Florida",
  bedrooms: 3,
};

const queries = buildMarketReconSearchQueries(cocoaInput);
assert.ok(queries.length >= 6, "market recon should emit multiple aggregator queries");
assert.ok(
  queries.some((q) => /220 Young Ave/i.test(q) && /site:zillow\.com/i.test(q)),
  "should include street + zillow site query",
);
assert.ok(
  queries.some((q) => /3 bedroom OR 3BR/i.test(q)),
  "should include bedroom OR group",
);
assert.ok(
  queries.some((q) => /Cocoa Beach Tower/i.test(q) && /site:realtor\.com/i.test(q)),
  "should include community + realtor site query",
);

assert.equal(detectMarketReconPortal("https://www.zillow.com/homedetails/220-Young-Ave/123_zpid/"), "zillow");
assert.equal(
  detectMarketReconPortal("https://www.realtor.com/realestateandhomes-detail/220-Young-Ave_Cocoa-Beach_FL_123"),
  "realtor",
);
assert.equal(detectMarketReconPortal("https://www.google.com/search?q=test"), null);

assert.ok(
  marketReconLooksAnchored(
    "https://www.zillow.com/homedetails/220-Young-Ave-Cocoa-Beach-FL/123_zpid/",
    "220 Young Ave APT 29, Cocoa Beach FL",
    "3 bedroom condo for sale",
    cocoaInput,
  ),
  "zillow homedetails with street + city in title should anchor",
);

assert.ok(
  !marketReconLooksAnchored(
    "https://www.zillow.com/homedetails/999-Other-St-Cocoa-Beach-FL/456_zpid/",
    "999 Other St, Cocoa Beach FL",
    "2 bedroom condo",
    cocoaInput,
  ),
  "unrelated street should not anchor when a resort street is configured",
);

assert.ok(
  marketReconLooksAnchored(
    "https://www.zillow.com/homedetails/Some-Building/456_zpid/",
    "Cocoa Beach Tower 3BR condo",
    "Cocoa Beach Florida",
    { communityName: "Cocoa Beach Tower", city: "Cocoa Beach", bedrooms: 3 },
  ),
  "community-only recon should anchor when no street is configured",
);

assert.ok(
  marketReconLooksAnchored(
    "https://www.redfin.com/FL/Cocoa-Beach/220-Young-Ave-32931/home/12345",
    "220 Young Ave Unit 59",
    "Cocoa Beach Tower 3BR",
    cocoaInput,
  ),
  "redfin URL with street number + name should anchor",
);

console.log(`market-recon-discovery.test.ts: ${queries.length} queries generated, all assertions passed`);
