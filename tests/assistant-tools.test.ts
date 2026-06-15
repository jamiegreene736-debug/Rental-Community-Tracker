import {
  ASSISTANT_TOOLS,
  ASSISTANT_TOOLS_BY_NAME,
  anthropicToolDefs,
  runAssistantTool,
} from "../server/assistant/tools";
import { cacheSystem, cacheTools } from "../server/assistant/prompt-cache";
import { formatPageContext } from "../server/assistant/page-context";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("assistant: tool registry");

// Registry is non-empty and the expected core tools exist.
for (const name of [
  "get_dashboard",
  "list_bookings",
  "get_reports",
  "get_buy_in_estimate",
  "find_buy_in",
  "scan_city_vrbo",
  "get_market_rates",
  "start_auto_fill",
  "check_auto_fill",
  "find_photos",
  "get_photo_alerts",
  "get_photo_listing_status",
  "list_guest_conversations",
  "get_guest_thread",
  "draft_guest_reply",
  "send_guest_message",
  "send_payment_receipt",
]) {
  check(`tool '${name}' registered`, ASSISTANT_TOOLS_BY_NAME.has(name));
}

// Confirm-before-act contract: every WRITE tool MUST provide confirmLabel +
// confirmSummary (so the operator sees what's about to happen); read tools need
// neither. start_auto_fill is currently the only write tool.
for (const t of ASSISTANT_TOOLS) {
  if (t.kind === "write") {
    check(
      `write tool '${t.name}' has confirmLabel + confirmSummary`,
      typeof t.confirmLabel === "function" && typeof t.confirmSummary === "function",
      t,
    );
  }
}
check("start_auto_fill is a write tool", ASSISTANT_TOOLS_BY_NAME.get("start_auto_fill")?.kind === "write");
check("check_auto_fill is a read tool", ASSISTANT_TOOLS_BY_NAME.get("check_auto_fill")?.kind === "read");

// The confirm summary/label render without throwing for a representative input.
{
  const t = ASSISTANT_TOOLS_BY_NAME.get("start_auto_fill");
  const input = { reservationId: "R1", propertyId: 4, checkIn: "2026-07-01", checkOut: "2026-07-08", expectedRevenue: 8000 };
  const label = t?.confirmLabel?.(input) ?? "";
  const summary = t?.confirmSummary?.(input) ?? "";
  check("start_auto_fill confirm label is non-empty", label.length > 0, label);
  check("start_auto_fill confirm summary mentions the booking", summary.includes("R1") && summary.length > 30, summary);
}

// Every tool with required params declares them inside its schema properties.
for (const t of ASSISTANT_TOOLS) {
  const schema = t.input_schema as any;
  const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
  const props = schema?.properties ?? {};
  check(
    `tool '${t.name}' required params are all declared`,
    required.every((r) => r in props),
    { required, props: Object.keys(props) },
  );
}

// Each tool has a name, a meaningful description, and a JSON-schema object.
for (const t of ASSISTANT_TOOLS) {
  const okName = typeof t.name === "string" && t.name.length > 0;
  const okDesc = typeof t.description === "string" && t.description.length >= 30;
  const schema = t.input_schema as any;
  const okSchema = schema && schema.type === "object" && typeof schema.properties === "object";
  check(`tool '${t.name}' well-formed (name/desc/schema)`, okName && okDesc && okSchema, t);
}

// Anthropic defs mirror the registry and omit the executor.
const defs = anthropicToolDefs();
check("anthropicToolDefs count matches registry", defs.length === ASSISTANT_TOOLS.length, defs.length);
check(
  "anthropicToolDefs expose only name/description/input_schema",
  defs.every((d) => Object.keys(d).sort().join(",") === "description,input_schema,name"),
  defs[0] && Object.keys(defs[0]),
);

// Prompt caching (Phase 4): system becomes a content-block array with a cache
// breakpoint, and ONLY the last tool def carries cache_control.
{
  const sys = cacheSystem("system text here") as any[];
  check("cacheSystem is a content-block array", Array.isArray(sys) && sys.length === 1, sys);
  check("cacheSystem block has ephemeral cache_control", sys?.[0]?.cache_control?.type === "ephemeral", sys?.[0]);
  const ct = cacheTools(anthropicToolDefs() as any[]) as any[];
  check("cacheTools count matches registry", ct.length === ASSISTANT_TOOLS.length, ct.length);
  check("cacheTools marks ONLY the last tool", !ct[0]?.cache_control && ct[ct.length - 1]?.cache_control?.type === "ephemeral");
}

// Page context (Phase: page-awareness): empty/garbage → undefined; real context
// → a block that includes the JSON and the "use this; don't ask" instruction.
check("formatPageContext: undefined for empty", formatPageContext(undefined) === undefined && formatPageContext({}) === undefined);
check("formatPageContext: non-object → undefined", formatPageContext("x" as unknown) === undefined);
{
  const block = formatPageContext({ page: "Pre-flight", data: { community: "Paniolo Hale", address: "100 Lio Pl, Maunaloa, Hawaii" } }) ?? "";
  check("formatPageContext: includes the data", block.includes("Paniolo Hale") && block.includes("Maunaloa"), block);
  check("formatPageContext: instructs to act, not ask", /do NOT ask/i.test(block), block);
}

// Unknown tool dispatch is graceful (no throw, returns an _error envelope).
(async () => {
  const r = (await runAssistantTool("does_not_exist", {})) as any;
  check("unknown tool returns _error envelope", !!r && r._error === true, r);

  console.log(`\nassistant-tools: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
