import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertBuyInSchema, insertCommunityDraftSchema } from "@shared/schema";
import path from "path";
import fs from "fs";
import JSZip from "jszip";
import { chromium } from "playwright";
import { runAvailabilityScan, isScannerRunning, getScannableProperties, getCurrentScanPropertyId, getPropertyName } from "./availability-scanner";

// Hardcoded listing URLs per community. Primary is scraped first; fallback is tried if primary fails.
// All other communities fall back to Google Images search.
const COMMUNITY_SOURCE_URLS: Record<string, { primary: string; fallback?: string }> = {
  "Regency at Poipu Kai": {
    primary: "https://www.zillow.com/homedetails/1831-Poipu-Rd-APT-823-Koloa-HI-96756/80152954_zpid/",
    fallback: "https://www.homes.com/property/1831-poipu-rd-koloa-hi-unit-720/gy46glh43cckm/",
  },
};

// Maps communityPhotoFolder folder names to their display community names
const COMMUNITY_FOLDER_TO_NAME: Record<string, string> = {
  "community-regency-poipu-kai": "Regency at Poipu Kai",
  "community-kekaha-estate": "Kekaha Beachfront Estate",
  "community-keauhou-estates": "Keauhou Estates",
  "community-mauna-kai": "Mauna Kai Princeville",
  "community-kaha-lani": "Kaha Lani Resort",
  "community-lae-nani": "Lae Nani Resort",
  "community-poipu-beachside": "Poipu Brenneckes Beachside",
  "community-kaiulani": "Kaiulani of Princeville",
  "community-poipu-oceanfront": "Poipu Brenneckes Oceanfront",
  "community-pili-mai": "Pili Mai",
};

interface ScrapedPhoto {
  url: string;
  title: string;
  source: string;
  sourceLink: string;
}

async function scrapeListingPhotos(primaryUrl: string, fallbackUrl?: string): Promise<ScrapedPhoto[]> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    let navigatedUrl: string | null = null;

    // Try primary URL
    try {
      const resp = await page.goto(primaryUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
      if (resp && resp.status() < 400) navigatedUrl = primaryUrl;
    } catch (_) {}

    // Try fallback if primary failed
    if (!navigatedUrl && fallbackUrl) {
      try {
        const resp = await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
        if (resp && resp.status() < 400) navigatedUrl = fallbackUrl;
      } catch (_) {}
    }

    if (!navigatedUrl) return [];

    // Wait briefly for lazy-loaded images
    await page.waitForTimeout(2500);

    const currentUrl = page.url();
    const isZillow = currentUrl.includes("zillow.com");
    const isHomes = currentUrl.includes("homes.com");
    const sourceName = isZillow ? "Zillow" : isHomes ? "Homes.com" : new URL(currentUrl).hostname;

    let photoUrls: string[] = [];

    // --- Zillow: extract from __NEXT_DATA__ JSON blob (most reliable) ---
    if (isZillow) {
      photoUrls = await page.evaluate(() => {
        const nd = (window as any).__NEXT_DATA__;
        if (!nd) return [];
        const urls: string[] = [];

        function walk(obj: any, depth: number): void {
          if (depth > 14 || !obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) { obj.forEach(v => walk(v, depth + 1)); return; }
          // Zillow photo format: { mixedSources: { jpeg: [{url, width}, ...] } }
          if (obj.mixedSources?.jpeg && Array.isArray(obj.mixedSources.jpeg)) {
            const jpegs: Array<{ url: string; width?: number }> = obj.mixedSources.jpeg;
            if (jpegs.length > 0) {
              const biggest = jpegs.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a), jpegs[0]);
              if (biggest.url) urls.push(biggest.url);
            }
            return;
          }
          Object.values(obj).forEach(v => walk(v, depth + 1));
        }

        walk(nd, 0);
        return [...new Set(urls)];
      }).catch(() => [] as string[]);
    }

    // --- Homes.com / generic fallback: JSON-LD + img tags ---
    if (photoUrls.length === 0) {
      photoUrls = await page.evaluate(() => {
        const candidates: string[] = [];

        // JSON-LD structured data often has image arrays
        document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
          try {
            function pickImgs(obj: any): void {
              if (!obj || typeof obj !== "object") return;
              const imgs = obj.image ? (Array.isArray(obj.image) ? obj.image : [obj.image]) : [];
              imgs.forEach((img: any) => {
                if (typeof img === "string") candidates.push(img);
                else if (img?.url) candidates.push(img.url);
              });
              Object.values(obj).forEach(v => pickImgs(v));
            }
            pickImgs(JSON.parse(el.textContent || "{}"));
          } catch (_) {}
        });

        // img tags — collect src / data-src
        document.querySelectorAll("img").forEach(img => {
          const src = img.src || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || "";
          if (src.startsWith("http")) candidates.push(src);
        });

        return [...new Set(candidates)];
      }).catch(() => [] as string[]);
    }

    // Filter out icons/logos/SVGs/GIFs and format
    const results: ScrapedPhoto[] = photoUrls
      .filter(url => {
        const u = url.toLowerCase();
        return !u.endsWith(".svg") && !u.endsWith(".gif")
          && !u.includes("logo") && !u.includes("icon") && !u.includes("sprite")
          && !u.includes("placeholder") && url.startsWith("http");
      })
      .map(url => ({
        url,
        title: `${sourceName} listing photo`,
        source: sourceName,
        sourceLink: navigatedUrl!,
      }));

    return results;
  } finally {
    await browser.close();
  }
}

// ========== AI MAKEOVER JOB SYSTEM ==========
interface MakeoverJobPhoto {
  index: number;
  zipName: string;
  localPath: string;
  servePath: string;
  shouldProcess: boolean;
  status: "pending" | "processing" | "done" | "failed";
  resultBuffer?: Buffer;
}
interface MakeoverJob {
  name: string;
  status: "running" | "done" | "error";
  photos: MakeoverJobPhoto[];
  processedCount: number;
  totalCount: number;
  interiorCount: number;
  zipBuffer?: Buffer;
  error?: string;
  listeners: Set<any>;
  createdAt: number;
}
const makeoverJobs = new Map<string, MakeoverJob>();
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of makeoverJobs) {
    if (job.createdAt < cutoff) makeoverJobs.delete(id);
  }
}, 30 * 60 * 1000);

function emitJobEvent(jobId: string, data: object) {
  const job = makeoverJobs.get(jobId);
  if (!job) return;
  const line = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of job.listeners) { try { res.write(line); } catch (_) {} }
}

const EXTERIOR_KW = ["pool","community","exterior","outside","beach","ocean","view","patio","balcony","garden","yard","front","aerial","court","tennis","hot-tub","hottub","resort","grounds","walkway","entrance","driveway"];

// Any unit photo that isn't obviously exterior is treated as interior (makeover candidate).
// Generic filenames like photo_00.jpg default to interior since community/exterior photos
// are always served from the communityFolder (shouldProcess=false) not unit folders.
function isInteriorPhotoKw(filename: string): boolean {
  const lower = filename.toLowerCase();
  return !EXTERIOR_KW.some(k => lower.includes(k));
}

function getFilenamePromptKw(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes("bedroom") || lower.includes("master") || lower.includes("bed"))
    return "luxurious master bedroom, king bed with crisp white linens, coastal decor, bright natural light through large windows, modern furniture";
  if (lower.includes("kitchen"))
    return "modern vacation rental kitchen, white shaker cabinets, stainless steel appliances, quartz countertops, bright and clean, coastal style";
  if (lower.includes("bathroom") || lower.includes("bath"))
    return "luxury vacation rental bathroom, marble tiles, rainfall shower, modern fixtures, bright spa-like lighting";
  if (lower.includes("living") || lower.includes("lounge") || lower.includes("great"))
    return "elegant vacation rental living room, comfortable linen sofas, coastal modern decor, large windows with natural light, bright and airy";
  if (lower.includes("dining"))
    return "bright vacation rental dining room, wooden farmhouse table, upholstered chairs, pendant lighting, natural light";
  if (lower.includes("loft"))
    return "airy vacation rental loft space, comfortable seating, natural light from skylights, modern coastal decor";
  return "luxury vacation rental interior, modern coastal style, bright natural light, high-end furniture, professional real estate photography";
}

async function describeWithClaudeKw(imageBuffer: Buffer, mimeType: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022", max_tokens: 250,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBuffer.toString("base64") } },
          { type: "text", text: "Describe this vacation rental interior for an AI image generation prompt. Focus on: room type, furniture style, color palette, lighting, and overall aesthetic. Be specific, under 180 words, no preamble." },
        ]}],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return (data.content?.[0]?.text as string) || null;
  } catch { return null; }
}

async function generateWithStabilityKw(prompt: string): Promise<Buffer | null> {
  const key = process.env.STABILITY_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        text_prompts: [
          { text: `${prompt}, luxury vacation rental, professional real estate photography, bright natural light, 4K`, weight: 1 },
          { text: "low quality, blurry, dark, cluttered, people, text, watermark, bad anatomy", weight: -1 },
        ],
        cfg_scale: 7, height: 1024, width: 1024, samples: 1, steps: 30,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const b64 = data.artifacts?.[0]?.base64 as string | undefined;
    return b64 ? Buffer.from(b64, "base64") : null;
  } catch { return null; }
}

async function generateWithReplicateKw(prompt: string): Promise<Buffer | null> {
  const key = process.env.REPLICATE_API_KEY;
  if (!key) { console.error("[sdxl] No REPLICATE_API_KEY set"); return null; }
  try {
    const createResp = await fetch("https://api.replicate.com/v1/models/stability-ai/sdxl/predictions", {
      method: "POST",
      headers: { "Authorization": `Token ${key}`, "Content-Type": "application/json", "Prefer": "wait=60" },
      body: JSON.stringify({
        input: {
          prompt: `${prompt}, luxury vacation rental, professional real estate photography, bright natural light, 4K high resolution`,
          negative_prompt: "low quality, blurry, dark, cluttered, people, text, watermark, deformed",
          width: 1024, height: 1024, num_inference_steps: 25, guidance_scale: 7.5, scheduler: "K_EULER",
        },
      }),
    });
    if (!createResp.ok) {
      const errText = await createResp.text();
      console.error("[sdxl] Create failed:", createResp.status, errText);
      return null;
    }
    const prediction = await createResp.json() as { id?: string; status: string; output?: string[] | string; error?: string };
    console.log("[sdxl] Prediction response: status=", prediction.status, "id=", prediction.id, "error=", prediction.error, "output=", JSON.stringify(prediction.output)?.substring(0, 120));
    if (prediction.error) { console.error("[sdxl] Prediction error:", prediction.error); return null; }
    const extractUrl = (output: string[] | string | undefined): string | null => {
      if (!output) return null;
      if (Array.isArray(output)) return output[0] || null;
      if (typeof output === "string") return output;
      return null;
    };
    const downloadUrl = (status: string, output: string[] | string | undefined): string | null =>
      status === "succeeded" ? extractUrl(output) : null;
    const immediateUrl = downloadUrl(prediction.status, prediction.output);
    if (immediateUrl) {
      console.log("[sdxl] Immediate success, downloading from:", immediateUrl.substring(0, 80));
      const imgResp = await fetch(immediateUrl);
      if (!imgResp.ok) { console.error("[sdxl] Image download failed:", imgResp.status); return null; }
      return Buffer.from(await imgResp.arrayBuffer());
    }
    if (prediction.id) {
      console.log("[sdxl] Polling prediction:", prediction.id);
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
          headers: { "Authorization": `Token ${key}` },
        });
        const result = await pollResp.json() as { status: string; output?: string[] | string; error?: string };
        if (i % 10 === 0) console.log("[sdxl] Poll", i, "status=", result.status);
        if (result.error) { console.error("[sdxl] Poll error:", result.error); return null; }
        const pollUrl = downloadUrl(result.status, result.output);
        if (pollUrl) {
          console.log("[sdxl] Poll success at attempt", i, ", downloading");
          const imgResp = await fetch(pollUrl);
          if (!imgResp.ok) { console.error("[sdxl] Poll image download failed:", imgResp.status); return null; }
          return Buffer.from(await imgResp.arrayBuffer());
        }
        if (result.status === "failed" || result.status === "canceled") {
          console.error("[sdxl] Prediction failed/canceled at poll", i);
          return null;
        }
      }
      console.error("[sdxl] Timed out after 120s polling");
    }
    return null;
  } catch (err: any) {
    console.error("[sdxl] Exception:", err?.message || err);
    return null;
  }
}

async function upscaleWithReplicateKw(imageBuffer: Buffer, mimeType: string): Promise<Buffer | null> {
  const key = process.env.REPLICATE_API_KEY;
  if (!key) return null;
  try {
    const b64 = imageBuffer.toString("base64");
    const dataUri = `data:${mimeType};base64,${b64}`;
    const createResp = await fetch("https://api.replicate.com/v1/models/nightmareai/real-esrgan/predictions", {
      method: "POST",
      headers: { "Authorization": `Token ${key}`, "Content-Type": "application/json", "Prefer": "wait=60" },
      body: JSON.stringify({ input: { image: dataUri, scale: 2, face_enhance: false } }),
    });
    if (!createResp.ok) {
      console.error("[upscale] Replicate Real-ESRGAN error:", createResp.status, await createResp.text());
      return null;
    }
    const prediction = await createResp.json() as { id?: string; status: string; output?: string; error?: string };
    const resolveOutput = async (p: typeof prediction): Promise<Buffer | null> => {
      if (p.status === "succeeded" && p.output) {
        const imgResp = await fetch(p.output);
        if (!imgResp.ok) return null;
        return Buffer.from(await imgResp.arrayBuffer());
      }
      return null;
    };
    const quick = await resolveOutput(prediction);
    if (quick) return quick;
    if (prediction.id) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
          headers: { "Authorization": `Token ${key}` },
        });
        const result = await pollResp.json() as { status: string; output?: string; error?: string };
        if (result.status === "succeeded" && result.output) {
          const imgResp = await fetch(result.output);
          if (!imgResp.ok) return null;
          return Buffer.from(await imgResp.arrayBuffer());
        }
        if (result.status === "failed") { console.error("[upscale] Real-ESRGAN failed:", result.error); return null; }
      }
    }
    return null;
  } catch (err) { console.error("[upscale] exception:", err); return null; }
}

async function processPhotoWithAIKw(imageBuffer: Buffer, mimeType: string, filename: string): Promise<Buffer | null> {
  const claudeDesc = await describeWithClaudeKw(imageBuffer, mimeType);
  const prompt = claudeDesc || getFilenamePromptKw(filename);
  console.log(`[makeover-job] ${filename} → prompt: ${prompt.substring(0, 80)}...`);
  const generated = await (async () => {
    const stability = await generateWithStabilityKw(prompt);
    if (stability) return stability;
    return generateWithReplicateKw(prompt);
  })();
  if (!generated) return null;
  // Upscale the generated image 2x for higher resolution output
  console.log(`[makeover-job] ${filename} → upscaling 2x...`);
  const upscaled = await upscaleWithReplicateKw(generated, "image/jpeg");
  return upscaled || generated;
}

async function runMakeoverJob(jobId: string): Promise<void> {
  const job = makeoverJobs.get(jobId);
  if (!job) return;
  try {
    const zip = new JSZip();
    for (const photo of job.photos) {
      if (!fs.existsSync(photo.localPath)) {
        photo.status = "failed";
        emitJobEvent(jobId, { type: "photo_done", index: photo.index, status: "failed", hasResult: false, processedCount: job.processedCount });
        continue;
      }
      const rawData = fs.readFileSync(photo.localPath);
      const ext = path.extname(photo.localPath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
      if (photo.shouldProcess) {
        photo.status = "processing";
        emitJobEvent(jobId, { type: "photo_start", index: photo.index, total: job.totalCount, zipName: photo.zipName, servePath: photo.servePath });
        const result = await processPhotoWithAIKw(rawData, mimeType, photo.zipName);
        if (result) {
          photo.resultBuffer = result;
          photo.status = "done";
          job.processedCount++;
          zip.file(photo.zipName.replace(/\.(jpg|jpeg|png)$/i, ".jpg"), result);
        } else {
          photo.status = "failed";
          zip.file(photo.zipName, rawData);
        }
      } else {
        // Upscale community/exterior photos too — same 2x Real-ESRGAN pass
        const upscaled = await upscaleWithReplicateKw(rawData, mimeType);
        photo.status = "done";
        zip.file(photo.zipName.replace(/\.(jpg|jpeg|png)$/i, ".jpg"), upscaled || rawData);
      }
      emitJobEvent(jobId, { type: "photo_done", index: photo.index, status: photo.status, hasResult: !!photo.resultBuffer, processedCount: job.processedCount });
    }
    job.zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    job.status = "done";
    emitJobEvent(jobId, { type: "complete", processedCount: job.processedCount, totalCount: job.totalCount, interiorCount: job.interiorCount });
  } catch (err: any) {
    job.status = "error";
    job.error = err.message;
    emitJobEvent(jobId, { type: "error", message: err.message });
  }
  for (const res of job.listeners) { try { res.end(); } catch (_) {} }
  job.listeners.clear();
}

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

  // AI photo makeover: uses Claude vision to describe each interior photo, then generates
  // a new luxury-style version via Stability AI or Replicate SDXL. Returns a ZIP.
  app.post("/api/photos/ai-makeover", async (req, res) => {
    const replicateKey = process.env.REPLICATE_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const stabilityKey = process.env.STABILITY_API_KEY;

    if (!replicateKey && !stabilityKey) {
      return res.status(500).json({ error: "No AI image generation API key configured (need REPLICATE_API_KEY or STABILITY_API_KEY)" });
    }

    const { folders, communityFolder, beginningPhotos, endPhotos, name } = req.body as {
      folders: string[];
      communityFolder?: string;
      beginningPhotos?: string[];
      endPhotos?: string[];
      name?: string;
    };

    if (!folders || folders.length === 0) {
      return res.status(400).json({ error: "No folders provided" });
    }

    const photosBase = path.join(process.cwd(), "client", "public", "photos");

    // Interior keywords → these photos get AI treatment
    const interiorKeywords = ["living", "bedroom", "kitchen", "dining", "bathroom", "lounge", "family", "master", "bed", "bath", "office", "room", "interior", "sofa", "couch", "great-room", "great_room", "greatroom", "overview", "detail", "area", "space", "hallway", "foyer", "entry", "loft"];
    // Exterior keywords → pass through unchanged
    const exteriorKeywords = ["pool", "community", "exterior", "outside", "beach", "ocean", "view", "patio", "balcony", "garden", "yard", "front", "aerial", "court", "tennis", "hot-tub", "hottub"];

    function isInteriorWithFurniture(filename: string): boolean {
      const lower = filename.toLowerCase();
      if (exteriorKeywords.some(k => lower.includes(k))) return false;
      return interiorKeywords.some(k => lower.includes(k));
    }

    function getFilenamePrompt(filename: string): string {
      const lower = filename.toLowerCase();
      if (lower.includes("bedroom") || lower.includes("master") || lower.includes("bed"))
        return "luxurious master bedroom, king bed with crisp white linens, coastal decor, bright natural light through large windows, modern furniture";
      if (lower.includes("kitchen"))
        return "modern vacation rental kitchen, white shaker cabinets, stainless steel appliances, quartz countertops, bright and clean, coastal style";
      if (lower.includes("bathroom") || lower.includes("bath"))
        return "luxury vacation rental bathroom, marble tiles, rainfall shower, modern fixtures, bright spa-like lighting";
      if (lower.includes("living") || lower.includes("lounge") || lower.includes("great"))
        return "elegant vacation rental living room, comfortable linen sofas, coastal modern decor, large windows with natural light, bright and airy";
      if (lower.includes("dining"))
        return "bright vacation rental dining room, wooden farmhouse table, upholstered chairs, pendant lighting, natural light";
      if (lower.includes("loft"))
        return "airy vacation rental loft space, comfortable seating, natural light from skylights, modern coastal decor";
      return "luxury vacation rental interior, modern coastal style, bright natural light, high-end furniture, professional real estate photography";
    }

    // --- Step 1: Describe image with Claude vision (optional enhancement) ---
    async function describeWithClaude(imageBuffer: Buffer, mimeType: string): Promise<string | null> {
      if (!anthropicKey) return null;
      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 250,
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mimeType, data: imageBuffer.toString("base64") } },
                { type: "text", text: "Describe this vacation rental interior for an AI image generation prompt. Focus on: room type, furniture style, color palette, lighting, and overall aesthetic. Be specific, under 180 words, no preamble." },
              ],
            }],
          }),
        });
        if (!resp.ok) return null;
        const data = await resp.json() as any;
        return (data.content?.[0]?.text as string) || null;
      } catch {
        return null;
      }
    }

    // --- Step 2a: Generate with Stability AI ---
    async function generateWithStabilityAI(prompt: string): Promise<Buffer | null> {
      if (!stabilityKey) return null;
      try {
        const resp = await fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": `Bearer ${stabilityKey}`,
          },
          body: JSON.stringify({
            text_prompts: [
              { text: `${prompt}, luxury vacation rental, professional real estate photography, bright natural light, 4K`, weight: 1 },
              { text: "low quality, blurry, dark, cluttered, people, text, watermark, bad anatomy", weight: -1 },
            ],
            cfg_scale: 7,
            height: 1024,
            width: 1024,
            samples: 1,
            steps: 30,
          }),
        });
        if (!resp.ok) {
          console.error("Stability AI error:", resp.status, await resp.text());
          return null;
        }
        const data = await resp.json() as any;
        const b64 = data.artifacts?.[0]?.base64 as string | undefined;
        return b64 ? Buffer.from(b64, "base64") : null;
      } catch (err) {
        console.error("Stability AI exception:", err);
        return null;
      }
    }

    // --- Step 2b: Generate with Replicate SDXL text-to-image ---
    async function generateWithReplicate(prompt: string): Promise<Buffer | null> {
      if (!replicateKey) return null;
      try {
        const createResp = await fetch("https://api.replicate.com/v1/models/stability-ai/sdxl/predictions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${replicateKey}`,
            "Content-Type": "application/json",
            "Prefer": "wait=60",
          },
          body: JSON.stringify({
            input: {
              prompt: `${prompt}, luxury vacation rental, professional real estate photography, bright natural light, 4K high resolution`,
              negative_prompt: "low quality, blurry, dark, cluttered, people, text, watermark, deformed",
              width: 1024,
              height: 1024,
              num_inference_steps: 25,
              guidance_scale: 7.5,
              scheduler: "K_EULER",
            },
          }),
        });

        if (!createResp.ok) {
          console.error("Replicate SDXL error:", createResp.status, await createResp.text());
          return null;
        }

        const prediction = await createResp.json() as { id?: string; status: string; output?: string[]; error?: string };

        // Synchronous success (Prefer: wait hit)
        if (prediction.status === "succeeded" && prediction.output?.length) {
          const imgResp = await fetch(prediction.output[0]);
          if (!imgResp.ok) return null;
          return Buffer.from(await imgResp.arrayBuffer());
        }

        // Fall back to polling if still processing
        if (prediction.id) {
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
              headers: { "Authorization": `Bearer ${replicateKey}` },
            });
            const result = await pollResp.json() as { status: string; output?: string[]; error?: string };
            if (result.status === "succeeded" && result.output?.length) {
              const imgResp = await fetch(result.output[0]);
              if (!imgResp.ok) return null;
              return Buffer.from(await imgResp.arrayBuffer());
            }
            if (result.status === "failed") {
              console.error("Replicate prediction failed:", result.error);
              return null;
            }
          }
        }
        return null;
      } catch (err) {
        console.error("Replicate exception:", err);
        return null;
      }
    }

    // --- Orchestrate: describe → generate ---
    async function processPhotoWithAI(imageBuffer: Buffer, mimeType: string, filename: string): Promise<Buffer | null> {
      // Get a description from Claude if available, otherwise derive from filename
      const claudeDesc = await describeWithClaude(imageBuffer, mimeType);
      const prompt = claudeDesc || getFilenamePrompt(filename);
      console.log(`[ai-makeover] ${filename} → prompt: ${prompt.substring(0, 80)}...`);

      // Try Stability AI first, then fall back to Replicate
      const stabilityResult = await generateWithStabilityAI(prompt);
      if (stabilityResult) return stabilityResult;

      return await generateWithReplicate(prompt);
    }

    // Collect all image file paths with their desired ZIP names
    interface PhotoEntry {
      filePath: string;
      zipName: string;
      shouldProcess: boolean;
    }

    const allPhotos: PhotoEntry[] = [];
    let globalIndex = 1;

    // Community beginning photos (never process — resort amenities)
    if (communityFolder && beginningPhotos && beginningPhotos.length > 0) {
      const communityDir = path.join(photosBase, communityFolder);
      for (const photo of beginningPhotos) {
        const safePhoto = photo.replace(/[^a-zA-Z0-9_.-]/g, "");
        const paddedIndex = String(globalIndex).padStart(3, "0");
        const ext = path.extname(safePhoto);
        const baseName = path.basename(safePhoto, ext).replace(/^\d+-/, "");
        allPhotos.push({ filePath: path.join(communityDir, safePhoto), zipName: `${paddedIndex}-community-${baseName}${ext}`, shouldProcess: false });
        globalIndex++;
      }
    }

    // Unit photos
    for (const folder of folders) {
      const safeFolder = folder.replace(/[^a-zA-Z0-9_-]/g, "");
      const photosDir = path.join(photosBase, safeFolder);
      if (!fs.existsSync(photosDir)) continue;
      const files = fs.readdirSync(photosDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
      for (const file of files) {
        const paddedIndex = String(globalIndex).padStart(3, "0");
        const ext = path.extname(file);
        const baseName = path.basename(file, ext).replace(/^\d+-/, "");
        allPhotos.push({ filePath: path.join(photosDir, file), zipName: `${paddedIndex}-${safeFolder}-${baseName}${ext}`, shouldProcess: isInteriorWithFurniture(file) });
        globalIndex++;
      }
    }

    // Community end photos (never process)
    if (communityFolder && endPhotos && endPhotos.length > 0) {
      const communityDir = path.join(photosBase, communityFolder);
      for (const photo of endPhotos) {
        const safePhoto = photo.replace(/[^a-zA-Z0-9_.-]/g, "");
        const paddedIndex = String(globalIndex).padStart(3, "0");
        const ext = path.extname(safePhoto);
        const baseName = path.basename(safePhoto, ext).replace(/^\d+-/, "");
        allPhotos.push({ filePath: path.join(photosBase, communityFolder, safePhoto), zipName: `${paddedIndex}-community-${baseName}${ext}`, shouldProcess: false });
        globalIndex++;
      }
    }

    const validPhotos = allPhotos.filter(p => fs.existsSync(p.filePath));
    if (validPhotos.length === 0) {
      return res.status(404).json({ error: "No photos found" });
    }

    const processCount = validPhotos.filter(p => p.shouldProcess).length;
    res.setHeader("X-Photos-Total", String(validPhotos.length));
    res.setHeader("X-Photos-Processing", String(processCount));

    // Process all photos
    const zip = new JSZip();
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const photo of validPhotos) {
      const rawData = fs.readFileSync(photo.filePath);
      const ext = path.extname(photo.filePath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : "image/jpeg";

      if (photo.shouldProcess) {
        console.log(`[ai-makeover] Processing: ${photo.zipName}`);
        const result = await processPhotoWithAI(rawData, mimeType, photo.zipName);
        if (result) {
          zip.file(photo.zipName.replace(/\.(jpg|jpeg|png)$/i, ".jpg"), result);
          processed++;
        } else {
          zip.file(photo.zipName, rawData);
          failed++;
          console.warn(`[ai-makeover] Fell back to original for: ${photo.zipName}`);
        }
      } else {
        zip.file(photo.zipName, rawData);
        skipped++;
      }
    }

    console.log(`[ai-makeover] Done: ${processed} AI-generated, ${skipped} passed through, ${failed} fell back to original`);

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const safeName = (name || "ai-makeover").replace(/[^a-zA-Z0-9_-]/g, "");
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeName}-ai-makeover.zip"`,
      "Content-Length": String(zipBuffer.length),
      "X-Photos-Processed": String(processed),
      "X-Photos-Skipped": String(skipped),
      "X-Photos-Failed": String(failed),
    });
    res.send(zipBuffer);
  });

  // ========== JOB-BASED AI MAKEOVER (SSE progress) ==========
  app.post("/api/photos/ai-makeover/start", async (req, res) => {
    const { folders, communityFolder, beginningPhotos, endPhotos, name } = req.body as {
      folders: string[];
      communityFolder?: string;
      beginningPhotos?: string[];
      endPhotos?: string[];
      name?: string;
    };
    if (!folders || folders.length === 0) return res.status(400).json({ error: "No folders provided" });

    const photosBase = path.join(process.cwd(), "client", "public", "photos");
    const allPhotos: MakeoverJobPhoto[] = [];
    let globalIndex = 0;

    if (communityFolder && beginningPhotos && beginningPhotos.length > 0) {
      const communityDir = path.join(photosBase, communityFolder);
      for (const photo of beginningPhotos) {
        const safePhoto = photo.replace(/[^a-zA-Z0-9_.-]/g, "");
        const ext = path.extname(safePhoto);
        const baseName = path.basename(safePhoto, ext).replace(/^\d+-/, "");
        const paddedIndex = String(globalIndex + 1).padStart(3, "0");
        allPhotos.push({ index: globalIndex++, zipName: `${paddedIndex}-community-${baseName}${ext}`, localPath: path.join(communityDir, safePhoto), servePath: `/photos/${communityFolder}/${safePhoto}`, shouldProcess: false, status: "pending" });
      }
    }
    for (const folder of folders) {
      const safeFolder = folder.replace(/[^a-zA-Z0-9_-]/g, "");
      const photosDir = path.join(photosBase, safeFolder);
      if (!fs.existsSync(photosDir)) continue;
      const files = fs.readdirSync(photosDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
      for (const file of files) {
        const ext = path.extname(file);
        const baseName = path.basename(file, ext).replace(/^\d+-/, "");
        const paddedIndex = String(globalIndex + 1).padStart(3, "0");
        allPhotos.push({ index: globalIndex++, zipName: `${paddedIndex}-${safeFolder}-${baseName}${ext}`, localPath: path.join(photosDir, file), servePath: `/photos/${safeFolder}/${file}`, shouldProcess: isInteriorPhotoKw(file), status: "pending" });
      }
    }
    if (communityFolder && endPhotos && endPhotos.length > 0) {
      const communityDir = path.join(photosBase, communityFolder);
      for (const photo of endPhotos) {
        const safePhoto = photo.replace(/[^a-zA-Z0-9_.-]/g, "");
        const ext = path.extname(safePhoto);
        const baseName = path.basename(safePhoto, ext).replace(/^\d+-/, "");
        const paddedIndex = String(globalIndex + 1).padStart(3, "0");
        allPhotos.push({ index: globalIndex++, zipName: `${paddedIndex}-community-${baseName}${ext}`, localPath: path.join(photosBase, communityFolder, safePhoto), servePath: `/photos/${communityFolder}/${safePhoto}`, shouldProcess: false, status: "pending" });
      }
    }

    const interiorCount = allPhotos.filter(p => p.shouldProcess).length;
    const jobId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const job: MakeoverJob = { name: name || "ai-makeover", status: "running", photos: allPhotos, processedCount: 0, totalCount: allPhotos.length, interiorCount, listeners: new Set(), createdAt: Date.now() };
    makeoverJobs.set(jobId, job);
    runMakeoverJob(jobId).catch(err => {
      const j = makeoverJobs.get(jobId);
      if (j) { j.status = "error"; j.error = err.message; }
    });
    res.json({ jobId, totalCount: allPhotos.length, interiorCount, photos: allPhotos.map(p => ({ index: p.index, zipName: p.zipName, servePath: p.servePath, isInterior: p.shouldProcess })) });
  });

  app.get("/api/photos/ai-makeover/events/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = makeoverJobs.get(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    for (const photo of job.photos) {
      if (photo.status !== "pending") {
        res.write(`data: ${JSON.stringify({ type: "photo_done", index: photo.index, status: photo.status, hasResult: !!photo.resultBuffer, processedCount: job.processedCount })}\n\n`);
      }
    }
    if (job.status === "done") {
      res.write(`data: ${JSON.stringify({ type: "complete", processedCount: job.processedCount, totalCount: job.totalCount, interiorCount: job.interiorCount })}\n\n`);
      res.end(); return;
    }
    if (job.status === "error") {
      res.write(`data: ${JSON.stringify({ type: "error", message: job.error })}\n\n`);
      res.end(); return;
    }
    job.listeners.add(res);
    const keepAlive = setInterval(() => { try { res.write(":keep-alive\n\n"); } catch (_) {} }, 15000);
    req.on("close", () => { clearInterval(keepAlive); job.listeners.delete(res); });
  });

  app.get("/api/photos/ai-makeover/result/:jobId/photo/:index", (req, res) => {
    const { jobId, index } = req.params;
    const job = makeoverJobs.get(jobId);
    if (!job) return res.status(404).end();
    const photo = job.photos[parseInt(index, 10)];
    if (!photo || !photo.resultBuffer) return res.status(404).end();
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(photo.resultBuffer);
  });

  app.get("/api/photos/ai-makeover/download/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = makeoverJobs.get(jobId);
    if (!job || !job.zipBuffer) return res.status(job ? 202 : 404).json({ error: job ? "Still processing" : "Not found" });
    const safeName = job.name.replace(/[^a-zA-Z0-9_-]/g, "");
    res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${safeName}-ai-makeover.zip"`, "Content-Length": String(job.zipBuffer.length) });
    res.send(job.zipBuffer);
  });

  app.get("/api/photos/find-replacement", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SearchAPI not configured" });
    const { communityName, location, bedrooms } = req.query as Record<string, string>;
    if (!communityName || !location) return res.status(400).json({ error: "communityName and location required" });
    try {
      const bedroomsLabel = bedrooms ? `${bedrooms} bedroom ` : "";
      const query = `${bedroomsLabel}${communityName} ${location} vacation rental condo interior`;
      const params = new URLSearchParams({ engine: "google_images", q: query, api_key: apiKey, num: "20", safe: "active" });
      const response = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
      if (!response.ok) return res.status(500).json({ error: "Image search failed" });
      const data = await response.json() as any;
      const images = (data.images_results || [])
        .filter((img: any) => { const src = (img.original || img.thumbnail || "").toLowerCase(); return !src.includes("airbnb") && !src.includes("vrbo") && !src.includes("booking.com") && src; })
        .slice(0, 12)
        .map((img: any) => ({ url: img.original || img.thumbnail, thumbnail: img.thumbnail || img.original, label: img.title || "Replacement photo", source: img.source || "" }));
      res.json({ images });
    } catch (err: any) { res.status(500).json({ error: "Find replacement failed", message: err.message }); }
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

          const formatSpDate = (dateStr: string) => {
            const [y, m, d] = dateStr.split("-");
            return `${m}/${d}/${y}`;
          };
          const spSearchUrl = spSlug
            ? `https://www.suite-paradise.com/${spSlug}?check_in=${formatSpDate(checkIn)}&check_out=${formatSpDate(checkOut)}`
            : null;

          suiteParadiseResults[`${bedrooms}BR`] = {
            count,
            totalResults: spListings.length,
            properties: spListings.slice(0, 10),
            searchUrl: spSearchUrl,
            note: spListings.length === 0
              ? (spSlug ? "Suite Paradise listings can't be searched automatically. Use the link below to search their site directly — they often have great deals for booking direct." : "Suite Paradise may not have listings in this community.")
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

  app.get("/api/photo-audit/check-vrbo", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "SearchAPI.io API key not configured" });
    }

    const unitNumber = req.query.unitNumber as string;
    const complexName = req.query.complexName as string;
    if (!unitNumber || !complexName) {
      return res.status(400).json({ error: "Missing unitNumber or complexName" });
    }

    try {
      const query = `${complexName} ${unitNumber} VRBO site:vrbo.com`;
      const params = new URLSearchParams({
        engine: "google",
        q: query,
        api_key: apiKey,
        num: "5",
      });

      const response = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
      if (!response.ok) {
        return res.status(500).json({ error: `Search failed with status ${response.status}` });
      }

      const data = await response.json() as any;
      const organicResults = data.organic_results || [];

      const vrboListings = organicResults
        .filter((r: any) => {
          const url = (r.link || "").toLowerCase();
          const snippet = (r.snippet || "").toLowerCase();
          const title = (r.title || "").toLowerCase();
          return url.includes("vrbo.com") && (
            snippet.includes(unitNumber) ||
            title.includes(unitNumber) ||
            title.includes(`#${unitNumber}`)
          );
        })
        .map((r: any) => ({
          title: r.title,
          url: r.link,
          snippet: r.snippet,
        }));

      const otherCompanies = ["parrish", "kauai exclusive", "cb island", "elite pacific", "gather", "ali'i resorts"];
      const hasConflict = vrboListings.some((listing: any) => {
        const text = `${listing.title} ${listing.snippet}`.toLowerCase();
        return otherCompanies.some(company => text.includes(company));
      });

      res.json({
        unitNumber,
        complexName,
        vrboListings,
        hasConflict,
        isListedOnVrbo: vrboListings.length > 0,
        checkedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: "VRBO check failed", message: err.message });
    }
  });

  app.get("/api/photo-audit/find-non-vrbo", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "SearchAPI.io API key not configured" });
    }

    const complexName = req.query.complexName as string;
    const bedrooms = req.query.bedrooms as string;
    if (!complexName || !bedrooms) {
      return res.status(400).json({ error: "Missing complexName or bedrooms" });
    }

    try {
      const searchQuery = `${bedrooms} bedroom ${complexName} Kauai rentals -site:vrbo.com -site:airbnb.com`;
      const searchParams = new URLSearchParams({
        engine: "google",
        q: searchQuery,
        api_key: apiKey,
        num: "15",
      });

      const searchResponse = await fetch(`https://www.searchapi.io/api/v1/search?${searchParams.toString()}`);
      if (!searchResponse.ok) {
        return res.status(500).json({ error: `Search failed: ${searchResponse.status}` });
      }

      const searchData = await searchResponse.json() as any;
      const candidates = (searchData.organic_results || [])
        .filter((r: any) => {
          const url = (r.link || "").toLowerCase();
          return !url.includes("vrbo.com") && !url.includes("airbnb.com");
        })
        .slice(0, 10)
        .map((r: any) => ({
          title: r.title,
          url: r.link,
          snippet: r.snippet,
          source: new URL(r.link).hostname,
        }));

      const unitPattern = /(?:#|unit\s*|room\s*)(\w+)/gi;
      const candidatesWithUnits = candidates.map((c: any) => {
        const text = `${c.title} ${c.snippet}`;
        const matches = [...text.matchAll(unitPattern)];
        const unitNumbers = [...new Set(matches.map(m => m[1]))];
        return { ...c, extractedUnits: unitNumbers };
      });

      const verified: any[] = [];
      for (const candidate of candidatesWithUnits) {
        if (candidate.extractedUnits.length === 0) {
          verified.push({ ...candidate, vrboStatus: "no_unit_number" });
          continue;
        }

        for (const unitNum of candidate.extractedUnits.slice(0, 2)) {
          const vrboQuery = `${complexName} ${unitNum} site:vrbo.com`;
          const vrboParams = new URLSearchParams({
            engine: "google",
            q: vrboQuery,
            api_key: apiKey,
            num: "5",
          });

          await new Promise(r => setTimeout(r, 500));

          try {
            const vrboResponse = await fetch(`https://www.searchapi.io/api/v1/search?${vrboParams.toString()}`);
            if (vrboResponse.ok) {
              const vrboData = await vrboResponse.json() as any;
              const vrboResults = (vrboData.organic_results || []).filter((r: any) => {
                const url = (r.link || "").toLowerCase();
                const title = (r.title || "").toLowerCase();
                return url.includes("vrbo.com") && (title.includes(unitNum.toLowerCase()) || title.includes(`#${unitNum.toLowerCase()}`));
              });

              verified.push({
                ...candidate,
                checkedUnit: unitNum,
                vrboStatus: vrboResults.length > 0 ? "on_vrbo" : "not_on_vrbo",
                vrboMatches: vrboResults.length,
              });
            }
          } catch {
            verified.push({ ...candidate, checkedUnit: unitNum, vrboStatus: "check_failed" });
          }
        }
      }

      const safeUnits = verified.filter(v => v.vrboStatus === "not_on_vrbo");
      const onVrbo = verified.filter(v => v.vrboStatus === "on_vrbo");

      res.json({
        complexName,
        bedrooms,
        totalCandidates: candidates.length,
        verified,
        safeUnits,
        onVrboCount: onVrbo.length,
        safeCount: safeUnits.length,
        checkedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: "Search failed", message: err.message });
    }
  });

  app.get("/api/scanner/properties", async (_req, res) => {
    res.json(getScannableProperties());
  });

  app.post("/api/scanner/run", async (req, res) => {
    if (isScannerRunning()) {
      return res.status(409).json({ error: "A scan is already running" });
    }
    let propertyId: number | undefined;
    if (req.body?.propertyId) {
      propertyId = parseInt(req.body.propertyId);
      if (isNaN(propertyId)) {
        return res.status(400).json({ error: "Invalid propertyId" });
      }
      const validIds = getScannableProperties().map(p => p.id);
      if (!validIds.includes(propertyId)) {
        return res.status(400).json({ error: `Property ${propertyId} is not a scannable listing` });
      }
    }
    let lodgifyPropertyId: number | undefined;
    if (req.body?.lodgifyPropertyId) {
      lodgifyPropertyId = parseInt(req.body.lodgifyPropertyId);
      if (isNaN(lodgifyPropertyId)) {
        return res.status(400).json({ error: "Invalid lodgifyPropertyId" });
      }
    }
    const weeksAhead = 52;
    runAvailabilityScan(weeksAhead, propertyId, lodgifyPropertyId).catch(err => {
      console.error("Scanner run error:", err);
    });
    const label = propertyId ? getPropertyName(propertyId) : "all properties";
    res.json({ message: `Scan started for ${label}`, weeksAhead, propertyId, lodgifyPropertyId });
  });

  app.get("/api/scanner/status", async (_req, res) => {
    try {
      const latest = await storage.getLatestScannerRun();
      res.json({
        running: isScannerRunning(),
        currentPropertyId: getCurrentScanPropertyId(),
        latestRun: latest || null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/scanner/runs", async (_req, res) => {
    try {
      const runs = await storage.getScannerRuns(20);
      res.json(runs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // List actual files in a community photo folder (dynamic — doesn't rely on hardcoded data)
  app.get("/api/photos/community-files", async (req, res) => {
    const folder = (req.query.folder as string || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!folder) return res.status(400).json({ error: "Missing folder" });
    const folderPath = path.join(process.cwd(), "client/public/photos", folder);
    try {
      const files = await fs.promises.readdir(folderPath).catch(() => []);
      const imageFiles = files
        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .sort();
      res.json({ folder, files: imageFiles });
    } catch {
      res.json({ folder, files: [] });
    }
  });

  // Community Photo Finder
  app.get("/api/community-photos/search", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "SearchAPI.io API key not configured" });
    }

    const communityName = req.query.communityName as string;
    if (!communityName || !communityName.trim()) {
      return res.status(400).json({ error: "Missing communityName parameter" });
    }

    const name = communityName.trim();

    // --- If this community has a hardcoded listing URL, scrape it directly ---
    const sourceConfig = COMMUNITY_SOURCE_URLS[name];
    if (sourceConfig) {
      try {
        const scraped = await scrapeListingPhotos(sourceConfig.primary, sourceConfig.fallback);
        if (scraped.length > 0) {
          const results = scraped.map((p, i) => ({
            url: p.url,
            thumbnail: p.url,
            title: p.title,
            source: p.source,
            sourceLink: p.sourceLink,
            score: 100 - i, // preserve order, high score so they sort first
          }));
          return res.json({ communityName: name, results, totalFound: results.length, source: "listing" });
        }
        // Scraped but got nothing — fall through to Google Images search
      } catch (err: any) {
        console.warn(`[community-photos] Scraping failed for ${name}, falling back to search:`, err.message);
        // Fall through to search below
      }
    }

    // Known aliases / extra terms that help narrow results to the specific community
    const COMMUNITY_EXTRAS: Record<string, string> = {
      "Regency at Poipu Kai": "Poipu Kai resort Kauai",
      "Kekaha Beachfront Estate": "Kekaha Kauai beachfront",
      "Keauhou Estates": "Keauhou Kona Hawaii",
      "Mauna Kai Princeville": "Princeville Kauai resort",
      "Kaha Lani Resort": "Kapaa Kauai resort",
      "Lae Nani Resort": "Kapaa Kauai oceanfront",
      "Poipu Brenneckes Beachside": "Poipu Beach Kauai",
      "Kaiulani of Princeville": "Princeville Kauai",
      "Poipu Brenneckes Oceanfront": "Poipu Beach Kauai oceanfront",
      "Pili Mai": "Pili Mai Poipu Kauai",
    };

    const extras = COMMUNITY_EXTRAS[name] || "resort Kauai";

    // Three focused queries: pool/grounds, aerial/exterior, amenities
    const queries = [
      `"${name}" pool grounds resort`,
      `"${name}" exterior buildings aerial ${extras}`,
      `"${name}" amenities community common area`,
    ];

    // Keywords that indicate an individual unit interior — reject these
    const interiorKeywords = [
      "bedroom", "kitchen", "bathroom", "bath", "living room", "dining room",
      "interior", "couch", "sofa", "bed ", "master", "loft", "hallway",
      "floor plan", "floorplan", "map", "square feet",
    ];

    // Sources to deprioritize (individual listing platforms show unit interiors)
    const lowTrustSources = ["airbnb.com", "vrbo.com", "booking.com", "homeaway.com"];

    // Sources known to have accurate community property photos
    const highTrustSources = [
      "tripadvisor.com", "suiteparadise.com", "outrigger.com",
      "castleresorts.com", "parrish.com", "google.com", "maps.google.com",
      "jeanandabbott.com", "kauaibeachrentals.com", "remax.com", "zillow.com",
    ];

    const nameWords = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);

    function scoreAndValidate(img: any): { valid: boolean; label: string; score: number } {
      const title = (img.title || "").toLowerCase();
      const sourceLink = (img.source?.link || "").toLowerCase();
      const sourceName = (img.source?.name || "").toLowerCase();
      const imageUrl = (img.original?.link || "").toLowerCase();

      // Must have an original image URL
      if (!img.original?.link) return { valid: false, label: "", score: 0 };

      // Skip SVG/GIF/tiny images
      if (imageUrl.endsWith(".svg") || imageUrl.endsWith(".gif")) return { valid: false, label: "", score: 0 };
      const w = img.original?.width || 0;
      const h = img.original?.height || 0;
      if (w > 0 && h > 0 && (w < 300 || h < 200)) return { valid: false, label: "", score: 0 };

      // Reject if title strongly suggests interior unit photo
      const hasInterior = interiorKeywords.some(kw => title.includes(kw));
      if (hasInterior) return { valid: false, label: "", score: 0 };

      // Reject low-trust individual listing platforms
      if (lowTrustSources.some(s => sourceLink.includes(s) || imageUrl.includes(s))) {
        return { valid: false, label: "", score: 0 };
      }

      // Community name validation: at least one significant word from community name
      // must appear in the title, source URL, or image URL
      const contextText = `${title} ${sourceLink} ${sourceName} ${imageUrl}`;
      const nameMatch = nameWords.some(w => contextText.includes(w));
      if (!nameMatch) return { valid: false, label: "", score: 0 };

      // Build a human-readable label
      let label = img.title || name;
      if (label.length > 80) label = label.substring(0, 77) + "...";

      // Score: higher = better
      let score = 50;
      if (highTrustSources.some(s => sourceLink.includes(s))) score += 30;

      // Boost for community/resort/pool keywords in title
      const boostWords = ["pool", "resort", "grounds", "exterior", "building", "aerial", "community", "clubhouse", "tennis", "complex", "property"];
      boostWords.forEach(w => { if (title.includes(w)) score += 5; });

      return { valid: true, label, score };
    }

    try {
      // Run all three queries in parallel
      const searchPromises = queries.map(async (q) => {
        const params = new URLSearchParams({
          engine: "google_images",
          q,
          api_key: apiKey,
          num: "30",
          safe: "active",
        });
        const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!resp.ok) return [];
        const data = await resp.json() as any;
        return (data.images || []) as any[];
      });

      const allResults = await Promise.all(searchPromises);
      const combined = allResults.flat();

      // Deduplicate by original image URL
      const seen = new Set<string>();
      const validated: any[] = [];

      for (const img of combined) {
        const url = img.original?.link;
        if (!url || seen.has(url)) continue;
        seen.add(url);

        const { valid, label, score } = scoreAndValidate(img);
        if (!valid) continue;

        validated.push({
          url,
          thumbnail: img.thumbnail || url,
          title: label,
          source: img.source?.name || img.source?.link || "Unknown",
          sourceLink: img.source?.link || "",
          width: img.original?.width,
          height: img.original?.height,
          score,
        });
      }

      // Sort by score descending, take top 40
      validated.sort((a, b) => b.score - a.score);
      const top = validated.slice(0, 40);

      res.json({ communityName: name, results: top, totalFound: top.length });
    } catch (err: any) {
      res.status(500).json({ error: "Community photo search failed", message: err.message });
    }
  });

  // Save selected community photos directly into the community folder
  app.post("/api/community-photos/save", async (req, res) => {
    const { communityFolder, imageUrls } = req.body as { communityFolder: string; imageUrls: string[] };
    if (!communityFolder || !imageUrls?.length) {
      return res.status(400).json({ error: "Missing communityFolder or imageUrls" });
    }
    if (!/^community-[\w-]+$/.test(communityFolder)) {
      return res.status(400).json({ error: "Invalid communityFolder name" });
    }

    const folderPath = path.join(process.cwd(), "client/public/photos", communityFolder);
    await fs.promises.mkdir(folderPath, { recursive: true });

    // Clear existing files in folder
    const existing = await fs.promises.readdir(folderPath).catch(() => []);
    for (const f of existing) {
      if (/\.(jpg|jpeg|png|webp)$/i.test(f)) {
        await fs.promises.unlink(path.join(folderPath, f)).catch(() => {});
      }
    }

    const saved: string[] = [];
    const failed: string[] = [];

    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      try {
        const imgResp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; VacationRentalBot/1.0)" },
          signal: AbortSignal.timeout(10000),
        });
        if (!imgResp.ok) { failed.push(url); continue; }
        const contentType = imgResp.headers.get("content-type") || "";
        const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
        const filename = `${String(i + 1).padStart(2, "0")}-community.${ext}`;
        const buffer = Buffer.from(await imgResp.arrayBuffer());
        if (buffer.length < 5000) { failed.push(url); continue; } // skip tiny/broken images
        await fs.promises.writeFile(path.join(folderPath, filename), buffer);
        saved.push(filename);
      } catch {
        failed.push(url);
      }
    }

    res.json({ saved, failed, folder: communityFolder });
  });

  // Batch-populate all community photo folders from web search (one-time operation)
  app.post("/api/community-photos/populate-all", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SearchAPI.io API key not configured" });

    const COMMUNITIES_MAP: Record<string, string> = {
      "Regency at Poipu Kai": "community-regency-poipu-kai",
      "Kekaha Beachfront Estate": "community-kekaha-estate",
      "Keauhou Estates": "community-keauhou-estates",
      "Mauna Kai Princeville": "community-mauna-kai",
      "Kaha Lani Resort": "community-kaha-lani",
      "Lae Nani Resort": "community-lae-nani",
      "Poipu Brenneckes Beachside": "community-poipu-beachside",
      "Kaiulani of Princeville": "community-kaiulani",
      "Poipu Brenneckes Oceanfront": "community-poipu-oceanfront",
      "Pili Mai": "community-pili-mai",
    };

    const COMMUNITY_EXTRAS: Record<string, string> = {
      "Regency at Poipu Kai": "Poipu Kai resort Kauai",
      "Kekaha Beachfront Estate": "Kekaha Kauai beachfront",
      "Keauhou Estates": "Keauhou Kona Hawaii",
      "Mauna Kai Princeville": "Princeville Kauai resort",
      "Kaha Lani Resort": "Kapaa Kauai resort",
      "Lae Nani Resort": "Kapaa Kauai oceanfront",
      "Poipu Brenneckes Beachside": "Poipu Beach Kauai",
      "Kaiulani of Princeville": "Princeville Kauai",
      "Poipu Brenneckes Oceanfront": "Poipu Beach Kauai oceanfront",
      "Pili Mai": "Pili Mai Poipu Kauai",
    };

    const interiorKeywords = ["bedroom", "kitchen", "bathroom", "bath", "living room", "dining room", "interior", "couch", "sofa", "bed ", "master", "loft", "hallway", "floor plan", "floorplan", "map", "square feet"];
    const lowTrustSources = ["airbnb.com", "vrbo.com", "booking.com", "homeaway.com"];
    const highTrustSources = ["tripadvisor.com", "suiteparadise.com", "outrigger.com", "castleresorts.com", "parrish.com", "google.com", "jeanandabbott.com"];

    const results: Record<string, { saved: number; failed: number }> = {};

    for (const [communityName, folderName] of Object.entries(COMMUNITIES_MAP)) {
      try {
        const extras = COMMUNITY_EXTRAS[communityName] || "resort Kauai";
        const queries = [
          `"${communityName}" pool grounds resort`,
          `"${communityName}" exterior buildings aerial ${extras}`,
          `"${communityName}" amenities community common area`,
        ];
        const nameWords = communityName.toLowerCase().split(/\s+/).filter(w => w.length > 3);

        const allImages: any[] = [];
        for (const q of queries) {
          const params = new URLSearchParams({ engine: "google_images", q, api_key: apiKey, num: "30", safe: "active" });
          const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
          if (resp.ok) {
            const data = await resp.json() as any;
            allImages.push(...(data.images || []));
          }
          await new Promise(r => setTimeout(r, 500)); // rate limit between queries
        }

        // Deduplicate and score
        const seen = new Set<string>();
        const validated: any[] = [];
        for (const img of allImages) {
          const url = img.original?.link;
          if (!url || seen.has(url)) continue;
          seen.add(url);
          const title = (img.title || "").toLowerCase();
          const sourceLink = (img.source?.link || "").toLowerCase();
          const imageUrl = url.toLowerCase();
          if (!img.original?.link) continue;
          if (imageUrl.endsWith(".svg") || imageUrl.endsWith(".gif")) continue;
          const w = img.original?.width || 0; const h = img.original?.height || 0;
          if (w > 0 && h > 0 && (w < 300 || h < 200)) continue;
          if (interiorKeywords.some(kw => title.includes(kw))) continue;
          if (lowTrustSources.some(s => sourceLink.includes(s) || imageUrl.includes(s))) continue;
          const contextText = `${title} ${sourceLink} ${imageUrl}`;
          if (!nameWords.some(w => contextText.includes(w))) continue;
          let score = 50;
          if (highTrustSources.some(s => sourceLink.includes(s))) score += 30;
          ["pool", "resort", "grounds", "exterior", "building", "aerial", "community", "clubhouse"].forEach(w => { if (title.includes(w)) score += 5; });
          validated.push({ url, score });
        }
        validated.sort((a, b) => b.score - a.score);
        const top6 = validated.slice(0, 6).map(v => v.url);

        // Save to folder
        const folderPath = path.join(process.cwd(), "client/public/photos", folderName);
        await fs.promises.mkdir(folderPath, { recursive: true });
        const existing = await fs.promises.readdir(folderPath).catch(() => []);
        for (const f of existing) {
          if (/\.(jpg|jpeg|png|webp)$/i.test(f)) await fs.promises.unlink(path.join(folderPath, f)).catch(() => {});
        }

        let saved = 0; let failed = 0;
        for (let i = 0; i < top6.length; i++) {
          try {
            const imgResp = await fetch(top6[i], {
              headers: { "User-Agent": "Mozilla/5.0 (compatible; VacationRentalBot/1.0)" },
              signal: AbortSignal.timeout(12000),
            });
            if (!imgResp.ok) { failed++; continue; }
            const ct = imgResp.headers.get("content-type") || "";
            const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
            const buffer = Buffer.from(await imgResp.arrayBuffer());
            if (buffer.length < 5000) { failed++; continue; }
            await fs.promises.writeFile(path.join(folderPath, `${String(i + 1).padStart(2, "0")}-community.${ext}`), buffer);
            saved++;
          } catch { failed++; }
        }
        results[communityName] = { saved, failed };
      } catch (err: any) {
        results[communityName] = { saved: 0, failed: -1 };
      }
      await new Promise(r => setTimeout(r, 1000)); // rate limit between communities
    }

    res.json({ status: "complete", results });
  });

  app.get("/api/scanner/results", async (req, res) => {
    try {
      const filters: { runId?: number; community?: string; status?: string } = {};
      if (req.query.runId) filters.runId = parseInt(req.query.runId as string);
      if (req.query.community) filters.community = req.query.community as string;
      if (req.query.status) filters.status = req.query.status as string;
      const results = await storage.getAvailabilityScans(filters);
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ========== PLATFORM CHECK (reverse image search) ==========
  // Checks whether a photo (local or via URL) appears on Airbnb, VRBO, or Booking.com.
  // Local photos are first uploaded to ImgBB to get a public URL.
  app.post("/api/photos/platform-check", async (req, res) => {
    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    const imgbbKey = process.env.IMGBB_API_KEY;

    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const { folder, filename, imageUrl, communityName, location } = req.body as {
      folder?: string;
      filename?: string;
      imageUrl?: string;
      communityName?: string;
      location?: string;
    };

    // Island detection helpers for location-based filtering
    const ISLAND_KEYWORDS: Record<string, string[]> = {
      kauai: ["kauai", "lihue", "kapaa", "koloa", "poipu", "princeville", "hanalei", "waimea", "eleele", "kalaheo", "96766", "96746", "96756", "96765", "96741"],
      oahu: ["oahu", "honolulu", "waikiki", "kailua", "kaneohe", "aiea", "pearl city", "96815", "96816", "96734", "96701"],
      maui: ["maui", "kihei", "lahaina", "wailea", "paia", "makena", "kapalua", "kahului", "96753", "96761", "96732"],
      "big island": ["big island", "kona", "kailua-kona", "hilo", "waikoloa", "kohala", "waimea", "96740", "96720", "96743"],
      molokai: ["molokai", "kaunakakai"],
      lanai: ["lanai city"],
    };
    const detectIsland = (text: string): string | null => {
      const lower = text.toLowerCase();
      for (const [island, keywords] of Object.entries(ISLAND_KEYWORDS)) {
        if (keywords.some(k => lower.includes(k))) return island;
      }
      return null;
    };
    const ourIsland = detectIsland(location || "");
    const communityWords = (communityName || "").toLowerCase().split(/\s+/).filter(w => w.length > 3);

    let publicUrl: string | null = null;

    if (imageUrl) {
      // External photo — use URL directly
      publicUrl = imageUrl;
    } else if (folder && filename) {
      // Local photo — upload to ImgBB first
      if (!imgbbKey) {
        return res.status(500).json({ error: "IMGBB_API_KEY not configured — needed to upload local photos for reverse search" });
      }
      const photosBase = path.join(process.cwd(), "client", "public", "photos");
      const safeFolder = (folder || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const safeFile = (filename || "").replace(/[^a-zA-Z0-9_.-]/g, "");
      const filePath = path.join(photosBase, safeFolder, safeFile);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Photo not found" });
      }

      const base64Data = fs.readFileSync(filePath).toString("base64");
      const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `image=${encodeURIComponent(base64Data)}`,
      });

      if (!imgbbResp.ok) {
        const errText = await imgbbResp.text();
        console.error("[platform-check] ImgBB upload failed:", imgbbResp.status, errText);
        return res.status(500).json({ error: "Failed to upload image for reverse search" });
      }

      const imgbbData = await imgbbResp.json() as any;
      publicUrl = imgbbData?.data?.url || null;
      if (!publicUrl) return res.status(500).json({ error: "ImgBB did not return a URL" });
    } else {
      return res.status(400).json({ error: "Provide either folder+filename (local photo) or imageUrl (external photo)" });
    }

    // Run Google Lens reverse image search via SearchAPI
    const searchResp = await fetch(
      `https://www.searchapi.io/api/v1/search?engine=google_lens&url=${encodeURIComponent(publicUrl)}&api_key=${searchApiKey}`,
    );

    if (!searchResp.ok) {
      const errText = await searchResp.text();
      console.error("[platform-check] SearchAPI failed:", searchResp.status, errText);
      return res.status(500).json({ error: "Reverse image search failed" });
    }

    const searchData = await searchResp.json() as any;

    // Check all result arrays for vacation rental platform URLs
    const PLATFORMS: Record<string, string> = {
      "airbnb.com": "Airbnb",
      "vrbo.com": "VRBO",
      "booking.com": "Booking.com",
    };

    const found: { name: string; url: string; title: string; matchLocation: string; confidence: "high" | "medium" | "low" }[] = [];

    const allResults = [
      ...(searchData.visual_matches || []),
      ...(searchData.organic_results || []),
      ...(searchData.image_results || []),
      ...(searchData.inline_images || []),
      ...(searchData.pages_with_matching_images || []),
    ];

    for (const result of allResults) {
      const url: string = result.link || result.source_url || result.url || result.source?.link || "";
      const title: string = result.title || result.snippet || "";
      const titleLower = title.toLowerCase();
      const position: number = result.position ?? 999;

      // ── 1. Island mismatch filter: discard if matched listing is on a different island ──
      if (ourIsland) {
        const matchIsland = detectIsland(title + " " + url);
        if (matchIsland && matchIsland !== ourIsland) {
          console.log(`[platform-check] Discarding cross-island match: "${title}" (${matchIsland} vs our ${ourIsland})`);
          continue;
        }
      }

      // ── 2. Community name cross-reference ──
      const hasCommunityMatch = communityWords.length > 0 && communityWords.some(w => titleLower.includes(w));

      // ── 3. Similarity threshold via position ──
      // With community name match: accept top 10 results (high confidence from branding)
      // Without community name match: only accept position 1-2 (near-identical visuals required)
      const positionLimit = hasCommunityMatch ? 10 : 2;
      if (position > positionLimit) {
        console.log(`[platform-check] Skipping low-confidence match pos=${position} (limit=${positionLimit}): "${title}"`);
        continue;
      }

      const confidence: "high" | "medium" | "low" = hasCommunityMatch ? "high" : position === 1 ? "medium" : "low";
      const matchLocation = detectIsland(title + " " + url) || "";

      for (const [domain, platformName] of Object.entries(PLATFORMS)) {
        if (url.includes(domain) && !found.some(f => f.name === platformName && f.url === url)) {
          found.push({ name: platformName, url, title, matchLocation, confidence });
        }
      }
    }

    console.log(`[platform-check] ${filename || imageUrl}: ourIsland=${ourIsland} community="${communityName}" → ${found.length > 0 ? found.map(f => `${f.name}(${f.confidence})`).join(", ") : "clear"}`);
    res.json({ filename: filename || null, platforms: found, checkedUrl: publicUrl });
  });

  // ========== FIND REPLACEMENT LISTING ==========
  // Searches for a different MLS unit at the same community and returns its photos.
  app.post("/api/photos/find-replacement", async (req, res) => {
    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const { communityFolder, currentZillowUrl } = req.body as {
      communityFolder: string;
      currentZillowUrl?: string;
    };

    const safeFolder = (communityFolder || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const communityName = COMMUNITY_FOLDER_TO_NAME[safeFolder];
    if (!communityName) {
      return res.status(400).json({ error: "Unknown community folder" });
    }

    const knownPrimary = COMMUNITY_SOURCE_URLS[communityName]?.primary || currentZillowUrl || null;

    // Search for Zillow listings at this community using SearchAPI Google search
    let candidateUrls: string[] = [];
    for (const siteQuery of [`site:zillow.com "${communityName}"`, `site:homes.com "${communityName}"`]) {
      try {
        const searchResp = await fetch(
          `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(siteQuery)}&num=8&api_key=${searchApiKey}`,
        );
        if (!searchResp.ok) continue;
        const searchData = await searchResp.json() as any;
        const urls: string[] = (searchData.organic_results || [])
          .map((r: any) => r.link as string)
          .filter((u: string) => (u.includes("zillow.com/homedetails") || u.includes("homes.com/property")) && u !== knownPrimary);
        candidateUrls = [...candidateUrls, ...urls];
        if (candidateUrls.length >= 5) break;
      } catch {}
    }

    candidateUrls = [...new Set(candidateUrls)].slice(0, 5);

    // Try to scrape photos from each candidate (up to 3 attempts)
    let attempts = 0;
    for (const url of candidateUrls) {
      if (attempts >= 3) break;
      attempts++;
      console.log(`[find-replacement] Trying: ${url}`);
      try {
        const photos = await scrapeListingPhotos(url);
        if (photos.length >= 3) {
          // Extract unit identifier from URL path
          const unitMatch = url.match(/apt-([a-z0-9]+)/i)
            || url.match(/unit-([a-z0-9]+)/i)
            || url.match(/-([a-z0-9]+)[-/]?.*zpid/i);
          const unitLabel = unitMatch ? `Unit #${unitMatch[1].toUpperCase()}` : "a different unit";
          return res.json({
            photos: photos.map(p => ({ url: p.url, label: p.title || "Photo" })),
            source: `${communityName} — ${unitLabel}`,
            communityName,
            sourceUrl: url,
          });
        }
      } catch (err: any) {
        console.warn(`[find-replacement] Failed for ${url}:`, err.message);
      }
    }

    return res.json({
      photos: [],
      error: "Could not find a replacement unit automatically — please select photos manually.",
    });
  });

  // ============================================================
  // Step 4: Fetch unit photos from a Zillow/Homes.com URL
  // ============================================================
  app.post("/api/community/fetch-unit-photos", async (req, res) => {
    const { url } = req.body as { url: string };
    if (!url) return res.status(400).json({ error: "url required" });
    try {
      const photos = await scrapeListingPhotos(url);
      res.json({ photos: photos.map(p => ({ url: p.url, label: p.title || "Photo" })) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Step 4: Platform check on a public image URL (no ImgBB needed — URL is already public)
  app.post("/api/community/check-photo-url", async (req, res) => {
    const { imageUrl } = req.body as { imageUrl: string };
    if (!imageUrl) return res.status(400).json({ error: "imageUrl required" });

    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    try {
      const resp = await fetch(
        `https://www.searchapi.io/api/v1/search?engine=google_lens&url=${encodeURIComponent(imageUrl)}&api_key=${searchApiKey}`,
      );
      if (!resp.ok) {
        const errText = await resp.text();
        return res.status(resp.status).json({ error: `SearchAPI error: ${errText}` });
      }
      const data = await resp.json() as any;
      const matches: Array<{ platform: string; url: string }> = [];
      const allLinks = [
        ...(data.visual_matches || []),
        ...(data.organic_results || []),
        ...(data.image_results || []),
      ] as Array<{ link: string; title?: string; source?: string }>;

      for (const r of allLinks) {
        const link = r.link || "";
        if (link.includes("airbnb.com")) matches.push({ platform: "Airbnb", url: link });
        else if (link.includes("vrbo.com")) matches.push({ platform: "VRBO", url: link });
        else if (link.includes("booking.com")) matches.push({ platform: "Booking.com", url: link });
      }

      res.json({ matches, clean: matches.length === 0 });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================================
  // Community Draft CRUD
  // ============================================================
  app.get("/api/community/drafts", async (_req, res) => {
    const drafts = await storage.getCommunityDrafts();
    res.json(drafts);
  });

  app.post("/api/community/save", async (req, res) => {
    const result = insertCommunityDraftSchema.safeParse(req.body);
    if (!result.success) return res.status(400).json({ error: result.error.flatten() });
    const draft = await storage.createCommunityDraft(result.data);
    res.json(draft);
  });

  app.patch("/api/community/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const draft = await storage.updateCommunityDraft(id, req.body);
    if (!draft) return res.status(404).json({ error: "Not found" });
    res.json(draft);
  });

  app.delete("/api/community/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
    const ok = await storage.deleteCommunityDraft(id);
    if (!ok) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  });

  // ============================================================
  // Step 2: Research communities in a city/state via SearchAPI + Claude scoring
  // ============================================================
  app.post("/api/community/research", async (req, res) => {
    const { city, state } = req.body as { city: string; state: string };
    if (!city || !state) return res.status(400).json({ error: "city and state required" });

    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const queries = [
      `"${city}" "${state}" condo community vacation rental individual owners site:airbnb.com OR site:vrbo.com`,
      `"${city}" "${state}" resort condo complex multiple units short term rental`,
      `"${city}" "${state}" townhome community Airbnb VRBO individually owned units`,
    ];

    const allResults: Array<{ title: string; link: string; snippet: string }> = [];

    for (const q of queries) {
      try {
        const resp = await fetch(
          `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(q)}&num=8&api_key=${searchApiKey}`,
        );
        if (!resp.ok) continue;
        const data = await resp.json() as any;
        const organic = (data.organic_results || []) as Array<{ title: string; link: string; snippet: string }>;
        allResults.push(...organic);
      } catch (e: any) {
        console.warn("[community/research] SearchAPI error:", e.message);
      }
    }

    // Deduplicate by URL domain+title
    const seen = new Set<string>();
    const unique = allResults.filter(r => {
      const key = r.title?.toLowerCase().slice(0, 60) ?? r.link;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 15);

    if (unique.length === 0) {
      return res.json({ communities: [] });
    }

    // Rate-spot-check via SearchAPI VRBO/Airbnb for first 5 results
    async function spotCheckRate(communityName: string): Promise<{ low: number | null; high: number | null }> {
      try {
        const q = `${communityName} ${city} ${state} nightly rate VRBO Airbnb`;
        const resp = await fetch(
          `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(q)}&num=5&api_key=${searchApiKey}`,
        );
        if (!resp.ok) return { low: null, high: null };
        const data = await resp.json() as any;
        const text = JSON.stringify(data).toLowerCase();
        const prices: number[] = [];
        const priceMatches = text.match(/\$\s*(\d{3,4})\s*(?:\/night|per night|a night)/g) || [];
        for (const m of priceMatches) {
          const num = parseInt(m.replace(/[^\d]/g, ""));
          if (num >= 100 && num <= 5000) prices.push(num);
        }
        if (prices.length === 0) return { low: null, high: null };
        return { low: Math.min(...prices), high: Math.max(...prices) };
      } catch {
        return { low: null, high: null };
      }
    }

    // Score with Claude
    let communities: Array<{
      name: string;
      city: string;
      state: string;
      estimatedLowRate: number | null;
      estimatedHighRate: number | null;
      unitTypes: string;
      confidenceScore: number;
      researchSummary: string;
      sourceUrl: string;
    }> = [];

    if (anthropicKey) {
      const prompt = `You are evaluating vacation rental communities for a bundled multi-unit listing model (NexStay). We are looking for communities where:
1. Units are individually owned condos or townhomes (NOT hotel-owned, NOT timeshare, NOT managed by single resort)
2. The complex has at least 10+ units
3. Multiple bedroom configurations exist (2BR + 3BR, 3BR + 3BR, etc.) that can be bundled
4. Active vacation rental presence on Airbnb/VRBO
5. Premium nightly rates ($500+/night for 3BR units)

Here are search results for "${city}, ${state}":
${unique.map((r, i) => `[${i}] TITLE: ${r.title}\nURL: ${r.link}\nSNIPPET: ${r.snippet}`).join("\n\n")}

For each result that could be a qualifying community, extract:
- communityName: the name of the condo/resort complex
- unitTypes: estimated bedroom configurations available (e.g. "2BR, 3BR")
- confidenceScore: 0-100 how well it fits the bundling model
- reason: 1-2 sentence explanation
- sourceUrl: the URL from the result

Return ONLY a JSON array (no markdown, no code fences). Each element: {"communityName":"...","unitTypes":"...","confidenceScore":0,"reason":"...","sourceUrl":"..."}.
Only include communities with confidenceScore >= 40. Max 8 results.`;

      try {
        const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 2000,
            messages: [{ role: "user", content: prompt }],
          }),
        });

        if (claudeResp.ok) {
          const claudeData = await claudeResp.json() as any;
          const text: string = claudeData?.content?.[0]?.text ?? "";
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const scored = JSON.parse(jsonMatch[0]) as Array<{
              communityName: string;
              unitTypes: string;
              confidenceScore: number;
              reason: string;
              sourceUrl: string;
            }>;

            for (const s of scored.slice(0, 8)) {
              const rates = await spotCheckRate(s.communityName);
              communities.push({
                name: s.communityName,
                city,
                state,
                estimatedLowRate: rates.low,
                estimatedHighRate: rates.high,
                unitTypes: s.unitTypes,
                confidenceScore: s.confidenceScore,
                researchSummary: s.reason,
                sourceUrl: s.sourceUrl,
              });
            }
          }
        }
      } catch (e: any) {
        console.warn("[community/research] Claude error:", e.message);
      }
    } else {
      // Fallback without Claude: return raw results as low-confidence candidates
      communities = unique.slice(0, 8).map(r => ({
        name: r.title?.split(" - ")[0]?.split(" | ")[0] ?? r.title,
        city,
        state,
        estimatedLowRate: null,
        estimatedHighRate: null,
        unitTypes: "Unknown",
        confidenceScore: 50,
        researchSummary: r.snippet,
        sourceUrl: r.link,
      }));
    }

    communities.sort((a, b) => b.confidenceScore - a.confidenceScore);
    res.json({ communities });
  });

  // ============================================================
  // Step 3: Search Zillow/Homes.com for units in a community
  // ============================================================
  app.post("/api/community/search-units", async (req, res) => {
    const { communityName, city, state } = req.body as { communityName: string; city: string; state: string };
    if (!communityName) return res.status(400).json({ error: "communityName required" });

    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const queries = [
      `site:zillow.com "${communityName}" ${city} ${state}`,
      `site:homes.com "${communityName}" ${city} ${state}`,
    ];

    const units: Array<{ url: string; title: string; bedrooms: number | null; price: number | null; source: string }> = [];

    for (const q of queries) {
      try {
        const resp = await fetch(
          `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(q)}&num=10&api_key=${searchApiKey}`,
        );
        if (!resp.ok) continue;
        const data = await resp.json() as any;
        const organic = (data.organic_results || []) as Array<{ title: string; link: string; snippet: string }>;
        for (const r of organic) {
          const isZillow = r.link?.includes("zillow.com/homedetails");
          const isHomes = r.link?.includes("homes.com/property");
          if (!isZillow && !isHomes) continue;

          // Extract bedroom count from title/snippet
          const bedroomMatch = (r.title + " " + r.snippet).match(/(\d+)\s*(?:bed|br|bedroom)/i);
          const bedrooms = bedroomMatch ? parseInt(bedroomMatch[1]) : null;

          // Extract price from snippet
          const priceMatch = r.snippet?.match(/\$[\s]*([\d,]+)/);
          const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, "")) : null;

          units.push({
            url: r.link,
            title: r.title,
            bedrooms,
            price,
            source: isZillow ? "Zillow" : "Homes.com",
          });
        }
      } catch (e: any) {
        console.warn("[community/search-units] error:", e.message);
      }
    }

    // Deduplicate by URL
    const seen = new Set<string>();
    const deduped = units.filter(u => {
      if (seen.has(u.url)) return false;
      seen.add(u.url);
      return true;
    });

    // Group by bedroom count
    const grouped: Record<number | string, typeof deduped> = {};
    for (const u of deduped) {
      const key = u.bedrooms ?? "unknown";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(u);
    }

    res.json({ units: deduped, grouped });
  });

  // ============================================================
  // Step 5: Generate listing draft with Claude
  // ============================================================
  app.post("/api/community/generate-listing", async (req, res) => {
    const { communityName, city, state, unit1, unit2, suggestedRate } = req.body as {
      communityName: string;
      city: string;
      state: string;
      unit1: { bedrooms: number; url: string; description?: string };
      unit2: { bedrooms: number; url: string; description?: string };
      suggestedRate: number;
    };

    if (!communityName || !unit1 || !unit2) {
      return res.status(400).json({ error: "communityName, unit1, unit2 required" });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const combinedBedrooms = (unit1.bedrooms || 0) + (unit2.bedrooms || 0);

    const DISCLOSURE = `⚠️ IMPORTANT DISCLOSURE

This listing combines two separate, individually owned units within the same community. The photos shown are representative of the unit type, quality, and bedroom count within this community — the exact unit assigned may differ but will be of equivalent size, finishes, and bedroom count. Guests will receive two separate unit keys/access codes at check-in. Both units are located within the same building cluster or immediate community grounds.

---`;

    if (!anthropicKey) {
      const fallbackTitle = `${communityName} — ${combinedBedrooms}BR Combined | ${city}, ${state}`.slice(0, 80);
      const fallbackDescription = `${DISCLOSURE}\n\nThis listing combines two units at ${communityName} in ${city}, ${state}. Unit 1 is a ${unit1.bedrooms}-bedroom residence and Unit 2 is a ${unit2.bedrooms}-bedroom residence, totaling ${combinedBedrooms} bedrooms. Guests receive separate access codes for each unit at check-in.`;
      return res.json({ title: fallbackTitle, description: fallbackDescription, combinedBedrooms, suggestedRate });
    }

    const prompt = `Generate a VRBO-ready vacation rental listing for a bundled multi-unit listing at ${communityName} in ${city}, ${state}.

The listing combines:
- Unit 1: ${unit1.bedrooms}-bedroom unit at ${communityName}
- Unit 2: ${unit2.bedrooms}-bedroom unit at ${communityName}
- Combined total: ${combinedBedrooms} bedrooms
- Suggested nightly rate: $${suggestedRate}

Requirements:
1. HEADLINE: Max 80 characters, VRBO-compliant, exciting and descriptive
2. DESCRIPTION: Must start with this EXACT disclosure block (copy it verbatim):

${DISCLOSURE}

Then follow with:
- Engaging community/location highlights (2-3 paragraphs)
- Bedroom and bathroom breakdown for both units
- Key amenities
- Local attractions

Keep the total description under 800 words. Write for VRBO. Be specific about ${city}, ${state}.

Return ONLY valid JSON: {"title": "...", "description": "..."}`;

    try {
      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 2000,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const claudeData = await claudeResp.json() as any;
      const text: string = claudeData?.content?.[0]?.text ?? "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in Claude response");

      const { title, description } = JSON.parse(jsonMatch[0]);
      return res.json({ title: title.slice(0, 80), description, combinedBedrooms, suggestedRate });
    } catch (e: any) {
      console.warn("[community/generate-listing] Claude error:", e.message);
      const fallbackTitle = `${communityName} — ${combinedBedrooms}BR Combined | ${city}, ${state}`.slice(0, 80);
      const fallbackDescription = `${DISCLOSURE}\n\nThis listing combines two units at ${communityName} in ${city}, ${state}.`;
      return res.json({ title: fallbackTitle, description: fallbackDescription, combinedBedrooms, suggestedRate });
    }
  });

  return httpServer;
}
