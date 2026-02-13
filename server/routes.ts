import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
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

  return httpServer;
}
