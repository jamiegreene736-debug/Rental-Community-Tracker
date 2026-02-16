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
    if (!foldersParam) {
      return res.status(400).json({ error: "Missing folders query parameter" });
    }

    const folders = foldersParam.split(",").map(f => f.replace(/[^a-zA-Z0-9_-]/g, "")).filter(Boolean);
    if (folders.length === 0) {
      return res.status(400).json({ error: "No valid folders specified" });
    }

    const zip = new JSZip();
    let totalFiles = 0;
    const photosBase = path.join(process.cwd(), "client", "public", "photos");

    for (const folder of folders) {
      const photosDir = path.join(photosBase, folder);
      if (!fs.existsSync(photosDir)) continue;
      const files = fs.readdirSync(photosDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
      for (const file of files) {
        const filePath = path.join(photosDir, file);
        const data = fs.readFileSync(filePath);
        zip.file(`${folder}/${file}`, data);
        totalFiles++;
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
        const periodRates = rates.map((rate: any) => {
          const monthIndex = MONTH_NAMES.indexOf(rate.month);
          const startDate = new Date(rate.year, monthIndex, 1);
          const endDate = new Date(rate.year, monthIndex + 1, 0);

          return {
            start: startDate.toISOString().split("T")[0],
            end: endDate.toISOString().split("T")[0],
            nightly: rate.sellRate,
            weekly: 0,
            monthly: 0,
            min_stay: typeof rate.minStay === "number" && rate.minStay > 0 ? rate.minStay : 5,
          };
        });

        const ratePayload = {
          house_id: parsedPropertyId,
          room_type_id: room.id,
          periods: periodRates,
        };

        const rateResponse = await fetch("https://api.lodgify.com/v1/rates/savewithoutavailability", {
          method: "PUT",
          headers: {
            "X-ApiKey": apiKey,
            "Content-Type": "application/json",
            "accept": "application/json",
          },
          body: JSON.stringify(ratePayload),
        });

        if (!rateResponse.ok) {
          const errorText = await rateResponse.text();
          let errorData;
          try {
            errorData = JSON.parse(errorText);
          } catch {
            errorData = { message: errorText };
          }
          results.push({
            roomTypeId: room.id,
            roomTypeName: room.name,
            success: false,
            error: errorData,
          });
          continue;
        }

        const resultText = await rateResponse.text();
        let parsedResult;
        try {
          parsedResult = JSON.parse(resultText);
        } catch {
          parsedResult = { raw: resultText };
        }

        results.push({
          roomTypeId: room.id,
          roomTypeName: room.name,
          success: true,
          periodsSubmitted: periodRates.length,
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
