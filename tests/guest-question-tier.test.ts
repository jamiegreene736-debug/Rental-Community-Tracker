// Network-free unit tests for shared/guest-question-tier.ts — the guest inbox
// tier classifier (tier 1 = super-basic property question the AI auto-answers
// in Hawaii style; tier 2 = everything else, never auto-sent) + the shared UI
// badge derivation — plus SOURCE ASSERTIONS locking the server/UI wiring:
// the tier-1 scoped auto-send gate, web-search grounded drafting, the
// downgrade-to-tier-2 paths, schema columns, routes, and inbox badges.
import { readFileSync } from "node:fs";
import {
  classifyGuestQuestionTier,
  autoReplyTierBadge,
  MAX_TIER1_MESSAGE_CHARS,
} from "../shared/guest-question-tier";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("guest-question-tier: tier-1 basics");

const t = (msg: string) => classifyGuestQuestionTier(msg);

// The operator's canonical example.
check("ocean view → tier 1", t("Is there an ocean view?").tier === 1, t("Is there an ocean view?"));
check("ocean view topic recorded", t("Is there an ocean view?").topics.includes("view"));
check("parking → tier 1", t("Is there parking at the condo?").tier === 1);
check("parking without question mark → tier 1", t("is there parking").tier === 1);
check("wifi → tier 1", t("Does the unit have wifi?").tier === 1);
check("AC → tier 1", t("Is there air conditioning?").tier === 1);
check("washer/dryer → tier 1", t("Do you have a washer and dryer in the unit?").tier === 1);
check("pool → tier 1", t("Is there a pool?").tier === 1);
check("BBQ → tier 1", t("Are there BBQ grills on site?").tier === 1);
check("lanai → tier 1", t("Does it have a lanai?").tier === 1);
check("beach distance → tier 1", t("How far is the walk to the beach?").tier === 1);
check("check-in time → tier 1", t("What time is check-in?").tier === 1);
check("king bed → tier 1", t("Is there a king bed in the master?").tier === 1);
check("TV → tier 1", t("Does the condo have a smart TV with Netflix?").tier === 1);
const multiBasic = t("Is there a pool? And does it have wifi?");
check("multi-question all-basic stays tier 1", multiBasic.tier === 1, multiBasic);
// "included" reads as a cost question ("is wifi included?") → tier 2.
check("'is wifi included' → tier 2 (pricing)", t("Is wifi included in the unit?").tier === 2);
check("wondering phrasing → tier 1", t("Just wondering if the unit has a dishwasher").tier === 1);

console.log("guest-question-tier: tier-2 everything else");

check("discount → tier 2", t("Can you give us a discount?").tier === 2);
check("refund → tier 2", t("I need a refund").tier === 2);
check("availability → tier 2", t("Is it available in March?").tier === 2);
check("booking request → tier 2", t("Can we book the condo for July?").tier === 2);
check("price → tier 2", t("What is the price for 5 nights?").tier === 2);
check("'is parking free' → tier 2 (pricing)", t("Is parking free?").tier === 2);
check("pets → tier 2", t("Do you allow pets?").tier === 2);
check("early check-in → tier 2", t("Can we check in early?").tier === 2);
check("basic + risky combo → tier 2", t("Is there an ocean view? Also can we check in early?").tier === 2);
check("accessibility → tier 2", t("Is the unit wheelchair accessible?").tier === 2);
check("elevator/stairs → tier 2", t("Are there stairs to the unit?").tier === 2);
check("complaint → tier 2", t("The wifi is broken").tier === 2);
check("urgent → tier 2", t("Urgent - is there parking?").tier === 2);
check("door code → tier 2", t("What is the door code?").tier === 2);
check("service request → tier 2", t("Can you pick us up from the airport?").tier === 2);
check("'can you heat the pool' request → tier 2", t("Can you heat the pool for us?").tier === 2);
check("'can you confirm' fact wrapper stays tier 1", t("Can you confirm there is AC in the unit?").tier === 1);
check("no basic topic → tier 2", t("We land at 3pm on Thursday").tier === 2);
check("statement (not a question) → tier 2", t("Looking forward to the ocean view").tier === 2);
check("empty → tier 2", t("").tier === 2);
const longMsg = "Is there a pool? ".repeat(40);
check(`over ${MAX_TIER1_MESSAGE_CHARS} chars → tier 2`, t(longMsg).tier === 2);
check("tier-2 reason is populated", t("Can you give us a discount?").reason.length > 0);
check("tier-1 reason names the topic", /view/i.test(t("Is there an ocean view?").reason));

console.log("guest-question-tier: badge derivation");

check("legacy row (no tier) → null", autoReplyTierBadge({ tier: null, status: "sent", replySent: true, autoSent: true }) === null);
const answered = autoReplyTierBadge({ tier: 1, status: "sent", replySent: true, autoSent: true });
check("tier1 auto-sent → AI answered", answered?.kind === "tier1-answered" && /AI answered/.test(answered.label), answered);
const sending = autoReplyTierBadge({ tier: 1, status: "queued", replySent: false, autoSent: false });
check("tier1 queued → answering…", sending?.kind === "tier1-sending", sending);
const manual = autoReplyTierBadge({ tier: 1, status: "sent", replySent: true, autoSent: false });
check("tier1 human-sent → tier1-manual", manual?.kind === "tier1-manual", manual);
const held1 = autoReplyTierBadge({ tier: 1, status: "drafted", replySent: false, autoSent: false });
check("tier1 drafted (toggle off) → held", held1?.kind === "tier1-held", held1);
check("tier1 dismissed → null", autoReplyTierBadge({ tier: 1, status: "dismissed", replySent: false, autoSent: false }) === null);
const held2 = autoReplyTierBadge({ tier: 2, status: "flagged", replySent: false, autoSent: false, tierReason: "Risky topic (refund)" });
check("tier2 pending → no-auto-reply badge", held2?.kind === "tier2-held" && /no auto-reply/i.test(held2.label), held2);
check("tier2 title carries the reason", /Risky topic/.test(held2?.title ?? ""), held2);
const handled2 = autoReplyTierBadge({ tier: 2, status: "sent", replySent: true, autoSent: false });
check("tier2 replied → handled", handled2?.kind === "tier2-handled", handled2);
const dismissed2 = autoReplyTierBadge({ tier: 2, status: "dismissed", replySent: false, autoSent: false });
check("tier2 dismissed → handled", dismissed2?.kind === "tier2-handled", dismissed2);

console.log("guest-question-tier: server wiring source assertions");

const autoReply = readFileSync(new URL("../server/auto-reply.ts", import.meta.url), "utf8");
check("auto-reply imports the shared classifier", autoReply.includes('from "@shared/guest-question-tier"'));
check("tier-1 setting key exists", autoReply.includes('"auto_send.tier1_enabled"'));
check("tier-1 default is ON", /let _tier1AutoEnabled = true/.test(autoReply));
check("canAutoSend gates on tier-1 toggle", autoReply.includes("const tierOneAutoSend = tier === 1 && _tier1AutoEnabled") && autoReply.includes("(_autoSendEnabled || tierOneAutoSend)"));
check("send queue authorizes per-row by tier", autoReply.includes("_autoSendEnabled || (_tier1AutoEnabled && fresh.tier === 1)"));
check("send-queue top gate covers tier-1 mode", autoReply.includes("if (!_autoSendEnabled && !_tier1AutoEnabled)"));
check("tier-1 drafts get the web_search server tool", autoReply.includes('"web_search_20250305"'));
check("pause_turn resumes the server tool loop", autoReply.includes('stopReason === "pause_turn"'));
check("server_tool_use recorded for the audit trail", autoReply.includes('"server_tool_use"'));
check("tier-1 model default is sonnet", autoReply.includes('process.env.AUTO_REPLY_TIER1_MODEL || "claude-sonnet-4-6"'));
check("Hawaii-style tier-1 prompt block present", autoReply.includes("TIER 1 BASIC QUESTION — HAWAII-STYLE AUTO-ANSWER"));
check("tier-1 prompt keeps the flag escape hatch", autoReply.includes("call flag_for_human instead of answering"));
check("model-flag downgrade to tier 2", autoReply.includes("The AI held it: ${result.flagReason}"));
check("output-filter downgrade to tier 2", autoReply.includes("The AI held it: ${outputSafety.reason}"));
check("unmapped-listing downgrade to tier 2", autoReply.includes("No Guesty listing mapped"));
check("risky keywords force tier 2", autoReply.includes("safety.risky ? 2 : tierResult.tier"));
check("log entry persists tier + reason", /tier,\s*\n\s*tierReason,/.test(autoReply));
check("tier-1 toggle-off reverts queued tier-1 rows", autoReply.includes("l.tier === 1"));

const schema = readFileSync(new URL("../shared/schema.ts", import.meta.url), "utf8");
check("schema has tier column", schema.includes('tier: integer("tier")'));
check("schema has tier_reason column", schema.includes('tierReason: text("tier_reason")'));

const maintenance = readFileSync(new URL("../server/schema-maintenance.ts", import.meta.url), "utf8");
check("boot ALTER adds tier", maintenance.includes("ALTER TABLE auto_reply_log ADD COLUMN IF NOT EXISTS tier integer"));
check("boot ALTER adds tier_reason", maintenance.includes("ALTER TABLE auto_reply_log ADD COLUMN IF NOT EXISTS tier_reason text"));

const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
check("tiers endpoint exists", routes.includes('"/api/inbox/auto-reply/tiers"'));
check("tier-1 toggle endpoint exists", routes.includes('"/api/inbox/auto-reply/tier1/toggle"'));
check("tiers endpoint is a cheap read (no draft cleanup)", (() => {
  const idx = routes.indexOf('"/api/inbox/auto-reply/tiers"');
  return idx > 0 && !routes.slice(idx, idx + 2200).includes("dismissHandledAutoReplyDrafts");
})());

const auth = readFileSync(new URL("../server/auth.ts", import.meta.url), "utf8");
check("agent role can read the tier map", auth.includes('path === "/api/inbox/auto-reply/tiers"'));

const inbox = readFileSync(new URL("../client/src/pages/inbox.tsx", import.meta.url), "utf8");
check("inbox imports the shared badge helper", inbox.includes("autoReplyTierBadge"));
check("conversation rows render the tier chip", inbox.includes("badge-tier-${c._id}"));
check("thread header renders the tier verdict", inbox.includes("badge-tier-thread-"));
check("admin tier-1 switch present", inbox.includes("switch-tier1-auto-answer"));
check("thread copy states tier-2 = no automatic response", inbox.includes("Tier 2 — no automatic AI response, needs you"));

console.log(`\nguest-question-tier: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
