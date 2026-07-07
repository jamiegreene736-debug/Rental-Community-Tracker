import assert from "node:assert";
import {
  resolveBuyInSmtpConfig,
  smtpHostFromImapHost,
  buyInEmailSendConfigured,
} from "../server/buy-in-email";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

// The reservations mailbox default (simplelogin.ts SIMPLELOGIN_MAILBOX_EMAIL,
// captured at import — unset in the test process, so this is the default).
const MAILBOX = "reservations@magicalislandvacations.com";

// Keys resolveBuyInSmtpConfig() + guestInboxImapConfig() read. Snapshot, clear
// them all, apply a scenario, run, restore — env is process-global.
const ENV_KEYS = [
  "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_PORT", "SMTP_SECURE",
  "GUEST_INBOX_IMAP_USER", "RESERVATIONS_IMAP_USER",
  "GUEST_INBOX_IMAP_PASSWORD", "RESERVATIONS_IMAP_PASSWORD", "GMAIL_APP_PASSWORD",
  "GUEST_INBOX_IMAP_HOST", "GUEST_INBOX_IMAP_PORT",
];

function withEnv(overrides: Record<string, string>, fn: () => void) {
  const snapshot: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { snapshot[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try { fn(); } finally {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k]!;
    }
  }
}

console.log("buy-in-email SMTP config resolution");

// ── smtpHostFromImapHost ──────────────────────────────────────────────────────
check("imap.gmail.com → smtp.gmail.com", smtpHostFromImapHost("imap.gmail.com") === "smtp.gmail.com");
check("IMAP.GMAIL.COM (case) → smtp.gmail.com", smtpHostFromImapHost("IMAP.GMAIL.COM") === "smtp.gmail.com");
check("imap-mail.outlook.com → smtp-mail.outlook.com", smtpHostFromImapHost("imap-mail.outlook.com") === "smtp-mail.outlook.com");
check("imap.fastmail.com → smtp.fastmail.com", smtpHostFromImapHost("imap.fastmail.com") === "smtp.fastmail.com");
check("non-imap host → null", smtpHostFromImapHost("outlook.office365.com") === null);
check("empty → null", smtpHostFromImapHost("") === null && smtpHostFromImapHost("   ") === null);

// ── dedicated SMTP_* env wins, verbatim (unchanged legacy behavior) ───────────
withEnv({ SMTP_HOST: "smtp.example.com", SMTP_USER: "bot@example.com", SMTP_PASS: "secret" }, () => {
  const c = resolveBuyInSmtpConfig();
  check("full SMTP_* → smtp-env source", c?.source === "smtp-env");
  check("full SMTP_* → verbatim host/user/pass", c?.host === "smtp.example.com" && c?.user === "bot@example.com" && c?.pass === "secret");
  check("full SMTP_* → default port 587, secure false", c?.port === 587 && c?.secure === false);
});
withEnv({ SMTP_HOST: "smtp.example.com", SMTP_USER: "bot@example.com", SMTP_PASS: "secret", SMTP_PORT: "465" }, () => {
  const c = resolveBuyInSmtpConfig();
  check("SMTP_PORT 465 → secure true", c?.port === 465 && c?.secure === true);
});

// ── the actual bug: no SMTP_*, but the mailbox IMAP password is present ───────
withEnv({ RESERVATIONS_IMAP_PASSWORD: "app pass word" }, () => {
  const c = resolveBuyInSmtpConfig();
  check("no SMTP_* + IMAP pass → reservations-mailbox source", c?.source === "reservations-mailbox");
  check("mailbox fallback → derives smtp.gmail.com from default imap host", c?.host === "smtp.gmail.com");
  check("mailbox fallback → user = mailbox default", c?.user === MAILBOX);
  check("mailbox fallback → pass whitespace-stripped (matches IMAP config)", c?.pass === "apppassword");
  check("mailbox fallback → port 587 secure false", c?.port === 587 && c?.secure === false);
  check("buyInEmailSendConfigured() true when mailbox pass present", buyInEmailSendConfigured() === true);
});
withEnv({ GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" }, () => {
  const c = resolveBuyInSmtpConfig();
  check("GMAIL_APP_PASSWORD alone → configured via mailbox", c?.source === "reservations-mailbox" && c?.host === "smtp.gmail.com" && c?.user === MAILBOX);
});

// ── partial SMTP_* fills the rest from the mailbox ────────────────────────────
withEnv({ SMTP_USER: "sendas@example.com", RESERVATIONS_IMAP_PASSWORD: "pw" }, () => {
  const c = resolveBuyInSmtpConfig();
  check("SMTP_USER + mailbox pass → user from env, pass from mailbox", c?.user === "sendas@example.com" && c?.pass === "pw" && c?.source === "reservations-mailbox");
});
withEnv({ SMTP_HOST: "smtp.custom.com", GMAIL_APP_PASSWORD: "pw" }, () => {
  const c = resolveBuyInSmtpConfig();
  check("SMTP_HOST + mailbox pass → explicit host honored", c?.host === "smtp.custom.com");
});
withEnv({ SMTP_SECURE: "true", RESERVATIONS_IMAP_PASSWORD: "pw" }, () => {
  const c = resolveBuyInSmtpConfig();
  check("SMTP_SECURE=true on mailbox fallback → port 465 secure true", c?.port === 465 && c?.secure === true);
});

// ── genuinely unconfigured → null (honest) ────────────────────────────────────
withEnv({}, () => {
  check("no creds anywhere → null", resolveBuyInSmtpConfig() === null);
  check("buyInEmailSendConfigured() false when nothing set", buyInEmailSendConfigured() === false);
});
withEnv({ GUEST_INBOX_IMAP_HOST: "outlook.office365.com", RESERVATIONS_IMAP_PASSWORD: "pw" }, () => {
  // Password present, but the non-imap host can't be mapped and no SMTP_HOST → null.
  check("unmappable IMAP host w/o SMTP_HOST → null", resolveBuyInSmtpConfig() === null);
});
withEnv({ GUEST_INBOX_IMAP_HOST: "outlook.office365.com", SMTP_HOST: "smtp.office365.com", RESERVATIONS_IMAP_PASSWORD: "pw" }, () => {
  const c = resolveBuyInSmtpConfig();
  check("unmappable IMAP host + explicit SMTP_HOST → configured", c?.host === "smtp.office365.com" && c?.source === "reservations-mailbox");
});

console.log(`\nbuy-in-email SMTP: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
