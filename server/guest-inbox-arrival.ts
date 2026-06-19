// Extract arrival details (address, codes, Wi‑Fi, parking) from VRBO guest-thread
// emails and merge them onto the matching buy_in row.

import { parseArrivalDetailsFromText } from "./buy-in-email";
import type { BuyIn } from "@shared/schema";

const ARRIVAL_SCALAR_FIELDS = [
  "unitAddress",
  "accessCode",
  "wifiName",
  "wifiPassword",
  "parkingInfo",
] as const;

type ArrivalScalarField = typeof ARRIVAL_SCALAR_FIELDS[number];

/** Merge parsed arrival fields onto existing buy-in values (fill blanks; enrich address/notes). */
export function mergeArrivalDetailsIntoBuyIn(
  existing: Pick<BuyIn, ArrivalScalarField | "arrivalNotes">,
  parsed: Record<string, string>,
): Partial<Pick<BuyIn, ArrivalScalarField | "arrivalNotes">> {
  const updates: Partial<Pick<BuyIn, ArrivalScalarField | "arrivalNotes">> = {};

  for (const key of ARRIVAL_SCALAR_FIELDS) {
    const next = String(parsed[key] ?? "").trim();
    if (!next) continue;
    const cur = String(existing[key] ?? "").trim();
    if (!cur) {
      updates[key] = next;
      continue;
    }
    // Prefer a longer, more specific street address when VRBO sends a fuller one later.
    if (key === "unitAddress" && next.length > cur.length && /\d/.test(next)) {
      updates[key] = next;
    }
  }

  const newNotes = String(parsed.arrivalNotes ?? "").trim();
  if (newNotes) {
    const cur = String(existing.arrivalNotes ?? "").trim();
    if (!cur) {
      updates.arrivalNotes = newNotes;
    } else {
      const merged = [...cur.split("\n"), ...newNotes.split("\n")]
        .map((line) => line.trim())
        .filter(Boolean);
      updates.arrivalNotes = [...new Set(merged)].join("\n").slice(0, 2000);
    }
  }

  return updates;
}

export function parseArrivalDetailsFromGuestEmail(subject: string, body: string): Record<string, string> {
  return parseArrivalDetailsFromText(`${String(subject ?? "").trim()}\n${String(body ?? "")}`);
}

function buyInArrivalPatch(
  before: BuyIn,
  after: Pick<BuyIn, ArrivalScalarField | "arrivalNotes">,
): Partial<Pick<BuyIn, ArrivalScalarField | "arrivalNotes">> {
  const patch: Partial<Pick<BuyIn, ArrivalScalarField | "arrivalNotes">> = {};
  for (const key of [...ARRIVAL_SCALAR_FIELDS, "arrivalNotes"] as const) {
    const next = String(after[key] ?? "").trim();
    const prev = String(before[key] ?? "").trim();
    if (next && next !== prev) patch[key] = next;
  }
  return patch;
}

/** Scan guest-inbox messages for an alias and merge arrival details onto the buy-in. */
export async function applyArrivalDetailsFromGuestInbox(aliasEmail: string): Promise<{
  updated: boolean;
  buyInId: number | null;
  fields: string[];
}> {
  const alias = String(aliasEmail ?? "").trim().toLowerCase();
  if (!alias) return { updated: false, buyInId: null, fields: [] };

  const { storage } = await import("./storage");
  const buyIn = await storage.getBuyInByTravelerEmail(alias);
  if (!buyIn) return { updated: false, buyInId: null, fields: [] };

  const messages = await storage.getGuestInboxMessages(alias, 100);
  if (!messages.length) return { updated: false, buyInId: buyIn.id, fields: [] };

  let working: Pick<BuyIn, ArrivalScalarField | "arrivalNotes"> = {
    unitAddress: buyIn.unitAddress,
    accessCode: buyIn.accessCode,
    wifiName: buyIn.wifiName,
    wifiPassword: buyIn.wifiPassword,
    parkingInfo: buyIn.parkingInfo,
    arrivalNotes: buyIn.arrivalNotes,
  };

  for (const msg of [...messages].reverse()) {
    const parsed = parseArrivalDetailsFromGuestEmail(msg.subject, msg.body);
    const merged = mergeArrivalDetailsIntoBuyIn(working, parsed);
    working = { ...working, ...merged };
  }

  const patch = buyInArrivalPatch(buyIn, working);
  if (!Object.keys(patch).length) {
    return { updated: false, buyInId: buyIn.id, fields: [] };
  }

  await storage.updateBuyIn(buyIn.id, patch);
  return { updated: true, buyInId: buyIn.id, fields: Object.keys(patch) };
}

/** Apply arrival extraction for a single newly stored guest-inbox message. */
export async function applyArrivalDetailsFromGuestMessage(input: {
  aliasEmail: string;
  subject: string;
  body: string;
}): Promise<{ updated: boolean; buyInId: number | null; fields: string[] }> {
  const alias = String(input.aliasEmail ?? "").trim().toLowerCase();
  if (!alias) return { updated: false, buyInId: null, fields: [] };

  const { storage } = await import("./storage");
  const buyIn = await storage.getBuyInByTravelerEmail(alias);
  if (!buyIn) return { updated: false, buyInId: null, fields: [] };

  const parsed = parseArrivalDetailsFromGuestEmail(input.subject, input.body);
  const patch = mergeArrivalDetailsIntoBuyIn(buyIn, parsed);
  if (!Object.keys(patch).length) {
    return { updated: false, buyInId: buyIn.id, fields: [] };
  }

  await storage.updateBuyIn(buyIn.id, patch);
  return { updated: true, buyInId: buyIn.id, fields: Object.keys(patch) };
}
