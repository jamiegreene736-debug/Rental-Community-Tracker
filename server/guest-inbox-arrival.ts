// Extract arrival details (address, codes, Wi‑Fi, parking) from VRBO guest-thread
// emails and merge them onto the matching buy_in row.

import {
  expectedStateHintFromBuyIn,
  isPlausiblePropertyAddressForBuyIn,
  isUsableArrivalField,
  parseArrivalDetailsFromText,
} from "./buy-in-email";
import { BUY_IN_MARKET_LOCATIONS, resolveBuyInMarket } from "@shared/buy-in-market";
import type { BuyIn } from "@shared/schema";

const ARRIVAL_SCALAR_FIELDS = [
  "unitAddress",
  "accessCode",
  "wifiName",
  "wifiPassword",
  "parkingInfo",
] as const;

type ArrivalScalarField = typeof ARRIVAL_SCALAR_FIELDS[number];

type ArrivalBuyInContext = Pick<BuyIn, "propertyName" | "unitLabel" | "notes" | "propertyId">;

function communityStateForBuyIn(buyIn: ArrivalBuyInContext): string | null {
  const marketKey = resolveBuyInMarket(buyIn.propertyName)
    ?? resolveBuyInMarket(buyIn.unitLabel);
  const fromMarket = marketKey ? BUY_IN_MARKET_LOCATIONS[marketKey]?.state : null;
  return expectedStateHintFromBuyIn(buyIn, fromMarket);
}

function cleanExistingArrivalValue(
  key: ArrivalScalarField | "arrivalNotes",
  value: string | null | undefined,
  buyIn?: ArrivalBuyInContext | null,
  communityState?: string | null,
): string {
  const v = String(value ?? "").trim();
  if (!v) return "";
  if (key === "unitAddress") {
    return isPlausiblePropertyAddressForBuyIn(v, buyIn, communityState) ? v : "";
  }
  return isUsableArrivalField(key, v) ? v : "";
}

/** Merge parsed arrival fields onto existing buy-in values (fill blanks; enrich address/notes). */
export function mergeArrivalDetailsIntoBuyIn(
  existing: Pick<BuyIn, ArrivalScalarField | "arrivalNotes">,
  parsed: Record<string, string>,
  buyIn?: ArrivalBuyInContext | null,
  communityState?: string | null,
): Partial<Pick<BuyIn, ArrivalScalarField | "arrivalNotes">> {
  const updates: Partial<Pick<BuyIn, ArrivalScalarField | "arrivalNotes">> = {};

  for (const key of ARRIVAL_SCALAR_FIELDS) {
    const next = String(parsed[key] ?? "").trim();
    const cur = cleanExistingArrivalValue(key, existing[key], buyIn, communityState);
    const curRaw = String(existing[key] ?? "").trim();
    const curCorrupt = !!curRaw && !cur;

    if (key === "unitAddress" && next && !isPlausiblePropertyAddressForBuyIn(next, buyIn, communityState)) {
      if (curCorrupt) updates[key] = "";
      continue;
    }

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

export function parseArrivalDetailsFromGuestEmail(
  subject: string,
  body: string,
  buyIn?: ArrivalBuyInContext | null,
  communityState?: string | null,
): Record<string, string> {
  const state = communityState ?? (buyIn ? communityStateForBuyIn(buyIn) : null);
  return parseArrivalDetailsFromText(`${String(subject ?? "").trim()}\n${String(body ?? "")}`, {
    buyIn,
    communityState: state,
  });
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

  const communityState = communityStateForBuyIn(buyIn);
  const messages = await storage.getGuestInboxMessages(alias, 100);
  if (!messages.length) {
    const staleAddress = String(buyIn.unitAddress ?? "").trim();
    if (staleAddress && !isPlausiblePropertyAddressForBuyIn(staleAddress, buyIn, communityState)) {
      await storage.updateBuyIn(buyIn.id, { unitAddress: null });
      return { updated: true, buyInId: buyIn.id, fields: ["unitAddress"] };
    }
    return { updated: false, buyInId: buyIn.id, fields: [] };
  }

  let working: Pick<BuyIn, ArrivalScalarField | "arrivalNotes"> = {
    unitAddress: cleanExistingArrivalValue("unitAddress", buyIn.unitAddress, buyIn, communityState),
    accessCode: cleanExistingArrivalValue("accessCode", buyIn.accessCode, buyIn, communityState),
    wifiName: cleanExistingArrivalValue("wifiName", buyIn.wifiName, buyIn, communityState),
    wifiPassword: cleanExistingArrivalValue("wifiPassword", buyIn.wifiPassword, buyIn, communityState),
    parkingInfo: cleanExistingArrivalValue("parkingInfo", buyIn.parkingInfo, buyIn, communityState),
    arrivalNotes: cleanExistingArrivalValue("arrivalNotes", buyIn.arrivalNotes, buyIn, communityState),
  };

  for (const msg of [...messages].reverse()) {
    const parsed = parseArrivalDetailsFromGuestEmail(msg.subject, msg.body, buyIn, communityState);
    const merged = mergeArrivalDetailsIntoBuyIn(working, parsed, buyIn, communityState);
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

  const communityState = communityStateForBuyIn(buyIn);
  const parsed = parseArrivalDetailsFromGuestEmail(input.subject, input.body, buyIn, communityState);
  const patch = mergeArrivalDetailsIntoBuyIn(buyIn, parsed, buyIn, communityState);
  if (!Object.keys(patch).length) {
    return { updated: false, buyInId: buyIn.id, fields: [] };
  }

  await storage.updateBuyIn(buyIn.id, patch);
  return { updated: true, buyInId: buyIn.id, fields: Object.keys(patch) };
}
