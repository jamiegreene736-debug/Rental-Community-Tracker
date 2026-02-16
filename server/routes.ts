import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
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
        const rateEntries = rates.map((rate: any) => {
          const monthIndex = MONTH_NAMES.indexOf(rate.month);
          const startDate = new Date(rate.year, monthIndex, 1);
          const endDate = new Date(rate.year, monthIndex + 1, 0);

          return {
            room_type_id: room.id,
            start_date: startDate.toISOString().split("T")[0],
            end_date: endDate.toISOString().split("T")[0],
            price_per_day: rate.sellRate,
            min_stay: typeof rate.minStay === "number" && rate.minStay > 0 ? rate.minStay : 5,
          };
        });

        const ratePayload = {
          property_id: parsedPropertyId,
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

  return httpServer;
}
