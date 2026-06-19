// Extract arrival details (address, codes, Wi‑Fi, parking) from VRBO guest-thread
// emails and merge them onto the matching buy_in row.

import { parseArrivalDetailsFromText, isUsableArrivalField } from "./buy-in-email";
import type { BuyIn } from "@shared/schema";

const ARRIVAL_SCALAR_FIELDS = [
  "unitAddress",
  "accessCode",
  "wifiName",
  "wifiPassword",
  "parkingInfo",
] as const;

type ArrivalScalarField = typeof ARRIVAL_SCALAR_FIELDS[number];

function cleanExistingArrivalValue(key: ArrivalScalarField | "arrivalNotes", value: string | null | undefined): string {
  const v = String(value ?? "").trim();
  if (!v) return "";
  return isUsableArrivalField(key, v) ? v : "";
}

/** Merge parsed arrival fields onto existing buy-in values (fill blanks; enrich address/notes). */
export function mergeArrivalDetailsIntoBuyIn(
  existing: Pick<BuyIn, ArrivalScalarField | "arrivalNotes">,
  parsed: Record<string, string>,
): Partial<Pick<BuyIn, ArrivalScalarField | "arrivalNotes">> {
  const updates: Partial<Pick<BuyIn, ArrivalScalarField | "arrivalNotes">> = {};

  for (const key of ARRIVAL_SCALAR_FIELDS) {
    const next = String(parsed[key] ?? "").trim();
    const cur = cleanExistingArrivalValue(key, existing[key]);
    const curRaw = String(existing[key] ?? "").trim();
    const curCorrupt = !!curRaw && !cur;

    if (!next) {
      if (curCorrupt) updates[key] = "";
      continue;
    }
    if (!cur || curCorrupt) {
      updates[key] = next;
      continue;
    }
    // Prefer a longer, more specific street address when VRBO sends a fuller one later.
    if (key === "unitAddress" && next.length > cur.length && /\d/.test(next)) {
      updates[key] = next;
    }
  }

  const newNotes = String(parsed.arrivalNotes ?? "").trim();
  const curNotes = cleanExistingArrivalValue("arrivalNotes", existing.arrivalNotes);
  const curNotesRaw = String(existing.arrivalNotes ?? "").trim();
  const notesCorrupt = !!curNotesRaw && !curNotes;

  if (newNotes) {
    if (!curNotes || notesCorrupt) {
      updates.arrivalNotes = newNotes;
    } else {
      const merged = [...curNotes.split("\n"), ...newNotes.split("\n")]
        .map((line) => line.trim())
        .filter(Boolean);
      updates.arrivalNotes = [...new Set(merged)].join("\n").slice(0, 2000);
    }
  } else if (notesCorrupt) {
    updates.arrivalNotes = "";
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
    if (next !== prev) patch[key] = next || null;
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
    unitAddress: cleanExistingArrivalValue("unitAddress", buyIn.unitAddress),
    accessCode: cleanExistingArrivalValue("accessCode", buyIn.accessCode),
    wifiName: cleanExistingArrivalValue("wifiName", buyIn.wifiName),
    wifiPassword: cleanExistingArrivalValue("wifiPassword", buyIn.wifiPassword),
    parkingInfo: cleanExistingArrivalValue("parkingInfo", buyIn.parkingInfo),
    arrivalNotes: cleanExistingArrivalValue("arrivalNotes", buyIn.arrivalNotes),
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
