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

    // Per-channel overrides via the Guesty integrations payload. Following
    // the same multi-shape defensive approach as channel markup (see
    // server/routes.ts /push-channel-markups) — Guesty's schema for these
    // fields has drifted across API versions; we send the current
    // canonical shape. If a channel isn't selected it stays untouched.
    if (perChannel) {
      const integrations: Record<string, Record<string, unknown>> = {};
      if (perChannel.airbnb) {
        integrations.airbnb2 = { cancellationPolicy: perChannel.airbnb };
      }
      if (perChannel.vrbo) {
        integrations.homeaway2 = { cancellationPolicy: perChannel.vrbo };
      }
      if (perChannel.booking) {
        integrations.bookingCom = { cancellationPolicy: perChannel.booking };
      }
      if (Object.keys(integrations).length > 0) {
        body.integrations = integrations;
      }
    }

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

    const airbnbData = findIntegration(["airbnb2", "airbnb"])
      ?? (listing.airBnb || (listing.channels as Record<string, unknown>)?.airbnb) as Record<string, string> | undefined;
    const vrboData = findIntegration(["homeaway", "vrbo"])
      ?? (listing.homeAway || (listing.channels as Record<string, unknown>)?.homeAway) as Record<string, string> | undefined;
    const bookingComData = findIntegration(["bookingCom", "booking_com"])
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
      const hasId = !!(d?.id || d?.listingId || d?.propertyId || d?.hotelId);
      const isCompleted = d?.status === "COMPLETED" || d?.status === "connected";
      return {
        connected: hasId || isCompleted,
        live: (hasId || isCompleted) && isListed,
        id: d?.id || d?.listingId || d?.propertyId || d?.hotelId || null,
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

    return {
      isListed,
      airbnb: airbnbInfo,
      vrbo: toInfo(vrboData),
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

    return { listingId, steps, errors, success: errors.length === 0 };
  }
}

export const guestyService = new GuestyService();
