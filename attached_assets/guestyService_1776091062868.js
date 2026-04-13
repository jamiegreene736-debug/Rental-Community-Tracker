/**
 * GuestyService — Full API service layer for Guesty Open API
 * Replaces all Lodgify browser-automation logic with clean REST calls.
 *
 * Env vars required:
 *   GUESTY_CLIENT_ID
 *   GUESTY_CLIENT_SECRET
 *
 * In a Replit project, set these in the Secrets tab (not .env file).
 */

const GUESTY_API_BASE = 'https://open-api.guesty.com/v1';
const GUESTY_AUTH_URL = 'https://auth.guesty.com/oauth/token';

class GuestyService {
  constructor() {
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  // ─── Auth ────────────────────────────────────────────────────────────────

  async getAccessToken() {
    // Reuse token until 60 seconds before expiry
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const clientId =
      (typeof process !== 'undefined' && process.env?.GUESTY_CLIENT_ID) ||
      window?.__GUESTY_CLIENT_ID__;
    const clientSecret =
      (typeof process !== 'undefined' && process.env?.GUESTY_CLIENT_SECRET) ||
      window?.__GUESTY_CLIENT_SECRET__;

    if (!clientId || !clientSecret) {
      throw new Error(
        'Missing Guesty credentials. Set GUESTY_CLIENT_ID and GUESTY_CLIENT_SECRET in Replit Secrets.'
      );
    }

    const res = await fetch(GUESTY_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'open-api',
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error_description || `Auth failed: ${res.status}`);
    }

    const data = await res.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000 - 60_000;
    return this.accessToken;
  }

  async request(method, endpoint, body = null, queryParams = '') {
    const token = await this.getAccessToken();
    const url = `${GUESTY_API_BASE}${endpoint}${queryParams ? `?${queryParams}` : ''}`;

    const options = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };

    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        err.message || err.error || `Guesty API ${res.status}: ${endpoint}`
      );
    }

    // 204 No Content
    if (res.status === 204) return { success: true };
    return res.json();
  }

  // ─── Connection Check ────────────────────────────────────────────────────

  /**
   * Verifies Guesty credentials are valid and connection is live.
   * @returns {{ connected: boolean, accountId?: string, error?: string }}
   */
  async checkConnection() {
    try {
      await this.getAccessToken();
      // Lightweight call — fetch just 1 listing to confirm account access
      const data = await this.request('GET', '/listings', null, 'limit=1&fields=_id,accountId');
      return {
        connected: true,
        accountId: data?.results?.[0]?.accountId || null,
      };
    } catch (e) {
      return { connected: false, error: e.message };
    }
  }

  // ─── Listings ────────────────────────────────────────────────────────────

  async getListings(limit = 25, skip = 0) {
    return this.request('GET', '/listings', null, `limit=${limit}&skip=${skip}`);
  }

  async getListing(id) {
    return this.request('GET', `/listings/${id}`);
  }

  /**
   * Creates the base listing shell. Must be followed by description/photo/financial calls
   * to fully build out the property.
   */
  async createListing(data) {
    const payload = {
      nickname: data.nickname,
      title: data.title,
      address: data.address,
      accommodates: data.accommodates,
      roomType: data.roomType,          // 'Entire home/apartment' | 'Private room' | 'Shared room'
      propertyType: data.propertyType,  // 'House' | 'Apartment' | 'Villa' | etc.
      otaRoomType: data.otaRoomType,    // Required for Booking.com: 'apartment' | 'villa' | etc.
      amenities: data.amenities || [],
      defaultCheckInTime: data.checkInTime || '15:00',
      defaultCheckoutTime: data.checkOutTime || '11:00',
      timezone: data.timezone || 'America/New_York',
      minimumAge: data.minimumAge || 18,
      areaSquareFeet: data.areaSquareFeet,
      type: data.type || 'SINGLE',
      isListed: false, // Always start unlisted — list after full build
    };

    return this.request('POST', '/listings', payload);
  }

  async updateListing(id, data) {
    return this.request('PUT', `/listings/${id}`, data);
  }

  // ─── Descriptions ────────────────────────────────────────────────────────

  /**
   * Updates all marketing descriptions for a listing.
   * Only include fields you want to change.
   */
  async updateDescriptions(id, descriptions) {
    return this.request('PUT', `/listings/${id}`, {
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

  // ─── Photos ──────────────────────────────────────────────────────────────

  /**
   * Uploads photos to a listing from publicly accessible URLs.
   * Guesty fetches the images from the URLs and hosts them.
   *
   * @param {string} id - Listing ID
   * @param {Array<{ url: string, caption?: string }>} photos
   */
  async uploadPhotos(id, photos) {
    return this.request('POST', `/listings/${id}/pictures/upload-by-urls`, {
      urls: photos.map((p) => ({
        url: typeof p === 'string' ? p : p.url,
        caption: p.caption || '',
      })),
    });
  }

  async reorderPhotos(id, pictureIds) {
    return this.request('PUT', `/listings/${id}/pictures/order`, { pictureIds });
  }

  async deletePhoto(id, pictureId) {
    return this.request('DELETE', `/listings/${id}/pictures/${pictureId}`);
  }

  // ─── Financials ──────────────────────────────────────────────────────────

  /**
   * Sets all pricing and fee data for a listing.
   */
  async updateFinancials(id, pricing) {
    const payload = {
      basePrice: pricing.basePrice,
      currency: pricing.currency || 'USD',
    };

    if (pricing.weekendBasePrice != null) payload.weekendBasePrice = pricing.weekendBasePrice;
    if (pricing.weeklyDiscount != null) payload.weeklyPriceFactor = pricing.weeklyDiscount;     // e.g. 0.90 = 10% off
    if (pricing.monthlyDiscount != null) payload.monthlyPriceFactor = pricing.monthlyDiscount;  // e.g. 0.85 = 15% off
    if (pricing.cleaningFee != null) payload.cleaningFee = pricing.cleaningFee;
    if (pricing.securityDeposit != null) payload.securityDepositFee = pricing.securityDeposit;
    if (pricing.extraPersonFee != null) payload.extraPersonFee = pricing.extraPersonFee;
    if (pricing.guestsIncluded != null) payload.guestsIncludedInRegularFee = pricing.guestsIncluded;

    // Channel-specific cleaning fees (only if channel is connected)
    if (pricing.channelCleaningFees) {
      payload.channelCleaningFees = pricing.channelCleaningFees;
      // Format: { airbnb: { amount: 100, type: 'fixed', calculation: 'PER_STAY' }, ... }
    }

    return this.request('PUT', `/financials/listing/${id}`, payload);
  }

  // ─── Booking Settings ────────────────────────────────────────────────────

  async updateBookingSettings(id, settings) {
    return this.request('PUT', `/listings/${id}`, {
      terms: {
        minNights: settings.minNights || 1,
        maxNights: settings.maxNights || 365,
        cancellationPolicy: settings.cancellationPolicy || 'flexible',
        instantBooking: settings.instantBooking !== undefined ? settings.instantBooking : true,
      },
    });
  }

  // ─── Listing / Unlisting ─────────────────────────────────────────────────

  async listOnChannels(id) {
    return this.request('PUT', `/listings/${id}`, { isListed: true });
  }

  async unlistFromChannels(id) {
    return this.request('PUT', `/listings/${id}`, { isListed: false });
  }

  // ─── Channel Status ──────────────────────────────────────────────────────

  /**
   * Returns the live channel connection status for a listing.
   * Checks Airbnb, VRBO, and Booking.com.
   */
  async getChannelStatus(id) {
    const listing = await this.getListing(id);

    const airbnb = listing.airBnb || listing.channels?.airbnb;
    const vrbo = listing.homeAway || listing.channels?.homeAway;
    const bookingCom = listing.bookingCom || listing.channels?.bookingCom;

    return {
      isListed: listing.isListed || false,
      airbnb: {
        connected: !!(airbnb?.id || airbnb?.listingId),
        live: !!(airbnb?.id || airbnb?.listingId) && listing.isListed,
        id: airbnb?.id || airbnb?.listingId || null,
        status: airbnb?.status || null,
      },
      vrbo: {
        connected: !!(vrbo?.id || vrbo?.propertyId),
        live: !!(vrbo?.id || vrbo?.propertyId) && listing.isListed,
        id: vrbo?.id || vrbo?.propertyId || null,
        status: vrbo?.status || null,
      },
      bookingCom: {
        connected: !!(bookingCom?.id || bookingCom?.hotelId),
        live: !!(bookingCom?.id || bookingCom?.hotelId) && listing.isListed,
        id: bookingCom?.id || bookingCom?.hotelId || null,
        status: bookingCom?.status || null,
      },
    };
  }

  // ─── Full Build Pipeline ─────────────────────────────────────────────────

  /**
   * Chains all necessary API calls to fully build a listing from scraped data.
   * Returns a detailed log of each step's result.
   *
   * @param {object} propertyData - Full property payload from your scraper
   * @param {function} onProgress - Optional callback: (step, status, detail) => void
   * @returns {{ listingId, steps, errors, success }}
   */
  async buildFullListing(propertyData, onProgress = () => {}) {
    const steps = [];
    const errors = [];
    let listingId = null;

    const log = (step, status, detail = {}) => {
      const entry = { step, status, ...detail, timestamp: new Date().toISOString() };
      if (status === 'error') errors.push(entry);
      else steps.push(entry);
      onProgress(step, status, detail);
    };

    // ── Step 1: Create base listing ──────────────────────────────────────
    try {
      log('create_listing', 'pending');
      const listing = await this.createListing(propertyData);
      listingId = listing._id;
      log('create_listing', 'success', { id: listingId });
    } catch (e) {
      log('create_listing', 'error', { error: e.message });
      return { listingId: null, steps, errors, success: false };
    }

    // ── Step 2: Descriptions ─────────────────────────────────────────────
    if (propertyData.descriptions) {
      try {
        log('descriptions', 'pending');
        await this.updateDescriptions(listingId, propertyData.descriptions);
        log('descriptions', 'success');
      } catch (e) {
        log('descriptions', 'error', { error: e.message });
      }
    }

    // ── Step 3: Photos ───────────────────────────────────────────────────
    if (propertyData.photos?.length) {
      try {
        log('photos', 'pending');
        await this.uploadPhotos(listingId, propertyData.photos);
        log('photos', 'success', { count: propertyData.photos.length });
      } catch (e) {
        log('photos', 'error', { error: e.message });
      }
    }

    // ── Step 4: Financials ───────────────────────────────────────────────
    if (propertyData.pricing) {
      try {
        log('financials', 'pending');
        await this.updateFinancials(listingId, propertyData.pricing);
        log('financials', 'success');
      } catch (e) {
        log('financials', 'error', { error: e.message });
      }
    }

    // ── Step 5: Booking settings ─────────────────────────────────────────
    if (propertyData.bookingSettings) {
      try {
        log('booking_settings', 'pending');
        await this.updateBookingSettings(listingId, propertyData.bookingSettings);
        log('booking_settings', 'success');
      } catch (e) {
        log('booking_settings', 'error', { error: e.message });
      }
    }

    const success = errors.length === 0;
    return { listingId, steps, errors, success };
  }

  // ─── Update Pipeline ─────────────────────────────────────────────────────

  /**
   * Updates an existing listing with changed data.
   * Only the fields present in propertyData will be updated.
   */
  async updateFullListing(listingId, propertyData, onProgress = () => {}) {
    const steps = [];
    const errors = [];

    const log = (step, status, detail = {}) => {
      const entry = { step, status, ...detail, timestamp: new Date().toISOString() };
      if (status === 'error') errors.push(entry);
      else steps.push(entry);
      onProgress(step, status, detail);
    };

    if (propertyData.descriptions) {
      try {
        log('descriptions', 'pending');
        await this.updateDescriptions(listingId, propertyData.descriptions);
        log('descriptions', 'success');
      } catch (e) {
        log('descriptions', 'error', { error: e.message });
      }
    }

    if (propertyData.photos?.length) {
      try {
        log('photos', 'pending');
        await this.uploadPhotos(listingId, propertyData.photos);
        log('photos', 'success', { count: propertyData.photos.length });
      } catch (e) {
        log('photos', 'error', { error: e.message });
      }
    }

    if (propertyData.pricing) {
      try {
        log('financials', 'pending');
        await this.updateFinancials(listingId, propertyData.pricing);
        log('financials', 'success');
      } catch (e) {
        log('financials', 'error', { error: e.message });
      }
    }

    if (propertyData.amenities) {
      try {
        log('amenities', 'pending');
        await this.updateListing(listingId, { amenities: propertyData.amenities });
        log('amenities', 'success');
      } catch (e) {
        log('amenities', 'error', { error: e.message });
      }
    }

    return { listingId, steps, errors, success: errors.length === 0 };
  }
}

export const guestyService = new GuestyService();
export default guestyService;
