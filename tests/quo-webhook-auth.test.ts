// Quo/OpenPhone webhook acceptance + outbound mirroring (2026-07-21).
//
// INCIDENT this locks against: the 2026-07-11 header-only secret change
// silently 401'd EVERY OpenPhone delivery from Jul 10 on (OpenPhone cannot
// send custom headers; the webhook URLs carried ?secret=, which the fix
// deliberately stopped reading). Guest texts, app-sent outbound mirrors, and
// missed calls all vanished for 11 days. The fix: verify OpenPhone's own
// `openphone-signature` (keys fetched from the OpenPhone API), mirror
// OUTGOING app-sent texts into the matched conversation, and backfill.
import { createHmac } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { verifyOpenPhoneSignature } from "../shared/quo-webhook-signature";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

console.log("openphone signature verification");
{
  const key = Buffer.from("test-signing-key-material").toString("base64");
  const body = JSON.stringify({ type: "message.received", data: { object: { id: "MSG1" } } });
  const ts = "1789300000000";
  const sig = createHmac("sha256", Buffer.from(key, "base64")).update(`${ts}.${body}`).digest("base64");
  const header = `hmac;1;${ts};${sig}`;

  check("valid signature verifies", verifyOpenPhoneSignature(body, header, [key]) === true);
  check("Buffer raw body verifies too", verifyOpenPhoneSignature(Buffer.from(body), header, [key]) === true);
  check("second key in the ring still verifies", verifyOpenPhoneSignature(body, header, ["b3RoZXI=", key]) === true);
  check("tampered body fails", verifyOpenPhoneSignature(body + " ", header, [key]) === false);
  check("wrong key fails", verifyOpenPhoneSignature(body, header, ["d3Jvbmc="]) === false);
  check("tampered timestamp fails", verifyOpenPhoneSignature(body, `hmac;1;${ts}1;${sig}`, [key]) === false);
  check("malformed header fails", verifyOpenPhoneSignature(body, "not-a-signature", [key]) === false);
  check("missing header fails", verifyOpenPhoneSignature(body, undefined, [key]) === false);
  check("no keys fails closed", verifyOpenPhoneSignature(body, header, []) === false);
  check("null body fails closed", verifyOpenPhoneSignature(null, header, [key]) === false);
}

console.log("source guards — webhook acceptance ladder");
{
  const routes = read("server/routes.ts");
  check(
    "both webhook endpoints go through the shared acceptance ladder",
    (routes.match(/await quoWebhookAccepted\(req, "(message|call)"\)/g) ?? []).length === 2,
  );
  check(
    "the ladder tries the OpenPhone signature FIRST (keys from the API, no new env)",
    /quoWebhookAccepted[\s\S]{0,900}getQuoWebhookSigningKeys\(\)[\s\S]{0,200}verifyOpenPhoneSignature/.test(routes),
  );
  check(
    "rejections log LOUDLY (a silent 401 hid this outage for 11 days)",
    /\[quo-webhook\] REJECTED/.test(routes),
  );
  check(
    // The Jul-11 rationale stands: secrets in URLs leak into edge logs. The
    // string may appear in comments — only CODE lines count.
    "the query-string secret stays dead",
    routes
      .split("\n")
      .filter((line) => line.includes("req.query.secret"))
      .every((line) => line.trim().startsWith("//")),
  );
  check("admin SMS backfill endpoint exists", routes.includes('app.post("/api/inbox/sms/backfill"'));

  const quoSms = read("server/quo-sms.ts");
  check(
    "outgoing webhook events conversation-match too (app-sent texts join the guest thread)",
    /const match = await findGuestyConversationByPhone\(guestPhone\)\.catch/.test(quoSms),
  );
  check(
    "webhook merge never clobbers an existing row's thread attribution",
    /getQuoSmsMessageByProviderId\(providerMessageId\)[\s\S]{0,400}match\?\.conversationId \?\? existing\?\.conversationId \?\? null/.test(quoSms),
  );
  check(
    "message backfill feeds the SAME recording path as live webhooks",
    /backfillQuoMessages[\s\S]{0,2000}recordQuoWebhook\(\{ type: "message\.backfill", data: \{ object: message \} \}\)/.test(quoSms),
  );
  check(
    "signing keys are cached with a stale-beats-none fallback",
    /signingKeysCache\?\.keys \?\? \[\]/.test(quoSms),
  );
}

if (failures > 0) {
  console.error(`\n${failures} quo-webhook-auth test(s) failed`);
  process.exit(1);
}
console.log("\nAll quo-webhook-auth tests passed");
