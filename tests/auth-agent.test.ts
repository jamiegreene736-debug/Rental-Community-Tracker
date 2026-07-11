import assert from "node:assert/strict";
import type { Request } from "express";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";
// Agent logins are now loaded from the AGENT_LOGINS env var (never hardcoded —
// server/auth.ts is in a public repo). Set dummy test creds BEFORE importing
// server/auth so loadAgentLogins() reads them at module-eval time. These are
// throwaway values, NOT the real (now-rotated) agent passwords.
process.env.AGENT_LOGINS = "testagent:test-pass-123,christaltest:Str0ng#Pass";

const { isAgentAllowedPath, resolveLoginRole } = await import("../server/auth");

function req(method: string, path: string): Request {
  return { method, path } as Request;
}

console.log("auth agent suite");

assert.equal(resolveLoginRole("testagent", "test-pass-123", "admin-secret"), "agent");
assert.equal(resolveLoginRole("", "admin-secret", "admin-secret"), "admin");
assert.equal(resolveLoginRole("admin", "admin-secret", "admin-secret"), "admin");
assert.equal(resolveLoginRole("testagent", "admin-secret", "admin-secret"), null);
// A username not present in AGENT_LOGINS never resolves (old burned creds are gone).
assert.equal(resolveLoginRole("agent", "agent", "admin-secret"), null);
assert.equal(resolveLoginRole("christalh", "VacationRentalz@12", "admin-secret"), null);
console.log("  ✓ classifies admin and env-configured agent credentials");

// A second agent-role login parsed from AGENT_LOGINS — identical rights.
assert.equal(resolveLoginRole("christaltest", "Str0ng#Pass", "admin-secret"), "agent");
assert.equal(resolveLoginRole("ChristalTest", "Str0ng#Pass", "admin-secret"), "agent"); // username case-insensitive
assert.equal(resolveLoginRole("christaltest", "wrong", "admin-secret"), null);
assert.equal(resolveLoginRole("christaltest", "str0ng#pass", "admin-secret"), null); // password IS case-sensitive
console.log("  ✓ a second env agent login resolves to the agent role (identical permissions)");

// Agent identity constants (login greeting + reply sign-off name + compose seed).
const { AGENT_DISPLAY_NAME, AGENT_LOGIN_GREETING, AGENT_REPLY_SIGNOFF_NAME, AGENT_REPLY_SIGNOFF, AGENT_COMPOSE_SEED } =
  await import("../shared/agent-identity");
assert.equal(AGENT_DISPLAY_NAME, "Christal");
assert.equal(AGENT_LOGIN_GREETING, "Aloha Christal");
assert.equal(AGENT_REPLY_SIGNOFF_NAME, "Christal");
assert.equal(AGENT_REPLY_SIGNOFF, "Mahalo,\nChristal");
assert.equal(AGENT_COMPOSE_SEED, "\n\nMahalo,\nChristal");
// The seed, once trimmed, is exactly the sign-off (the inbox uses this to detect
// a signature-only box and keep Send disabled).
assert.equal(AGENT_COMPOSE_SEED.trim(), AGENT_REPLY_SIGNOFF);
console.log("  ✓ agent identity = Christal (greeting + sign-off name + compose seed)");

assert.equal(isAgentAllowedPath(req("GET", "/api/auth/session")), true);
assert.equal(isAgentAllowedPath(req("GET", "/api/guesty-property-map")), true);
assert.equal(isAgentAllowedPath(req("GET", "/api/agent/properties/12/bookings")), true);
assert.equal(isAgentAllowedPath(req("GET", "/api/guesty-proxy/communication/conversations/abc/posts")), true);
assert.equal(isAgentAllowedPath(req("POST", "/api/guesty-proxy/communication/conversations/abc/send-message")), true);
assert.equal(isAgentAllowedPath(req("POST", "/api/inbox/sms/conversations/abc/send")), true);
assert.equal(isAgentAllowedPath(req("POST", "/api/inbox/calls/123/acknowledge")), true);
assert.equal(isAgentAllowedPath(req("GET", "/api/bookings/res123/arrival-details")), true);
assert.equal(isAgentAllowedPath(req("GET", "/alternatives/abc123")), true);
console.log("  ✓ allows inbox, call, message, and arrival-detail routes");

// Guest issues tracker — agents read/create/comment but cannot delete.
assert.equal(isAgentAllowedPath(req("GET", "/api/inbox/guest-issues")), true);
assert.equal(isAgentAllowedPath(req("GET", "/api/inbox/guest-issues/conv123")), true);
assert.equal(isAgentAllowedPath(req("POST", "/api/inbox/guest-issues")), true);
assert.equal(isAgentAllowedPath(req("POST", "/api/inbox/guest-issues/42/comments")), true);
assert.equal(isAgentAllowedPath(req("DELETE", "/api/inbox/guest-issues/42")), false);
assert.equal(isAgentAllowedPath(req("POST", "/api/inbox/guest-issues/42")), false);
console.log("  ✓ allows agents to read/create/comment on guest issues but not delete");

assert.equal(isAgentAllowedPath(req("GET", "/api/property/market-rates")), false);
assert.equal(isAgentAllowedPath(req("POST", "/api/pricing/bulk-refresh")), false);
assert.equal(isAgentAllowedPath(req("POST", "/api/community/drafts")), false);
assert.equal(isAgentAllowedPath(req("PUT", "/api/guesty-proxy/reservations/res123/confirm")), false);
assert.equal(isAgentAllowedPath(req("POST", "/api/inbox/auto-approve/run")), false);
assert.equal(isAgentAllowedPath(req("GET", "/bookings")), false);
console.log("  ✓ blocks pricing, listing creation, reservation approval, and operations routes");

console.log("auth agent suite passed");
