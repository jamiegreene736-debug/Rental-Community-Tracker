import assert from "node:assert/strict";
import type { Request } from "express";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const { isAgentAllowedPath, resolveLoginRole } = await import("../server/auth");

function req(method: string, path: string): Request {
  return { method, path } as Request;
}

console.log("auth agent suite");

assert.equal(resolveLoginRole("agent", "agent", "admin-secret"), "agent");
assert.equal(resolveLoginRole("", "admin-secret", "admin-secret"), "admin");
assert.equal(resolveLoginRole("admin", "admin-secret", "admin-secret"), "admin");
assert.equal(resolveLoginRole("agent", "admin-secret", "admin-secret"), null);
console.log("  ✓ classifies admin and agent credentials");

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

assert.equal(isAgentAllowedPath(req("GET", "/api/property/market-rates")), false);
assert.equal(isAgentAllowedPath(req("POST", "/api/pricing/bulk-refresh")), false);
assert.equal(isAgentAllowedPath(req("POST", "/api/community/drafts")), false);
assert.equal(isAgentAllowedPath(req("PUT", "/api/guesty-proxy/reservations/res123/confirm")), false);
assert.equal(isAgentAllowedPath(req("POST", "/api/inbox/auto-approve/run")), false);
assert.equal(isAgentAllowedPath(req("GET", "/bookings")), false);
console.log("  ✓ blocks pricing, listing creation, reservation approval, and operations routes");

console.log("auth agent suite passed");
