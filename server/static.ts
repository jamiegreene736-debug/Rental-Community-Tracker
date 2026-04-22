import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Serve runtime photo writes (community-photo save, unit-swap rescrape, etc.)
  // directly from client/public/photos/ BEFORE the built dist. Otherwise new
  // photos written at runtime would be invisible until the next redeploy
  // (because Vite copies client/public → dist/public only at build time).
  const runtimePhotosPath = path.resolve(process.cwd(), "client/public/photos");
  if (fs.existsSync(runtimePhotosPath)) {
    app.use("/photos", express.static(runtimePhotosPath));
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
