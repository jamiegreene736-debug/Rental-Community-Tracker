// Guesty "separate published address" engine (2026-07-17).
//
// Turns the feature ON for a listing and points it at the community's
// CLUBHOUSE address (google_maps discovery, precision-gated) or — when no
// clubhouse can be found — the GENERIC main-building address with every unit
// designator stripped. Write path is Guesty's Address controller:
//
//   GET  /v1/address/{guestyPropertyId}            → { address, publishedAddress, isPublishedAddressEnabled }
//   PUT  /v1/address/{guestyPropertyId}/update     → ALL THREE keys required
//   GET  again                                     → read-back verification
//
// LOAD-BEARING: the PUT requires the PRIVATE `address` too, so this engine
// ECHOES the address object exactly as Guesty returned it (only ensuring a
// `location` when one can be borrowed from the listing document / resolution)
// — it must never reshape or strip private-address fields, or a published-
// address push would corrupt the listing's real location. PUT /listings/{id}
// does NOT accept publishedAddress; don't "simplify" back to the listing PUT.
//
// Resolutions cache in app_settings `published_addresses.v1` keyed by the
// builder propertyId (positive core / negative -draftId) so the combo
// pipeline can pre-resolve a clubhouse before any Guesty listing exists and
// the mapping-birth hooks reuse it without a second SearchAPI spend.

import {
  addressLat,
  addressLng,
  buildGuestyPublishedAddress,
  genericPublishedPartsFromPrivateAddress,
  parsePublishedAddressStore,
  publishedAddressSatisfiesTarget,
  publishedStreetRoot,
  PUBLISHED_ADDRESS_STORE_KEY,
  serializePublishedAddressStore,
  summarizePublishedAddressPush,
  type GuestyAddressLike,
  type PublishedAddressParts,
  type PublishedAddressStore,
  type ResolvedPublishedAddress,
} from "@shared/published-address";
import { communityAddressRuleForName } from "@shared/community-addresses";
import { parseStreetCityState } from "@shared/address-listing-logic";
import { propertyIdForGuestyListing } from "@shared/builder-deep-link";
import { guestyRequest } from "./guesty-sync";
import { storage } from "./storage";
import { recordGuestyPush } from "./guesty-push-history";
import { discoverCommunityClubhouseAddress } from "./community-address-discovery";
import { getUnitBuilderByPropertyId } from "../client/src/data/unit-builder-data";

// ── Resolution cache store (promise-tail, fail-soft — mirrors guesty-push-history) ──

let storeTail: Promise<void> = Promise.resolve();
function mutateStore(mutate: (store: PublishedAddressStore, nowIso: string) => void): Promise<void> {
  storeTail = storeTail.then(async () => {
    try {
      const nowIso = new Date().toISOString();
      const raw = await storage.getSetting(PUBLISHED_ADDRESS_STORE_KEY);
      const store = parsePublishedAddressStore(raw ?? null);
      mutate(store, nowIso);
      await storage.setSetting(PUBLISHED_ADDRESS_STORE_KEY, serializePublishedAddressStore(store));
    } catch {
      // Fail-soft: the cache is an optimization, never a blocker.
    }
  });
  return storeTail;
}

async function readCachedResolution(propertyId: number): Promise<ResolvedPublishedAddress | null> {
  try {
    await storeTail;
    const raw = await storage.getSetting(PUBLISHED_ADDRESS_STORE_KEY);
    const store = parsePublishedAddressStore(raw ?? null);
    return store.properties[String(propertyId)] ?? null;
  } catch {
    return null;
  }
}

function writeCachedResolution(propertyId: number, entry: ResolvedPublishedAddress): void {
  void mutateStore((store, nowIso) => {
    store.properties[String(propertyId)] = { ...entry, updatedAt: nowIso };
  });
}

// ── Local property identity (community name + fallback address parts) ────────

type LocalIdentity = {
  communityName: string | null;
  city: string | null;
  state: string | null;
  fallbackStreet: string | null;
  fallbackZip: string | null;
};

const ZIP_RE = /\b[A-Z]{2}\s+(\d{5}(?:-\d{4})?)\b/;

function zipFromAddressText(text: string | null | undefined): string | null {
  const m = ZIP_RE.exec(String(text ?? ""));
  return m ? m[1] : null;
}

async function localIdentityForProperty(propertyId: number): Promise<LocalIdentity> {
  const empty: LocalIdentity = { communityName: null, city: null, state: null, fallbackStreet: null, fallbackZip: null };
  try {
    if (propertyId > 0) {
      const builder = getUnitBuilderByPropertyId(propertyId);
      if (!builder) return empty;
      const parsed = parseStreetCityState(builder.address ?? "");
      const street = publishedStreetRoot(builder.address ?? "");
      return {
        communityName: builder.complexName || null,
        city: parsed?.city || null,
        state: parsed?.state || null,
        fallbackStreet: street || null,
        fallbackZip: zipFromAddressText(builder.address),
      };
    }
    if (propertyId < 0) {
      const draft = await storage.getCommunityDraft(-propertyId).catch(() => undefined);
      if (!draft) return empty;
      const streetSource = draft.streetAddress || draft.unit1Address || "";
      const street = publishedStreetRoot(streetSource);
      return {
        communityName: draft.name || null,
        city: draft.city || null,
        state: draft.state || null,
        fallbackStreet: street || null,
        fallbackZip: zipFromAddressText(streetSource),
      };
    }
  } catch {
    // fall through to empty — resolution then leans on the private address
  }
  return empty;
}

// ── Resolution ladder: clubhouse → generic main-building ─────────────────────

export async function resolvePublishedAddressForProperty(
  propertyId: number | null,
  opts: { privateAddress?: GuestyAddressLike | null; forceRefresh?: boolean } = {},
): Promise<ResolvedPublishedAddress | null> {
  if (propertyId != null && !opts.forceRefresh) {
    const cached = await readCachedResolution(propertyId);
    if (cached) return cached;
  }

  const identity = propertyId != null ? await localIdentityForProperty(propertyId) : null;
  const privateParts = genericPublishedPartsFromPrivateAddress(opts.privateAddress);
  const rule = identity?.communityName ? communityAddressRuleForName(identity.communityName) : null;

  const city = rule?.city || privateParts?.city || identity?.city || undefined;
  const state = rule?.state || privateParts?.state || identity?.state || undefined;
  const zipcode = privateParts?.zipcode || identity?.fallbackZip || undefined;
  const country = privateParts?.country || undefined;
  const privLat = addressLat(opts.privateAddress);
  const privLng = addressLng(opts.privateAddress);

  let resolved: ResolvedPublishedAddress | null = null;

  // ① Clubhouse — only when we know which community this is (a bare unmapped
  // listing has no community name to search for).
  if (identity?.communityName) {
    const clubhouse = await discoverCommunityClubhouseAddress({
      communityName: identity.communityName,
      city: identity.city,
      state: identity.state,
    }).catch(() => null);
    if (clubhouse) {
      const parsedFull = parseStreetCityState(clubhouse.fullAddress);
      resolved = {
        // Belt-and-braces unit strip — a clubhouse POI address never should
        // carry one, but the published street must be structurally unit-free.
        street: publishedStreetRoot(clubhouse.street) || clubhouse.street,
        city: parsedFull?.city || city,
        state: parsedFull?.state || state,
        zipcode: zipFromAddressText(clubhouse.fullAddress) || zipcode,
        country,
        ...(clubhouse.lat != null && clubhouse.lng != null
          ? { lat: clubhouse.lat, lng: clubhouse.lng }
          : privLat != null && privLng != null
            ? { lat: privLat, lng: privLng }
            : {}),
        source: "clubhouse",
        label: clubhouse.matchedTitle || "clubhouse",
        resolvedAt: new Date().toISOString(),
      };
    }
  }

  // ② Generic main-building address, no unit number: curated rule street wins
  // (it IS the community's main-building street), else the private address
  // with unit designators stripped, else the builder/draft street.
  if (!resolved) {
    const ruleStreet = rule?.street ? publishedStreetRoot(rule.street) || null : null;
    const street = ruleStreet || privateParts?.street || identity?.fallbackStreet || null;
    if (street) {
      resolved = {
        street,
        city,
        state,
        zipcode,
        country,
        ...(privLat != null && privLng != null ? { lat: privLat, lng: privLng } : {}),
        source: "community",
        label: "main building address",
        resolvedAt: new Date().toISOString(),
      };
    }
  }

  if (resolved && propertyId != null) writeCachedResolution(propertyId, resolved);
  return resolved;
}

/** Combo-pipeline pre-resolve: run the clubhouse discovery + cache while the
 *  draft exists but no Guesty listing does. Fail-soft, no Guesty calls. */
export async function preResolvePublishedAddressForProperty(propertyId: number): Promise<void> {
  try {
    await resolvePublishedAddressForProperty(propertyId, {});
  } catch (e: any) {
    console.warn(`[published-address] pre-resolve property ${propertyId}: ${e?.message ?? e}`);
  }
}

// ── Guesty Address-controller push ───────────────────────────────────────────

export type PublishedAddressPushResult = {
  ok: boolean;
  verified: boolean;
  /** Feature was already enabled with the target address — no PUT issued. */
  alreadyOn?: boolean;
  pushed?: boolean;
  address?: PublishedAddressParts & { source: "clubhouse" | "community"; label: string };
  pushedAt?: string;
  error?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bounded GET retry: 429/5xx/network are transient (the guesty-sync global
// gate already absorbs the pause; the retry just re-queues once), other 4xx
// fail fast. PUTs are never blind-retried.
async function guestyGetWithRetry(endpoint: string, attempts = 2): Promise<any> {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      return await guestyRequest("GET", endpoint);
    } catch (e: any) {
      lastErr = e;
      const status = Number(e?.status);
      const retryable = e?.rateLimited === true || status === 429 || status >= 500 || !Number.isFinite(status);
      if (!retryable || attempt >= attempts) throw e;
      await sleep(5000);
    }
  }
  throw lastErr;
}

type AddressEntity = {
  address: GuestyAddressLike | null;
  publishedAddress: GuestyAddressLike | null;
  isPublishedAddressEnabled: boolean | null;
};

function resultAddress(
  resolved: ResolvedPublishedAddress,
): PublishedAddressParts & { source: "clubhouse" | "community"; label: string } {
  return {
    street: resolved.street,
    city: resolved.city,
    state: resolved.state,
    zipcode: resolved.zipcode,
    country: resolved.country,
    source: resolved.source,
    label: resolved.label,
  };
}

function parseAddressEntity(data: any): AddressEntity | null {
  if (!data || typeof data !== "object") return null;
  const address = data.address && typeof data.address === "object" ? (data.address as GuestyAddressLike) : null;
  if (!address) return null;
  return {
    address,
    publishedAddress:
      data.publishedAddress && typeof data.publishedAddress === "object"
        ? (data.publishedAddress as GuestyAddressLike)
        : null,
    isPublishedAddressEnabled:
      typeof data.isPublishedAddressEnabled === "boolean" ? data.isPublishedAddressEnabled : null,
  };
}

export async function pushPublishedAddressForListing(input: {
  listingId: string;
  propertyId?: number | null;
  /** Push even when Guesty already shows the feature on with the target address. */
  force?: boolean;
  /** Re-run clubhouse discovery instead of reusing the cached resolution. */
  forceRefreshResolution?: boolean;
  reason: string;
}): Promise<PublishedAddressPushResult> {
  const listingId = String(input.listingId ?? "").trim();
  if (!listingId) return { ok: false, verified: false, error: "listingId is required" };
  try {
    // Resolve Guesty's property-entity id from the listing (same recipe as
    // push-amenities: newer accounts expose propertyId/property._id, legacy
    // accounts fold listing and property into one document).
    const listing = (await guestyGetWithRetry(`/listings/${listingId}`)) as Record<string, any>;
    const guestyPropertyId: string =
      (listing?.propertyId as string | undefined) ??
      listing?.property?._id ??
      listing?._id ??
      listingId;
    const listingAddress: GuestyAddressLike | null =
      listing?.address && typeof listing.address === "object" ? (listing.address as GuestyAddressLike) : null;

    // GET the address entity — try the resolved property id first, fall back
    // to the listing id (id namespaces coincide on legacy accounts).
    const idCandidates = Array.from(new Set([guestyPropertyId, listingId].filter(Boolean)));
    let entity: AddressEntity | null = null;
    let addressEntityId: string | null = null;
    let lastGetError: any = null;
    for (const id of idCandidates) {
      try {
        const parsed = parseAddressEntity(await guestyGetWithRetry(`/address/${id}`));
        if (parsed) {
          entity = parsed;
          addressEntityId = id;
          break;
        }
      } catch (e: any) {
        lastGetError = e;
        if (Number(e?.status) !== 404) throw e;
      }
    }
    // Fall back to the listing document's own address when the Address
    // controller GET is unavailable — the PUT still needs a private address
    // to echo, and the listing doc carries the same data in the flat shape.
    if (!entity) {
      if (!listingAddress) {
        const why = lastGetError?.message ? ` (${lastGetError.message})` : "";
        return { ok: false, verified: false, error: `Could not read the listing's private address from Guesty${why}` };
      }
      entity = { address: listingAddress, publishedAddress: null, isPublishedAddressEnabled: null };
      addressEntityId = guestyPropertyId;
    }

    const privateAddress = entity.address!;
    if (!String(privateAddress.full ?? privateAddress.street ?? "").trim()) {
      return { ok: false, verified: false, error: "The Guesty listing has no private address to publish from" };
    }

    // Resolve the app-side propertyId when the caller didn't know it (e.g.
    // the push-descriptions hook only has the listing id).
    let propertyId = input.propertyId ?? null;
    if (propertyId == null) {
      try {
        const maps = await storage.getGuestyPropertyMap();
        propertyId = propertyIdForGuestyListing(listingId, maps);
      } catch {
        propertyId = null;
      }
    }

    const resolved = await resolvePublishedAddressForProperty(propertyId, {
      privateAddress,
      forceRefresh: input.forceRefreshResolution === true,
    });
    if (!resolved) {
      return {
        ok: false,
        verified: false,
        error: "No publishable address could be resolved (no clubhouse found and no numbered street on the listing or its community)",
      };
    }

    // Idempotence: feature already on with the target address → nothing to
    // push (hooks stay cheap; no ledger stamp because no push happened).
    if (
      input.force !== true &&
      entity.isPublishedAddressEnabled === true &&
      publishedAddressSatisfiesTarget(entity.publishedAddress, resolved)
    ) {
      return { ok: true, verified: true, alreadyOn: true, pushed: false, address: resultAddress(resolved) };
    }

    // Build the PUT body. The private address is ECHOED verbatim; we only
    // ensure a `location` exists (the PUT schema requires one per address),
    // borrowing from the listing document or the resolution when missing.
    const privateEcho: Record<string, unknown> = { ...(privateAddress as Record<string, unknown>) };
    const privLat = addressLat(privateAddress) ?? addressLat(listingAddress);
    const privLng = addressLng(privateAddress) ?? addressLng(listingAddress);
    if (!(privateEcho.location && Number.isFinite(Number((privateEcho.location as any)?.lat)))) {
      const lat = privLat ?? resolved.lat ?? null;
      const lng = privLng ?? resolved.lng ?? null;
      if (lat != null && lng != null) privateEcho.location = { lat, lng };
    }
    const publishedParts: PublishedAddressParts = {
      ...resolved,
      ...(resolved.lat == null && privLat != null && privLng != null ? { lat: privLat, lng: privLng } : {}),
    };
    const putBody = {
      address: privateEcho,
      publishedAddress: buildGuestyPublishedAddress(publishedParts),
      isPublishedAddressEnabled: true,
    };

    console.log(
      `[published-address] ${input.reason}: PUT /address/${addressEntityId}/update for listing ${listingId} → "${resolved.street}" (${resolved.source})`,
    );
    await guestyRequest("PUT", `/address/${addressEntityId}/update`, putBody);

    // Read-back verification: the flag must be ON and the published street
    // must echo. Never infer enablement from presence alone.
    const after = parseAddressEntity(await guestyGetWithRetry(`/address/${addressEntityId}`));
    const verified =
      !!after &&
      after.isPublishedAddressEnabled === true &&
      publishedAddressSatisfiesTarget(after.publishedAddress, resolved);
    if (!verified) {
      const message = `Published address push did not round-trip (enabled=${String(after?.isPublishedAddressEnabled)})`;
      recordGuestyPush(listingId, "published-address", "error", message);
      return { ok: false, verified: false, pushed: true, address: resultAddress(resolved), error: message };
    }
    const pushedAt = new Date().toISOString();
    recordGuestyPush(listingId, "published-address", "success", summarizePublishedAddressPush(resolved.street, resolved.source));
    return { ok: true, verified: true, pushed: true, address: resultAddress(resolved), pushedAt };
  } catch (e: any) {
    const message = `Published address push failed: ${e?.message ?? e}`;
    console.warn(`[published-address] ${input.reason}: listing ${listingId}: ${message}`);
    recordGuestyPush(listingId, "published-address", "error", message);
    return { ok: false, verified: false, error: message };
  }
}

// ── Fire-and-forget ensure hooks ─────────────────────────────────────────────
// Same posture as autoPushSavedAmenitiesForProperty: void-fired at every call
// site, never throws, and a short cooldown absorbs the builder create flow
// firing import-guesty-listing + schedule-sync back-to-back.

const ensureRecent = new Map<string, number>();
const PUBLISHED_ADDRESS_ENSURE_COOLDOWN_MS = 2 * 60 * 1000;

function ensureCooldownOk(key: string): boolean {
  const now = Date.now();
  const last = ensureRecent.get(key);
  if (last != null && now - last < PUBLISHED_ADDRESS_ENSURE_COOLDOWN_MS) return false;
  ensureRecent.set(key, now);
  return true;
}

export function ensurePublishedAddressForMapping(
  propertyId: number,
  guestyListingId: string,
  reason: string,
): void {
  const listingId = String(guestyListingId ?? "").trim();
  if (!listingId || !Number.isFinite(propertyId)) return;
  if (process.env.PUBLISHED_ADDRESS_AUTO_PUSH_DISABLED === "1") return;
  if (!ensureCooldownOk(`${propertyId}|${listingId}`)) return;
  void pushPublishedAddressForListing({ listingId, propertyId, reason })
    .then((r) => {
      if (r.ok) {
        console.log(
          `[published-address] ${reason}: property ${propertyId} → listing ${listingId} ${r.alreadyOn ? "already enabled" : "pushed"} (${r.address?.street ?? "?"})`,
        );
      } else {
        console.warn(`[published-address] ${reason}: property ${propertyId} → listing ${listingId}: ${r.error}`);
      }
    })
    .catch((e: any) => {
      console.warn(`[published-address] ${reason}: property ${propertyId}:`, e?.message ?? e);
    });
}

export function ensurePublishedAddressForListing(guestyListingId: string, reason: string): void {
  const listingId = String(guestyListingId ?? "").trim();
  if (!listingId) return;
  if (process.env.PUBLISHED_ADDRESS_AUTO_PUSH_DISABLED === "1") return;
  if (!ensureCooldownOk(`listing|${listingId}`)) return;
  void pushPublishedAddressForListing({ listingId, reason })
    .then((r) => {
      if (!r.ok) console.warn(`[published-address] ${reason}: listing ${listingId}: ${r.error}`);
    })
    .catch((e: any) => {
      console.warn(`[published-address] ${reason}: listing ${listingId}:`, e?.message ?? e);
    });
}
