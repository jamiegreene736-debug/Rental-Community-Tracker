const GUESTY_API_BASE = "/api/guesty-proxy";

export type GuestyAddress = {
  full: string;
  lat?: number;
  lng?: number;
  city?: string;
  state?: string;
  zipcode?: string;
  country?: string;
};

export type GuestyPhoto = {
  url: string;
  caption?: string;
  source?: string;
};

export type GuestyDescriptions = {
  title?: string;
  summary?: string;
  space?: string;
  neighborhood?: string;
  transit?: string;
  access?: string;
  notes?: string;
  houseRules?: string;
};

export type GuestyPricing = {
  basePrice: number;
  weekendBasePrice?: number;
  cleaningFee?: number;
  securityDeposit?: number;
  extraPersonFee?: number;
  guestsIncluded?: number;
  currency?: string;
  weeklyDiscount?: number;
  monthlyDiscount?: number;
  channelCleaningFees?: Record<string, { amount: number; type: string; calculation: string }>;
};

export type GuestyBookingSettings = {
  minNights?: number;
  maxNights?: number;
  // Legacy single-policy field. Kept for callers that haven't migrated
  // to per-channel policies. When `cancellationPolicies` is also set,
  // the per-channel values win.
  cancellationPolicy?: string;
  // Per-channel cancellation policies. Each channel has its own enum
  // of accepted values — see GuestyListingBuilder's dropdowns for the
  // options. Pushed via `integrations.{airbnb2|homeaway2|bookingCom}`
  // alongside the top-level `terms.cancellationPolicy` fallback.
  cancellationPolicies?: {
    airbnb?: string;
    vrbo?: string;
    booking?: string;
  };
  instantBooking?: boolean;
  advanceNotice?: number;    // days before check-in that booking must be made (0 = same day)
  preparationTime?: number;  // buffer/cleaning days blocked after checkout
};

export type GuestyRoom = {
  roomNumber: number;
  name?: string;   // e.g. "Master Bedroom", "Bedroom 2", "Living Room"
  beds: { type: string; quantity: number }[];
};

export type GuestyPropertyData = {
  nickname: string;
  title?: string;
  address: GuestyAddress;
  accommodates: number;
  propertyType?: string;
  roomType?: string;
  otaRoomType?: string;
  amenities?: string[];
  checkInTime?: string;
  checkOutTime?: string;
  timezone?: string;
  minimumAge?: number;
  areaSquareFeet?: number;
  taxMapKey?: string;
  tatLicense?: string;
  getLicense?: string;
  strPermit?: string;
  bedrooms?: number;
  bathrooms?: number;
  listingRooms?: GuestyRoom[];
  descriptions?: GuestyDescriptions;
  photos?: GuestyPhoto[];
  pricing?: GuestyPricing;
  bookingSettings?: GuestyBookingSettings;
};

export type ChannelInfo = {
  connected: boolean;
  live: boolean;
  id: string | null;
  status: string | null;
  // Public listing URL on the channel's own site, when derivable. Airbnb
  // has a canonical pattern we construct from the ID; VRBO and
  // Booking.com require Guesty to have stamped a URL field on the
  // integration record (best-effort, null when not present). Used to
  // make the Channel Status cards click through to the live listing.
  publicUrl: string | null;
  // Airbnb only: regulatory/compliance state pulled from
  // integrations[].airbnb2.permits.regulations[0]. null = no regulations
  // record (jurisdiction isn't regulated in Airbnb's eyes, or the field
  // hasn't been touched yet).
  compliance?: {
    status: "success" | "pending" | "failed" | "unknown";
    jurisdiction: string | null;        // e.g. "kauai_county_hawaii"
    regulationType: string | null;      // e.g. "registration"
    lastUpdatedOn: string | null;
  } | null;
  // VRBO only: compliance fields detected from any of the paths Guesty
  // actually persists them on a real listing payload — see getChannelStatus
  // for the full lookup. null = none detected; otherwise each field is
  // independently nullable. Used by the VRBO compliance card sub-block to
  // show a persistent "compliance on file" state across page reloads.
  vrboLicense?: {
    licenseNumber: string | null;       // TAT (Transient Accommodations Tax)
    taxId: string | null;               // GET (General Excise Tax)
    parcelNumber: string | null;        // TMK (Tax Map Key)
  } | null;
};

export type GuestyChannelStatus = {
  isListed: boolean;
  airbnb: ChannelInfo;
  vrbo: ChannelInfo;
  bookingCom: ChannelInfo;
};

export type BuildStepEntry = {
  step: string;
  status: "pending" | "success" | "error";
  id?: string;
  error?: string;
  timestamp: string;
};

export type BuildResult = {
  listingId: string | null;
  steps: BuildStepEntry[];
  errors: BuildStepEntry[];
  success: boolean;
};

class GuestyService {
  // All Guesty API calls are proxied through /api/guesty-proxy — the server
  // handles OAuth token management, caching, and rate-limit recovery.
  async request<T = unknown>(method: string, endpoint: string, body: unknown = null, queryParams = ""): Promise<T> {
    const url = `${GUESTY_API_BASE}${endpoint}${queryParams ? `?${queryParams}` : ""}`;

    const options: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };

    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);

    if (!res.ok) {
      if (res.status === 429) throw new Error("RATE_LIMITED");
      const err = await res.json().catch(() => ({})) as { message?: string; error?: string | { message?: string; code?: string } };
      const msg =
        err.message ||
        (typeof err.error === "object" ? err.error?.message : err.error) ||
        `Guesty API ${res.status}: ${endpoint}`;
      throw new Error(msg);
    }

    if (res.status === 204) return { success: true } as T;
    return res.json() as Promise<T>;
  }

  async checkConnection(): Promise<{ connected: boolean; accountId?: string | null; error?: string }> {
    try {
      const data = await this.request<{ results?: Array<{ accountId?: string }> }>(
        "GET", "/listings", null, "limit=1&fields=_id,accountId"
      );
      return {
        connected: true,
        accountId: data?.results?.[0]?.accountId || null,
      };
    } catch (e) {
      const msg = (e as Error).message;
      return { connected: false, error: msg };
    }
  }

  async getListings(limit = 25, skip = 0) {
    return this.request<{ results: Array<{ _id: string; nickname?: string; title?: string }> }>(
      "GET", "/listings", null, `limit=${limit}&skip=${skip}`
    );
  }

  async getListing(id: string) {
    return this.request<Record<string, unknown>>("GET", `/listings/${id}`);
  }

  async createListing(data: GuestyPropertyData) {
    const payload: Record<string, unknown> = {
      nickname: (data.nickname || "").slice(0, 40).trimEnd(),
      title: data.title,
      address: data.address,
      accommodates: data.accommodates,
      roomType: data.roomType || "Entire home/apt",
      propertyType: data.propertyType || "House",
      otaRoomType: data.otaRoomType || "Holiday home",
      amenities: data.amenities || [],
      defaultCheckInTime: data.checkInTime || "15:00",
      defaultCheckoutTime: data.checkOutTime || "11:00",
      timezone: data.timezone || "Pacific/Honolulu",
      minimumAge: data.minimumAge || 18,
      type: "SINGLE",
      isListed: false,
    };
    if (data.areaSquareFeet) payload.areaSquareFeet = data.areaSquareFeet;
    if (data.bedrooms) payload.bedrooms = data.bedrooms;
    if (data.bathrooms) payload.bathrooms = data.bathrooms;
    if (data.listingRooms && data.listingRooms.length > 0) payload.listingRooms = data.listingRooms;
    return this.request<{ _id: string }>("POST", "/listings", payload);
  }

  async updateListingDetails(id: string, details: { areaSquareFeet?: number; bedrooms?: number; bathrooms?: number; listingRooms?: GuestyRoom[] }) {
    const payload: Record<string, unknown> = {};
    if (details.areaSquareFeet) payload.areaSquareFeet = details.areaSquareFeet;
    if (details.bedrooms) payload.bedrooms = details.bedrooms;
    if (details.bathrooms) payload.bathrooms = details.bathrooms;
    if (details.listingRooms && details.listingRooms.length > 0) payload.listingRooms = details.listingRooms;
    return this.request("PUT", `/listings/${id}`, payload);
  }

  async updateAddress(id: string, address: GuestyAddress) {
    return this.request("PUT", `/listings/${id}`, { address });
  }

  async updateNickname(id: string, nickname: string) {
    return this.request("PUT", `/listings/${id}`, {
      nickname: nickname.slice(0, 40).trimEnd(),
    });
  }

  async updateSpaceDescription(id: string, space: string) {
    return this.request("PUT", `/listings/${id}`, { publicDescription: { space } });
  }

  // Routes through our server which resolves the listing's propertyId and then
  // hits PUT /properties-api/amenities/{propertyId} — the only endpoint that
  // drives Guesty's Popular Amenities panel. `amenities` must be the canonical
  // Guesty `name` strings (see /api/builder/guesty-supported-amenities).
  async updateAmenities(listingId: string, amenities: string[]) {
    const res = await fetch("/api/builder/push-amenities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listingId, amenities }),
    });
    const data = await res.json();
    if (!res.ok || !data?.success) throw new Error(data?.error ?? `push-amenities HTTP ${res.status}`);
    return data;
  }

  async updateDescriptions(id: string, descriptions: GuestyDescriptions) {
    return this.request("PUT", `/listings/${id}`, {
      title: descriptions.title,
      publicDescription: {
        summary: descriptions.summary,
        space: descriptions.space,
        access: descriptions.access,
        neighborhood: descriptions.neighborhood,
        transit: descriptions.transit,
        notes: descriptions.notes,
        houseRules: descriptions.houseRules,
      },
    });
  }

  async uploadPhotos(id: string, photos: GuestyPhoto[]) {
    // Guesty v1 API: add pictures one at a time via POST /listings/{id}/pictures
    // Note: photos must have publicly accessible URLs (not local /photos/... paths)
    for (const p of photos) {
      await this.request("POST", `/listings/${id}/pictures`, { url: p.url, caption: p.caption || "" });
    }
    return { success: true, count: photos.length };
  }

  async updateFinancials(id: string, pricing: GuestyPricing) {
    return this.request("PUT", `/financials/listing/${id}`, {
      basePrice: pricing.basePrice,
      currency: pricing.currency || "USD",
    });
  }

  async updateBookingSettings(id: string, settings: GuestyBookingSettings) {
    // Top-level `terms.cancellationPolicy` is the fallback applied when a
    // channel-specific policy isn't set. We default it to the Airbnb
    // value (most listings publish on Airbnb) so the listing has a sane
    // universal policy even if the operator only cared about one channel.
    const perChannel = settings.cancellationPolicies;
    const universalPolicy =
      settings.cancellationPolicy ??
      perChannel?.airbnb ??
      perChannel?.vrbo ??
      perChannel?.booking ??
      "firm";

    const terms: Record<string, unknown> = {
      minNights:          settings.minNights  ?? 3,
      maxNights:          settings.maxNights  ?? 365,
      cancellationPolicy: universalPolicy,
      instantBooking:     settings.instantBooking ?? true,
    };
    // Guesty stores advanceNotice in hours (0 = same day, 24 = 1 day, 48 = 2 days…)
    if (settings.advanceNotice !== undefined) {
      terms.advanceNotice = settings.advanceNotice * 24;
    }
    // preparationTime is in days (0 = no gap, 1 = 1 day cleaning buffer, etc.)
    if (settings.preparationTime !== undefined) {
      terms.preparationTime = settings.preparationTime;
    }

    const body: Record<string, unknown> = { terms };

    // NOTE: per-channel cancellation policies are visible + editable in
    // the UI (Pricing tab → Booking Rules card), but only the
    // `universalPolicy` above is synced to Guesty via `terms.cancellationPolicy`.
    //
    // An earlier version of this function also sent
    // `body.integrations = { airbnb2: {...}, homeaway2: {...},
    // bookingCom: {...} }` — Guesty rejected that with a 500 because
    // their write shape for `integrations` is an ARRAY of
    // `{platform, <platform-key>:{...}}` entries, not an object keyed
    // by platform. Sending the wrong shape 500'd every Booking-Rules
    // push. Until we confirm Guesty's actual accepted write shape
    // (docs are opaque on this), we push only the top-level policy and
    // rely on the operator to set channel-specific overrides in
    // Guesty's UI. The per-channel dropdowns in our builder serve as
    // the operator's own record of what they intend — not a sync
    // mechanism. See PR #43 for the fix and PR #35 for the original
    // per-channel UI.

    return this.request("PUT", `/listings/${id}`, body);
  }

  async blockCalendarDates(listingId: string, startDate: string, endDate: string) {
    return this.request("POST", `/blocks`, {
      listingId,
      startDate,
      endDate,
      reasonType: "owner_block",
      note: "Auto-blocked: low buy-in availability",
    });
  }

  async listOnChannels(id: string) {
    return this.request("PUT", `/listings/${id}`, { isListed: true });
  }

  async unlistFromChannels(id: string) {
    return this.request("PUT", `/listings/${id}`, { isListed: false });
  }

  async getChannelStatus(id: string): Promise<GuestyChannelStatus> {
    const listing = await this.getListing(id) as Record<string, unknown>;
    const isListed = !!(listing.isListed);

    // Guesty stores channel connections in listing.integrations[] with platform keys
    // like "airbnb2", "homeaway", "bookingCom". Fall back to legacy top-level fields.
    const integrations: Record<string, unknown>[] = Array.isArray(listing.integrations)
      ? listing.integrations as Record<string, unknown>[]
      : [];

    const findIntegration = (platformKeys: string[]) => {
      const entry = integrations.find(i => platformKeys.includes(i.platform as string));
      if (!entry) return undefined;
      const key = entry.platform as string;
      return entry[key] as Record<string, string> | undefined;
    };

    // Guesty has versioned its integration platform keys over the years —
    // the current keys are "airbnb2" / "homeaway2" (with "bookingCom" still
    // being the booking platform as of 2026-04). List both the current and
    // legacy keys so we don't miss older accounts that still hold the old
    // platform name.
    const airbnbData = findIntegration(["airbnb2", "airbnb"])
      ?? (listing.airBnb || (listing.channels as Record<string, unknown>)?.airbnb) as Record<string, string> | undefined;
    const vrboData = findIntegration(["homeaway2", "homeaway", "vrbo"])
      ?? (listing.homeAway || (listing.channels as Record<string, unknown>)?.homeAway) as Record<string, string> | undefined;
    const bookingComData = findIntegration(["bookingCom2", "bookingCom", "booking_com"])
      ?? (listing.bookingCom || (listing.channels as Record<string, unknown>)?.bookingCom) as Record<string, string> | undefined;

    // Look for the public listing URL across the various field names
    // Guesty has used for it over different API versions — `listingUrl`
    // is the current canonical, but older records may have `url`,
    // `propertyUrl`, or `publicUrl`. Returns the first non-empty match.
    const pickChannelUrl = (d: Record<string, unknown> | undefined): string | null => {
      if (!d) return null;
      for (const k of ["listingUrl", "url", "publicUrl", "propertyUrl"]) {
        const v = d[k];
        if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
      }
      return null;
    };

    const toInfo = (data: Record<string, unknown> | undefined): ChannelInfo => {
      const d = data as Record<string, string> | undefined;
      // Channel ID fields vary by platform: Airbnb uses `id`, Booking.com
      // typically `hotelId`, and VRBO (homeaway2) uses `advertiserId` — no
      // single convention. Look across all of them so connection detection
      // doesn't hinge on a specific vendor's naming.
      const hasId = !!(d?.id || d?.listingId || d?.propertyId || d?.hotelId || d?.advertiserId);
      const isCompleted = d?.status === "COMPLETED" || d?.status === "connected";
      return {
        connected: hasId || isCompleted,
        live: (hasId || isCompleted) && isListed,
        id: d?.id || d?.listingId || d?.propertyId || d?.hotelId || d?.advertiserId || null,
        status: d?.status || null,
        publicUrl: pickChannelUrl(data),
      };
    };

    // Airbnb compliance — lifted from airbnb2.permits.regulations[0].
    // Null if the permits object or regulations array is missing. That
    // can mean the jurisdiction isn't regulated by Airbnb OR the form
    // has never been submitted. The caller can disambiguate based on
    // the listing's address (we don't guess here).
    const airbnbCompliance = (() => {
      const permits = (airbnbData as Record<string, unknown> | undefined)?.permits as Record<string, unknown> | undefined;
      const regs = permits?.regulations as Array<Record<string, unknown>> | undefined;
      const lastUpdated = (permits?.lastUpdatedOn as string | undefined) ?? null;
      if (!regs || regs.length === 0) return null;
      const first = regs[0];
      const status = (first.status as string) || "unknown";
      return {
        status: (["success", "pending", "failed"].includes(status) ? status : "unknown") as "success" | "pending" | "failed" | "unknown",
        jurisdiction: (first.regulatoryBody as string) ?? null,
        regulationType: (first.regulationType as string) ?? null,
        lastUpdatedOn: lastUpdated,
      };
    })();

    const airbnbInfo = toInfo(airbnbData);
    airbnbInfo.compliance = airbnbCompliance;

    // Airbnb URLs are deterministic from the listing ID —
    // https://www.airbnb.com/rooms/{id} has been the canonical shape
    // for years. Only fill this in when the integration didn't already
    // stamp a listingUrl, so a channel-manager-provided URL always wins.
    if (!airbnbInfo.publicUrl && airbnbInfo.id) {
      airbnbInfo.publicUrl = `https://www.airbnb.com/rooms/${airbnbInfo.id}`;
    }

    // VRBO compliance fields. Detect from the four places Guesty stores
    // them, in priority order — whichever has the most complete picture
    // wins. The Kaha Lani case (2026-04-28): operator manually filled the
    // "Vrbo license requirements" panel in Guesty admin which writes to
    // the listing's TOP-LEVEL `licenseNumber` / `taxId` fields, but this
    // readback was missing that path entirely — so the comparison
    // surfaced as "Compliance on file but incomplete" with GET (taxId)
    // appearing absent even though Guesty's UI showed it filled in.
    //
    //   1. `listing.tags`  — TMK:/TAT:/GET: prefixed entries written by
    //      /api/builder/push-compliance Step 1. Carries all three values
    //      (TAT, GET, TMK).
    //   2. `listing.licenseNumber` (TAT) and `listing.taxId` (GET) at
    //      the top level. Written by push-compliance Step 2 AND by
    //      Guesty's "Vrbo license requirements" admin panel when the
    //      operator edits manually — the canonical Guesty path for
    //      these fields. TMK doesn't have a top-level slot.
    //   3. `integrations[platform=bookingCom].bookingCom.license.information.contentData`
    //      — Booking.com Hawaii variant 6 (`hawaii-hotel_v1`) license
    //      object written by push-compliance Step 3b. Carries TAT
    //      (`number`) and TMK (`tmk_number`) but NOT GET. Guesty's UI
    //      "Vrbo license requirements" panel surfaces these too because
    //      the variant is shared between VRBO and Booking.com.
    //   4. `listing.channels.homeaway.{licenseNumber, taxId, parcelNumber}`
    //      — the original path. Real Guesty payloads rarely populate
    //      this; kept as a last-resort fallback.
    const vrboInfo = toInfo(vrboData);
    const vrboLicense = (() => {
      // From tags (most complete — has TAT/GET/TMK)
      const tagsArr: string[] = Array.isArray(listing.tags) ? listing.tags as string[] : [];
      const tagValue = (prefix: string): string | null => {
        const m = tagsArr.find((t) => typeof t === "string" && t.startsWith(prefix));
        return m ? m.slice(prefix.length).trim() || null : null;
      };
      const fromTagsTat = tagValue("TAT:");
      const fromTagsGet = tagValue("GET:");
      const fromTagsTmk = tagValue("TMK:");

      // From listing top-level (the Guesty-canonical path the admin UI
      // writes to). `licenseNumber` is the Registration/License Number
      // field (TAT for Hawaii); `taxId` is the General Excise/Tax ID
      // field (GET for Hawaii).
      const fromTopLevelTat = typeof listing.licenseNumber === "string" && listing.licenseNumber.trim() ? listing.licenseNumber.trim() : null;
      const fromTopLevelGet = typeof listing.taxId === "string" && listing.taxId.trim() ? listing.taxId.trim() : null;

      // From Booking.com Hawaii variant contentData (TAT + TMK only)
      const bookingInteg = integrations.find((i) => i.platform === "bookingCom" || i.platform === "bookingCom2") as Record<string, unknown> | undefined;
      const bookingLicenseInfo = ((bookingInteg?.bookingCom as Record<string, unknown> | undefined)?.license as Record<string, unknown> | undefined)?.information as Record<string, unknown> | undefined;
      const contentData = bookingLicenseInfo?.contentData as Array<{ name?: string; value?: string }> | undefined;
      const contentValue = (name: string): string | null => {
        if (!Array.isArray(contentData)) return null;
        const m = contentData.find((c) => c?.name === name);
        return (m?.value && typeof m.value === "string") ? m.value : null;
      };
      const fromBookingTat = contentValue("number");
      const fromBookingTmk = contentValue("tmk_number");

      // Legacy/future-proof: channels.homeaway path
      const homeaway = ((listing.channels as Record<string, unknown> | undefined)?.homeaway || {}) as Record<string, string | undefined>;

      const licenseNumber = fromTagsTat || fromTopLevelTat || fromBookingTat || homeaway.licenseNumber || null;
      const taxId         = fromTagsGet || fromTopLevelGet || homeaway.taxId || null;
      const parcelNumber  = fromTagsTmk || fromBookingTmk || homeaway.parcelNumber || null;
      if (!licenseNumber && !taxId && !parcelNumber) return null;
      return { licenseNumber, taxId, parcelNumber };
    })();
    vrboInfo.vrboLicense = vrboLicense;

    return {
      isListed,
      airbnb: airbnbInfo,
      vrbo: vrboInfo,
      bookingCom: toInfo(bookingComData),
    };
  }

  async buildFullListing(
    propertyData: GuestyPropertyData,
    onProgress: (step: string, status: string, detail?: Record<string, unknown>) => void = () => {}
  ): Promise<BuildResult> {
    const steps: BuildStepEntry[] = [];
    const errors: BuildStepEntry[] = [];
    let listingId: string | null = null;

    const log = (step: string, status: "pending" | "success" | "error", detail: Record<string, unknown> = {}) => {
      const entry: BuildStepEntry = { step, status, ...detail as Partial<BuildStepEntry>, timestamp: new Date().toISOString() };
      if (status === "error") errors.push(entry);
      else steps.push(entry);
      onProgress(step, status, detail);
    };

    try {
      log("create_listing", "pending");
      const listing = await this.createListing(propertyData);
      listingId = listing._id;
      log("create_listing", "success", { id: listingId ?? undefined });
    } catch (e) {
      log("create_listing", "error", { error: (e as Error).message });
      return { listingId: null, steps, errors, success: false };
    }

    if (propertyData.listingRooms && propertyData.listingRooms.length > 0) {
      try {
        log("rooms_beds", "pending");
        await this.updateListingDetails(listingId!, {
          areaSquareFeet: propertyData.areaSquareFeet,
          bedrooms: propertyData.bedrooms,
          bathrooms: propertyData.bathrooms,
          listingRooms: propertyData.listingRooms,
        });
        log("rooms_beds", "success", { rooms: propertyData.listingRooms.length });
      } catch (e) {
        log("rooms_beds", "error", { error: (e as Error).message });
      }
    }

    if (propertyData.descriptions) {
      try {
        log("descriptions", "pending");
        await this.updateDescriptions(listingId!, propertyData.descriptions);
        log("descriptions", "success");
      } catch (e) {
        log("descriptions", "error", { error: (e as Error).message });
      }
    }

    // Photos are NOT pushed during auto-build — use the Photos tab's dedicated
    // "Push Photos to Guesty" button which hosts each file on ImgBB first to
    // get a public URL that Guesty can fetch.

    if (propertyData.pricing) {
      try {
        log("financials", "pending");
        await this.updateFinancials(listingId!, propertyData.pricing);
        log("financials", "success");
      } catch (e) {
        log("financials", "error", { error: (e as Error).message });
      }
    }

    if (propertyData.bookingSettings) {
      try {
        log("booking_settings", "pending");
        await this.updateBookingSettings(listingId!, propertyData.bookingSettings);
        log("booking_settings", "success");
      } catch (e) {
        log("booking_settings", "error", { error: (e as Error).message });
      }
    }

    return {
      listingId,
      steps,
      errors,
      success: errors.length === 0,
    };
  }

  async updateFullListing(
    listingId: string,
    propertyData: GuestyPropertyData,
    onProgress: (step: string, status: string, detail?: Record<string, unknown>) => void = () => {}
  ): Promise<BuildResult> {
    const steps: BuildStepEntry[] = [];
    const errors: BuildStepEntry[] = [];

    const log = (step: string, status: "pending" | "success" | "error", detail: Record<string, unknown> = {}) => {
      const entry: BuildStepEntry = { step, status, ...detail as Partial<BuildStepEntry>, timestamp: new Date().toISOString() };
      if (status === "error") errors.push(entry);
      else steps.push(entry);
      onProgress(step, status, detail);
    };

    if (propertyData.nickname) {
      try {
        log("nickname", "pending");
        await this.updateNickname(listingId, propertyData.nickname);
        log("nickname", "success");
      } catch (e) {
        log("nickname", "error", { error: (e as Error).message });
      }
    }

    if (propertyData.address) {
      try {
        log("address", "pending");
        await this.updateAddress(listingId, propertyData.address);
        log("address", "success");
      } catch (e) {
        log("address", "error", { error: (e as Error).message });
      }
    }

    if (propertyData.listingRooms && propertyData.listingRooms.length > 0) {
      try {
        log("rooms_beds", "pending");
        await this.updateListingDetails(listingId, {
          areaSquareFeet: propertyData.areaSquareFeet,
          bedrooms: propertyData.bedrooms,
          bathrooms: propertyData.bathrooms,
          listingRooms: propertyData.listingRooms,
        });
        log("rooms_beds", "success", { rooms: propertyData.listingRooms.length });
      } catch (e) {
        log("rooms_beds", "error", { error: (e as Error).message });
      }
    }

    if (propertyData.descriptions) {
      try {
        log("descriptions", "pending");
        await this.updateDescriptions(listingId, propertyData.descriptions);
        log("descriptions", "success");
      } catch (e) {
        log("descriptions", "error", { error: (e as Error).message });
      }
    }

    // Photos are NOT pushed via Push Updates — use the Photos tab's dedicated
    // "Push Photos to Guesty" button which hosts each file on ImgBB first.

    if (propertyData.pricing) {
      try {
        log("financials", "pending");
        await this.updateFinancials(listingId, propertyData.pricing);
        log("financials", "success");
      } catch (e) {
        log("financials", "error", { error: (e as Error).message });
      }
    }

    if (propertyData.bookingSettings) {
      try {
        log("booking_settings", "pending");
        await this.updateBookingSettings(listingId, propertyData.bookingSettings);
        log("booking_settings", "success");
      } catch (e) {
        log("booking_settings", "error", { error: (e as Error).message });
      }
    }

    if (propertyData.amenities && propertyData.amenities.length > 0) {
      try {
        log("amenities", "pending");
        await this.updateAmenities(listingId, propertyData.amenities);
        log("amenities", "success", { count: propertyData.amenities.length });
      } catch (e) {
        log("amenities", "error", { error: (e as Error).message });
      }
    }

    // Final step: flip isListed from false → true so the listing goes live
    // across connected channels (Airbnb/VRBO/Booking.com) immediately. The
    // createListing call above sets isListed:false so the listing exists as
    // a draft while we populate it; without this step the operator has to
    // open Guesty admin → this listing → List on channels → Edit → toggle
    // Status to Listed, which is easy to miss after a build.
    try {
      log("list_on_channels", "pending");
      await this.listOnChannels(listingId);
      log("list_on_channels", "success");
    } catch (e) {
      log("list_on_channels", "error", { error: (e as Error).message });
    }

    return { listingId, steps, errors, success: errors.length === 0 };
  }
}

export const guestyService = new GuestyService();
