import {
  ASSISTANT_TOOLS,
  ASSISTANT_TOOLS_BY_NAME,
  anthropicToolDefs,
  runAssistantTool,
} from "../server/assistant/tools";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("assistant: tool registry");

// Every Phase 0 tool is read-only (write tools land with a confirm gate later).
check("all Phase 0 tools are read-only", ASSISTANT_TOOLS.every((t) => t.kind === "read"));

// Registry is non-empty and the expected core tools exist.
for (const name of ["get_dashboard", "list_bookings", "get_reports", "get_buy_in_estimate"]) {
  check(`tool '${name}' registered`, ASSISTANT_TOOLS_BY_NAME.has(name));
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

// Unknown tool dispatch is graceful (no throw, returns an _error envelope).
(async () => {
  const r = (await runAssistantTool("does_not_exist", {})) as any;
  check("unknown tool returns _error envelope", !!r && r._error === true, r);

  console.log(`\nassistant-tools: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
