import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertBuyInSchema } from "@shared/schema";
import path from "path";
import fs from "fs";
import JSZip from "jszip";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/photos/zip-multi", async (req, res) => {
    const foldersParam = req.query.folders as string;
    const name = (req.query.name as string) || "all-photos";
    const communityFolder = (req.query.communityFolder as string || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const beginningPhotos = (req.query.beginningPhotos as string || "").split(",").filter(Boolean);
    const endPhotos = (req.query.endPhotos as string || "").split(",").filter(Boolean);

    if (!foldersParam) {
      return res.status(400).json({ error: "Missing folders query parameter" });
    }

    const folders = foldersParam.split(",").map(f => f.replace(/[^a-zA-Z0-9_-]/g, "")).filter(Boolean);
    if (folders.length === 0) {
      return res.status(400).json({ error: "No valid folders specified" });
    }

    const zip = new JSZip();
    let totalFiles = 0;
    let globalIndex = 1;
    const photosBase = path.join(process.cwd(), "client", "public", "photos");

    const addFileToZip = (filePath: string, zipName: string) => {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        zip.file(zipName, data);
        totalFiles++;
      }
    };

    if (communityFolder && beginningPhotos.length > 0) {
      const communityDir = path.join(photosBase, communityFolder);
      for (const photo of beginningPhotos) {
        const safePhoto = photo.replace(/[^a-zA-Z0-9_.-]/g, "");
        const paddedIndex = String(globalIndex).padStart(3, "0");
        const ext = path.extname(safePhoto);
        const baseName = path.basename(safePhoto, ext).replace(/^\d+-/, "");
        addFileToZip(path.join(communityDir, safePhoto), `${paddedIndex}-community-${baseName}${ext}`);
        globalIndex++;
      }
    }

    for (const folder of folders) {
      const photosDir = path.join(photosBase, folder);
      if (!fs.existsSync(photosDir)) continue;
      const files = fs.readdirSync(photosDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
      for (const file of files) {
        const paddedIndex = String(globalIndex).padStart(3, "0");
        const ext = path.extname(file);
        const baseName = path.basename(file, ext).replace(/^\d+-/, "");
        addFileToZip(path.join(photosDir, file), `${paddedIndex}-${folder}-${baseName}${ext}`);
        globalIndex++;
      }
    }

    if (communityFolder && endPhotos.length > 0) {
      const communityDir = path.join(photosBase, communityFolder);
      for (const photo of endPhotos) {
        const safePhoto = photo.replace(/[^a-zA-Z0-9_.-]/g, "");
        const paddedIndex = String(globalIndex).padStart(3, "0");
        const ext = path.extname(safePhoto);
        const baseName = path.basename(safePhoto, ext).replace(/^\d+-/, "");
        addFileToZip(path.join(communityDir, safePhoto), `${paddedIndex}-community-${baseName}${ext}`);
        globalIndex++;
      }
    }

    if (totalFiles === 0) {
      return res.status(404).json({ error: "No photos found" });
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "");
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeName}-photos.zip"`,
      "Content-Length": String(zipBuffer.length),
    });
    res.send(zipBuffer);
  });

  app.get("/api/photos/zip/:folder", async (req, res) => {
    const folder = req.params.folder.replace(/[^a-zA-Z0-9_-]/g, "");
    const photosDir = path.join(process.cwd(), "client", "public", "photos", folder);

    if (!fs.existsSync(photosDir)) {
      return res.status(404).json({ error: "Photo folder not found" });
    }

    const files = fs.readdirSync(photosDir).filter(f => f.endsWith(".jpg") || f.endsWith(".png") || f.endsWith(".jpeg"));
    if (files.length === 0) {
      return res.status(404).json({ error: "No photos found in folder" });
    }

    const zip = new JSZip();
    for (const file of files) {
      const filePath = path.join(photosDir, file);
      const data = fs.readFileSync(filePath);
      zip.file(file, data);
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${folder}-photos.zip"`,
      "Content-Length": String(zipBuffer.length),
    });
    res.send(zipBuffer);
  });

  app.get("/api/lodgify/properties", async (_req, res) => {
    const apiKey = process.env.LODGIFY_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Lodgify API key not configured" });
    }
    try {
      const response = await fetch("https://api.lodgify.com/v2/properties?page=1&size=50", {
        headers: {
          "X-ApiKey": apiKey,
          "accept": "application/json",
        },
      });
      if (!response.ok) {
        return res.status(response.status).json({ error: "Failed to fetch Lodgify properties" });
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: "Failed to connect to Lodgify API" });
    }
  });

  app.get("/api/lodgify/property/:propertyId/rooms", async (req, res) => {
    const apiKey = process.env.LODGIFY_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Lodgify API key not configured" });
    }
    try {
      const { propertyId } = req.params;
      const response = await fetch(`https://api.lodgify.com/v2/properties/${propertyId}`, {
        headers: {
          "X-ApiKey": apiKey,
          "accept": "application/json",
        },
      });
      if (!response.ok) {
        return res.status(response.status).json({ error: "Failed to fetch Lodgify property details" });
      }
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: "Failed to connect to Lodgify API" });
    }
  });

  app.post("/api/lodgify/push-rates", async (req, res) => {
    const apiKey = process.env.LODGIFY_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Lodgify API key not configured" });
    }

    const { lodgifyPropertyId, rates } = req.body;
    if (!lodgifyPropertyId || !rates || !Array.isArray(rates) || rates.length === 0) {
      return res.status(400).json({ error: "Missing lodgifyPropertyId or rates array" });
    }

    const MONTH_NAMES = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];

    for (const rate of rates) {
      if (typeof rate.month !== "string" || MONTH_NAMES.indexOf(rate.month) === -1) {
        return res.status(400).json({ error: `Invalid month name: "${rate.month}"` });
      }
      if (typeof rate.year !== "number" || rate.year < 2024 || rate.year > 2030) {
        return res.status(400).json({ error: `Invalid year: ${rate.year}` });
      }
      if (typeof rate.sellRate !== "number" || rate.sellRate <= 0) {
        return res.status(400).json({ error: `Invalid sellRate: ${rate.sellRate}` });
      }
    }

    const parsedPropertyId = parseInt(String(lodgifyPropertyId), 10);
    if (isNaN(parsedPropertyId) || parsedPropertyId <= 0) {
      return res.status(400).json({ error: "Lodgify property ID must be a positive number" });
    }

    try {
      const propertyResponse = await fetch(`https://api.lodgify.com/v2/properties/${parsedPropertyId}`, {
        headers: {
          "X-ApiKey": apiKey,
          "accept": "application/json",
        },
      });

      if (!propertyResponse.ok) {
        return res.status(propertyResponse.status).json({
          error: `Lodgify property ${parsedPropertyId} not found or inaccessible`,
        });
      }

      const propertyData: any = await propertyResponse.json();

      const roomTypes = propertyData.rooms?.map((r: any) => ({
        id: r.id,
        name: r.name,
      })) || [];

      if (roomTypes.length === 0) {
        return res.status(400).json({ error: "No room types found for this Lodgify property" });
      }

      const results: any[] = [];

      for (const room of roomTypes) {
        const firstRate = rates[0];
        const defaultMinStay = typeof firstRate.minStay === "number" && firstRate.minStay > 0 ? firstRate.minStay : 5;

        const rateEntries: any[] = [
          {
            is_default: true,
            price_per_day: firstRate.sellRate,
            min_stay: defaultMinStay,
          },
        ];

        for (const rate of rates) {
          const monthIndex = MONTH_NAMES.indexOf(rate.month);
          const startDate = new Date(rate.year, monthIndex, 1);
          const endDate = new Date(rate.year, monthIndex + 1, 0);
          const minStay = typeof rate.minStay === "number" && rate.minStay > 0 ? rate.minStay : 5;

          rateEntries.push({
            is_default: false,
            name: `${rate.month} ${rate.year}`,
            start_date: startDate.toISOString().split("T")[0],
            end_date: endDate.toISOString().split("T")[0],
            price_per_day: rate.sellRate,
            min_stay: minStay,
          });
        }

        const ratePayload = {
          property_id: parsedPropertyId,
          room_type_id: room.id,
          rates: rateEntries,
        };

        const rateResponse = await fetch("https://api.lodgify.com/v1/rates/savewithoutavailability", {
          method: "POST",
          headers: {
            "X-ApiKey": apiKey,
            "Content-Type": "application/json",
            "accept": "application/json",
          },
          body: JSON.stringify(ratePayload),
        });

        const rateResponseStatus = rateResponse.status;
        const rateResponseText = await rateResponse.text();

        if (!rateResponse.ok) {
          let errorData;
          try {
            errorData = JSON.parse(rateResponseText);
          } catch {
            errorData = { message: rateResponseText || `HTTP ${rateResponseStatus} error` };
          }
          console.error(`Lodgify rate push failed for room ${room.id} (${room.name}):`, {
            status: rateResponseStatus,
            error: errorData,
            payload: JSON.stringify(ratePayload).substring(0, 500),
          });
          results.push({
            roomTypeId: room.id,
            roomTypeName: room.name,
            success: false,
            httpStatus: rateResponseStatus,
            error: errorData,
          });
          continue;
        }

        let parsedResult;
        try {
          parsedResult = JSON.parse(rateResponseText);
        } catch {
          parsedResult = { raw: rateResponseText };
        }

        results.push({
          roomTypeId: room.id,
          roomTypeName: room.name,
          success: true,
          rateEntriesSubmitted: rateEntries.length,
          response: parsedResult,
        });
      }

      const allSucceeded = results.every((r) => r.success);
      res.status(allSucceeded ? 200 : 207).json({
        success: allSucceeded,
        lodgifyPropertyId: parsedPropertyId,
        roomTypesProcessed: results.length,
        results,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to push rates to Lodgify", message: err.message });
    }
  });

  // ========== BUY-IN CRUD ==========

  app.get("/api/buy-ins", async (_req, res) => {
    try {
      const buyIns = await storage.getBuyIns();
      res.json(buyIns);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch buy-ins", message: err.message });
    }
  });

  app.get("/api/buy-ins/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const buyIn = await storage.getBuyIn(id);
      if (!buyIn) return res.status(404).json({ error: "Buy-in not found" });
      res.json(buyIn);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch buy-in", message: err.message });
    }
  });

  app.post("/api/buy-ins", async (req, res) => {
    try {
      const parsed = insertBuyInSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid buy-in data", details: parsed.error.flatten() });
      }
      const buyIn = await storage.createBuyIn(parsed.data);
      res.status(201).json(buyIn);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to create buy-in", message: err.message });
    }
  });

  app.patch("/api/buy-ins/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const allowed = ["propertyId", "unitId", "propertyName", "unitLabel", "checkIn", "checkOut", "costPaid", "airbnbConfirmation", "airbnbListingUrl", "notes", "status"];
      const filtered: Record<string, any> = {};
      for (const key of allowed) {
        if (key in req.body) filtered[key] = req.body[key];
      }
      if (filtered.costPaid !== undefined) {
        const cost = parseFloat(String(filtered.costPaid));
        if (isNaN(cost) || cost < 0) return res.status(400).json({ error: "Invalid costPaid" });
        filtered.costPaid = String(cost);
      }
      if (filtered.checkIn && !/^\d{4}-\d{2}-\d{2}$/.test(filtered.checkIn)) {
        return res.status(400).json({ error: "Invalid checkIn date format (YYYY-MM-DD)" });
      }
      if (filtered.checkOut && !/^\d{4}-\d{2}-\d{2}$/.test(filtered.checkOut)) {
        return res.status(400).json({ error: "Invalid checkOut date format (YYYY-MM-DD)" });
      }
      const buyIn = await storage.updateBuyIn(id, filtered);
      if (!buyIn) return res.status(404).json({ error: "Buy-in not found" });
      res.json(buyIn);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to update buy-in", message: err.message });
    }
  });

  app.delete("/api/buy-ins/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const deleted = await storage.deleteBuyIn(id);
      if (!deleted) return res.status(404).json({ error: "Buy-in not found" });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to delete buy-in", message: err.message });
    }
  });

  // ========== AIRBNB SEARCH VIA SEARCHAPI.IO ==========

  const PROPERTY_UNIT_NEEDS: Record<number, { community: string; units: { bedrooms: number }[] }> = {
    1: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 2 }, { bedrooms: 2 }] },
    4: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    7: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }, { bedrooms: 2 }] },
    8: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    9: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    10: { community: "Kekaha Beachfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    12: { community: "Kekaha Beachfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    14: { community: "Keauhou", units: [{ bedrooms: 4 }, { bedrooms: 2 }] },
    18: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    19: { community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    20: { community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    21: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }, { bedrooms: 2 }] },
    23: { community: "Kapaa Beachfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    24: { community: "Poipu Oceanfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    26: { community: "Keauhou", units: [{ bedrooms: 5 }, { bedrooms: 2 }] },
    27: { community: "Poipu Kai", units: [{ bedrooms: 2 }, { bedrooms: 2 }] },
    28: { community: "Poipu Brenneckes", units: [{ bedrooms: 4 }, { bedrooms: 3 }] },
    29: { community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 4 }] },
    31: { community: "Poipu Brenneckes", units: [{ bedrooms: 5 }, { bedrooms: 2 }] },
    32: { community: "Pili Mai", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    33: { community: "Pili Mai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    34: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
  };

  const COMMUNITY_SEARCH_LOCATIONS: Record<string, string> = {
    "Poipu Kai": "Regency at Poipu Kai, Koloa, Kauai, Hawaii",
    "Kekaha Beachfront": "Kekaha, Kauai, Hawaii",
    "Keauhou": "Keauhou, Kailua-Kona, Big Island, Hawaii",
    "Princeville": "Princeville, Kauai, Hawaii",
    "Kapaa Beachfront": "Kapaa, Kauai, Hawaii",
    "Poipu Oceanfront": "Poipu Beach, Koloa, Kauai, Hawaii",
    "Poipu Brenneckes": "Brenneckes Beach, Poipu, Kauai, Hawaii",
    "Pili Mai": "Pili Mai at Poipu, Koloa, Kauai, Hawaii",
  };

  app.get("/api/airbnb/search", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "SearchAPI.io API key not configured" });
    }

    try {
      const propertyId = parseInt(req.query.propertyId as string, 10);
      const checkIn = req.query.checkIn as string;
      const checkOut = req.query.checkOut as string;

      if (!propertyId || isNaN(propertyId)) {
        return res.status(400).json({ error: "propertyId is required" });
      }
      if (!checkIn || !checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
        return res.status(400).json({ error: "checkIn and checkOut required in YYYY-MM-DD format" });
      }

      const propertyConfig = PROPERTY_UNIT_NEEDS[propertyId];
      if (!propertyConfig) {
        return res.status(404).json({ error: "Property not found in multi-unit config" });
      }

      const searchLocation = COMMUNITY_SEARCH_LOCATIONS[propertyConfig.community] || `${propertyConfig.community}, Hawaii`;

      const bedroomCounts: Record<number, number> = {};
      for (const unit of propertyConfig.units) {
        bedroomCounts[unit.bedrooms] = (bedroomCounts[unit.bedrooms] || 0) + 1;
      }

      const results: Record<string, any> = {
        community: propertyConfig.community,
        searchLocation,
        checkIn,
        checkOut,
        unitsNeeded: Object.entries(bedroomCounts).map(([br, count]) => ({
          bedrooms: parseInt(br),
          count,
        })),
        searches: {},
      };

      for (const [bedroomStr, count] of Object.entries(bedroomCounts)) {
        const bedrooms = parseInt(bedroomStr);
        const searchParams: Record<string, string> = {
          engine: "airbnb",
          check_in_date: checkIn,
          check_out_date: checkOut,
          adults: "2",
          bedrooms: String(bedrooms),
          type_of_place: "entire_home",
          currency: "USD",
          api_key: apiKey,
        };

        searchParams.q = searchLocation;

        const params = new URLSearchParams(searchParams);

        const response = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!response.ok) {
          const errText = await response.text();
          console.error(`SearchAPI error for ${bedrooms}BR:`, errText);
          results.searches[`${bedrooms}BR`] = { error: `SearchAPI returned ${response.status}`, count, properties: [] };
          continue;
        }

        const data = await response.json();
        const properties = (data.properties || []).map((p: any) => ({
          id: p.id,
          title: p.title,
          description: p.description,
          link: p.link,
          bookingLink: p.booking_link,
          rating: p.rating,
          reviews: p.reviews,
          price: p.price,
          accommodations: p.accommodations,
          images: (p.images || []).slice(0, 3),
          badges: p.badges,
          gpsCoordinates: p.gps_coordinates,
        }));

        properties.sort((a: any, b: any) => {
          const priceA = a.price?.extracted_total_price ?? Infinity;
          const priceB = b.price?.extracted_total_price ?? Infinity;
          return priceA - priceB;
        });

        results.searches[`${bedrooms}BR`] = {
          count,
          totalResults: properties.length,
          properties: properties.slice(0, 10),
        };
      }

      res.json(results);
    } catch (err: any) {
      console.error("Airbnb search error:", err);
      res.status(500).json({ error: "Failed to search Airbnb", message: err.message });
    }
  });

  // ========== VRBO DIRECT SCRAPER ==========

  const COMMUNITY_VRBO_DESTINATIONS: Record<string, string> = {
    "Poipu Kai": "Regency at Poipu Kai, Koloa, Hawaii",
    "Kekaha Beachfront": "Kekaha, Hawaii",
    "Keauhou": "Keauhou, Kailua-Kona, Hawaii",
    "Princeville": "Princeville, Kauai, Hawaii",
    "Kapaa Beachfront": "Kapaa, Kauai, Hawaii",
    "Poipu Oceanfront": "Poipu Beach, Koloa, Hawaii",
    "Poipu Brenneckes": "Poipu Beach, Koloa, Hawaii",
    "Pili Mai": "Pili Mai at Poipu, Koloa, Hawaii",
  };

  const COMMUNITY_SP_SLUGS: Record<string, string> = {
    "Poipu Kai": "poipu-vacation-rentals",
    "Poipu Oceanfront": "poipu-vacation-rentals",
    "Poipu Brenneckes": "poipu-vacation-rentals",
    "Pili Mai": "poipu-vacation-rentals",
    "Kapaa Beachfront": "kapaa-vacation-rentals",
    "Princeville": "princeville-vacation-rentals",
  };

  function detectPlatform(name: string, link: string, source: string): string {
    const combined = `${name} ${link} ${source}`.toLowerCase();
    if (combined.includes("vrbo") || combined.includes("homeaway")) return "vrbo";
    if (combined.includes("suite-paradise") || combined.includes("suite paradise") || combined.includes("suiteparadise")) return "suite-paradise";
    if (combined.includes("airbnb")) return "airbnb";
    if (combined.includes("booking.com")) return "booking";
    return "other";
  }

  app.get("/api/vrbo/search", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "SearchAPI.io API key not configured" });
    }

    try {
      const propertyId = parseInt(req.query.propertyId as string, 10);
      const checkIn = req.query.checkIn as string;
      const checkOut = req.query.checkOut as string;

      if (!propertyId || isNaN(propertyId)) {
        return res.status(400).json({ error: "propertyId is required" });
      }
      if (!checkIn || !checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
        return res.status(400).json({ error: "checkIn and checkOut required in YYYY-MM-DD format" });
      }

      const propertyConfig = PROPERTY_UNIT_NEEDS[propertyId];
      if (!propertyConfig) {
        return res.status(404).json({ error: "Property not found in multi-unit config" });
      }

      const destination = COMMUNITY_VRBO_DESTINATIONS[propertyConfig.community] || `${propertyConfig.community}, Hawaii`;
      const spSlug = COMMUNITY_SP_SLUGS[propertyConfig.community];

      const bedroomCounts: Record<number, number> = {};
      for (const unit of propertyConfig.units) {
        bedroomCounts[unit.bedrooms] = (bedroomCounts[unit.bedrooms] || 0) + 1;
      }

      const checkInDate = new Date(checkIn + "T12:00:00");
      const checkOutDate = new Date(checkOut + "T12:00:00");
      const totalNights = Math.max(1, Math.round((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24)));

      const vrboResults: Record<string, any> = {};
      const suiteParadiseResults: Record<string, any> = {};

      const searchPromises = Object.entries(bedroomCounts).map(async ([bedroomStr, count]) => {
        const bedrooms = parseInt(bedroomStr);

        const searchParams: Record<string, string> = {
          engine: "google_hotels",
          q: destination,
          check_in_date: checkIn,
          check_out_date: checkOut,
          adults: "2",
          property_type: "vacation_rental",
          bedrooms: String(bedrooms),
          sort_by: "lowest_price",
          currency: "USD",
          api_key: apiKey,
        };

        try {
          const params = new URLSearchParams(searchParams);
          const response = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);

          if (!response.ok) {
            const errText = await response.text();
            console.error(`Google Hotels search error for ${bedrooms}BR:`, errText);
            vrboResults[`${bedrooms}BR`] = { count, totalResults: 0, properties: [], error: `Search returned ${response.status}` };
            return;
          }

          const data = await response.json();
          const allProperties = (data.properties || []).map((p: any, idx: number) => {
            const pricePerNight = p.price_per_night?.extracted_price || p.extracted_price || null;
            const totalPrice = pricePerNight ? pricePerNight * totalNights : null;
            const source = detectPlatform(p.name || "", p.link || "", p.source || "");

            return {
              id: `gh-${bedrooms}br-${idx}`,
              title: p.name || "Vacation Rental",
              description: p.description || `${bedrooms} bedroom vacation rental`,
              link: p.link && p.link.startsWith("/") ? `https://www.google.com${p.link}` : (p.link || ""),
              bookingLink: p.link && p.link.startsWith("/") ? `https://www.google.com${p.link}` : (p.link || ""),
              source,
              price: totalPrice ? {
                total_price: `$${totalPrice.toLocaleString()}`,
                extracted_total_price: totalPrice,
                price_per_night: pricePerNight,
              } : null,
              rating: p.overall_rating || null,
              reviews: p.reviews || null,
              images: p.images?.slice(0, 3).map((img: any) => img.thumbnail || img.original_image || img) || [],
              badges: [],
              accommodations: [
                p.type || "Vacation Rental",
                ...(p.amenities?.slice(0, 3) || []),
              ].filter(Boolean),
            };
          });

          const vrboListings = allProperties.filter((p: any) => p.source === "vrbo" || p.source === "other" || p.source === "booking");
          const spListings = allProperties.filter((p: any) => p.source === "suite-paradise");

          const vrboSearchUrl = `https://www.vrbo.com/search?` + new URLSearchParams({
            destination,
            startDate: checkIn,
            endDate: checkOut,
            adults: "2",
            bedrooms: String(bedrooms),
            sort: "PRICE_RELEVANT",
          }).toString();

          vrboResults[`${bedrooms}BR`] = {
            count,
            totalResults: vrboListings.length,
            properties: vrboListings.slice(0, 15),
            vrboSearchUrl,
          };

          const spSearchUrl = spSlug
            ? `https://www.suite-paradise.com/${spSlug}?check_in=${checkIn}&check_out=${checkOut}&bedrooms=${bedrooms}`
            : null;

          suiteParadiseResults[`${bedrooms}BR`] = {
            count,
            totalResults: spListings.length,
            properties: spListings.slice(0, 10),
            searchUrl: spSearchUrl,
            note: spListings.length === 0
              ? (spSlug ? "No Suite Paradise listings found in Google results. Try searching their site directly." : "Suite Paradise may not have listings in this community.")
              : undefined,
          };
        } catch (fetchErr: any) {
          console.error(`Search error for ${bedrooms}BR:`, fetchErr.message);
          vrboResults[`${bedrooms}BR`] = { count, totalResults: 0, properties: [], error: fetchErr.message };
          suiteParadiseResults[`${bedrooms}BR`] = { count, totalResults: 0, properties: [] };
        }
      });

      await Promise.all(searchPromises);

      res.json({
        community: propertyConfig.community,
        checkIn,
        checkOut,
        totalNights,
        unitsNeeded: Object.entries(bedroomCounts).map(([br, count]) => ({
          bedrooms: parseInt(br),
          count,
        })),
        vrbo: vrboResults,
        suiteParadise: suiteParadiseResults,
      });
    } catch (err: any) {
      console.error("VRBO/SP search error:", err);
      res.status(500).json({ error: "Failed to search vacation rentals", message: err.message });
    }
  });

  // ========== AVAILABILITY / RECOMMENDATIONS ==========

  app.get("/api/availability", async (req, res) => {
    try {
      const checkIn = req.query.checkIn as string;
      const checkOut = req.query.checkOut as string;
      if (!checkIn || !checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
        return res.status(400).json({ error: "checkIn and checkOut required in YYYY-MM-DD format" });
      }
      const booked = await storage.getBookedUnits(checkIn, checkOut);
      res.json(booked);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to check availability", message: err.message });
    }
  });

  // ========== LODGIFY BOOKING SYNC ==========

  app.post("/api/lodgify/sync-bookings", async (_req, res) => {
    const apiKey = process.env.LODGIFY_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Lodgify API key not configured" });
    }

    try {
      let allBookings: any[] = [];
      let page = 1;
      const size = 50;
      let hasMore = true;

      while (hasMore) {
        const response = await fetch(
          `https://api.lodgify.com/v2/reservations/bookings?page=${page}&size=${size}&includeCount=true&includeTransactions=false&includeExternal=true&includeQuoteDetails=true`,
          {
            headers: {
              "X-ApiKey": apiKey,
              "accept": "application/json",
            },
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          return res.status(response.status).json({ error: "Failed to fetch Lodgify bookings", details: errorText });
        }

        const data: any = await response.json();
        const items = data.items || data || [];

        if (Array.isArray(items)) {
          allBookings = allBookings.concat(items);
        }

        if (!Array.isArray(items) || items.length < size) {
          hasMore = false;
        } else {
          page++;
        }

        if (page > 20) break;
      }

      let synced = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const booking of allBookings) {
        try {
          const rawId = booking.id || booking.booking_id;
          if (!rawId) {
            skipped++;
            continue;
          }
          const lodgifyBookingId = parseInt(String(rawId), 10);
          if (isNaN(lodgifyBookingId)) {
            skipped++;
            continue;
          }

          const checkIn = booking.arrival || booking.check_in || booking.date_arrival;
          const checkOut = booking.departure || booking.check_out || booking.date_departure;

          if (!checkIn || !checkOut) {
            skipped++;
            continue;
          }

          const guestName = booking.guest?.name || booking.guest_name || `${booking.guest?.first_name || ""} ${booking.guest?.last_name || ""}`.trim() || null;
          const guestEmail = booking.guest?.email || booking.guest_email || null;
          const totalAmount = booking.total_amount || booking.amount || booking.quote?.total || null;
          const source = booking.source || booking.booking_source || booking.channel || null;
          const status = booking.status || booking.booking_status || null;
          const lodgifyPropertyId = booking.property_id || booking.property?.id || null;
          const lodgifyPropertyName = booking.property_name || booking.property?.name || null;
          const nights = booking.nights || null;

          const checkInDate = typeof checkIn === "string" ? checkIn.split("T")[0] : new Date(checkIn).toISOString().split("T")[0];
          const checkOutDate = typeof checkOut === "string" ? checkOut.split("T")[0] : new Date(checkOut).toISOString().split("T")[0];

          await storage.upsertLodgifyBooking({
            lodgifyBookingId: lodgifyBookingId,
            propertyId: null,
            unitId: null,
            lodgifyPropertyId,
            lodgifyPropertyName,
            guestName,
            guestEmail,
            checkIn: checkInDate,
            checkOut: checkOutDate,
            totalAmount: totalAmount ? String(totalAmount) : null,
            source,
            status,
            currency: booking.currency || "USD",
            nights,
          });
          synced++;
        } catch (err: any) {
          errors.push(`Booking ${booking.id}: ${err.message}`);
        }
      }

      res.json({
        success: true,
        totalFetched: allBookings.length,
        synced,
        skipped,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to sync Lodgify bookings", message: err.message });
    }
  });

  app.get("/api/lodgify/bookings", async (_req, res) => {
    try {
      const bookings = await storage.getLodgifyBookings();
      res.json(bookings);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch stored bookings", message: err.message });
    }
  });

  // ========== PROFITABILITY REPORTS ==========

  app.get("/api/reports/monthly", async (req, res) => {
    try {
      const year = parseInt(req.query.year as string, 10) || new Date().getFullYear();
      const month = parseInt(req.query.month as string, 10) || new Date().getMonth() + 1;

      const report = await storage.getMonthlyReport(year, month);
      const totalBuyInCost = report.buyIns.reduce((sum, b) => sum + parseFloat(b.costPaid || "0"), 0);
      const totalRevenue = report.bookings.reduce((sum, b) => sum + parseFloat(b.totalAmount || "0"), 0);

      res.json({
        year,
        month,
        totalBuyInCost,
        totalRevenue,
        profit: totalRevenue - totalBuyInCost,
        buyInCount: report.buyIns.length,
        bookingCount: report.bookings.length,
        buyIns: report.buyIns,
        bookings: report.bookings,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to generate report", message: err.message });
    }
  });

  app.get("/api/reports/summary", async (_req, res) => {
    try {
      const allBuyIns = await storage.getBuyIns();
      const allBookings = await storage.getLodgifyBookings();

      const totalBuyInCost = allBuyIns.reduce((sum, b) => sum + parseFloat(b.costPaid || "0"), 0);
      const totalRevenue = allBookings.reduce((sum, b) => sum + parseFloat(b.totalAmount || "0"), 0);
      const activeBuyIns = allBuyIns.filter(b => b.status === "active").length;

      const monthlyData: Record<string, { buyInCost: number; revenue: number; buyIns: number; bookings: number }> = {};
      for (const b of allBuyIns) {
        const key = b.checkIn ? b.checkIn.substring(0, 7) : "unknown";
        if (!monthlyData[key]) monthlyData[key] = { buyInCost: 0, revenue: 0, buyIns: 0, bookings: 0 };
        monthlyData[key].buyInCost += parseFloat(b.costPaid || "0");
        monthlyData[key].buyIns++;
      }
      for (const b of allBookings) {
        const key = b.checkIn ? b.checkIn.substring(0, 7) : "unknown";
        if (!monthlyData[key]) monthlyData[key] = { buyInCost: 0, revenue: 0, buyIns: 0, bookings: 0 };
        monthlyData[key].revenue += parseFloat(b.totalAmount || "0");
        monthlyData[key].bookings++;
      }

      res.json({
        totalBuyInCost,
        totalRevenue,
        totalProfit: totalRevenue - totalBuyInCost,
        totalBuyIns: allBuyIns.length,
        activeBuyIns,
        totalBookings: allBookings.length,
        monthlyBreakdown: Object.entries(monthlyData)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, data]) => ({ month, ...data, profit: data.revenue - data.buyInCost })),
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to generate summary", message: err.message });
    }
  });

  return httpServer;
}
