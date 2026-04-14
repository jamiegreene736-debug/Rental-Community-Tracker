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
  cancellationPolicy?: string;
  instantBooking?: boolean;
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
      const err = await res.json().catch(() => ({})) as { message?: string; error?: string };
      throw new Error(err.message || err.error || `Guesty API ${res.status}: ${endpoint}`);
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
    const payload = {
      nickname: data.nickname,
      title: data.title,
      address: data.address,
      accommodates: data.accommodates,
      roomType: data.roomType || "Entire home/apartment",
      propertyType: data.propertyType || "House",
      otaRoomType: data.otaRoomType || "holiday_home",
      amenities: data.amenities || [],
      defaultCheckInTime: data.checkInTime || "15:00",
      defaultCheckoutTime: data.checkOutTime || "11:00",
      timezone: data.timezone || "Pacific/Honolulu",
      minimumAge: data.minimumAge || 18,
      areaSquareFeet: data.areaSquareFeet,
      type: "SINGLE",
      isListed: false,
    };
    return this.request<{ _id: string }>("POST", "/listings", payload);
  }

  async updateDescriptions(id: string, descriptions: GuestyDescriptions) {
    return this.request("PUT", `/listings/${id}`, {
      title: descriptions.title,
      publicDescriptions: {
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
    return this.request("POST", `/listings/${id}/pictures/upload-by-urls`, {
      urls: photos.map((p) => ({ url: p.url, caption: p.caption || "" })),
    });
  }

  async updateFinancials(id: string, pricing: GuestyPricing) {
    const payload: Record<string, unknown> = {
      basePrice: pricing.basePrice,
      currency: pricing.currency || "USD",
    };
    if (pricing.weekendBasePrice != null) payload.weekendBasePrice = pricing.weekendBasePrice;
    if (pricing.weeklyDiscount != null) payload.weeklyPriceFactor = pricing.weeklyDiscount;
    if (pricing.monthlyDiscount != null) payload.monthlyPriceFactor = pricing.monthlyDiscount;
    if (pricing.cleaningFee != null) payload.cleaningFee = pricing.cleaningFee;
    if (pricing.securityDeposit != null) payload.securityDepositFee = pricing.securityDeposit;
    if (pricing.extraPersonFee != null) payload.extraPersonFee = pricing.extraPersonFee;
    if (pricing.guestsIncluded != null) payload.guestsIncludedInRegularFee = pricing.guestsIncluded;
    if (pricing.channelCleaningFees) payload.channelCleaningFees = pricing.channelCleaningFees;
    return this.request("PUT", `/financials/listing/${id}`, payload);
  }

  async updateBookingSettings(id: string, settings: GuestyBookingSettings) {
    return this.request("PUT", `/listings/${id}`, {
      terms: {
        minNights: settings.minNights || 1,
        maxNights: settings.maxNights || 365,
        cancellationPolicy: settings.cancellationPolicy || "flexible",
        instantBooking: settings.instantBooking !== undefined ? settings.instantBooking : true,
      },
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

    const airbnb = (listing.airBnb || (listing.channels as Record<string, unknown>)?.airbnb) as Record<string, string> | undefined;
    const vrbo = (listing.homeAway || (listing.channels as Record<string, unknown>)?.homeAway) as Record<string, string> | undefined;
    const bookingCom = (listing.bookingCom || (listing.channels as Record<string, unknown>)?.bookingCom) as Record<string, string> | undefined;
    const isListed = !!(listing.isListed);

    return {
      isListed,
      airbnb: {
        connected: !!(airbnb?.id || airbnb?.listingId),
        live: !!(airbnb?.id || airbnb?.listingId) && isListed,
        id: airbnb?.id || airbnb?.listingId || null,
        status: airbnb?.status || null,
      },
      vrbo: {
        connected: !!(vrbo?.id || vrbo?.propertyId),
        live: !!(vrbo?.id || vrbo?.propertyId) && isListed,
        id: vrbo?.id || vrbo?.propertyId || null,
        status: vrbo?.status || null,
      },
      bookingCom: {
        connected: !!(bookingCom?.id || bookingCom?.hotelId),
        live: !!(bookingCom?.id || bookingCom?.hotelId) && isListed,
        id: bookingCom?.id || bookingCom?.hotelId || null,
        status: bookingCom?.status || null,
      },
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

    if (propertyData.descriptions) {
      try {
        log("descriptions", "pending");
        await this.updateDescriptions(listingId!, propertyData.descriptions);
        log("descriptions", "success");
      } catch (e) {
        log("descriptions", "error", { error: (e as Error).message });
      }
    }

    if (propertyData.photos && propertyData.photos.length > 0) {
      try {
        log("photos", "pending");
        await this.uploadPhotos(listingId!, propertyData.photos);
        log("photos", "success", { count: propertyData.photos.length });
      } catch (e) {
        log("photos", "error", { error: (e as Error).message });
      }
    }

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

    if (propertyData.descriptions) {
      try {
        log("descriptions", "pending");
        await this.updateDescriptions(listingId, propertyData.descriptions);
        log("descriptions", "success");
      } catch (e) {
        log("descriptions", "error", { error: (e as Error).message });
      }
    }

    if (propertyData.photos && propertyData.photos.length > 0) {
      try {
        log("photos", "pending");
        await this.uploadPhotos(listingId, propertyData.photos);
        log("photos", "success", { count: propertyData.photos.length });
      } catch (e) {
        log("photos", "error", { error: (e as Error).message });
      }
    }

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

    return { listingId, steps, errors, success: errors.length === 0 };
  }
}

export const guestyService = new GuestyService();
