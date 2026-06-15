// Pure helper: render the client-supplied "what page is the operator looking at"
// payload into a system block. Kept dependency-free so it's unit-testable without
// a DB. This is what stops the assistant from interrogating the operator for
// facts that are already on their screen.

export function formatPageContext(context: unknown): string | undefined {
  if (!context || typeof context !== "object") return undefined;
  let json: string;
  try {
    json = JSON.stringify(context);
  } catch {
    return undefined;
  }
  if (!json || json === "{}" || json.length < 3) return undefined;
  if (json.length > 4000) json = `${json.slice(0, 4000)}…`;
  return [
    "CURRENT PAGE THE OPERATOR IS VIEWING (live context from the app UI):",
    json,
    "",
    "Use this context directly. If it already contains what a tool needs — community/resort name, address, city, state, unit bedroom layout, propertyId, listingId, reservationId, dates — USE those values and ACT; do NOT ask the operator to re-type things that are on their screen. Only ask a question if essential information is genuinely absent from both the context and the conversation.",
  ].join("\n");
}
