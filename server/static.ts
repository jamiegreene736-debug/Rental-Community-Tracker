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

  app.use(
    express.static(distPath, {
      setHeaders: (res, filePath) => {
        // index.html references the content-hashed JS/CSS bundle filenames, so
        // it MUST always be revalidated. Without this, iOS standalone PWAs
        // (added-to-home-screen) pin a stale index.html across deploys and keep
        // loading the old bundle hash, so shipped UI changes never appear.
        // The hashed files under /assets are immutable and safe to cache long.
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    // Same no-cache reasoning as above: the SPA shell must never be cached, or
    // PWA/browser clients keep loading the previous deploy's bundle hash.
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
