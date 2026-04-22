import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertBuyInSchema, insertCommunityDraftSchema, insertUnitSwapSchema } from "@shared/schema";
import { getPropertyUnits, getUnitConfig } from "@shared/property-units";
import path from "path";
import fs from "fs";
import JSZip from "jszip";
import { chromium } from "playwright";
import { runAvailabilityScan, isScannerRunning, getScannableProperties, getCurrentScanPropertyId, getPropertyName } from "./availability-scanner";
import { scheduleGuestySync, syncPropertyToGuesty, guestyRequest } from "./guesty-sync";
import { getAutoApproveStatus, setAutoApproveEnabled, runAutoApprove } from "./auto-approve";
import { getAutoReplyStatus, setAutoReplyEnabled, runAutoReply, sendDraftedReply, dismissReply } from "./auto-reply";
import { validateAndFixPhoto } from "./photo-validator";
import { researchCommunitiesForCity, TOP_MARKET_SEEDS } from "./community-research";
import { checkCommunityType } from "@shared/community-type";
import { labelPhoto, inferKindFromFolder, listPhotoFiles } from "./photo-labeler";
import { getGuestyToken, setGuestyTokenManually, getGuestyTokenStatus, RateLimitedError } from "./guesty-token";
import { insertMessageTemplateSchema } from "@shared/schema";

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

// Street address fragment for each community — used to find individual Zillow unit listings via Google Images
const COMMUNITY_FOLDER_TO_ADDRESS: Record<string, string> = {
  "community-regency-poipu-kai": "2253 Poipu Rd",
  "community-kekaha-estate": "8351 Kekaha Rd",
  "community-keauhou-estates": "78-261 Manukai St",
  "community-mauna-kai": "3900 Wyllie Rd",
  "community-kaha-lani": "4460 Nehe Rd",
  "community-lae-nani": "410 Papaloa Rd",
  "community-poipu-beachside": "2251 Poipu Rd",
  "community-kaiulani": "3970 Wyllie Rd",
  "community-poipu-oceanfront": "2249 Poipu Rd",
  "community-pili-mai": "2651 Puuholo Rd",
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

// Retry a Replicate POST up to maxRetries times on 429 rate-limit responses.
async function replicatePostWithRetry(url: string, key: string, body: object, label: string, maxRetries = 4): Promise<Response> {
  const headers = { "Authorization": `Token ${key}`, "Content-Type": "application/json", "Prefer": "wait=60" };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (resp.status !== 429) return resp;
    if (attempt === maxRetries) {
      console.error(`[${label}] Still rate-limited after ${maxRetries} retries — giving up`);
      return resp;
    }
    let retryAfter = 15;
    try { const j = await resp.json() as any; retryAfter = Math.min((j?.retry_after || 15) + 3, 90); } catch (_) {}
    console.log(`[${label}] 429 rate-limit (attempt ${attempt + 1}/${maxRetries + 1}) — waiting ${retryAfter}s...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
  }
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function generateWithReplicateKw(prompt: string): Promise<Buffer | null> {
  const key = process.env.REPLICATE_API_KEY;
  if (!key) { console.error("[flux] No REPLICATE_API_KEY set"); return null; }
  try {
    const createResp = await replicatePostWithRetry(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
      key,
      {
        input: {
          prompt: `${prompt}, luxury vacation rental interior, professional real estate photography, bright natural light, 4K high resolution`,
          num_outputs: 1,
          aspect_ratio: "1:1",
          output_quality: 90,
          num_inference_steps: 4,
        },
      },
      "flux"
    );
    if (!createResp.ok) {
      let errText = "";
      try { errText = await createResp.text(); } catch (_) {}
      console.error("[flux] Create failed:", createResp.status, errText);
      return null;
    }
    const prediction = await createResp.json() as { id?: string; status: string; output?: string[] | string; error?: string };
    console.log("[flux] Prediction response: status=", prediction.status, "id=", prediction.id, "error=", prediction.error, "output=", JSON.stringify(prediction.output)?.substring(0, 120));
    if (prediction.error) { console.error("[flux] Prediction error:", prediction.error); return null; }
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
    const createResp = await replicatePostWithRetry(
      "https://api.replicate.com/v1/models/nightmareai/real-esrgan/predictions",
      key,
      { input: { image: dataUri, scale: 2, face_enhance: false } },
      "upscale"
    );
    if (!createResp.ok) {
      let errText = "";
      try { errText = await createResp.text(); } catch (_) {}
      console.error("[upscale] Replicate Real-ESRGAN error:", createResp.status, errText);
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

      // Upscale every photo (interior and exterior) with Real-ESRGAN 2x.
      // This enhances the real photos without replacing their content.
      photo.status = "processing";
      emitJobEvent(jobId, { type: "photo_start", index: photo.index, total: job.totalCount, zipName: photo.zipName, servePath: photo.servePath });
      console.log(`[makeover-job] ${photo.zipName} → upscaling 2x (Real-ESRGAN)...`);
      const upscaled = await upscaleWithReplicateKw(rawData, mimeType);
      const finalBuffer = upscaled || rawData;
      photo.resultBuffer = upscaled || undefined;
      photo.status = "done";
      if (upscaled) job.processedCount++;
      zip.file(photo.zipName.replace(/\.(jpg|jpeg|png)$/i, ".jpg"), finalBuffer);

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

  // ── Guesty OAuth token plumbing ─────────────────────────────────────────────
  // All token caching now lives in server/guesty-token.ts (DB-backed + file
  // fallback + in-memory + refresh dedup). This replaces the old per-file
  // caches that kept getting wiped by Railway's ephemeral filesystem.

  app.get("/api/guesty-property-map", async (_req, res) => {
    try {
      const map = await storage.getGuestyPropertyMap();
      res.json(map);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch Guesty property map", message: err.message });
    }
  });

  app.post("/api/guesty-token", async (_req, res) => {
    try {
      const token = await getGuestyToken();
      const status = await getGuestyTokenStatus();
      return res.json({ access_token: token, expires_in: status.expiresInSeconds ?? 86400 });
    } catch (err: any) {
      if (err instanceof RateLimitedError) {
        return res.status(429).json({ error: "RATE_LIMITED", message: err.message });
      }
      return res.status(500).json({ error: "Guesty auth failed", message: err.message });
    }
  });

  // Admin: diagnostic + manual override for the token cache.
  // When Guesty's /oauth2/token is rate-limiting you, grab a fresh token from
  // Guesty's UI (or any working API call's Authorization header) and POST it
  // here to unstick the app without redeploying.
  app.get("/api/admin/guesty-token/status", async (_req, res) => {
    try {
      const s = await getGuestyTokenStatus();
      res.json(s);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/admin/guesty-token/set", async (req, res) => {
    const { token, expiresInSeconds } = req.body as { token?: string; expiresInSeconds?: number };
    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "token (string) required" });
    }
    const ttl = Math.max(60, Math.min(86400, Number(expiresInSeconds) || 86400));
    try {
      await setGuestyTokenManually(token, ttl);
      const status = await getGuestyTokenStatus();
      res.json({ success: true, source: status.source, expiresInSeconds: status.expiresInSeconds });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Guesty API proxy ─────────────────────────────────────────────────────────
  // All Guesty Open API calls are routed through here so the browser never needs
  // to call Guesty directly — avoids CORS issues and keeps the token server-side.
  // Usage: GET /api/guesty-proxy/listings?limit=5
  //        PUT /api/guesty-proxy/listings/:id
  //        etc. — maps 1:1 to https://open-api.guesty.com/v1/*
  app.all("/api/guesty-proxy/*path", async (req: Request, res: Response) => {
    // Shared token module handles memory/DB/file caching + refresh dedup.
    let token: string;
    try {
      token = await getGuestyToken();
    } catch (err: any) {
      if (err instanceof RateLimitedError) {
        return res.status(429).json({ error: "RATE_LIMITED", message: err.message });
      }
      return res.status(500).json({ error: "Guesty auth error", message: err.message });
    }

    // ── Forward request to Guesty ────────────────────────────────────────────
    // Strip the "/api/guesty-proxy" prefix to get the Guesty API path
    const guestyPath = req.path.replace(/^\/api\/guesty-proxy/, "") || "/";
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const url = `https://open-api.guesty.com/v1${guestyPath}${qs ? "?" + qs : ""}`;

    const fetchOptions: RequestInit = {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };

    if (req.method !== "GET" && req.method !== "HEAD" && req.body && Object.keys(req.body).length > 0) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    try {
      const guestyRes = await fetch(url, fetchOptions);

      if (guestyRes.status === 204) {
        return res.status(204).send();
      }

      const contentType = guestyRes.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await guestyRes.json();
        return res.status(guestyRes.status).json(data);
      } else {
        const text = await guestyRes.text();
        return res.status(guestyRes.status).send(text);
      }
    } catch (err: any) {
      return res.status(502).json({ error: "Guesty proxy error", message: err.message });
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

  // POST /api/admin/cleanup-removed-properties
  // One-shot cleanup after the 2026-04 condo-only pivot. Deletes every DB row
  // tied to propertyIds that were stripped from PROPERTY_UNIT_CONFIGS.
  // Idempotent — safe to run multiple times. Returns counts per table.
  app.post("/api/admin/cleanup-removed-properties", async (_req, res) => {
    const REMOVED_PROPERTY_IDS = [7, 10, 12, 14, 21, 26, 28, 31, 36];
    try {
      // Lazy-import drizzle helpers + tables so we don't pay the import cost
      // on every request.
      const { db } = await import("./db");
      const { inArray } = await import("drizzle-orm");
      const { buyIns, guestyPropertyMap, availabilityScans, unitSwaps } = await import("@shared/schema");

      const buyInsDeleted = await db
        .delete(buyIns)
        .where(inArray(buyIns.propertyId, REMOVED_PROPERTY_IDS))
        .returning({ id: buyIns.id });

      const mapsDeleted = await db
        .delete(guestyPropertyMap)
        .where(inArray(guestyPropertyMap.propertyId, REMOVED_PROPERTY_IDS))
        .returning({ id: guestyPropertyMap.id });

      const scansDeleted = await db
        .delete(availabilityScans)
        .where(inArray(availabilityScans.propertyId, REMOVED_PROPERTY_IDS))
        .returning({ id: availabilityScans.id });

      let swapsDeleted: { id: number }[] = [];
      try {
        swapsDeleted = await db
          .delete(unitSwaps)
          .where(inArray(unitSwaps.propertyId, REMOVED_PROPERTY_IDS))
          .returning({ id: unitSwaps.id });
      } catch {
        // unit_swaps may not exist or may not have propertyId — safe to skip
      }

      return res.json({
        removedPropertyIds: REMOVED_PROPERTY_IDS,
        buyIns: buyInsDeleted.length,
        guestyPropertyMap: mapsDeleted.length,
        availabilityScans: scansDeleted.length,
        unitSwaps: swapsDeleted.length,
      });
    } catch (err: any) {
      console.error("[admin/cleanup] error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ========== OPERATIONS: FIND BUY-IN ACROSS ALL SOURCES ==========
  //
  // Fan-out search across Airbnb, Vrbo/Booking.com, and Google-discovered
  // property-management companies for a given community + date range + bedroom
  // count. Returns unified, price-sorted candidates so the host can pick the
  // cheapest option to buy in at.
  //
  // GET /api/operations/find-buy-in?propertyId=X&bedrooms=N&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD
  // Response:
  //   {
  //     community, nights, dates,
  //     sources: { airbnb: [...], vrbo: [...], booking: [...], pm: [...] },
  //     cheapest: [top 2 cross-source by nightly price]
  //   }
  app.get("/api/operations/find-buy-in", async (req: Request, res: Response) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const propertyId = parseInt(req.query.propertyId as string, 10);
    const bedrooms = parseInt(req.query.bedrooms as string, 10);
    const checkIn = req.query.checkIn as string;
    const checkOut = req.query.checkOut as string;

    if (!propertyId || isNaN(propertyId)) return res.status(400).json({ error: "propertyId required" });
    if (!bedrooms || isNaN(bedrooms)) return res.status(400).json({ error: "bedrooms required" });
    if (!checkIn || !checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
      return res.status(400).json({ error: "checkIn and checkOut required (YYYY-MM-DD)" });
    }

    const config = PROPERTY_UNIT_NEEDS[propertyId];
    if (!config) return res.status(404).json({ error: "Property not in config" });

    const community = config.community;
    const nights = Math.max(1, Math.round((new Date(checkOut + "T12:00:00").getTime() - new Date(checkIn + "T12:00:00").getTime()) / 86_400_000));
    const searchLocation = COMMUNITY_SEARCH_LOCATIONS[community] || `${community}, Hawaii`;
    const vrboDestination = COMMUNITY_VRBO_DESTINATIONS[community] || `${community}, Hawaii`;
    const bounds = COMMUNITY_BOUNDS[community];

    // ── Resort-name resolution ───────────────────────────────────────────
    // The whole business model is combining two units IN THE SAME RESORT.
    // A generic "Kapaa, Hawaii" search catches anything in that area — not
    // useful. Look up the Guesty listing title and extract the resort name
    // from it (e.g. "Kaha Lani - 5BR Oceanfront - Sleeps 14" → "Kaha Lani").
    let resortName: string | null = null;
    let listingTitle: string | null = null;
    try {
      const guestyListingId = await storage.getGuestyListingId(propertyId);
      if (guestyListingId) {
        const listing = await guestyRequest("GET", `/listings/${guestyListingId}?fields=title%20nickname`) as any;
        listingTitle = listing?.title ?? listing?.nickname ?? null;
        if (listingTitle) {
          // Grab everything before the first " - " or " – " separator.
          // Works for "Kaha Lani - 5BR ..." and "Poipu Kai - 6BR Villas...".
          resortName = listingTitle.split(/\s+[–-]\s+/)[0].trim();
        }
      }
    } catch (e: any) {
      console.warn(`[find-buy-in] couldn't resolve resort name for property ${propertyId}:`, e.message);
    }

    // Normalize a string for inclusion checks — lowercase + collapse punctuation
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const resortTokens = resortName ? norm(resortName).split(" ").filter(t => t.length >= 3) : [];
    // True if the haystack mentions every significant token of the resort name
    const mentionsResort = (haystack: string): boolean => {
      if (!resortName || resortTokens.length === 0) return true; // no filter
      const n = norm(haystack);
      return resortTokens.every(t => n.includes(t));
    };

    // Bedroom extraction from free text — looks for "2BR", "2 bedroom",
    // "two bedroom", "three-bedroom", "studio" (=0), "efficiency" (=0), etc.
    const bedroomFromText = (text: string): number | null => {
      const t = text.toLowerCase();
      if (/\bstudio\b|\befficiency\b/.test(t)) return 0;
      const m = t.match(/(\d+)\s*(?:br|bd|bed|bedroom|bdr)/);
      if (m) return parseInt(m[1], 10);
      const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
      for (const [w, n] of Object.entries(words)) {
        if (new RegExp(`\\b${w}[\\s-]bedroom\\b`).test(t)) return n;
      }
      return null;
    };
    // Reject if text mentions a bedroom count that clearly doesn't match.
    // Keep unknowns — we show the user and they can verify.
    const bedroomOk = (text: string): boolean => {
      const b = bedroomFromText(text);
      if (b === null) return true; // unknown — keep for manual review
      return b >= bedrooms;
    };

    console.log(`[find-buy-in] resort="${resortName}" listing="${listingTitle}" bedrooms=${bedrooms} ${checkIn}→${checkOut}`);

    type Candidate = {
      source: "airbnb" | "vrbo" | "booking" | "pm";
      sourceLabel: string;
      title: string;
      url: string;
      nightlyPrice: number;
      totalPrice: number;
      bedrooms?: number;
      image?: string;
      snippet?: string;
    };

    const asNum = (v: unknown): number => {
      if (typeof v === "number") return v;
      if (typeof v === "string") return Number(v.replace(/[^\d.]/g, "")) || 0;
      return 0;
    };

    // ── URL quality: keep only links that lead directly to a specific unit.
    // Clicking a buy-in link should land on that unit's page, not a search
    // results page or the PM company's homepage. Patterns below match each
    // platform's canonical detail-page shape.
    const isDetailUrl = (source: "airbnb" | "vrbo" | "booking" | "pm", rawUrl: string): boolean => {
      let u: URL;
      try { u = new URL(rawUrl); } catch { return false; }
      const path = u.pathname;
      switch (source) {
        case "airbnb":
          // /rooms/12345, /rooms/plus/12345, /luxury/listing/12345
          return /^\/rooms\/(plus\/)?\d+/.test(path)
              || /^\/luxury\/listing\/\d+/.test(path);
        case "vrbo":
          // Property pages: numeric id paths like /1234567, /1234567ha,
          // or /vacation-rental/p1234567
          return /^\/\d+[a-z]{0,3}\/?$/.test(path)
              || /^\/vacation-rental\/p\d+/.test(path);
        case "booking":
          // Hotel detail pages end in .html under /hotel/
          return /^\/hotel\/[a-z]{2}\/.+\.html$/i.test(path)
              && !/searchresults/i.test(path);
        case "pm": {
          // PM sites vary wildly — an over-strict path heuristic kills the
          // only source with live prices (OTA organic results never carry
          // price). Accept anything deeper than the bare homepage; callers
          // can use `isLandingUrl` to rank landing pages lower.
          return path.length > 1 && path !== "/";
        }
      }
    };

    // Secondary signal: does this PM URL look like a resort-landing page
    // rather than a specific unit? Used for ranking, NOT for filtering —
    // we still surface landing pages if that's all the PM offers, but
    // unit-specific URLs bubble to the top.
    const isLandingUrl = (source: "airbnb" | "vrbo" | "booking" | "pm", rawUrl: string): boolean => {
      if (source !== "pm") return false;
      let u: URL;
      try { u = new URL(rawUrl); } catch { return false; }
      const segments = u.pathname.split("/").filter(Boolean);
      if (segments.length === 0) return true;
      const last = segments[segments.length - 1].toLowerCase();
      const resortSlug = resortName
        ? resortName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        : "";
      if (resortSlug && (last === resortSlug
                      || last === `${resortSlug}-resort`
                      || last.replace(/-resort$/, "") === resortSlug)) return true;
      if (/^(resort|resorts|hotel|hotels|vacation-rentals?|rentals?|kauai|oahu|maui|hawaii)$/.test(last)) return true;
      return false;
    };

    // Append the reservation's check-in/out to the URL so the landing page
    // opens with availability already filtered for those dates. Each platform
    // uses different query param names.
    const withStayDates = (source: "airbnb" | "vrbo" | "booking" | "pm", rawUrl: string): string => {
      let u: URL;
      try { u = new URL(rawUrl); } catch { return rawUrl; }
      const set = (k: string, v: string) => { if (!u.searchParams.has(k)) u.searchParams.set(k, v); };
      switch (source) {
        case "airbnb":
          set("check_in", checkIn);
          set("check_out", checkOut);
          set("adults", "2");
          break;
        case "vrbo":
          set("arrival", checkIn);
          set("departure", checkOut);
          break;
        case "booking":
          set("checkin", checkIn);
          set("checkout", checkOut);
          set("group_adults", "2");
          break;
        case "pm":
          // No universal convention across PM sites — sprinkle every common
          // param name. Sites that use one of these will pre-fill dates;
          // sites that don't will ignore unknown params.
          set("checkin", checkIn);
          set("checkout", checkOut);
          set("check_in", checkIn);
          set("check_out", checkOut);
          set("arrival", checkIn);
          set("departure", checkOut);
          break;
      }
      return u.toString();
    };

    // Helper: run a Google site: search restricted to one OTA and filter
    // aggressively. Requires the resort name to appear in title OR snippet
    // (if we resolved one), and the bedroom count to match.
    const siteSearch = async (
      siteDomain: string,
      source: "airbnb" | "vrbo" | "booking",
      sourceLabel: string,
    ): Promise<{ candidates: Candidate[]; raw: number; dropped: { noResort: number; wrongBedrooms: number } }> => {
      const resortQualifier = resortName ? `"${resortName}"` : searchLocation;
      const query = `site:${siteDomain} ${resortQualifier} ${bedrooms} bedroom`;
      try {
        const params = new URLSearchParams({ engine: "google", q: query, num: "15", api_key: apiKey });
        const r = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!r.ok) return { candidates: [], raw: 0, dropped: { noResort: 0, wrongBedrooms: 0 } };
        const data = await r.json() as any;
        const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];
        let noResort = 0;
        let wrongBedrooms = 0;
        const kept = organic
          .filter((o: any) => o?.link && o.link.includes(siteDomain))
          // Skip anything that isn't a real listing page — a search-results
          // page or region landing is useless as a buy-in link.
          .filter((o: any) => isDetailUrl(source, String(o.link)))
          .filter((o: any) => {
            const hay = `${o?.title ?? ""} ${o?.snippet ?? ""} ${o?.link ?? ""}`;
            if (!mentionsResort(hay)) { noResort++; return false; }
            if (!bedroomOk(hay)) { wrongBedrooms++; return false; }
            return true;
          })
          .slice(0, 8)
          .map((o: any): Candidate => {
            const snippet = String(o?.snippet ?? "");
            const inferred = bedroomFromText(`${o?.title ?? ""} ${snippet}`);
            return {
              source,
              sourceLabel,
              title: String(o?.title ?? `${sourceLabel} listing`),
              url: withStayDates(source, String(o?.link ?? "")),
              nightlyPrice: 0, // Google organic results don't carry live prices
              totalPrice: 0,
              bedrooms: inferred ?? undefined,
              snippet: snippet.slice(0, 160),
            };
          });
        return { candidates: kept, raw: organic.length, dropped: { noResort, wrongBedrooms } };
      } catch (e: any) {
        console.error(`[find-buy-in] ${source} site:${siteDomain} error:`, e.message);
        return { candidates: [], raw: 0, dropped: { noResort: 0, wrongBedrooms: 0 } };
      }
    };

    // ── Airbnb: TWO fetches run in parallel, then merged.
    //    1) site: Google search — great at resort-specific matches via
    //       quoted-name, but Google organic never carries live prices.
    //    2) SearchAPI airbnb engine — returns listings with real prices
    //       (price.extracted_total_price), filtered by location bounds.
    //    The engine sometimes returns listings outside the target resort
    //    so we post-filter to require the resort name in title/desc.
    //    This is what lets auto-fill actually pick a priced candidate.
    let airbnbRawCount = 0;
    let airbnbDropped = { noResort: 0, wrongBedrooms: 0 };
    let airbnbPricedCount = 0;
    const airbnbPromise: Promise<Candidate[]> = (async () => {
      const [site, priced] = await Promise.all([
        siteSearch("airbnb.com", "airbnb", "Airbnb"),
        (async (): Promise<Candidate[]> => {
          try {
            const sp: Record<string, string> = {
              engine: "airbnb",
              check_in_date: checkIn,
              check_out_date: checkOut,
              adults: "2",
              bedrooms: String(bedrooms),
              type_of_place: "entire_home",
              currency: "USD",
              api_key: apiKey,
              q: searchLocation,
            };
            if (bounds) {
              sp.sw_lat = String(bounds.sw_lat);
              sp.sw_lng = String(bounds.sw_lng);
              sp.ne_lat = String(bounds.ne_lat);
              sp.ne_lng = String(bounds.ne_lng);
            }
            const r = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`);
            if (!r.ok) return [];
            const data = await r.json() as any;
            let properties: any[] = Array.isArray(data?.properties) ? data.properties : [];
            airbnbPricedCount = properties.length;
            // Require resort mention in title/desc — the engine's geo
            // bounds aren't tight enough to guarantee it alone.
            if (resortName) {
              properties = properties.filter((p: any) => {
                const hay = `${p?.name ?? p?.title ?? ""} ${p?.description ?? ""}`;
                return mentionsResort(hay);
              });
            }
            return properties
              .filter((p: any) => p?.price?.extracted_total_price > 0 && p?.link)
              .map((p: any): Candidate => {
                const total = Number(p.price.extracted_total_price);
                const url = withStayDates("airbnb", String(p.link));
                return {
                  source: "airbnb",
                  sourceLabel: "Airbnb",
                  title: String(p?.name ?? p?.title ?? "Airbnb listing"),
                  url,
                  nightlyPrice: Math.round(total / Math.max(1, nights)),
                  totalPrice: total,
                  bedrooms: typeof p?.bedrooms === "number" ? p.bedrooms : undefined,
                  image: Array.isArray(p?.images) ? p.images[0] : undefined,
                  snippet: String(p?.description ?? "").slice(0, 160),
                };
              });
          } catch (e: any) {
            console.error(`[find-buy-in] airbnb engine error:`, e.message);
            return [];
          }
        })(),
      ]);
      airbnbRawCount = site.raw;
      airbnbDropped = site.dropped;
      // Dedupe by listing id in path, preferring the priced version.
      const roomId = (u: string): string | null => {
        const m = u.match(/\/rooms\/(?:plus\/)?(\d+)/);
        return m ? m[1] : null;
      };
      const byId = new Map<string, Candidate>();
      for (const c of priced) {
        const id = roomId(c.url);
        if (id) byId.set(id, c);
      }
      const unpriced = site.candidates.filter((c) => {
        const id = roomId(c.url);
        return !id || !byId.has(id);
      });
      return [...priced, ...unpriced];
    })();

    // ── Vrbo + Booking via site: search ───────────────────────────────────
    let vrboRawCount = 0;
    let vrboDropped = { noResort: 0, wrongBedrooms: 0 };
    let bookingRawCount = 0;
    let bookingDropped = { noResort: 0, wrongBedrooms: 0 };
    const vrboPromise: Promise<Candidate[]> = (async () => {
      const { candidates, raw, dropped } = await siteSearch("vrbo.com", "vrbo", "Vrbo");
      vrboRawCount = raw;
      vrboDropped = dropped;
      return candidates;
    })();
    const bookingPromise: Promise<Candidate[]> = (async () => {
      const { candidates, raw, dropped } = await siteSearch("booking.com", "booking", "Booking.com");
      bookingRawCount = raw;
      bookingDropped = dropped;
      return candidates;
    })();

    const hotelsPromise: Promise<{ vrbo: Candidate[]; booking: Candidate[] }> = Promise.all([vrboPromise, bookingPromise])
      .then(([v, b]) => ({ vrbo: v, booking: b }));

    // ── Property-management companies via Google search ────────────────────
    // No live pricing — we return company sites + their booking page as
    // starting points so the host can price-check manually if the OTA results
    // above aren't cheap enough.
    // PM companies — Stage 1: find relevant PM companies via Google.
    // Stage 2: for each PM company, do a secondary `site:` search to surface
    // specific property listing pages (not just the homepage) for the target
    // bedroom count. This gives the host actual per-property URLs they can
    // click through to, rather than a generic PM homepage.
    let pmRawCount = 0;
    const pmPromise: Promise<Candidate[]> = (async () => {
      try {
        const qualifier = resortName ? `"${resortName}"` : community;
        const query = `${qualifier} vacation rental property management OR rentals -airbnb.com -vrbo.com -booking.com`;
        const params = new URLSearchParams({
          engine: "google",
          q: query,
          num: "10",
          api_key: apiKey,
        });
        const r = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!r.ok) return [];
        const data = await r.json() as any;
        const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];
        pmRawCount = organic.length;

        // Dedupe by domain and keep the top N candidate PM sites
        const seenDomains = new Set<string>();
        const pmSites: Array<{ domain: string; title: string; homepageUrl: string; snippet: string }> = [];
        for (const o of organic) {
          const url = String(o?.link ?? "");
          if (!url) continue;
          try {
            const domain = new URL(url).hostname.replace(/^www\./, "");
            if (/airbnb\.com|vrbo\.com|booking\.com|tripadvisor\.com|google\.com/.test(domain)) continue;
            if (seenDomains.has(domain)) continue;
            seenDomains.add(domain);
            pmSites.push({
              domain,
              title: String(o?.title ?? domain),
              homepageUrl: url,
              snippet: String(o?.snippet ?? "").slice(0, 140),
            });
            if (pmSites.length >= 6) break;
          } catch { /* skip malformed URLs */ }
        }

        // Stage 2: per-PM-site deep dive to find SPECIFIC property listing pages
        // with rates. We do this in parallel — 6 sites × ~1s each.
        const deepResults = await Promise.all(pmSites.map(async (site): Promise<Candidate[]> => {
          try {
            const searchQuery = `site:${site.domain} ${bedrooms} bedroom rental rates`;
            const pp = new URLSearchParams({
              engine: "google",
              q: searchQuery,
              num: "5",
              api_key: apiKey,
            });
            const rr = await fetch(`https://www.searchapi.io/api/v1/search?${pp.toString()}`);
            // If the per-site search fails, skip the PM site entirely.
            // Returning the homepage URL as a fallback (previous behavior) was
            // misleading — users clicked it expecting a specific listing.
            if (!rr.ok) return [];
            const dd = await rr.json() as any;
            const hits = Array.isArray(dd?.organic_results) ? dd.organic_results : [];
            // Extract nightly price from snippet if the PM published one
            // ("$450/night", "starting at $525", etc.)
            const extractPrice = (text: string): number => {
              const m = text.match(/\$\s*(\d{3,4})\s*(?:\/|per|a\s+)?\s*(?:night|nt|night)/i)
                ?? text.match(/(?:from|starting(?:\s+at)?)\s+\$\s*(\d{3,4})/i);
              return m ? parseInt(m[1], 10) : 0;
            };
            const candidates: Candidate[] = hits
              .filter((h: any) => {
                const hay = `${h?.title ?? ""} ${h?.snippet ?? ""}`;
                // PM deep-dive still needs to land inside the target resort
                // with the right bedroom count — same rules as the OTAs.
                return mentionsResort(hay) && bedroomOk(hay);
              })
              // Reject bare-homepage URLs — the whole point of the deep-dive
              // is to land on a specific listing page.
              .filter((h: any) => h?.link && isDetailUrl("pm", String(h.link)))
              .slice(0, 3)
              .map((h: any) => {
                const snippetText = String(h?.snippet ?? "");
                const nightly = extractPrice(snippetText + " " + String(h?.title ?? ""));
                const inferred = bedroomFromText(`${h?.title ?? ""} ${snippetText}`);
                return {
                  source: "pm" as const,
                  sourceLabel: site.title,
                  title: String(h?.title ?? "Listing").slice(0, 100),
                  url: String(h?.link ?? ""),
                  nightlyPrice: nightly,
                  totalPrice: nightly ? nightly * nights : 0,
                  bedrooms: inferred ?? undefined,
                  snippet: snippetText.slice(0, 160),
                };
              })
              .filter((c: Candidate) => c.url);
            // No homepage fallback: if we can't find a specific listing page,
            // we'd rather show nothing than a link that opens the PM homepage
            // and makes the user hunt for the unit and dates manually.
            return candidates;
          } catch (e: any) {
            console.error(`[find-buy-in] pm deep-dive ${site.domain} error:`, e.message);
            return [];
          }
        }));
        return deepResults.flat().slice(0, 20);
      } catch (e: any) {
        console.error("[find-buy-in] pm error:", e.message);
        return [];
      }
    })();

    const [airbnb, hotels, pm] = await Promise.all([airbnbPromise, hotelsPromise, pmPromise]);

    // Combined cheapest (top 2) across sources that have pricing
    const priced: Candidate[] = [...airbnb, ...hotels.vrbo, ...hotels.booking, ...pm]
      .filter(c => c.nightlyPrice > 0)
      .sort((a, b) => a.nightlyPrice - b.nightlyPrice);
    const cheapest = priced.slice(0, 2);

    console.log(
      `[find-buy-in] resort="${resortName}" ${bedrooms}BR ${checkIn}→${checkOut}: `
      + `airbnb=${airbnb.length}/${airbnbRawCount} (site, dropped noResort=${airbnbDropped.noResort}, wrongBR=${airbnbDropped.wrongBedrooms}) `
      + `airbnbEngine=${airbnbPricedCount} raw · `
      + `vrbo=${hotels.vrbo.length}/${vrboRawCount} (noResort=${vrboDropped.noResort}, wrongBR=${vrboDropped.wrongBedrooms}) `
      + `booking=${hotels.booking.length}/${bookingRawCount} (noResort=${bookingDropped.noResort}, wrongBR=${bookingDropped.wrongBedrooms}) `
      + `pm=${pm.length}/${pmRawCount} · priced=${priced.length}`
    );

    return res.json({
      community,
      resortName,
      listingTitle,
      bedrooms,
      nights,
      checkIn,
      checkOut,
      sources: {
        airbnb: airbnb.sort((a, b) => (a.nightlyPrice || 99999) - (b.nightlyPrice || 99999)),
        vrbo: hotels.vrbo.sort((a, b) => (a.nightlyPrice || 99999) - (b.nightlyPrice || 99999)),
        booking: hotels.booking.sort((a, b) => (a.nightlyPrice || 99999) - (b.nightlyPrice || 99999)),
        pm: pm.sort((a, b) => (a.nightlyPrice || 99999) - (b.nightlyPrice || 99999)),
      },
      debug: {
        rawCounts: { airbnb: airbnbRawCount, vrbo: vrboRawCount, booking: bookingRawCount, pm: pmRawCount },
        dropped: { airbnb: airbnbDropped, vrbo: vrboDropped, booking: bookingDropped },
        searchLocation,
        vrboDestination,
        resortName,
      },
      cheapest,
      totalPricedResults: priced.length,
    });
  });

  // ─── Availability verification ─────────────────────────────────────────
  // Pre-flight for auto-fill: given a specific listing URL + dates, confirm
  // the listing is actually bookable for those exact dates (not just that
  // it appeared in a broad search result). Prevents attaching buy-ins to
  // listings that have been booked since the initial search, or that
  // returned a "starting from" price not tied to our specific nights.
  //
  // Only Airbnb is verifiable — we re-call the airbnb engine with a narrow
  // query (resort + bedroom count + dates) and confirm the listing id is
  // still in the priced results. Vrbo/Booking/PM have no per-listing
  // verification endpoint in SearchAPI, so they return available=null
  // (unknown — don't block the attach, just flag to the client).
  app.get("/api/operations/verify-listing", async (req: Request, res: Response) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const url = req.query.url as string;
    const checkIn = req.query.checkIn as string;
    const checkOut = req.query.checkOut as string;
    const q = (req.query.q as string) || "";
    const bedroomsRaw = req.query.bedrooms as string | undefined;
    const bedrooms = bedroomsRaw ? parseInt(bedroomsRaw, 10) : null;

    if (!url) return res.status(400).json({ error: "url required" });
    if (!checkIn || !checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
      return res.status(400).json({ error: "checkIn and checkOut required (YYYY-MM-DD)" });
    }

    // Extract Airbnb listing id — skip verification for other sources.
    const m = url.match(/airbnb\.com\/rooms\/(?:plus\/)?(\d+)/);
    if (!m) {
      return res.json({ available: null, reason: "unsupported-source", listingId: null });
    }
    const listingId = m[1];

    try {
      const sp: Record<string, string> = {
        engine: "airbnb",
        check_in_date: checkIn,
        check_out_date: checkOut,
        adults: "2",
        currency: "USD",
        api_key: apiKey,
        q: q || "Hawaii",
      };
      if (bedrooms && !isNaN(bedrooms)) sp.bedrooms = String(bedrooms);
      const r = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`);
      if (!r.ok) {
        return res.json({ available: null, reason: `engine-${r.status}`, listingId });
      }
      const data = await r.json() as any;
      const properties: any[] = Array.isArray(data?.properties) ? data.properties : [];
      const match = properties.find((p: any) => String(p?.id ?? "") === listingId);

      if (!match) {
        // Listing didn't appear in the re-query. Could mean it's been booked,
        // dropped out of the top-N for other reasons, or is just further down
        // the results. Conservative: report available=false only when the
        // query was narrow enough that absence is meaningful (q present AND
        // bedrooms present). Otherwise report unknown.
        if (q && bedrooms) {
          return res.json({ available: false, reason: "not-in-priced-results", listingId, checkedCount: properties.length });
        }
        return res.json({ available: null, reason: "insufficient-query-scope", listingId, checkedCount: properties.length });
      }

      const total = Number(match?.price?.extracted_total_price ?? 0);
      if (!(total > 0)) {
        return res.json({ available: false, reason: "no-price-on-listing", listingId });
      }
      return res.json({
        available: true,
        listingId,
        currentTotalPrice: total,
        title: match?.name ?? match?.title ?? null,
      });
    } catch (e: any) {
      console.error(`[verify-listing] error for ${listingId}:`, e.message);
      return res.json({ available: null, reason: "network-error", listingId });
    }
  });

  // ========== BOOKINGS ↔ BUY-INS (Layer A: per-unit-slot attachment) ==========
  //
  // A multi-unit Guesty listing (e.g. 6-BR = 3-BR Unit 721 + 3-BR Unit 812) requires
  // ONE buy-in per physical unit per reservation. All endpoints below are slot-aware.

  // List reservations for a Guesty listing, annotated with per-unit-slot fill status.
  app.get("/api/bookings/listing/:listingId", async (req, res) => {
    try {
      const listingId = req.params.listingId;
      const propertyId = parseInt((req.query.propertyId as string) ?? "", 10);
      const includePast = req.query.includePast === "true";
      const limit = Math.min(parseInt((req.query.limit as string) ?? "100", 10) || 100, 200);

      if (!propertyId) {
        return res.status(400).json({ error: "propertyId query param required" });
      }

      const unitSlots = getPropertyUnits(propertyId);
      if (unitSlots.length === 0) {
        return res.status(400).json({ error: `No unit config found for property ${propertyId}` });
      }

      const today = new Date().toISOString().slice(0, 10);
      const fields = encodeURIComponent("_id status checkIn checkOut checkInDateLocalized checkOutDateLocalized nightsCount guest money source integration confirmationCode preApproveState");
      let url = `/reservations?listingId=${encodeURIComponent(listingId)}&limit=${limit}&sort=checkIn&fields=${fields}&status[]=confirmed&status[]=inquiry&status[]=awaitingPayment`;
      if (!includePast) {
        url += `&checkOutFrom=${today}`;
      }
      const data = await guestyRequest("GET", url) as any;
      // Guesty wraps list responses inconsistently across accounts — could be
      //   { results: [...] }         (legacy)
      //   { data: [...] }            (new flat)
      //   { data: { results: [...] } } (new envelope)
      const reservations: any[] = Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.data?.results)
            ? data.data.results
            : [];

      // For each reservation build per-slot attachment info
      const enriched = await Promise.all(
        reservations.map(async (r) => {
          const attached = r._id ? await storage.getBuyInsByReservation(r._id) : [];
          const slots = unitSlots.map((slot) => {
            const buyIn = attached.find((b) => b.unitId === slot.unitId) ?? null;
            return { ...slot, buyIn };
          });
          const filled = slots.filter((s) => s.buyIn).length;
          return {
            ...r,
            slots,
            slotsFilled: filled,
            slotsTotal: slots.length,
            fullyLinked: filled === slots.length,
          };
        }),
      );

      res.json({
        reservations: enriched,
        total: enriched.length,
        unitSlots,
        propertyId,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch bookings", message: err.message });
    }
  });

  // Buy-in candidates for ONE specific unit slot on a booking.
  app.get("/api/bookings/:reservationId/buy-in-candidates", async (req, res) => {
    try {
      const reservationId = req.params.reservationId;
      const propertyId = parseInt((req.query.propertyId as string) ?? "", 10);
      const unitId = req.query.unitId as string;
      const checkIn = req.query.checkIn as string;
      const checkOut = req.query.checkOut as string;

      if (!propertyId || !unitId || !checkIn || !checkOut) {
        return res.status(400).json({ error: "propertyId, unitId, checkIn, checkOut query params required" });
      }

      const slot = getUnitConfig(propertyId, unitId);
      if (!slot) {
        return res.status(404).json({ error: `Unit ${unitId} not configured for property ${propertyId}` });
      }

      const candidates = await storage.getBuyInCandidates({ propertyId, unitId, checkIn, checkOut });
      const bookingNights = Math.max(1, Math.round((+new Date(checkOut) - +new Date(checkIn)) / 86400000));

      const ranked = candidates
        .map((b) => {
          const buyInNights = Math.max(1, Math.round((+new Date(b.checkOut) - +new Date(b.checkIn)) / 86400000));
          const cost = parseFloat(String(b.costPaid)) || 0;
          const costPerNight = cost / buyInNights;
          const wastedNights = buyInNights - bookingNights;
          const score = costPerNight * bookingNights + Math.max(0, wastedNights) * costPerNight * 0.5;
          return {
            buyIn: b,
            buyInNights,
            totalCost: cost,
            costPerNight: Math.round(costPerNight * 100) / 100,
            wastedNights,
            effectiveCost: Math.round(costPerNight * bookingNights * 100) / 100,
            score: Math.round(score * 100) / 100,
          };
        })
        .sort((a, b) => a.score - b.score);

      res.json({
        reservationId,
        slot,
        bookingNights,
        candidates: ranked,
        count: ranked.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to find candidates", message: err.message });
    }
  });

  // Attach a buy-in to a reservation. Enforces one buy-in per (reservation, unit slot).
  app.post("/api/bookings/:reservationId/attach-buy-in", async (req, res) => {
    try {
      const reservationId = req.params.reservationId;
      const { buyInId } = req.body as { buyInId: number };
      if (!buyInId) return res.status(400).json({ error: "buyInId required" });

      const buyIn = await storage.attachBuyIn(buyInId, reservationId);
      if (!buyIn) return res.status(404).json({ error: "Buy-in not found" });
      res.json(buyIn);
    } catch (err: any) {
      res.status(400).json({ error: "Failed to attach buy-in", message: err.message });
    }
  });

  // Detach a specific buy-in from its reservation (pass buyInId, not reservationId-only).
  app.post("/api/bookings/detach-buy-in/:buyInId", async (req, res) => {
    try {
      const buyInId = parseInt(req.params.buyInId, 10);
      const buyIn = await storage.detachBuyIn(buyInId);
      if (!buyIn) return res.status(404).json({ error: "Buy-in not found" });
      res.json(buyIn);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to detach buy-in", message: err.message });
    }
  });

  // ========== AIRBNB SEARCH VIA SEARCHAPI.IO ==========

  // CONDO / TOWNHOME ONLY — mirrors shared/property-units.ts.
  // Removed villa/single-family entries (7, 10, 12, 14, 21, 26, 28, 31) on
  // 2026-04 per business-model pivot.
  const PROPERTY_UNIT_NEEDS: Record<number, { community: string; units: { bedrooms: number }[] }> = {
    1: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 2 }, { bedrooms: 2 }] },
    4: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    8: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    9: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    18: { community: "Poipu Kai", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    19: { community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    20: { community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 3 }] },
    23: { community: "Kapaa Beachfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    24: { community: "Poipu Oceanfront", units: [{ bedrooms: 3 }, { bedrooms: 2 }] },
    27: { community: "Poipu Kai", units: [{ bedrooms: 2 }, { bedrooms: 2 }] },
    29: { community: "Princeville", units: [{ bedrooms: 3 }, { bedrooms: 4 }] },
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

  // Bounding boxes (SW lat/lng → NE lat/lng) for each community.
  // SearchAPI Airbnb supports sw_lat/sw_lng/ne_lat/ne_lng to geo-constrain results.
  // We also post-filter by GPS coordinates in the returned listings for extra precision.
  const COMMUNITY_BOUNDS: Record<string, { sw_lat: number; sw_lng: number; ne_lat: number; ne_lng: number }> = {
    "Poipu Kai":        { sw_lat: 21.875, sw_lng: -159.478, ne_lat: 21.895, ne_lng: -159.458 },
    "Pili Mai":         { sw_lat: 21.882, sw_lng: -159.483, ne_lat: 21.899, ne_lng: -159.468 },
    "Poipu Brenneckes": { sw_lat: 21.872, sw_lng: -159.462, ne_lat: 21.882, ne_lng: -159.448 },
    "Poipu Oceanfront": { sw_lat: 21.872, sw_lng: -159.462, ne_lat: 21.882, ne_lng: -159.448 },
    "Princeville":      { sw_lat: 22.210, sw_lng: -159.498, ne_lat: 22.235, ne_lng: -159.468 },
    "Kapaa Beachfront": { sw_lat: 22.060, sw_lng: -159.333, ne_lat: 22.085, ne_lng: -159.308 },
    "Kekaha Beachfront":{ sw_lat: 21.955, sw_lng: -159.758, ne_lat: 21.978, ne_lng: -159.733 },
    "Keauhou":          { sw_lat: 19.528, sw_lng: -155.992, ne_lat: 19.558, ne_lng: -155.966 },
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

      const communityBounds = COMMUNITY_BOUNDS[propertyConfig.community];

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

        // q is always required by SearchAPI; bounds are added on top for geo-precision
        searchParams.q = searchLocation;
        if (communityBounds) {
          searchParams.sw_lat = String(communityBounds.sw_lat);
          searchParams.sw_lng = String(communityBounds.sw_lng);
          searchParams.ne_lat = String(communityBounds.ne_lat);
          searchParams.ne_lng = String(communityBounds.ne_lng);
        }

        const params = new URLSearchParams(searchParams);

        const response = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!response.ok) {
          const errText = await response.text();
          console.error(`SearchAPI error for ${bedrooms}BR:`, errText);
          results.searches[`${bedrooms}BR`] = { error: `SearchAPI returned ${response.status}`, count, properties: [] };
          continue;
        }

        const data = await response.json();
        let properties = (data.properties || []).map((p: any) => ({
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
          source: "airbnb",
        }));

        // Post-filter by GPS coordinates if bounding box is defined and listings have coordinates
        if (communityBounds) {
          const geoFiltered = properties.filter((p: any) => {
            const lat = p.gpsCoordinates?.latitude;
            const lng = p.gpsCoordinates?.longitude;
            if (!lat || !lng) return true; // keep if no coords (don't drop unknowns)
            return (
              lat >= communityBounds.sw_lat && lat <= communityBounds.ne_lat &&
              lng >= communityBounds.sw_lng && lng <= communityBounds.ne_lng
            );
          });
          // Only apply GPS filter if it retains at least some results
          if (geoFiltered.length > 0) properties = geoFiltered;
        }

        properties.sort((a: any, b: any) => {
          const priceA = a.price?.extracted_total_price ?? Infinity;
          const priceB = b.price?.extracted_total_price ?? Infinity;
          return priceA - priceB;
        });

        results.searches[`${bedrooms}BR`] = {
          count,
          totalResults: properties.length,
          properties: properties.slice(0, 10),
          geoFiltered: !!communityBounds,
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

  // ========== BUILDER PHOTO UPSCALE & UPLOAD ==========

  // Upscales a single local photo via Real-ESRGAN, hosts on ImgBB, returns public URL.
  // Client calls this for each photo in sequence then passes ImgBB URLs to Guesty.
  app.post("/api/builder/upscale-photo", async (req, res) => {
    const imgbbKey = process.env.IMGBB_API_KEY;
    const replicateKey = process.env.REPLICATE_API_KEY;

    const { localPath } = req.body as { localPath: string };
    if (!localPath || !localPath.startsWith("/photos/")) {
      return res.status(400).json({ error: "Invalid localPath — must start with /photos/" });
    }

    const safePath = localPath.replace(/\.\./g, "");
    const fullPath = path.join(process.cwd(), "client", "public", safePath);

    let rawData: Buffer;
    try {
      rawData = fs.readFileSync(fullPath);
    } catch {
      return res.status(404).json({ error: "Photo file not found", localPath: safePath });
    }

    const ext = path.extname(safePath).toLowerCase();
    const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

    // Upscale with Real-ESRGAN if key available
    let finalBuffer = rawData;
    let wasUpscaled = false;
    if (replicateKey) {
      console.log(`[builder-upscale] Upscaling ${safePath}...`);
      const upscaled = await upscaleWithReplicateKw(rawData, mimeType);
      if (upscaled) {
        finalBuffer = upscaled;
        wasUpscaled = true;
        console.log(`[builder-upscale] ✓ ${safePath} upscaled (${rawData.length} → ${upscaled.length} bytes)`);
      } else {
        console.warn(`[builder-upscale] Upscale failed for ${safePath}, using original`);
      }
    }

    // Upload to ImgBB to get a publicly accessible URL for Guesty
    if (!imgbbKey) {
      return res.status(500).json({ error: "IMGBB_API_KEY not configured — needed to host photos for Guesty" });
    }

    try {
      const form = new FormData();
      form.append("image", finalBuffer.toString("base64"));
      const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
        method: "POST",
        body: form,
      });
      if (!imgbbResp.ok) {
        const errText = await imgbbResp.text();
        return res.status(502).json({ error: "ImgBB upload failed", detail: errText });
      }
      const imgbbData = await imgbbResp.json() as any;
      const publicUrl = imgbbData?.data?.url;
      if (!publicUrl) return res.status(502).json({ error: "ImgBB returned no URL" });

      res.json({ url: publicUrl, wasUpscaled, localPath: safePath });
    } catch (err: any) {
      res.status(500).json({ error: "Upload to ImgBB failed", message: err.message });
    }
  });

  // ========== BUILDER COVER COLLAGE UPLOAD ==========
  // POST /api/builder/upload-collage
  // Accepts { base64: string (data URL or raw base64), listingId: string }
  // Uploads to ImgBB, prepends to Guesty listing pictures as cover photo.
  app.post("/api/builder/upload-collage", async (req, res) => {
    const imgbbKey = process.env.IMGBB_API_KEY;
    if (!imgbbKey) return res.status(500).json({ error: "IMGBB_API_KEY not configured" });

    const { base64, listingId } = req.body as { base64: string; listingId: string };
    if (!base64 || !listingId) return res.status(400).json({ error: "base64 and listingId required" });

    // Strip data URL prefix if present
    const raw = base64.replace(/^data:image\/[a-z]+;base64,/, "");

    // Upload to ImgBB
    let collageUrl: string;
    try {
      const form = new FormData();
      form.append("image", raw);
      const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, { method: "POST", body: form });
      if (!imgbbResp.ok) {
        const t = await imgbbResp.text();
        return res.status(502).json({ error: "ImgBB upload failed", detail: t.slice(0, 200) });
      }
      const imgbbData = await imgbbResp.json() as any;
      collageUrl = imgbbData?.data?.url;
      if (!collageUrl) return res.status(502).json({ error: "ImgBB returned no URL" });
    } catch (e: any) {
      return res.status(500).json({ error: "ImgBB error", message: e.message });
    }

    // Fetch existing pictures from Guesty, prepend collage as cover
    try {
      const listing = await guestyRequest("GET", `/listings/${listingId}`) as any;
      const existing: { original: string; caption: string }[] = (listing?.pictures || []).map((p: any) => ({
        original: p.original || p.url || "",
        caption: p.caption || "",
      })).filter((p: any) => p.original);

      // Remove any previous collage (first photo tagged with caption "Cover Collage")
      const withoutOldCollage = existing.filter(p => p.caption !== "Cover Collage");
      const updated = [{ original: collageUrl, caption: "Cover Collage" }, ...withoutOldCollage];
      await guestyRequest("PUT", `/listings/${listingId}`, { pictures: updated });

      res.json({ success: true, collageUrl, totalPhotos: updated.length });
    } catch (e: any) {
      res.status(500).json({ error: "Guesty update failed", message: e.message });
    }
  });

  // POST /api/builder/push-descriptions
  // POST /api/builder/push-channel-markups
  // Sets per-channel price adjustments on a Guesty listing, so the rate the
  // guest sees on Booking.com / Vrbo / Airbnb is ± X% vs the base rate.
  // Typically used to offset higher channel host-fees — e.g. +17% on
  // Booking.com to recover their commission.
  //
  // Body: { listingId: string, markups: { airbnb?: number, vrbo?: number, booking?: number, direct?: number } }
  //   Each markup is a decimal (0.05 = +5%). Negative decreases the rate.
  //
  // Guesty's schema for channel markup has drifted — we try a few known paths:
  //   1. PUT /listings/{id} body { priceMarkup: {airbnb: 0.05, ...} }
  //   2. PUT /listings/{id} body { integrations: {airbnb2: {priceMarkup: 0.05}, ...} }
  //   3. PUT /listings/{id} body { channels: {airbnb2: {priceMarkup: 0.05}, ...} }
  //   4. PUT /listings/{id}/channel-commissions body { channel: "airbnb", markup }
  // We POST all of them in a single PUT with both shape variants merged so whichever
  // Guesty cares about gets applied.
  app.post("/api/builder/push-channel-markups", async (req: Request, res: Response) => {
    const { listingId, markups } = req.body as {
      listingId?: string;
      markups?: Partial<Record<"airbnb" | "vrbo" | "booking" | "direct", number>>;
    };
    if (!listingId) return res.status(400).json({ error: "listingId required" });
    if (!markups || typeof markups !== "object") return res.status(400).json({ error: "markups object required" });

    // Map our logical channel keys to Guesty's integration platform keys.
    // Confirmed from a real listing read-back on 2026-04-21:
    //   Airbnb  → airbnb2     (legacy `airbnb` kept as fallback)
    //   Vrbo    → homeaway2   (Vrbo uses the HomeAway-2 integration slug;
    //                          `homeaway`/`vrbo` are NOT accepted)
    //   Booking → bookingCom
    //   Direct  → no integration record in Guesty — handled via base rate
    const channelToGuesty: Record<string, string[]> = {
      airbnb: ["airbnb2", "airbnb"],
      vrbo: ["homeaway2", "homeaway", "vrbo"],
      booking: ["bookingCom", "booking"],
      direct: ["manual", "direct"],
    };

    // Build PUT body that targets every known shape Guesty might accept
    const priceMarkupFlat: Record<string, number> = {};
    const integrationsPatch: Record<string, { priceMarkup?: number; priceAdjustment?: number }> = {};
    const channelsPatch: Record<string, { priceMarkup?: number }> = {};

    for (const [key, value] of Object.entries(markups)) {
      if (typeof value !== "number" || isNaN(value)) continue;
      priceMarkupFlat[key] = value;
      for (const guestyKey of channelToGuesty[key] ?? [key]) {
        integrationsPatch[guestyKey] = { priceMarkup: value, priceAdjustment: value };
        channelsPatch[guestyKey] = { priceMarkup: value };
      }
    }

    console.log(`[push-channel-markups] listing ${listingId}`, priceMarkupFlat);

    // Based on inspecting a live Guesty listing:
    //   - There's a top-level `markups: {}` field. That's the real target.
    //   - `integrations` is an ARRAY of {platform, ...}, not an object —
    //     so the old {integrations: {airbnb2: ...}} body was malformed.
    //   - `useAccountMarkups: true` flag forces Guesty to use account-level
    //     markups and IGNORE listing-level ones. We must flip it to false
    //     alongside the markup write or the push is silently thrown away.
    //
    // Guesty's exact schema for `markups` isn't documented (at least not
    // in the Open API reference) so we still try a few candidate shapes
    // and let the read-back confirm which one Guesty honors.
    type ShapeAttempt = {
      shape: string;
      body: Record<string, unknown>;
      ok: boolean;
      error?: string;
    };
    const attempts: ShapeAttempt[] = [];

    const tryShape = async (shape: string, body: Record<string, unknown>) => {
      try {
        await guestyRequest("PUT", `/listings/${listingId}`, body);
        attempts.push({ shape, body, ok: true });
        return true;
      } catch (e: any) {
        attempts.push({ shape, body, ok: false, error: e?.message ?? String(e) });
        return false;
      }
    };

    // Helper: snapshot the listing AFTER a push to see what Guesty actually
    // stored. The UI shows this so the operator knows which field path
    // (if any) got through.
    const readbackSaved = async () => {
      try {
        const fetched = await guestyRequest("GET", `/listings/${listingId}`) as any;
        return {
          markups: fetched?.markups ?? null,
          useAccountMarkups: fetched?.useAccountMarkups ?? null,
          priceMarkup: fetched?.priceMarkup ?? null,
        };
      } catch (e: any) {
        return { markups: null, useAccountMarkups: null, priceMarkup: null, readError: e?.message };
      }
    };

    // Convert our channel keys to Guesty platform keys for the `markups` body.
    const markupsByPlatform: Record<string, number> = {};
    const markupsByPlatformObj: Record<string, { percent: number; active: boolean }> = {};
    for (const [key, value] of Object.entries(priceMarkupFlat)) {
      for (const guestyKey of channelToGuesty[key] ?? [key]) {
        markupsByPlatform[guestyKey] = value;
        markupsByPlatformObj[guestyKey] = { percent: value * 100, active: true };
      }
    }

    // IMPORTANT: always flip useAccountMarkups off — listing-level markups
    // are ignored when the account-level toggle is true.
    let anySucceeded = false;
    if (!anySucceeded && Object.keys(markupsByPlatform).length > 0) {
      // Shape A: markups: { airbnb2: 0.148, ... } — flat decimals under `markups`
      anySucceeded = await tryShape("markups-flat-decimal", {
        useAccountMarkups: false,
        markups: markupsByPlatform,
      });
      if (anySucceeded) {
        const rb = await readbackSaved();
        if (rb.markups && typeof rb.markups === "object" && Object.keys(rb.markups).length > 0) {
          return res.json({ success: true, sent: markups, saved: rb, attempts, storedShape: "markups-flat-decimal" });
        }
        // Stored empty again — keep trying other shapes.
        anySucceeded = false;
      }
    }
    if (!anySucceeded && Object.keys(markupsByPlatformObj).length > 0) {
      // Shape B: markups: { airbnb2: { percent: 14.8, active: true }, ... }
      anySucceeded = await tryShape("markups-object-percent", {
        useAccountMarkups: false,
        markups: markupsByPlatformObj,
      });
      if (anySucceeded) {
        const rb = await readbackSaved();
        if (rb.markups && typeof rb.markups === "object" && Object.keys(rb.markups).length > 0) {
          return res.json({ success: true, sent: markups, saved: rb, attempts, storedShape: "markups-object-percent" });
        }
        anySucceeded = false;
      }
    }
    if (!anySucceeded) {
      // Shape C: legacy priceMarkup flat (old code path — kept as fallback).
      anySucceeded = await tryShape("priceMarkup-flat", { priceMarkup: priceMarkupFlat });
      if (anySucceeded) {
        const rb = await readbackSaved();
        if (rb.priceMarkup && Object.keys(rb.priceMarkup).length > 0) {
          return res.json({ success: true, sent: markups, saved: rb, attempts, storedShape: "priceMarkup-flat" });
        }
        anySucceeded = false;
      }
    }

    // Every attempt "succeeded" at HTTP level but Guesty stored nothing.
    // Tell the client honestly — they'll need to set markups in the
    // Guesty UI or at account level since the Open API path isn't honoring
    // any of the body shapes we've tried for this account.
    const saved = await readbackSaved();
    return res.json({
      success: false,
      sent: markups,
      saved,
      attempts,
      error:
        "Guesty accepted each PUT with HTTP 200 but stored nothing. Most likely cause: "
        + "listing-level channel markups aren't exposed via the Open API on this account. "
        + "Set them manually in the Guesty UI (Channel Manager → per-channel markup), "
        + "or we need a real documented field path.",
    });
  });

  // POST /api/builder/push-compliance — pushes TMK, TAT, and GET license to Guesty's internal tags (not synced to Airbnb/VRBO)
  app.post("/api/builder/push-compliance", async (req: Request, res: Response) => {
    const { listingId, taxMapKey, tatLicense, getLicense } = req.body as {
      listingId: string;
      taxMapKey?: string;
      tatLicense?: string;
      getLicense?: string;
    };
    if (!listingId) return res.status(400).json({ error: "listingId required" });
    if (!taxMapKey && !tatLicense && !getLicense) return res.status(400).json({ error: "taxMapKey, tatLicense, or getLicense required" });

    console.log(`[push-compliance] listing ${listingId} TMK:${taxMapKey} TAT:${tatLicense} GET:${getLicense}`);
    try {
      const current = await guestyRequest("GET", `/listings/${listingId}`) as Record<string, unknown>;

      // ── Step 1: Guesty tags (internal reference) ────────────────────────────
      const existingTags: string[] = Array.isArray(current.tags) ? current.tags : [];
      const stripped = existingTags.filter(t => !t.startsWith("TMK:") && !t.startsWith("TAT:") && !t.startsWith("GET:"));
      if (taxMapKey) stripped.push(`TMK:${taxMapKey}`);
      if (tatLicense) stripped.push(`TAT:${tatLicense}`);
      if (getLicense) stripped.push(`GET:${getLicense}`);
      await guestyRequest("PUT", `/listings/${listingId}`, { tags: stripped });

      // ── Step 2: licenseNumber field — Guesty's top-level "Registration/License
      //            Number" field. TAT is the STR permit so it's the primary value.
      //            taxId is Guesty's GET/General Excise Tax field.
      const licenseNumValue = tatLicense || getLicense || null;
      const taxIdValue = getLicense || null;
      const licPayload: Record<string, string> = {};
      if (licenseNumValue) licPayload.licenseNumber = licenseNumValue;
      if (taxIdValue) licPayload.taxId = taxIdValue;
      if (Object.keys(licPayload).length > 0) {
        await guestyRequest("PUT", `/listings/${listingId}`, licPayload);
      }

      // ── Step 3: VRBO channel compliance fields ───────────────────────────────
      // Guesty exposes these under channels.homeaway only once VRBO OAuth is
      // active for the listing. We attempt a best-effort push and verify.
      const vrboPayload: Record<string, unknown> = {};
      if (tatLicense || getLicense || taxMapKey) {
        vrboPayload["channels"] = {
          homeaway: {
            ...(tatLicense  ? { licenseNumber: tatLicense } : {}),
            ...(getLicense  ? { taxId:         getLicense } : {}),
            ...(taxMapKey   ? { parcelNumber:   taxMapKey  } : {}),
          },
        };
        try {
          await guestyRequest("PUT", `/listings/${listingId}`, vrboPayload);
        } catch { /* silently swallow — VRBO fields are optional */ }
      }

      // ── Step 4: publicDescription.notes (OTA-facing compliance block) ────────
      const COMPLIANCE_MARKER = "=== Hawaii Tax Compliance ===";
      const pubDesc = (current.publicDescription || {}) as Record<string, string>;
      const existingNotes: string = pubDesc.notes || "";
      const notesWithoutOldBlock = existingNotes.split(COMPLIANCE_MARKER)[0].trimEnd();
      const complianceLines: string[] = [COMPLIANCE_MARKER];
      if (getLicense) complianceLines.push(`General Excise Tax ID (GET): ${getLicense}`);
      if (tatLicense) complianceLines.push(`Transient Accommodations Tax ID (TAT): ${tatLicense}`);
      if (taxMapKey)  complianceLines.push(`Parcel Number (Tax Map Key): ${taxMapKey}`);
      const newNotes = [notesWithoutOldBlock, complianceLines.join("\n")].filter(Boolean).join("\n\n");
      await guestyRequest("PUT", `/listings/${listingId}`, { publicDescription: { notes: newNotes } });

      // ── Step 5: Verify everything via GET ────────────────────────────────────
      await new Promise(r => setTimeout(r, 500));
      const fetched = await guestyRequest("GET", `/listings/${listingId}`) as Record<string, unknown>;

      const savedTags: string[] = Array.isArray(fetched.tags) ? fetched.tags : [];
      const savedNotes: string = ((fetched.publicDescription as Record<string, string> | undefined)?.notes) || "";
      const savedLicenseNumber: string = (fetched.licenseNumber as string) || "";
      const savedTaxId: string = (fetched.taxId as string) || "";
      const vrboChannel = ((fetched.channels as Record<string, unknown> | undefined)?.homeaway || {}) as Record<string, string>;
      const savedVrboLicense  = vrboChannel.licenseNumber  || "";
      const savedVrboTaxId    = vrboChannel.taxId          || "";
      const savedVrboParcel   = vrboChannel.parcelNumber   || "";

      const tagsVerified =
        (!taxMapKey  || savedTags.some(t => t.includes(taxMapKey)))  &&
        (!tatLicense || savedTags.some(t => t.includes(tatLicense))) &&
        (!getLicense || savedTags.some(t => t.includes(getLicense)));
      const notesVerified = savedNotes.includes(COMPLIANCE_MARKER);
      const licenseNumberSaved = licenseNumValue ? savedLicenseNumber === licenseNumValue : null;
      const taxIdSaved = taxIdValue ? savedTaxId === taxIdValue : null;
      const vrboActive = !!(savedVrboLicense || savedVrboTaxId || savedVrboParcel);

      console.log(`[push-compliance] tags=${tagsVerified} notes=${notesVerified} licenseNumber=${licenseNumberSaved} taxId=${taxIdSaved} vrbo=${vrboActive}`);

      return res.json({
        success: true,
        verified: tagsVerified && notesVerified,
        savedTags,
        notesUpdated: notesVerified,
        // New fields
        licenseNumber: { sent: licenseNumValue, saved: savedLicenseNumber, ok: licenseNumberSaved },
        taxId:         { sent: taxIdValue,       saved: savedTaxId,         ok: taxIdSaved },
        vrbo: {
          attempted: Object.keys(vrboPayload).length > 0,
          saved: vrboActive,
          licenseNumber:  savedVrboLicense,
          taxId:          savedVrboTaxId,
          parcelNumber:   savedVrboParcel,
          note: vrboActive
            ? "VRBO channel compliance fields saved."
            : "VRBO fields not saved — listing needs an active VRBO channel (OAuth) in Guesty UI first.",
        },
      });
    } catch (err: any) {
      console.error(`[push-compliance] error:`, err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/builder/push-amenities — writes canonical amenity names to Guesty's
  // properties-api, which drives the Popular-Amenities checkboxes in the UI.
  // Body: { listingId, amenities: string[] } where amenities are Guesty canonical
  // names (e.g. "Air conditioning", "BBQ grill") from /properties-api/amenities/supported.
  app.post("/api/builder/push-amenities", async (req: Request, res: Response) => {
    const { listingId, amenities } = req.body as { listingId?: string; amenities?: string[] };
    if (!listingId) return res.status(400).json({ success: false, error: "listingId required" });
    if (!Array.isArray(amenities)) return res.status(400).json({ success: false, error: "amenities must be an array" });

    console.log(`[push-amenities] listing ${listingId} — ${amenities.length} amenities in`);
    try {
      // Resolve propertyId from the listing. Guesty's account schema varies:
      //  - Newer accounts expose propertyId / property._id as a separate entity.
      //  - Legacy accounts fold listing and property into one record; the listing _id
      //    is the property id used by /properties-api/amenities/{propertyId}.
      const listing = await guestyRequest("GET", `/listings/${listingId}`) as Record<string, unknown>;
      const propertyId =
        (listing.propertyId as string | undefined) ??
        (listing as any).property?._id ??
        (listing as any)._id ??
        listingId;
      console.log(
        `[push-amenities] resolved propertyId=${propertyId} ` +
        `(listing top-level keys: ${Object.keys(listing).slice(0, 25).join(",")})`,
      );

      // Normalize inputs against Guesty's canonical supported-amenities list.
      // Anything that doesn't map to a canonical name is pushed as a free-form
      // `otherAmenities` entry (Guesty surfaces these in the "Other" section).
      const supportedRaw = await guestyRequest("GET", "/properties-api/amenities/supported") as unknown;
      const supportedList: { name?: string }[] = Array.isArray(supportedRaw)
        ? supportedRaw as { name?: string }[]
        : ((supportedRaw as any)?.results ?? (supportedRaw as any)?.amenities ?? []);
      const canonicalNames = supportedList.map(a => a.name).filter((n): n is string => !!n);
      const norm = (s: string) =>
        s.toLowerCase().replace(/[_\-/&]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
      const byNorm = new Map(canonicalNames.map(n => [norm(n), n]));

      // Explicit aliases: our label/key → normalized Guesty name. Added for cases
      // where Guesty's wording diverges from ours. Values must pre-normalize cleanly
      // to a key present in byNorm.
      const aliasPairs: [string, string][] = [
        // Confirmed from user feedback (round 1)
        ["COVERED_LANAI_PATIO", "patio or balcony"],
        ["Covered Lanai / Patio", "patio or balcony"],
        ["OUTDOOR_FURNITURE", "outdoor seating furniture"],
        ["Outdoor Furniture", "outdoor seating furniture"],
        ["NEAR_SHOPPING", "shopping"],
        ["Near Shopping", "shopping"],
        ["NEAR_BEACH", "beach"],
        ["Near Beach (walking distance)", "beach"],
        // Confirmed from user feedback (round 2 — suggestion-panel alternatives)
        ["BEACHFRONT", "beach front"],
        ["Beachfront (on the beach)", "beach front"],
        ["OCEAN_VIEW", "sea view"],
        ["Ocean View", "sea view"],
        ["CARBON_MONOXIDE_ALARM", "carbon monoxide detector"],
        ["Carbon Monoxide Alarm", "carbon monoxide detector"],
        ["SMOKE_ALARM", "smoke detector"],
        ["SWIMMING_POOL_SHARED", "outdoor pool"],
        ["Swimming Pool (Shared)", "outdoor pool"],
        // "Pool" in our profile (if present) also goes to outdoor pool (Hawaii default)
        ["POOL", "outdoor pool"],
        ["CHILDREN_WELCOME", "family kid friendly"],
        ["Children Welcome", "family kid friendly"],
        // Previously-working items (keep)
        ["AIR_CONDITIONING", "air conditioning"],
        ["BBQ_GRILL", "bbq grill"],
        ["BBQ / Grill", "bbq grill"],
        ["ELEVATOR", "elevator"],
        ["Elevator Access", "elevator"],
        ["HAIR_DRYER", "hair dryer"],
        ["IRON_IRONING_BOARD", "iron"],
        ["COFFEE_MAKER", "coffee maker"],
        ["CABLE_TV", "cable tv"],
        ["PRIVATE_ENTRANCE", "private entrance"],
        ["LAPTOP_FRIENDLY_WORKSPACE", "laptop friendly workspace"],
        ["LONG_TERM_STAYS_ALLOWED", "long term stays allowed"],
      ];
      const aliasMap = new Map(aliasPairs.map(([k, v]) => [norm(k), v]));

      const resolveCanonical = (input: string): string | null => {
        const n = norm(input);
        const direct = byNorm.get(n);
        if (direct) return direct;
        const aliased = aliasMap.get(n);
        if (aliased) return byNorm.get(aliased) ?? null;
        return null;
      };

      const translated: string[] = [];
      const otherToSend: string[] = [];
      const dedupe = new Set<string>();
      const otherDedupe = new Set<string>();
      for (const a of amenities) {
        const hit = resolveCanonical(a);
        if (hit) {
          if (!dedupe.has(hit)) { dedupe.add(hit); translated.push(hit); }
        } else {
          // Preserve a human-readable form for the "Other" bucket.
          const pretty = a.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
          const key = pretty.toLowerCase();
          if (!otherDedupe.has(key)) { otherDedupe.add(key); otherToSend.push(pretty); }
        }
      }
      console.log(`[push-amenities] canonical=${translated.length} other=${otherToSend.length}`);
      if (otherToSend.length) console.log(`[push-amenities] other (not sent, Guesty ignores):`, otherToSend.slice(0, 10));

      // Only send canonical amenities. Guesty's PUT silently ignores otherAmenities
      // so we stop wasting the slot — unmapped items are reported back to the UI.
      await guestyRequest("PUT", `/properties-api/amenities/${propertyId}`, {
        amenities: translated,
      });

      // GET-after-PUT — wait briefly for Guesty's async write to commit
      await new Promise(r => setTimeout(r, 2000));
      const fetched = await guestyRequest("GET", `/properties-api/amenities/${propertyId}`) as Record<string, unknown>;
      const savedAmenities: string[] = Array.isArray(fetched.amenities) ? fetched.amenities as string[] : [];
      const savedOther: string[] = Array.isArray((fetched as any).otherAmenities) ? (fetched as any).otherAmenities : [];
      const savedLower = new Set([...savedAmenities, ...savedOther].map(s => s.toLowerCase()));
      const missing = [...translated, ...otherToSend].filter(a => !savedLower.has(a.toLowerCase()));

      // Build a nearest-match suggestion for each item Guesty couldn't accept,
      // so the UI can show the user Guesty's closest available name.
      // Suggestion ranker. Prefer:
      //  (1) exact token match anywhere in the candidate name (worth more than substring)
      //  (2) candidates whose token count matches the input's
      //  (3) shorter candidates when scores tie (less noise)
      // and return up to 3 candidates per input so the user can pick the right one.
      const suggestFor = (input: string): string[] => {
        const inputTokens = norm(input).split(" ").filter(t => t.length >= 2);
        if (!inputTokens.length) return [];
        const ranked = canonicalNames.map(name => {
          const candTokens = norm(name).split(" ").filter(Boolean);
          const candSet = new Set(candTokens);
          let score = 0;
          for (const t of inputTokens) {
            if (candSet.has(t)) score += 10 + t.length;       // exact token match
            else if (candTokens.some(c => c.startsWith(t) || t.startsWith(c))) score += 5;  // prefix overlap
            else if (norm(name).includes(t)) score += 1;      // substring fallback
          }
          // Penalise candidates that are much longer than the input
          const lenPenalty = Math.max(0, candTokens.length - inputTokens.length) * 2;
          return { name, score: score - lenPenalty, len: name.length };
        }).filter(x => x.score > 0);
        ranked.sort((a, b) => b.score - a.score || a.len - b.len);
        return ranked.slice(0, 3).map(r => r.name);
      };
      const suggestions = otherToSend.map(name => ({ name, suggestion: suggestFor(name)[0] ?? null, alternatives: suggestFor(name).slice(1) }));

      console.log(`[push-amenities] saved=${savedAmenities.length} missing=${missing.length} rejected=${otherToSend.length}`);
      console.log(`[push-amenities] guesty returned sample:`, savedAmenities.slice(0, 10));
      if (missing.length) console.log(`[push-amenities] missing sample:`, missing.slice(0, 10));
      res.json({
        success: true,
        sent: translated.length,
        saved: savedAmenities.length,
        savedAmenities,
        otherAmenities: savedOther,
        rejected: otherToSend,
        suggestions,
        missing,
        propertyId,
        guestyCatalogSize: canonicalNames.length,
      });
    } catch (err: any) {
      console.error(`[push-amenities] error:`, err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/builder/guesty-amenities?listingId=xxx — returns {amenities, otherAmenities}
  // currently set on the property (drives the Popular-Amenities panel in Guesty UI).
  app.get("/api/builder/guesty-amenities", async (req: Request, res: Response) => {
    const { listingId } = req.query as { listingId?: string };
    if (!listingId) return res.status(400).json({ error: "listingId required" });
    try {
      const listing = await guestyRequest("GET", `/listings/${listingId}`) as Record<string, unknown>;
      const propertyId =
        (listing.propertyId as string | undefined) ??
        (listing as any).property?._id ??
        (listing as any)._id ??
        listingId;
      const data = await guestyRequest("GET", `/properties-api/amenities/${propertyId}`);
      return res.json({ ...(data as object), propertyId });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/builder/guesty-supported-amenities — returns Guesty's canonical amenity list
  app.get("/api/builder/guesty-supported-amenities", async (req: Request, res: Response) => {
    try {
      const data = await guestyRequest("GET", "/properties-api/amenities/supported");
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/builder/inspect-listing?listingId=xxx  — returns raw Guesty listing JSON
  app.get("/api/builder/inspect-listing", async (req: Request, res: Response) => {
    const { listingId } = req.query as { listingId?: string };
    if (!listingId) return res.status(400).json({ error: "listingId required" });
    try {
      const data = await guestyRequest("GET", `/listings/${listingId}`);
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Pushes publicDescriptions fields to a Guesty listing via server-side guestyRequest.
  // Returns { success, sent, response?, error? } for debugging.
  app.post("/api/builder/push-descriptions", async (req: Request, res: Response) => {
    const { listingId, descriptions } = req.body as {
      listingId: string;
      descriptions: {
        title?: string;
        summary?: string;
        space?: string;
        neighborhood?: string;
        transit?: string;
        access?: string;
        notes?: string;
        houseRules?: string;
      };
    };

    if (!listingId) return res.status(400).json({ error: "listingId is required" });
    if (!descriptions) return res.status(400).json({ error: "descriptions is required" });

    const payload: Record<string, unknown> = {};
    if (descriptions.title) payload.title = descriptions.title;

    const publicDescriptions: Record<string, string> = {};
    if (descriptions.summary)      publicDescriptions.summary      = descriptions.summary;
    if (descriptions.space)        publicDescriptions.space        = descriptions.space;
    if (descriptions.access)       publicDescriptions.access       = descriptions.access;
    if (descriptions.neighborhood) publicDescriptions.neighborhood = descriptions.neighborhood;
    if (descriptions.transit)      publicDescriptions.transit      = descriptions.transit;
    if (descriptions.notes)        publicDescriptions.notes        = descriptions.notes;
    if (descriptions.houseRules)   publicDescriptions.houseRules   = descriptions.houseRules;

    if (Object.keys(publicDescriptions).length > 0) {
      payload.publicDescription = publicDescriptions;
    }

    console.log(`[push-descriptions] PUT /listings/${listingId}`, JSON.stringify(payload).slice(0, 300) + "...");

    try {
      await guestyRequest("PUT", `/listings/${listingId}`, payload);

      // Immediately GET the listing back to verify what Guesty actually stored
      const fetched = await guestyRequest("GET", `/listings/${listingId}`) as Record<string, unknown>;
      const savedDesc = fetched.publicDescription as Record<string, string> | undefined;
      const savedNickname = fetched.nickname as string | undefined;
      const savedTitle = fetched.title as string | undefined;

      console.log(`[push-descriptions] GET after PUT — nickname: "${savedNickname}", publicDescription keys: ${JSON.stringify(Object.keys(savedDesc ?? {}))}`);
      console.log(`[push-descriptions] summary preview: "${String(savedDesc?.summary ?? "").slice(0, 80)}"`);

      const summaryWasSaved = !!(savedDesc?.summary && savedDesc.summary.length > 10);

      return res.json({
        success: true,
        verified: summaryWasSaved,
        savedDescriptions: savedDesc ?? null,
        savedNickname: savedNickname ?? null,
        savedTitle: savedTitle ?? null,
      });
    } catch (err: any) {
      console.error(`[push-descriptions] error:`, err.message);
      return res.status(500).json({ success: false, error: err.message, sent: payload });
    }
  });

  // POST /api/builder/push-photos
  // Streams NDJSON events as each photo completes so the connection never times out.
  // Each line: { type:"photo", index, total, localPath, success, url?, wasUpscaled?, error? }
  // Final line: { type:"done", successCount, upscaledCount, total }
  app.post("/api/builder/push-photos", async (req, res) => {
    const imgbbKey = process.env.IMGBB_API_KEY;
    const replicateKey = process.env.REPLICATE_API_KEY;

    if (!imgbbKey) {
      return res.status(500).json({ error: "IMGBB_API_KEY not configured — needed to host photos for Guesty" });
    }

    const { guestyListingId, photos, upscale = true } = req.body as {
      guestyListingId: string;
      photos: { localPath: string; caption: string }[];
      upscale?: boolean;
    };

    if (!guestyListingId || !Array.isArray(photos) || photos.length === 0) {
      return res.status(400).json({ error: "guestyListingId and photos[] are required" });
    }

    // Stream NDJSON — one JSON line per photo + a final summary line.
    // This keeps the HTTP connection alive for as long as needed (no timeout).
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering if present
    res.flushHeaders();

    const emit = (obj: Record<string, unknown>) => {
      res.write(JSON.stringify(obj) + "\n");
    };

    let upscaledCount = 0;

    // Phase 1: Upload each photo to ImgBB (stream per-photo progress).
    // Collect successful { original, caption } objects for a single Guesty PUT at the end.
    // Guesty's v1 API does NOT have POST /listings/{id}/pictures — pictures are set via
    // PUT /listings/{id} with a "pictures" array where each item uses the "original" field.
    const collected: { original: string; caption: string }[] = [];
    const perPhotoResults: Array<{ index: number; localPath: string; success: boolean; url?: string; wasUpscaled?: boolean; error?: string }> = [];

    for (let i = 0; i < photos.length; i++) {
      const { localPath, caption } = photos[i];
      const index = i + 1;

      // Validate path
      if (!localPath || !localPath.startsWith("/photos/")) {
        emit({ type: "photo", index, total: photos.length, localPath, success: false, error: "Invalid path" });
        perPhotoResults.push({ index, localPath, success: false, error: "Invalid path" });
        continue;
      }

      const safePath = localPath.replace(/\.\./g, "");
      const fullPath = path.join(process.cwd(), "client", "public", safePath);

      // Read local file
      let rawData: Buffer;
      try {
        rawData = fs.readFileSync(fullPath);
      } catch {
        emit({ type: "photo", index, total: photos.length, localPath, success: false, error: "File not found on server" });
        perPhotoResults.push({ index, localPath, success: false, error: "File not found" });
        continue;
      }

      const ext = path.extname(safePath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

      // Optionally upscale with Replicate (skipped if upscale=false or no key)
      let finalBuffer = rawData;
      let finalMime = mimeType;
      let wasUpscaled = false;
      if (upscale && replicateKey) {
        try {
          const upscaled = await upscaleWithReplicateKw(rawData, mimeType);
          if (upscaled) {
            finalBuffer = upscaled;
            wasUpscaled = true;
          }
        } catch {
          // upscale failure is non-fatal — push original
        }
      }

      // Pre-flight validation: normalize to Guesty/Booking.com/Airbnb-compatible spec
      //   landscape, width=1920, JPEG, <=4MB. Auto-rotates portraits, resizes, recompresses.
      // Runs AFTER Replicate so AI upscale quality is preserved, then we enforce final spec.
      let validationChanges: string[] = [];
      try {
        const validated = await validateAndFixPhoto(finalBuffer, finalMime);
        finalBuffer = validated.buffer;
        finalMime = validated.mimeType;
        validationChanges = validated.changes;
        if (validationChanges.length > 0) {
          console.log(`[push-photos] validate ${index}/${photos.length} ${safePath}: ${validationChanges.join("; ")}`);
          emit({
            type: "validation",
            index,
            total: photos.length,
            localPath,
            changes: validationChanges,
            finalWidth: validated.finalWidth,
            finalHeight: validated.finalHeight,
            finalBytes: validated.finalBytes,
          });
        }
      } catch (e: any) {
        // Validation failure is non-fatal — push original buffer and flag it
        console.error(`[push-photos] validation failed ${index}/${photos.length}: ${e.message}`);
        emit({
          type: "validation",
          index,
          total: photos.length,
          localPath,
          warning: `validation failed: ${e.message} — pushing original`,
        });
      }

      // Upload to ImgBB to get a publicly accessible URL
      let publicUrl: string;
      try {
        const form = new FormData();
        form.append("image", finalBuffer.toString("base64"));
        const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
          method: "POST",
          body: form,
        });
        if (!imgbbResp.ok) {
          const errText = await imgbbResp.text();
          emit({ type: "photo", index, total: photos.length, localPath, success: false, error: `ImgBB ${imgbbResp.status}: ${errText.slice(0, 100)}` });
          perPhotoResults.push({ index, localPath, success: false, error: `ImgBB ${imgbbResp.status}` });
          continue;
        }
        const imgbbData = await imgbbResp.json() as any;
        publicUrl = imgbbData?.data?.url;
        if (!publicUrl) {
          emit({ type: "photo", index, total: photos.length, localPath, success: false, error: "ImgBB returned no URL" });
          perPhotoResults.push({ index, localPath, success: false, error: "ImgBB no URL" });
          continue;
        }
      } catch (e: any) {
        emit({ type: "photo", index, total: photos.length, localPath, success: false, error: `ImgBB error: ${e.message}` });
        perPhotoResults.push({ index, localPath, success: false, error: e.message });
        continue;
      }

      // ImgBB upload succeeded — queue for Guesty PUT
      if (wasUpscaled) upscaledCount++;
      collected.push({ original: publicUrl, caption: caption || "" });
      perPhotoResults.push({ index, localPath, success: true, url: publicUrl, wasUpscaled });
      emit({ type: "photo", index, total: photos.length, localPath, success: true, url: publicUrl, wasUpscaled, validationChanges, pending: true });
      console.log(`[push-photos] ✓ ImgBB ${index}/${photos.length} ${safePath}`);

      // Checkpoint: commit accumulated photos to Guesty every 5 successful uploads.
      // Each PUT replaces the full pictures array, so we accumulate. This way a server
      // restart or network drop mid-run still leaves the completed photos in Guesty.
      const CHECKPOINT_EVERY = 5;
      if (collected.length > 0 && collected.length % CHECKPOINT_EVERY === 0) {
        emit({ type: "checkpoint", saved: collected.length, total: photos.length });
        try {
          await guestyRequest("PUT", `/listings/${guestyListingId}`, { pictures: collected });
          console.log(`[push-photos] ✓ Checkpoint Guesty PUT — ${collected.length} photos committed`);
        } catch (e: any) {
          console.error(`[push-photos] ✗ Checkpoint Guesty PUT failed: ${e.message}`);
          // Non-fatal: keep uploading remaining photos, try final PUT at end
        }
      }
    }

    // Final PUT to Guesty with all collected pictures (handles remainder after last checkpoint).
    // Guesty stores pictures via PUT /listings/{id} with pictures[].original (not url).
    // This replaces all existing photos on the listing.
    let successCount = 0;
    if (collected.length > 0) {
      emit({ type: "saving", count: collected.length });
      try {
        await guestyRequest("PUT", `/listings/${guestyListingId}`, { pictures: collected });
        successCount = collected.length;
        console.log(`[push-photos] ✓ Guesty PUT — ${successCount} photos saved to listing ${guestyListingId}`);
      } catch (e: any) {
        console.error(`[push-photos] ✗ Guesty PUT failed: ${e.message}`);
        emit({ type: "done", successCount: 0, upscaledCount, total: photos.length, guestyError: e.message });
        res.end();
        return;
      }
    }

    emit({ type: "done", successCount, upscaledCount, total: photos.length });
    console.log(`[push-photos] Done: ${successCount}/${photos.length} pushed, ${upscaledCount} upscaled`);
    res.end();
  });

  // GET /api/builder/guesty-monthly-rates/:propertyId
  // Pulls Guesty's daily calendar rate for the given property across the requested
  // year range, then aggregates to a per-month average. Used by the pricing table
  // to show "what Guesty is ACTUALLY charging" next to "what our sheet expects".
  //
  // Query: ?startYear=2026&months=24  (default 24 months starting this month)
  // Response: { units: [{ guestyListingId, unitId, unitLabel, months: [{yearMonth,avgRate,minRate,maxRate,days}] }] }
  app.get("/api/builder/guesty-monthly-rates/:propertyId", async (req: Request, res: Response) => {
    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });

    const months = Math.min(parseInt((req.query.months as string) ?? "24", 10) || 24, 36);
    const startParam = req.query.start as string | undefined;
    const start = startParam ? new Date(startParam) : new Date();
    start.setDate(1); start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setMonth(end.getMonth() + months);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    try {
      // Multi-unit properties have multiple Guesty listings. For now we look up the
      // property's canonical Guesty listing via guestyPropertyMap. Multi-listing
      // support is a follow-up (returning one unit per Guesty listing).
      const listingId = await storage.getGuestyListingId(propertyId);
      if (!listingId) {
        return res.status(404).json({ error: `No Guesty listing mapped for property ${propertyId}` });
      }

      // Guesty's calendar endpoint — per-day price and availability.
      // https://open-api-docs.guesty.com/reference/calendarscontroller_getcalendars
      const url = `/availability-pricing/api/calendar/listings/${listingId}?startDate=${iso(start)}&endDate=${iso(end)}`;
      const calendarResp = await guestyRequest("GET", url) as any;
      // Response shape varies — could be array directly, {data: [...]}, or {status, data: [...]}.
      const days: any[] = Array.isArray(calendarResp)
        ? calendarResp
        : Array.isArray(calendarResp?.data) ? calendarResp.data
        : Array.isArray(calendarResp?.data?.days) ? calendarResp.data.days
        : Array.isArray(calendarResp?.days) ? calendarResp.days
        : [];

      // Bucket per-day rates by yearMonth
      const buckets = new Map<string, number[]>();
      for (const d of days) {
        const dateStr: string = d.date ?? d.day ?? "";
        const rate: number = Number(d.price ?? d.rate ?? d.nightlyPrice ?? 0);
        if (!dateStr || !rate || isNaN(rate)) continue;
        const ym = dateStr.slice(0, 7);
        const arr = buckets.get(ym) ?? [];
        arr.push(rate);
        buckets.set(ym, arr);
      }

      const monthEntries = Array.from(buckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([yearMonth, rates]) => {
          const total = rates.reduce((s, r) => s + r, 0);
          return {
            yearMonth,
            avgRate: Math.round(total / rates.length),
            minRate: Math.min(...rates),
            maxRate: Math.max(...rates),
            days: rates.length,
          };
        });

      return res.json({
        propertyId,
        guestyListingId: listingId,
        months: monthEntries,
        totalDays: days.length,
      });
    } catch (err: any) {
      console.error(`[guesty-monthly-rates] error:`, err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/builder/push-seasonal-rates
  // Pushes per-day base nightly rates to Guesty's calendar. The client sends
  // a flat rate per month and this expands it to the days in each month, then
  // PUTs them to Guesty in one chunked batch.
  //
  // Why this exists: a flat Guesty base rate combined with seasonal buy-in
  // cost creates wildly variable margins (95% in low season, 20% in high).
  // To hit a steady margin target across months, the base rate itself has
  // to scale with season — that's what this endpoint writes.
  app.post("/api/builder/push-seasonal-rates", async (req: Request, res: Response) => {
    const { listingId, monthlyRates } = req.body as {
      listingId?: string;
      // Each entry: { yearMonth: "2026-08", price: 1970 } — price becomes the
      // per-night base for every day in that month.
      monthlyRates?: Array<{ yearMonth: string; price: number }>;
    };
    if (!listingId) return res.status(400).json({ error: "listingId required" });
    if (!Array.isArray(monthlyRates) || monthlyRates.length === 0) {
      return res.status(400).json({ error: "monthlyRates array required" });
    }

    // Expand monthly rates into per-day entries Guesty will accept.
    type DayEntry = { date: string; price: number };
    const days: DayEntry[] = [];
    for (const { yearMonth, price } of monthlyRates) {
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) continue;
      if (!Number.isFinite(price) || price <= 0) continue;
      const [y, m] = yearMonth.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last day of this
      for (let d = 1; d <= lastDay; d++) {
        const ds = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        days.push({ date: ds, price: Math.round(price) });
      }
    }
    if (days.length === 0) return res.status(400).json({ error: "no valid days to push" });

    // Guesty's calendar update prefers ranges over individual days — group
    // consecutive same-price days into {startDate, endDate, price} ranges.
    type Range = { startDate: string; endDate: string; price: number };
    const ranges: Range[] = [];
    let current: Range | null = null;
    for (const d of days) {
      if (current && current.price === d.price) {
        current.endDate = d.date;
      } else {
        if (current) ranges.push(current);
        current = { startDate: d.date, endDate: d.date, price: d.price };
      }
    }
    if (current) ranges.push(current);

    console.log(`[push-seasonal-rates] listing ${listingId} · ${ranges.length} ranges · ${days.length} days`);

    // Guesty's calendar PUT validates one range at a time:
    //   PUT /availability-pricing/api/calendar/listings/:id
    //   { startDate, endDate, price }
    // Bulk-array bodies fail with "days is not allowed". We loop and PUT
    // one range per call. ~13 calls for the typical 24-month seasonal map.
    let pushedRanges = 0;
    const failedRanges: Array<{ range: Range; error: string }> = [];
    for (const range of ranges) {
      try {
        await guestyRequest("PUT", `/availability-pricing/api/calendar/listings/${listingId}`, {
          startDate: range.startDate,
          endDate: range.endDate,
          price: range.price,
        });
        pushedRanges++;
      } catch (e: any) {
        failedRanges.push({ range, error: e?.message ?? String(e) });
        // Keep going — partial success is more useful than aborting the
        // whole 24-month push because one range glitched.
      }
    }

    try {
      // Read back a sample of days to confirm the push stuck.
      const firstDate = days[0].date;
      const lastDate = days[days.length - 1].date;
      const verifyUrl = `/availability-pricing/api/calendar/listings/${listingId}?startDate=${firstDate}&endDate=${lastDate}`;
      const verify = await guestyRequest("GET", verifyUrl) as any;
      const vDays: any[] = Array.isArray(verify) ? verify
        : Array.isArray(verify?.data) ? verify.data
        : Array.isArray(verify?.data?.days) ? verify.data.days
        : Array.isArray(verify?.days) ? verify.days
        : [];
      // Count how many days in the response match the price we intended.
      const priceByDate = new Map(days.map((d) => [d.date, d.price]));
      let matched = 0;
      for (const d of vDays) {
        const dateStr: string = d.date ?? d.day ?? "";
        const rate: number = Number(d.price ?? d.rate ?? d.nightlyPrice ?? 0);
        if (priceByDate.get(dateStr) === Math.round(rate)) matched++;
      }
      return res.json({
        success: failedRanges.length === 0,
        pushedDays: days.length,
        pushedRanges,
        totalRanges: ranges.length,
        failedRanges: failedRanges.slice(0, 5),
        verifiedDays: matched,
        sampleRange: ranges[0],
      });
    } catch (err: any) {
      console.error(`[push-seasonal-rates] verify error:`, err.message);
      // Push happened (or partially happened); only verification failed.
      return res.json({
        success: failedRanges.length === 0,
        pushedDays: days.length,
        pushedRanges,
        totalRanges: ranges.length,
        failedRanges: failedRanges.slice(0, 5),
        verifyError: err.message,
      });
    }
  });

  // GET /api/builder/market-comps/:propertyId?nights=7
  // Fetches comparable Airbnb listings with the same total bedroom count as
  // our property bundle across three representative date windows (low,
  // high, holiday). Returns per-season price distributions — median,
  // percentiles, count — so the pricing table can flag whether a
  // proposed rate lands in the competitive range or way above market.
  //
  // Why this exists: a 6BR combined listing competes against area 6BR
  // villas + other multi-unit resort bundles. "$1,970/night" is meaningless
  // without knowing what a 6BR oceanfront rental in Kauai actually goes
  // for in July. This gives us the ceiling reference.
  app.get("/api/builder/market-comps/:propertyId", async (req: Request, res: Response) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const propertyId = parseInt(req.params.propertyId, 10);
    if (isNaN(propertyId)) return res.status(400).json({ error: "invalid propertyId" });
    const nights = Math.min(Math.max(parseInt((req.query.nights as string) ?? "7", 10) || 7, 2), 14);

    const config = PROPERTY_UNIT_NEEDS[propertyId];
    if (!config) return res.status(404).json({ error: "Property not in config" });

    const totalBR = config.units.reduce((s, u) => s + u.bedrooms, 0);
    const community = config.community;
    const searchLocation = COMMUNITY_SEARCH_LOCATIONS[community] || `${community}, Hawaii`;
    const bounds = COMMUNITY_BOUNDS[community];

    // Pick one check-in per season bucket. We want recent-but-future dates —
    // far enough ahead that Airbnb returns actual listings, not dead
    // inventory; not so far that the pricing engines haven't built calendars
    // yet. Walk ~4-10 months ahead and pick a weekday for each season.
    const now = new Date();
    const monthAhead = (delta: number): Date => {
      const d = new Date(now);
      d.setMonth(d.getMonth() + delta, 12);
      return d;
    };
    // LOW: mid-September (shoulder). HIGH: mid-July (summer). HOLIDAY: late Dec.
    // If we're already past those months this year, roll to next year.
    const pickDate = (targetMonth: number, targetDay: number): Date => {
      const y = now.getFullYear();
      const thisYear = new Date(y, targetMonth, targetDay, 12, 0, 0);
      if (thisYear.getTime() < now.getTime() + 30 * 86_400_000) {
        return new Date(y + 1, targetMonth, targetDay, 12, 0, 0);
      }
      return thisYear;
    };
    const toYmd = (d: Date) => d.toISOString().slice(0, 10);
    const addDays = (d: Date, n: number) => {
      const c = new Date(d); c.setDate(c.getDate() + n); return c;
    };
    const seasonWindows: Array<{ season: "LOW" | "HIGH" | "HOLIDAY"; checkIn: string; checkOut: string }> = [
      (() => { const ci = pickDate(8, 15); return { season: "LOW" as const,     checkIn: toYmd(ci), checkOut: toYmd(addDays(ci, nights)) }; })(),
      (() => { const ci = pickDate(6, 10); return { season: "HIGH" as const,    checkIn: toYmd(ci), checkOut: toYmd(addDays(ci, nights)) }; })(),
      (() => { const ci = pickDate(11, 26); return { season: "HOLIDAY" as const, checkIn: toYmd(ci), checkOut: toYmd(addDays(ci, nights)) }; })(),
    ];
    // Safety net — keep only windows whose check-in is actually in the
    // future. (pickDate already handles the roll-forward but double-check.)
    const safeWindows = seasonWindows.filter((w) => new Date(w.checkIn) >= now);
    if (safeWindows.length === 0) monthAhead(1); // silence unused warning

    // Distribution stats on a sorted array. Returns null if too few comps
    // — we don't want to call a "market median" on 2 samples.
    const percentile = (sortedArr: number[], p: number): number | null => {
      if (sortedArr.length === 0) return null;
      const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
      return sortedArr[idx];
    };
    const computeStats = (rates: number[]) => {
      if (rates.length < 3) return { n: rates.length, enough: false, median: null, p25: null, p40: null, p75: null, p90: null, min: null, max: null };
      const sorted = [...rates].sort((a, b) => a - b);
      return {
        n: sorted.length,
        enough: true,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p25: percentile(sorted, 25),
        p40: percentile(sorted, 40),
        median: percentile(sorted, 50),
        p75: percentile(sorted, 75),
        p90: percentile(sorted, 90),
      };
    };

    try {
      const perSeason = await Promise.all(seasonWindows.map(async (w) => {
        const sp: Record<string, string> = {
          engine: "airbnb",
          check_in_date: w.checkIn,
          check_out_date: w.checkOut,
          adults: String(Math.min(16, totalBR * 2)),
          bedrooms: String(totalBR),
          type_of_place: "entire_home",
          currency: "USD",
          api_key: apiKey,
          q: searchLocation,
        };
        if (bounds) {
          sp.sw_lat = String(bounds.sw_lat);
          sp.sw_lng = String(bounds.sw_lng);
          sp.ne_lat = String(bounds.ne_lat);
          sp.ne_lng = String(bounds.ne_lng);
        }
        try {
          const r = await fetch(`https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`);
          if (!r.ok) return {
            ...w, error: `HTTP ${r.status}`,
            condo: { stats: computeStats([]), sample: [] },
            villa: { stats: computeStats([]), sample: [] },
            all:   { stats: computeStats([]), sample: [] },
          };
          const data = await r.json() as any;
          const props: any[] = Array.isArray(data?.properties) ? data.properties : [];
          // Post-filter: require actual BR count >= totalBR. The engine's
          // `bedrooms` param is a minimum but some results slip through.
          const qualifying = props.filter((p: any) => {
            const pb = typeof p?.bedrooms === "number" ? p.bedrooms : null;
            return pb == null || pb >= totalBR;
          });

          // Classify each comp as villa-tier (premium, standalone) or
          // condo-tier (direct peer to our bundle). We read Airbnb's
          // `property_type` first — it's the authoritative field — and
          // fall back to title/description keyword detection when the
          // engine didn't populate it. Ambiguous entries are excluded
          // from BOTH buckets so they don't pollute either median.
          const classify = (p: any): "villa" | "condo" | "ambiguous" => {
            const pt = String(p?.property_type ?? p?.room_type ?? "").toLowerCase();
            const hay = `${pt} ${String(p?.name ?? p?.title ?? "").toLowerCase()} ${String(p?.description ?? "").toLowerCase()}`;
            const villaHit = /\b(villa|estate|mansion|chalet|bungalow|cottage|standalone|single[- ]family|detached|private home|pool home)\b/.test(hay);
            const condoHit = /\b(condo|condominium|townhome|townhouse|apartment|apt\.?|flat|suite)\b/.test(hay);
            if (villaHit && !condoHit) return "villa";
            if (condoHit && !villaHit) return "condo";
            // `property_type=House` alone typically skews villa for 6BR+
            // listings — we lean it into the villa tier so the ceiling
            // isn't under-populated. Condo tier only gets explicit condos.
            if (!villaHit && !condoHit && /\b(house|home)\b/.test(pt)) return "villa";
            return "ambiguous";
          };

          type Tier = "villa" | "condo" | "ambiguous";
          const bucket: Record<Tier, { rates: number[]; sample: any[] }> = {
            villa:     { rates: [], sample: [] },
            condo:     { rates: [], sample: [] },
            ambiguous: { rates: [], sample: [] },
          };

          for (const p of qualifying) {
            const total = Number(p?.price?.extracted_total_price ?? 0);
            if (!(total > 0)) continue;
            const nightly = total / nights;
            const tier = classify(p);
            bucket[tier].rates.push(nightly);
            if (bucket[tier].sample.length < 5) {
              bucket[tier].sample.push({
                title: String(p?.name ?? p?.title ?? "Listing"),
                url: String(p?.link ?? ""),
                bedrooms: typeof p?.bedrooms === "number" ? p.bedrooms : null,
                propertyType: String(p?.property_type ?? ""),
                nightlyRate: Math.round(nightly),
                tier,
              });
            }
          }

          const allRates = [...bucket.villa.rates, ...bucket.condo.rates, ...bucket.ambiguous.rates];
          return {
            ...w,
            condo: { stats: computeStats(bucket.condo.rates), sample: bucket.condo.sample },
            villa: { stats: computeStats(bucket.villa.rates), sample: bucket.villa.sample },
            all:   { stats: computeStats(allRates),          sample: [...bucket.condo.sample, ...bucket.villa.sample].slice(0, 6) },
            rawCount: props.length,
            qualifyingCount: qualifying.length,
          };
        } catch (e: any) {
          return {
            ...w, error: e.message,
            condo: { stats: computeStats([]), sample: [] },
            villa: { stats: computeStats([]), sample: [] },
            all:   { stats: computeStats([]), sample: [] },
          };
        }
      }));

      // Keyed by season for easy client lookup.
      const seasons: Record<string, any> = {};
      for (const s of perSeason) seasons[s.season] = s;

      return res.json({
        propertyId,
        community,
        totalBR,
        nights,
        seasons,
        searchLocation,
      });
    } catch (err: any) {
      console.error(`[market-comps] error:`, err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/builder/normalize-photos
  // Fetch a listing's existing Guesty pictures, run each through validateAndFixPhoto,
  // re-upload the fixed ones to ImgBB, and PUT the listing back.
  // Body: { guestyListingId: string }  OR  { all: true }  (iterates every mapped listing)
  // Streams NDJSON events: {type:"listing-start",id,name}, {type:"photo",...},
  //   {type:"listing-done",id,fixedCount,totalCount}, {type:"all-done",listingCount,...}
  app.post("/api/builder/normalize-photos", async (req, res) => {
    const imgbbKey = process.env.IMGBB_API_KEY;
    if (!imgbbKey) {
      return res.status(500).json({ error: "IMGBB_API_KEY not configured" });
    }

    const { guestyListingId, all } = req.body as { guestyListingId?: string; all?: boolean };
    if (!guestyListingId && !all) {
      return res.status(400).json({ error: "guestyListingId or all:true required" });
    }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const emit = (obj: Record<string, unknown>) => res.write(JSON.stringify(obj) + "\n");

    // Build target list
    let targets: { guestyListingId: string; propertyId?: number }[] = [];
    if (all) {
      const maps = await storage.getGuestyPropertyMap();
      targets = maps.map((m) => ({ guestyListingId: m.guestyListingId, propertyId: m.propertyId }));
    } else {
      targets = [{ guestyListingId: guestyListingId! }];
    }

    emit({ type: "start", listingCount: targets.length });

    let globalFixed = 0;
    let globalSkipped = 0;
    let globalFailed = 0;

    for (const target of targets) {
      const listingId = target.guestyListingId;
      let listingName = listingId;
      let pictures: Array<{ original?: string; _id?: string; caption?: string; url?: string }> = [];

      try {
        const listing = await guestyRequest("GET", `/listings/${listingId}`) as any;
        listingName = listing?.title || listing?.nickname || listingId;
        pictures = Array.isArray(listing?.pictures) ? listing.pictures : [];
      } catch (e: any) {
        emit({ type: "listing-error", id: listingId, error: `GET failed: ${e.message}` });
        globalFailed++;
        continue;
      }

      emit({ type: "listing-start", id: listingId, name: listingName, photoCount: pictures.length });

      if (pictures.length === 0) {
        emit({ type: "listing-done", id: listingId, name: listingName, fixedCount: 0, skippedCount: 0, totalCount: 0 });
        continue;
      }

      const normalized: { original: string; caption: string }[] = [];
      let fixedCount = 0;
      let skippedCount = 0;

      for (let i = 0; i < pictures.length; i++) {
        const pic = pictures[i];
        const url = pic.original || pic.url;
        const caption = pic.caption || "";
        const index = i + 1;

        if (!url) {
          emit({ type: "photo", listingId, index, total: pictures.length, success: false, error: "no URL on picture" });
          continue;
        }

        // Preserve the auto-generated cover collage exactly — it's already at spec
        // (1920×1080 JPEG from canvas) and re-encoding blurs the thin divider line.
        if (caption === "Cover Collage") {
          normalized.push({ original: url, caption });
          skippedCount++;
          emit({ type: "photo", listingId, index, total: pictures.length, success: true, skipped: true, preservedCollage: true });
          continue;
        }

        try {
          // Download current photo
          const dlResp = await fetch(url);
          if (!dlResp.ok) {
            emit({ type: "photo", listingId, index, total: pictures.length, success: false, error: `download ${dlResp.status}` });
            // Keep original in the array so we don't drop it
            normalized.push({ original: url, caption });
            continue;
          }
          const inBuf = Buffer.from(await dlResp.arrayBuffer());
          const contentType = dlResp.headers.get("content-type") || "image/jpeg";

          // Validate + fix
          const validated = await validateAndFixPhoto(inBuf, contentType);

          if (validated.changes.length === 0) {
            // Already compliant — keep original URL, no re-upload
            normalized.push({ original: url, caption });
            skippedCount++;
            emit({
              type: "photo",
              listingId,
              index,
              total: pictures.length,
              success: true,
              skipped: true,
              finalWidth: validated.finalWidth,
              finalHeight: validated.finalHeight,
            });
            continue;
          }

          // Re-upload the fixed buffer to ImgBB
          const form = new FormData();
          form.append("image", validated.buffer.toString("base64"));
          const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
            method: "POST",
            body: form,
          });
          if (!imgbbResp.ok) {
            emit({ type: "photo", listingId, index, total: pictures.length, success: false, error: `ImgBB ${imgbbResp.status}` });
            normalized.push({ original: url, caption }); // fall back to original
            continue;
          }
          const imgbbData = await imgbbResp.json() as any;
          const newUrl = imgbbData?.data?.url;
          if (!newUrl) {
            emit({ type: "photo", listingId, index, total: pictures.length, success: false, error: "ImgBB no URL" });
            normalized.push({ original: url, caption });
            continue;
          }

          normalized.push({ original: newUrl, caption });
          fixedCount++;
          emit({
            type: "photo",
            listingId,
            index,
            total: pictures.length,
            success: true,
            fixed: true,
            changes: validated.changes,
            originalWidth: validated.originalWidth,
            originalHeight: validated.originalHeight,
            finalWidth: validated.finalWidth,
            finalHeight: validated.finalHeight,
            url: newUrl,
          });
        } catch (e: any) {
          emit({ type: "photo", listingId, index, total: pictures.length, success: false, error: e.message });
          // Keep original URL so we don't strip photos from the listing
          normalized.push({ original: url, caption });
        }
      }

      // PUT back only if we actually changed something
      if (fixedCount > 0) {
        try {
          await guestyRequest("PUT", `/listings/${listingId}`, { pictures: normalized });
          console.log(`[normalize-photos] ✓ ${listingName}: ${fixedCount} fixed, ${skippedCount} ok`);
        } catch (e: any) {
          emit({ type: "listing-error", id: listingId, name: listingName, error: `PUT failed: ${e.message}` });
          globalFailed++;
          continue;
        }
      }

      globalFixed += fixedCount;
      globalSkipped += skippedCount;
      emit({
        type: "listing-done",
        id: listingId,
        name: listingName,
        fixedCount,
        skippedCount,
        totalCount: pictures.length,
      });
    }

    emit({
      type: "all-done",
      listingCount: targets.length,
      globalFixed,
      globalSkipped,
      globalFailed,
    });
    res.end();
  });

  // ========== BUILDER AVAILABILITY WINDOW SCANNER ==========

  app.get("/api/builder/scan-window", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const propertyId = parseInt(req.query.propertyId as string, 10);
    const checkIn = req.query.checkIn as string;
    const checkOut = req.query.checkOut as string;

    if (!propertyId || isNaN(propertyId)) return res.status(400).json({ error: "propertyId required" });
    if (!checkIn || !checkOut) return res.status(400).json({ error: "checkIn and checkOut required" });

    const propertyConfig = PROPERTY_UNIT_NEEDS[propertyId];
    if (!propertyConfig) return res.status(404).json({ error: "Property not in config" });

    const communityBounds = COMMUNITY_BOUNDS[propertyConfig.community];
    const searchLocation = COMMUNITY_SEARCH_LOCATIONS[propertyConfig.community] || `${propertyConfig.community}, Hawaii`;

    // Count how many of each bedroom type we need
    const bedroomCounts: Record<number, number> = {};
    for (const unit of propertyConfig.units) {
      bedroomCounts[unit.bedrooms] = (bedroomCounts[unit.bedrooms] || 0) + 1;
    }
    const neededCount = propertyConfig.units.length;

    try {
      let totalFound = 0;
      const unitResults: { bedrooms: number; needed: number; found: number }[] = [];
      const cheapestByBedroom: Record<number, { price: number; title: string; link: string }> = {};

      for (const [bedroomStr, needed] of Object.entries(bedroomCounts)) {
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

        // q is always required by SearchAPI; bounds are added on top for geo-precision
        searchParams.q = searchLocation;
        if (communityBounds) {
          searchParams.sw_lat = String(communityBounds.sw_lat);
          searchParams.sw_lng = String(communityBounds.sw_lng);
          searchParams.ne_lat = String(communityBounds.ne_lat);
          searchParams.ne_lng = String(communityBounds.ne_lng);
        }

        const params = new URLSearchParams(searchParams);
        const response = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!response.ok) {
          const errText = await response.text();
          console.error(`[scan-window] SearchAPI error for ${bedrooms}BR:`, errText);
          unitResults.push({ bedrooms, needed, found: 0 });
          continue;
        }

        const data = await response.json();
        let properties = data.properties || [];

        // GPS post-filter
        if (communityBounds) {
          const geoFiltered = properties.filter((p: any) => {
            const lat = p.gps_coordinates?.latitude;
            const lng = p.gps_coordinates?.longitude;
            if (!lat || !lng) return true;
            return lat >= communityBounds.sw_lat && lat <= communityBounds.ne_lat &&
                   lng >= communityBounds.sw_lng && lng <= communityBounds.ne_lng;
          });
          if (geoFiltered.length > 0) properties = geoFiltered;
        }

        const found = Math.min(properties.length, needed);
        totalFound += found;
        unitResults.push({ bedrooms, needed, found });

        // Track cheapest listing for pricing estimate
        const withPrice = (properties as any[]).filter(p => p.price?.extracted_total_price);
        withPrice.sort((a, b) => a.price.extracted_total_price - b.price.extracted_total_price);
        const cheapest = withPrice[0];
        if (cheapest) {
          cheapestByBedroom[bedrooms] = {
            price: cheapest.price.extracted_total_price,
            title: cheapest.name || cheapest.title || "Unknown",
            link: cheapest.link || cheapest.url || "",
          };
        }
      }

      // Estimated buy-in cost = sum of cheapest price × needed count per bedroom type
      let estimatedBuyInCost = 0;
      for (const [bedroomStr, needed] of Object.entries(bedroomCounts)) {
        const bedrooms = parseInt(bedroomStr);
        const cheap = cheapestByBedroom[bedrooms];
        if (cheap) estimatedBuyInCost += cheap.price * needed;
      }

      const status = totalFound >= neededCount ? "available" :
                     totalFound > 0            ? "low"       : "none";

      res.json({ status, availableCount: totalFound, neededCount, unitResults, checkIn, checkOut, cheapestByBedroom, estimatedBuyInCost: estimatedBuyInCost > 0 ? estimatedBuyInCost : undefined });
    } catch (err: any) {
      res.status(500).json({ error: "Scan failed", message: err.message });
    }
  });

  // ── Schedule availability sync to Guesty after listing creation ───────────────
  app.post("/api/builder/schedule-sync", async (req: Request, res: Response) => {
    const { propertyId, guestyListingId, delayMinutes = 60 } = req.body as {
      propertyId: number;
      guestyListingId: string;
      delayMinutes?: number;
    };

    if (!propertyId || !guestyListingId) {
      return res.status(400).json({ error: "propertyId and guestyListingId required" });
    }

    await storage.upsertGuestyPropertyMap(propertyId, guestyListingId);
    const delayMs = Math.min(delayMinutes, 180) * 60 * 1000;
    scheduleGuestySync(propertyId, guestyListingId, delayMs);

    res.json({ ok: true, syncScheduledInMinutes: Math.round(delayMs / 60000) });
  });

  // ── Manual Guesty sync trigger (for testing / admin use) ───────────────────
  app.post("/api/builder/sync-now", async (req: Request, res: Response) => {
    const { propertyId, guestyListingId } = req.body as { propertyId: number; guestyListingId: string };
    if (!propertyId || !guestyListingId) return res.status(400).json({ error: "propertyId and guestyListingId required" });

    try {
      const result = await syncPropertyToGuesty(propertyId, guestyListingId);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: "Sync failed", message: err.message });
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
    if (!apiKey) return res.status(500).json({ error: "SearchAPI.io API key not configured" });

    const unitNumber = req.query.unitNumber as string;
    const complexName = req.query.complexName as string;
    if (!unitNumber || !complexName) return res.status(400).json({ error: "Missing unitNumber or complexName" });

    const searchPlatform = async (siteQuery: string, sitePattern: string) => {
      try {
        const params = new URLSearchParams({ engine: "google", q: siteQuery, api_key: apiKey, num: "5" });
        const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
        if (!resp.ok) return [];
        const data = await resp.json() as any;
        return (data.organic_results || [])
          .filter((r: any) => {
            const url = (r.link || "").toLowerCase();
            const text = `${r.title || ""} ${r.snippet || ""}`.toLowerCase();
            return url.includes(sitePattern) && (
              text.includes(unitNumber.toLowerCase()) || text.includes(`#${unitNumber.toLowerCase()}`)
            );
          })
          .map((r: any) => ({ title: r.title, url: r.link, snippet: r.snippet }));
      } catch { return []; }
    };

    try {
      const [vrboListings, airbnbListings, bookingListings] = await Promise.all([
        searchPlatform(`${complexName} ${unitNumber} site:vrbo.com`, "vrbo.com"),
        searchPlatform(`${complexName} ${unitNumber} site:airbnb.com`, "airbnb.com"),
        searchPlatform(`${complexName} ${unitNumber} site:booking.com`, "booking.com"),
      ]);

      const otherCompanies = ["parrish", "kauai exclusive", "cb island", "elite pacific", "gather", "ali'i resorts"];
      const hasConflict = [...vrboListings, ...airbnbListings, ...bookingListings].some((listing: any) => {
        const text = `${listing.title} ${listing.snippet}`.toLowerCase();
        return otherCompanies.some(company => text.includes(company));
      });

      res.json({
        unitNumber,
        complexName,
        vrboListings,
        airbnbListings,
        bookingListings,
        hasConflict,
        isListedOnVrbo: vrboListings.length > 0,
        isListedOnAirbnb: airbnbListings.length > 0,
        isListedOnBooking: bookingListings.length > 0,
        isListedAnywhere: vrboListings.length > 0 || airbnbListings.length > 0 || bookingListings.length > 0,
        checkedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: "Platform check failed", message: err.message });
    }
  });

  // Quick 3-platform address-based check — used by Buy-In Tracker gate
  app.get("/api/platform-check/quick", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const address = (req.query.address as string || "").trim();
    const unitNumber = (req.query.unitNumber as string || "").trim();
    const complexName = (req.query.complexName as string || "").trim();
    if (!unitNumber || (!address && !complexName)) {
      return res.status(400).json({ error: "unitNumber and (address or complexName) required" });
    }

    // Extract street portion (everything before the first comma)
    const street = address ? address.split(",")[0].trim() : complexName;

    const checkOnePlatform = async (
      siteKey: string,
      sitePattern: string,
    ): Promise<{ listed: boolean; url: string | null; snippet: string | null }> => {
      const domain = sitePattern;
      // Address-based query is the primary (most precise); name-based is fallback
      const queries = [
        `site:${domain} "${street}" "${unitNumber}"`,
        `site:${domain} "${complexName}" "${unitNumber}"`,
      ].filter((q, i, arr) => arr.indexOf(q) === i); // dedupe if street === complexName
      try {
        for (const q of queries) {
          const params = new URLSearchParams({ engine: "google", q, api_key: apiKey, num: "5" });
          const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`);
          if (!resp.ok) continue;
          const data = await resp.json() as any;
          for (const r of (data.organic_results || []) as any[]) {
            const url: string = (r.link || "").toLowerCase();
            const text = `${r.title || ""} ${r.snippet || ""}`.toLowerCase();
            if (url.includes(sitePattern) && (
              text.includes(unitNumber.toLowerCase()) || text.includes(`#${unitNumber.toLowerCase()}`)
            )) {
              return { listed: true, url: r.link, snippet: `${r.title} — ${r.snippet}`.slice(0, 200) };
            }
          }
          await new Promise(r => setTimeout(r, 300));
        }
        return { listed: false, url: null, snippet: null };
      } catch { return { listed: false, url: null, snippet: null }; }
    };

    try {
      const [airbnb, vrbo, booking] = await Promise.all([
        checkOnePlatform("airbnb", "airbnb.com"),
        checkOnePlatform("vrbo", "vrbo.com"),
        checkOnePlatform("booking", "booking.com"),
      ]);
      res.json({ unitNumber, address, complexName, airbnb, vrbo, booking, checkedAt: new Date().toISOString() });
    } catch (err: any) {
      res.status(500).json({ error: "Quick platform check failed", message: err.message });
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
    const weeksAhead = 52;
    runAvailabilityScan(weeksAhead, propertyId).catch(err => {
      console.error("Scanner run error:", err);
    });
    const label = propertyId ? getPropertyName(propertyId) : "all properties";
    res.json({ message: `Scan started for ${label}`, weeksAhead, propertyId });
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

  // Serve community photo listing as { url, filename }[] — used by Builder Step 3
  app.get("/api/photos/community/:folder", async (req, res) => {
    const folder = req.params.folder.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!folder) return res.status(400).json({ error: "Missing folder" });
    const folderPath = path.join(process.cwd(), "client/public/photos", folder);
    try {
      const files = await fs.promises.readdir(folderPath).catch(() => []);
      const imageFiles = (files as string[])
        .filter((f: string) => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .sort();
      const result = imageFiles.map((f: string) => ({
        url: `/photos/${folder}/${f}`,
        filename: f,
      }));
      res.json(result);
    } catch {
      res.json([]);
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

    // Five targeted on-property queries — each focuses on a specific amenity/area type
    const queries = [
      `"${name}" pool`,
      `"${name}" building exterior`,
      `"${name}" amenities`,
      `"${name}" clubhouse`,
      `"${name}" resort grounds`,
    ];

    // Also include property management site searches for known high-quality sources
    const COMMUNITY_PM_QUERIES: Record<string, string[]> = {
      "Regency at Poipu Kai": [`site:suiteparadise.com "Poipu Kai"`, `site:kauaibeachrentals.com "Poipu Kai"`],
      "Kaha Lani Resort": [`site:suiteparadise.com "Kaha Lani"`, `site:parrish.com "Kaha Lani"`],
      "Lae Nani Resort": [`site:suiteparadise.com "Lae Nani"`, `site:castleresorts.com "Lae Nani"`],
      "Kaiulani of Princeville": [`site:parrish.com "Kaiulani"`, `site:princeville.com "Kaiulani"`],
      "Mauna Kai Princeville": [`site:parrish.com "Mauna Kai"`, `site:princeville.com "Mauna Kai"`],
      "Pili Mai": [`site:koloa-landing.com "Pili Mai"`, `site:suiteparadise.com "Pili Mai"`],
      "Keauhou Estates": [`site:outrigger.com "Keauhou"`, `site:holua.com "Keauhou"`],
    };
    const pmQueries = COMMUNITY_PM_QUERIES[name] || [];

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
      // Run all queries in parallel: 5 targeted on-property queries + PM site queries
      const allQueries = [...queries, ...pmQueries];
      const searchPromises = allQueries.map(async (q) => {
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

    // Auto-label the newly-saved photos with Claude Vision so the photo
    // tab renders accurate captions without the user having to manually
    // hit the relabel-all button after adding a community.
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey && saved.length > 0) {
      // Fire-and-forget so the save response isn't blocked on 5-6 Claude calls.
      (async () => {
        await storage.deletePhotoLabelsByFolder(communityFolder).catch(() => {});
        for (const filename of saved) {
          try {
            const result = await labelPhoto(
              path.join(folderPath, filename),
              inferKindFromFolder(communityFolder),
              anthropicKey,
            );
            if (result) {
              await storage.upsertPhotoLabel({
                folder: communityFolder,
                filename,
                label: result.label,
                category: result.category,
                model: result.model,
              });
            }
          } catch (e: any) {
            console.warn(`[auto-label] ${communityFolder}/${filename}: ${e?.message ?? e}`);
          }
        }
        console.log(`[auto-label] ${communityFolder}: labeled ${saved.length} photo(s)`);
      })();
    }

    res.json({ saved, failed, folder: communityFolder, autoLabeling: anthropicKey ? saved.length : 0 });
  });

  // ── Photo labels: read + relabel ──────────────────────────────────────
  // Returns the Claude-vision-generated captions for a given folder so
  // the client can override the static unit-builder-data.ts labels.
  // Shape: { labels: { "01-community.jpg": { label, category } }, folder }
  app.get("/api/photo-labels/:folder", async (req, res) => {
    const folder = req.params.folder;
    if (!folder || !/^[\w-]+$/.test(folder)) return res.status(400).json({ error: "invalid folder" });
    try {
      const rows = await storage.getPhotoLabelsByFolder(folder);
      const labels: Record<string, { label: string; category: string | null }> = {};
      for (const r of rows) labels[r.filename] = { label: r.label, category: r.category };
      return res.json({ folder, labels, count: rows.length });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Bulk-relabel every photo in every folder under client/public/photos.
  // Streams NDJSON progress so the client can render a live log. Safe to
  // re-run: upserts one row per (folder, filename), replacing the prior
  // label. Skips unlabeled files (bad extensions, files > 5MB, etc.)
  app.post("/api/admin/relabel-all-photos", async (req, res) => {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

    const onlyFolder = typeof (req.body as any)?.folder === "string" ? (req.body as any).folder as string : null;
    const photosRoot = path.join(process.cwd(), "client/public/photos");
    if (!fs.existsSync(photosRoot)) return res.status(404).json({ error: "photos directory missing" });

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const emit = (obj: Record<string, unknown>) => { res.write(JSON.stringify(obj) + "\n"); };

    try {
      const all = await fs.promises.readdir(photosRoot);
      const folders = all.filter((f) => !onlyFolder || f === onlyFolder);

      // Count total photos upfront so the client progress bar is honest.
      let total = 0;
      const perFolder: Array<{ folder: string; files: string[] }> = [];
      for (const folder of folders) {
        const folderPath = path.join(photosRoot, folder);
        const stat = await fs.promises.stat(folderPath).catch(() => null);
        if (!stat?.isDirectory()) continue;
        const files = await listPhotoFiles(folderPath);
        if (files.length === 0) continue;
        perFolder.push({ folder, files });
        total += files.length;
      }

      emit({ type: "start", folders: perFolder.length, total });

      let done = 0;
      let failed = 0;
      for (const { folder, files } of perFolder) {
        emit({ type: "folder", folder, files: files.length });
        // Nuke prior labels for this folder so stale entries don't linger
        // when a folder's photos have been re-saved in a different order.
        await storage.deletePhotoLabelsByFolder(folder).catch(() => {});
        const kind = inferKindFromFolder(folder);
        for (const filename of files) {
          const abs = path.join(photosRoot, folder, filename);
          const result = await labelPhoto(abs, kind, anthropicKey);
          done++;
          if (!result) {
            failed++;
            emit({ type: "photo", folder, filename, ok: false, done, total });
            continue;
          }
          await storage.upsertPhotoLabel({
            folder, filename,
            label: result.label,
            category: result.category,
            model: result.model,
          });
          emit({ type: "photo", folder, filename, ok: true, label: result.label, category: result.category, done, total });
        }
      }

      emit({ type: "done", total, done, failed, folders: perFolder.length });
      res.end();
    } catch (err: any) {
      emit({ type: "error", error: err.message });
      res.end();
    }
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

    const interiorKeywords = ["bedroom", "kitchen", "bathroom", "bath", "living room", "dining room", "interior", "couch", "sofa", "bed ", "master", "loft", "hallway", "floor plan", "floorplan", "map", "square feet"];
    const lowTrustSources = ["airbnb.com", "vrbo.com", "booking.com", "homeaway.com"];
    const highTrustSources = ["tripadvisor.com", "suiteparadise.com", "outrigger.com", "castleresorts.com", "parrish.com", "google.com", "jeanandabbott.com", "kauaibeachrentals.com"];

    const COMMUNITY_PM_QUERIES_BATCH: Record<string, string[]> = {
      "Regency at Poipu Kai": [`site:suiteparadise.com "Poipu Kai"`, `site:kauaibeachrentals.com "Poipu Kai"`],
      "Kaha Lani Resort": [`site:suiteparadise.com "Kaha Lani"`, `site:parrish.com "Kaha Lani"`],
      "Lae Nani Resort": [`site:suiteparadise.com "Lae Nani"`, `site:castleresorts.com "Lae Nani"`],
      "Kaiulani of Princeville": [`site:parrish.com "Kaiulani"`, `site:princeville.com "Kaiulani"`],
      "Mauna Kai Princeville": [`site:parrish.com "Mauna Kai"`, `site:princeville.com "Mauna Kai"`],
      "Pili Mai": [`site:koloa-landing.com "Pili Mai"`, `site:suiteparadise.com "Pili Mai"`],
      "Keauhou Estates": [`site:outrigger.com "Keauhou"`, `site:holua.com "Keauhou"`],
    };

    const results: Record<string, { saved: number; failed: number }> = {};

    for (const [communityName, folderName] of Object.entries(COMMUNITIES_MAP)) {
      console.log(`[populate-all] ▶ Starting: ${communityName} → ${folderName}`);
      try {
        // Five targeted on-property queries + PM site queries
        const queries = [
          `"${communityName}" pool`,
          `"${communityName}" building exterior`,
          `"${communityName}" amenities`,
          `"${communityName}" clubhouse`,
          `"${communityName}" resort grounds`,
          ...(COMMUNITY_PM_QUERIES_BATCH[communityName] || []),
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
          await new Promise(r => setTimeout(r, 400)); // rate limit between queries
        }
        console.log(`[populate-all] ${communityName}: fetched ${allImages.length} raw images across ${queries.length} queries`);

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
        const topUrls = validated.slice(0, 8).map(v => v.url);
        console.log(`[populate-all] ${communityName}: ${validated.length} valid candidates, saving top ${topUrls.length}`);

        // Purge existing community photos then save new ones
        const folderPath = path.join(process.cwd(), "client/public/photos", folderName);
        await fs.promises.mkdir(folderPath, { recursive: true });
        const existing = await fs.promises.readdir(folderPath).catch(() => []);
        let purged = 0;
        for (const f of existing) {
          if (/\.(jpg|jpeg|png|webp)$/i.test(f)) {
            await fs.promises.unlink(path.join(folderPath, f)).catch(() => {});
            purged++;
          }
        }
        console.log(`[populate-all] ${communityName}: purged ${purged} old photos`);

        let saved = 0; let failed = 0;
        for (let i = 0; i < topUrls.length; i++) {
          try {
            const imgResp = await fetch(topUrls[i], {
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
        console.log(`[populate-all] ✓ ${communityName}: saved=${saved}, failed=${failed}`);
      } catch (err: any) {
        console.log(`[populate-all] ✗ ${communityName}: ERROR — ${err?.message}`);
        results[communityName] = { saved: 0, failed: -1 };
      }
      await new Promise(r => setTimeout(r, 1000)); // rate limit between communities
    }
    console.log(`[populate-all] ✅ Complete! Results:`, JSON.stringify(results));

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

  // ========== PRE-FLIGHT CHECK ==========

  // Platform check: searches Google for the property on Airbnb, VRBO, and Booking.com
  app.get("/api/preflight/platform-check", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    const imgbbKey = process.env.IMGBB_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const name = (req.query.name as string || "").trim();
    const city = (req.query.city as string || "").trim();
    const unitsParam = (req.query.units as string || "[]");
    if (!name) return res.status(400).json({ error: "name is required" });

    let units: { unitId: string; unitNumber: string; address: string; photoFolder?: string }[] = [];
    try { units = JSON.parse(unitsParam); } catch { return res.status(400).json({ error: "Invalid units JSON" }); }
    if (units.length === 0) return res.status(400).json({ error: "units array is required" });

    const PLATFORM_CONFIGS = [
      { key: "airbnb",  pattern: "airbnb.com/rooms/" },
      { key: "vrbo",    pattern: "vrbo.com/" },
      { key: "booking", pattern: "booking.com/" },
    ];
    const photosBase = path.join(process.cwd(), "client", "public", "photos");

    // ── Helper: strip the unit number from an address so queries can target
    // the street portion cleanly. Input "4460 Nehe Rd 122 Lihue HI" with
    // unit="122" → "4460 Nehe Rd Lihue HI". Without this, the street query
    // double-counts the unit number ("4460 Nehe Rd 122" already contains it)
    // and a villa whose snippet mentions any "122" gets a false positive.
    const stripUnitFromAddress = (addr: string, unitNumber: string): string => {
      const n = (unitNumber || "").trim();
      if (!n || !addr) return addr;
      // Match unit-number with or without a marker, bounded by space/comma.
      const re = new RegExp(
        `(?:[,\\s])(?:unit\\s*#?|apt\\.?\\s*#?|apartment\\s*#?|suite\\s*#?|ste\\.?\\s*#?|no\\.?\\s*|#)?\\s*${n}(?=[,\\s]|$)`,
        "i",
      );
      return addr.replace(re, " ").replace(/\s*,\s*/g, ", ").replace(/\s{2,}/g, " ").trim();
    };

    // Extract the street portion (before the first comma, or before the city
    // if no commas) so we can demand the snippet mentions OUR street, not
    // just the unit number alone.
    const extractStreet = (cleanedAddr: string): string => {
      if (cleanedAddr.includes(",")) return cleanedAddr.split(",")[0].trim();
      // No comma form: "4460 Nehe Rd Lihue HI" — take through the last
      // street-type token (Rd/St/Ave/Dr/Blvd/Ln/Way/Ct/Pl/Ter/Cir/Pkwy/Hwy).
      const m = cleanedAddr.match(/^(.*?\b(?:rd|road|st|street|ave|avenue|dr|drive|blvd|boulevard|ln|lane|way|ct|court|pl|place|ter|terrace|cir|circle|pkwy|parkway|hwy|highway))\b/i);
      return (m ? m[1] : cleanedAddr).trim();
    };

    // Build a lowercase "haystack" from a search result for text checks.
    const resultText = (r: any): string =>
      `${r.title || ""} ${r.snippet || ""} ${r.link || ""}`.toLowerCase();

    // ── Helper: does the snippet mention the unit number with a marker strong
    // enough to distinguish it from a random "122" in a price / zip / review
    // count? We require either an explicit unit marker (Unit 122, #122, Apt
    // 122 …) OR the number as its own space-bounded word immediately after
    // the street (e.g. "Nehe Rd 122" or "Rd, 122"). Bare "122" anywhere is
    // rejected — it was the source of the Unit 122 / VRBO villa false
    // positive where the snippet mentioned the digits in an unrelated field.
    const snippetMentionsUnit = (r: any, unitNumber: string, streetTail?: string): boolean => {
      const text = resultText(r);
      const num = unitNumber.toLowerCase().replace(/^0+/, ""); // strip leading zeros
      if (!num) return false;
      // Strong markers — any of these is sufficient on its own.
      const markerPatterns = [
        new RegExp(`\\b(?:unit|apt\\.?|apartment|suite|ste\\.?|no\\.?)\\s*#?\\s*${num}\\b`, "i"),
        new RegExp(`#\\s*${num}\\b`, "i"),
        // URL slug form: property-name-122 (dash-prefixed, only in the link portion)
        new RegExp(`-${num}(?:[\\/\\?\\-]|$)`, "i"),
      ];
      if (markerPatterns.some((re) => re.test(text))) return true;
      // Weaker: number immediately after the street name ("Nehe Rd 122").
      // Only count when the street is also visible in the same text.
      if (streetTail) {
        const tail = streetTail.toLowerCase();
        const adjacent = new RegExp(`\\b${tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,?\\s*#?\\s*${num}\\b`, "i");
        if (adjacent.test(text)) return true;
      }
      return false;
    };

    // ── Helper: confirm URL is a specific listing page (not a search/region page) ─
    const isListingUrl = (url: string, cfg: typeof PLATFORM_CONFIGS[0]): boolean => {
      if (!url) return false;
      const u = url.toLowerCase();
      if (cfg.key === "airbnb") return u.includes("airbnb.com/rooms/") || u.includes("airbnb.com/h/");
      if (cfg.key === "vrbo") {
        // Accept every URL shape that actually resolves to ONE specific
        // listing. VRBO has several historical variants — the /es-es/p…vb
        // URL in the bug report is a Spanish-locale listing page, which the
        // old regex missed entirely.
        if (/vrbo\.com\/\d+[a-z]{0,3}(?:[\/?#]|$)/.test(u)) return true;       // /1234567, /1234567ha
        if (/vrbo\.com\/[a-z]{2}-[a-z]{2}\/p\d+/.test(u)) return true;          // /en-us/p12345, /es-es/p12345vb
        if (/vrbo\.com\/vacation-rental\/p\d+/.test(u)) return true;            // /vacation-rental/p12345
        // Explicitly reject category/search pages even though they live
        // under vrbo.com — those aren't a unit someone can have booked.
        if (/vrbo\.com\/(search|region|destinations?|vacation-rentals\/[a-z])/.test(u)) return false;
        return false;
      }
      if (cfg.key === "booking") return u.includes("booking.com/hotel/") || u.includes("booking.com/apartments/");
      return u.includes(cfg.pattern);
    };

    // ── Helper: text search per platform for a unit — address-based + name-based
    // Uses Google snippet text for verification (no HTML fetch — platforms block bots).
    //
    // Methodology (rev. 2026-04 after villa false-positive on VRBO /es-es/ URL):
    //   1. Strip the unit number out of the address before building the
    //      street query so we don't double-count "122" in the source text.
    //   2. Only trust URLs that match a specific-listing shape per platform.
    //      No longer fall back to "any URL under vrbo.com" — that accepted
    //      region/search pages and misdirected listings.
    //   3. snippetMentionsUnit requires a unit marker (#, Unit 122, -122)
    //      OR street-adjacent placement (Nehe Rd 122). Bare "122" anywhere
    //      in the snippet (price, review count, zip) is NOT sufficient.
    //   4. titleMatch additionally requires the street portion to appear in
    //      the snippet — otherwise it's a weak match (reported as unconfirmed).
    const textSearch = async (
      unit: { unitNumber: string; address: string },
      cfg: typeof PLATFORM_CONFIGS[0],
    ): Promise<{ listed: boolean | null; url: string | null; titleMatch: boolean }> => {
      const domain = cfg.key === "booking" ? "booking.com" : `${cfg.key}.com`;
      // Pre-clean the address so the unit number only appears in the
      // dedicated unit-number term of the query, never in the street term.
      const cleanedAddr = stripUnitFromAddress(unit.address || "", unit.unitNumber);
      const street = extractStreet(cleanedAddr);
      // Run address-based query (primary) and name+city query (fallback) in parallel
      const queries = [
        street ? `site:${domain} "${street}" "${unit.unitNumber}"` : null,
        `site:${domain} "${name}" "${city}" "${unit.unitNumber}"`,
      ].filter(Boolean) as string[];
      try {
        const searchResults = await Promise.all(queries.map(async (q) => {
          const params = new URLSearchParams({ engine: "google", q, api_key: apiKey, num: "5" });
          const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`, {
            headers: { "User-Agent": "NexStay/1.0" },
          });
          if (!resp.ok) return [];
          const data = await resp.json() as any;
          return (data.organic_results || []) as any[];
        }));
        // Merge results from both queries, dedupe by URL
        const seen = new Set<string>();
        const allResults: any[] = [];
        for (const batch of searchResults) {
          for (const r of batch) {
            const link: string = r.link || r.url || "";
            if (!seen.has(link)) { seen.add(link); allResults.push(r); }
          }
        }
        // Extract the street name alone (without the leading number) so we
        // can demand it appears in the snippet — this is what distinguishes
        // "Nehe Rd 122" (real match) from a random "122" in a different
        // listing's description.
        const streetName = street.replace(/^\d+\s*/, "").trim();
        const streetTail = streetName; // used for adjacency heuristic in snippetMentionsUnit

        let bestUrl: string | null = null;
        let bestTitleMatch = false;
        for (const r of allResults) {
          const link: string = r.link || r.url || "";
          if (!link.toLowerCase().includes(cfg.key === "booking" ? "booking.com" : `${cfg.key}.com`)) continue;
          // Hard requirement: only accept a URL that resolves to one specific
          // listing. Search/region/category pages and misdirected domain hits
          // never advance. This removes the old "vrbo.com anything" fallback
          // that caused the /es-es/p…vb villa to slip through.
          if (!isListingUrl(link, cfg)) continue;
          const unitInSnippet = snippetMentionsUnit(r, unit.unitNumber, streetTail);
          // For titleMatch we also need the STREET to appear in the snippet.
          // A listing URL + unit-number mention alone is still a "possible
          // match" (shown yellow in the UI), not a confirmed one.
          const streetInSnippet = streetName.length >= 3
            ? resultText(r).includes(streetName.toLowerCase())
            : false;
          // Hard gate: if NEITHER the street nor the unit number actually
          // appears in the snippet, Google's site: search returned a fuzzy
          // match that's probably a different listing entirely — the
          // scenario that produced the Unit 122 / villa false positive.
          // Skip it rather than surface it as a "possible match".
          if (!unitInSnippet && !streetInSnippet) continue;
          const titleMatch = unitInSnippet && streetInSnippet;
          if (titleMatch) return { listed: true, url: link, titleMatch: true };
          if (!bestUrl) { bestUrl = link; bestTitleMatch = false; }
        }
        if (bestUrl) return { listed: true, url: bestUrl, titleMatch: bestTitleMatch };
        return { listed: false, url: null, titleMatch: false };
      } catch { return { listed: null, url: null, titleMatch: false }; }
    };

    // ── Helper: photo reverse image search for a unit (caps at 3 photos) ──────
    type PhotoSignals = Record<string, boolean>; // platform key → found
    const photoSearch = async (photoFolder: string): Promise<{ signals: PhotoSignals; matchCount: number; totalChecked: number }> => {
      const signals: PhotoSignals = { airbnb: false, vrbo: false, booking: false };
      if (!imgbbKey) return { signals, matchCount: 0, totalChecked: 0 };
      // Empty photoFolder means no local photos available (e.g. a replacement unit) — skip photo check
      if (!photoFolder || photoFolder.trim() === "") return { signals, matchCount: 0, totalChecked: 0 };
      const folderPath = path.join(photosBase, photoFolder.replace(/[^a-zA-Z0-9_-]/g, ""));
      if (!fs.existsSync(folderPath)) return { signals, matchCount: 0, totalChecked: 0 };
      const files = fs.readdirSync(folderPath).filter((f: string) => /\.(jpg|jpeg|png)$/i.test(f)).sort().slice(0, 5);
      let matchCount = 0;
      for (const file of files) {
        try {
          const base64 = fs.readFileSync(path.join(folderPath, file)).toString("base64");
          const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `image=${encodeURIComponent(base64)}`,
          });
          if (!imgbbResp.ok) { await new Promise(r => setTimeout(r, 1000)); continue; }
          const imgbbData = await imgbbResp.json() as any;
          const publicUrl = imgbbData?.data?.url;
          if (!publicUrl) { await new Promise(r => setTimeout(r, 1000)); continue; }
          const searchParams = new URLSearchParams({ engine: "google_lens", url: publicUrl, api_key: apiKey });
          const searchResp = await fetch(`https://www.searchapi.io/api/v1/search?${searchParams.toString()}`, {
            headers: { "User-Agent": "NexStay/1.0" },
          });
          if (searchResp.ok) {
            const searchData = await searchResp.json() as any;
            const allLinks = [
              ...(searchData.visual_matches || []),
              ...(searchData.organic_results || []),
              ...(searchData.pages_with_matching_images || []),
              ...(searchData.knowledge_graph ? [searchData.knowledge_graph] : []),
            ].map((r: any) => (r.link || r.url || r.source || r.source_url || "").toLowerCase());
            for (const cfg of PLATFORM_CONFIGS) {
              const domain = cfg.key === "booking" ? "booking.com" : `${cfg.key}.com`;
              // Require it's actually a listing page, not just the platform homepage
              const found = allLinks.some((l: string) => {
                if (!l.includes(domain)) return false;
                return isListingUrl(l, cfg) || l.split(domain)[1]?.length > 5;
              });
              if (found && !signals[cfg.key]) {
                signals[cfg.key] = true;
                matchCount++;
              }
            }
          }
        } catch { /* best effort */ }
        await new Promise(r => setTimeout(r, 1000));
      }
      return { signals, matchCount, totalChecked: files.length };
    };

    // ── Combine text + photo signals into a single status per platform ─────────
    type CombinedResult = { status: string; url: string | null; detection: string };
    const combine = (
      text: { listed: boolean | null; url: string | null; titleMatch: boolean },
      photoFound: boolean,
      photoMatchCount: number,
      totalPhotos: number,
    ): CombinedResult => {
      if (text.listed && text.titleMatch)
        return { status: "confirmed", url: text.url, detection: "Title match confirmed" };
      if (text.listed && !text.titleMatch && photoFound)
        return { status: "photo-confirmed", url: text.url, detection: "Text found + photos matched" };
      if (!text.listed && photoFound)
        return { status: "photo-only", url: null, detection: `Photos matched (${totalPhotos} photo${totalPhotos !== 1 ? "s" : ""} checked) — no text confirmation` };
      if (text.listed && !text.titleMatch && !photoFound)
        return { status: "unconfirmed", url: text.url, detection: "Text found — title unconfirmed, no photo match" };
      if (text.listed === null)
        return { status: "error", url: null, detection: "Could not verify" };
      return { status: "not-listed", url: null, detection: "No signals found" };
    };

    // ── Process each unit: run text searches + photo search concurrently ───────
    const resultUnits = await Promise.all(
      units.map(async (unit) => {
        const [textResults, photoResult] = await Promise.all([
          Promise.all(PLATFORM_CONFIGS.map(cfg => textSearch(unit, cfg))),
          unit.photoFolder ? photoSearch(unit.photoFolder) : Promise.resolve({ signals: { airbnb: false, vrbo: false, booking: false }, matchCount: 0, totalChecked: 0 }),
        ]);
        const [airbnbText, vrboText, bookingText] = textResults;
        const { signals, matchCount, totalChecked } = photoResult;

        // Cross-platform correlation: if found on 2+ platforms via text, treat unconfirmed as confirmed
        const textListedCount = [airbnbText, vrboText, bookingText].filter(t => t.listed).length;
        const crossConfirmed = textListedCount >= 2;

        const resolveText = (t: typeof airbnbText) =>
          crossConfirmed && t.listed && !t.titleMatch ? { ...t, titleMatch: true } : t;

        return {
          unitId: unit.unitId,
          unitNumber: unit.unitNumber,
          address: unit.address,
          platforms: {
            airbnb:  combine(resolveText(airbnbText),  signals.airbnb,  signals.airbnb  ? matchCount : 0, totalChecked),
            vrbo:    combine(resolveText(vrboText),    signals.vrbo,    signals.vrbo    ? matchCount : 0, totalChecked),
            booking: combine(resolveText(bookingText), signals.booking, signals.booking ? matchCount : 0, totalChecked),
          },
        };
      }),
    );

    res.json({ units: resultUnits });
  });

  // Photo audit: runs reverse image search on each unit photo to detect platform listings
  app.get("/api/preflight/photo-audit", async (req, res) => {
    const apiKey = process.env.SEARCHAPI_API_KEY;
    const imgbbKey = process.env.IMGBB_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });
    if (!imgbbKey) return res.status(500).json({ error: "IMGBB_API_KEY not configured" });

    const foldersParam = (req.query.folders as string || "");
    const folders = foldersParam.split(",").map(f => f.replace(/[^a-zA-Z0-9_-]/g, "")).filter(Boolean);
    if (folders.length === 0) return res.status(400).json({ error: "folders is required" });

    const photosBase = path.join(process.cwd(), "client", "public", "photos");
    const PLATFORMS = ["airbnb.com", "vrbo.com", "booking.com"];

    const results: { folder: string; filename: string; url: string; found: boolean | null; platforms: string[]; error?: string }[] = [];

    for (const folder of folders) {
      const folderPath = path.join(photosBase, folder);
      if (!fs.existsSync(folderPath)) continue;
      const files = fs.readdirSync(folderPath).filter((f: string) => /\.(jpg|jpeg|png)$/i.test(f)).sort().slice(0, 5);

      for (const file of files) {
        const localPath = path.join(folderPath, file);
        try {
          const base64Data = fs.readFileSync(localPath).toString("base64");
          const imgbbResp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `image=${encodeURIComponent(base64Data)}`,
          });
          if (!imgbbResp.ok) {
            results.push({ folder, filename: file, url: `/photos/${folder}/${file}`, found: null, platforms: [], error: "Upload failed" });
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          const imgbbData = await imgbbResp.json() as any;
          const publicUrl = imgbbData?.data?.url;
          if (!publicUrl) {
            results.push({ folder, filename: file, url: `/photos/${folder}/${file}`, found: null, platforms: [], error: "No URL from imgbb" });
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          const searchParams = new URLSearchParams({ engine: "google_lens", url: publicUrl, api_key: apiKey });
          const searchResp = await fetch(`https://www.searchapi.io/api/v1/search?${searchParams.toString()}`, {
            headers: { "User-Agent": "NexStay/1.0" },
          });
          if (!searchResp.ok) {
            results.push({ folder, filename: file, url: `/photos/${folder}/${file}`, found: null, platforms: [], error: "Search failed" });
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          const searchData = await searchResp.json() as any;
          const allResults = [
            ...(searchData.visual_matches || []),
            ...(searchData.organic_results || []),
            ...(searchData.pages_with_matching_images || []),
          ];
          const foundPlatforms: string[] = [];
          for (const r of allResults) {
            const link: string = r.link || r.url || r.source_url || "";
            for (const p of PLATFORMS) {
              if (link.includes(p) && !foundPlatforms.includes(p)) foundPlatforms.push(p);
            }
          }
          results.push({ folder, filename: file, url: `/photos/${folder}/${file}`, found: foundPlatforms.length > 0, platforms: foundPlatforms });
        } catch (err: any) {
          results.push({ folder, filename: file, url: `/photos/${folder}/${file}`, found: null, platforms: [], error: err.message });
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    res.json({ results });
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
  // Fetch Zillow listing photos without Playwright (plain HTTP + parse __NEXT_DATA__)
  // ============================================================
  async function scrapeZillowPhotosFetch(url: string): Promise<{ url: string; title: string }[]> {
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          "Referer": "https://www.google.com/",
        },
      });
      console.error(`[scrapeZillow] ${url} → HTTP ${resp.status} ${resp.statusText}`);
      if (!resp.ok) return [];
      const html = await resp.text();
      console.error(`[scrapeZillow] HTML length: ${html.length}, has __NEXT_DATA__: ${html.includes('id="__NEXT_DATA__"')}, has mixedSources: ${html.includes("mixedSources")}`);

      // Extract __NEXT_DATA__ JSON embedded by Next.js SSR
      const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!match) return [];

      let nd: any;
      try { nd = JSON.parse(match[1]); } catch { return []; }

      const urls: string[] = [];
      function walk(obj: any, depth: number): void {
        if (depth > 16 || !obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) { obj.forEach(v => walk(v, depth + 1)); return; }
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

      const unique = [...new Set(urls)];
      return unique.map(u => ({ url: u, title: "Zillow photo" }));
    } catch {
      return [];
    }
  }

  // ============================================================
  // Find a replacement unit: Zillow search → Airbnb check → return clean unit
  // ============================================================
  app.post("/api/replacement/find-unit", async (req, res) => {
    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    const imgbbKey = process.env.IMGBB_API_KEY;
    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const { communityFolder, requiredBedrooms, skipUrls = [] } = req.body as {
      communityFolder: string;
      requiredBedrooms?: number;
      skipUrls?: string[];
    };

    const safeFolder = (communityFolder || "").replace(/[^a-zA-Z0-9_-]/g, "");
    const communityName = COMMUNITY_FOLDER_TO_NAME[safeFolder];
    if (!communityName) return res.status(400).json({ error: "Unknown community folder" });

    const communityAddress = COMMUNITY_FOLDER_TO_ADDRESS[safeFolder] || communityName;
    console.error(`[find-unit] Starting: folder=${communityFolder}, name=${communityName}, address=${communityAddress}, bedrooms=${requiredBedrooms}`);

    // Step 1 — Google search for Zillow listing URLs at this community address
    // Google results also include a thumbnail we can use for display (no Zillow scraping needed)
    interface Candidate {
      zillowUrl: string;
      address: string;
      unitNumber: string;  // e.g. "122", "339"
      thumbnail: string;   // Google-provided thumbnail for the result card
    }
    const candidates: Candidate[] = [];

    for (const siteQuery of [
      `site:zillow.com "${communityAddress}"`,
      `site:zillow.com "${communityName}"`,
    ]) {
      try {
        console.error(`[find-unit] Searching: ${siteQuery}`);
        const searchResp = await fetch(
          `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(siteQuery)}&num=10&api_key=${searchApiKey}`,
        );
        if (!searchResp.ok) {
          console.error(`[find-unit] SearchAPI HTTP ${searchResp.status}`);
          continue;
        }
        const searchData = await searchResp.json() as any;
        const results: any[] = searchData.organic_results || [];
        console.error(`[find-unit] Got ${results.length} Google results`);

        for (const r of results) {
          const link: string = r.link || "";
          if (!link.includes("zillow.com/homedetails")) continue;
          if (skipUrls.includes(link)) continue;

          // Extract unit number from URL slug — patterns: "Nehe-Rd-122-", "APT-122-", "Unit-122-"
          const slug = link.match(/homedetails\/([^/]+)\//)?.[1] || "";
          const parts = slug.split("-");
          // First try explicit apt/unit prefix (most reliable)
          const aptMatch = slug.match(/(?:apt|unit)-([a-z0-9]+)/i);
          let unitNumber = aptMatch ? aptMatch[1].toUpperCase() : "";
          if (!unitNumber) {
            // Scan parts backwards, skip index 0 (house number like "4460") and skip zip codes (5+ digits)
            // Unit numbers are 2-4 digits and appear after the street name segments
            for (let i = parts.length - 1; i >= 1; i--) {
              if (/^\d{2,4}$/.test(parts[i]) && parseInt(parts[i]) < 1000) {
                unitNumber = parts[i];
                break;
              }
            }
          }

          const addrDisplay = decodeURIComponent(slug)
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c: string) => c.toUpperCase())
            .replace(/\d{5}$/, "").trim();

          const thumbnail: string = r.thumbnail || r.rich_snippet?.top?.detected_extensions?.thumbnail || "";

          candidates.push({ zillowUrl: link, address: addrDisplay || communityName, unitNumber, thumbnail });
        }
        if (candidates.length >= 6) break;
      } catch (e: any) {
        console.error(`[find-unit] Search error: ${e?.message}`);
      }
    }

    console.error(`[find-unit] Found ${candidates.length} candidate URLs`);

    // Step 2 — For each candidate, do an Airbnb TEXT search for the specific address+unit
    // This avoids all Zillow page fetching (which returns 403) and photo reverse-searching
    for (const candidate of candidates) {
      try {
        const { zillowUrl, address, unitNumber, thumbnail } = candidate;

        // Check Airbnb using the STREET ADDRESS + unit number only.
        // The community-name query (e.g. "Kaha Lani Resort" + "228") causes false positives
        // because "228" can match review counts, square footage, etc. on any listing page.
        // The address query is specific enough: if the unit is on Airbnb it will mention the address.
        let foundOnAirbnb = false;
        if (unitNumber) {
          const q = `site:airbnb.com "${communityAddress}" "${unitNumber}"`;
          console.error(`[find-unit] Airbnb text check: ${q}`);
          try {
            const resp = await fetch(
              `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(q)}&num=3&api_key=${searchApiKey}`,
            );
            if (resp.ok) {
              const data = await resp.json() as any;
              const hits: any[] = data.organic_results || [];
              const airbnbHits = hits.filter((h: any) => (h.link || "").includes("airbnb.com"));
              console.error(`[find-unit] Airbnb hits for "${q}": ${airbnbHits.length}`);
              if (airbnbHits.length > 0) foundOnAirbnb = true;
            }
          } catch {}
        }

        if (!foundOnAirbnb) {
          console.error(`[find-unit] Clean unit found: ${zillowUrl}`);
          // Provide a placeholder thumbnail if Google didn't return one
          const photos = thumbnail
            ? [{ url: thumbnail, label: `Unit ${unitNumber || "—"} on Zillow` }]
            : [];
          return res.json({
            unit: {
              url: zillowUrl,
              address,
              unitLabel: unitNumber ? `Unit #${unitNumber}` : "New unit",
              bedrooms: requiredBedrooms ?? null,
              source: "Zillow",
              photos,
            },
          });
        }
        console.error(`[find-unit] Unit ${unitNumber} found on Airbnb — skipping`);
      } catch (err: any) {
        console.error(`[find-unit] Candidate error: ${err?.message}`);
      }
    }

    return res.json({
      error: "No eligible replacement units found. Please try again later or adjust your search criteria.",
    });
  });

  // ============================================================
  // Unit Swaps: Record a confirmed replacement unit for the builder
  // ============================================================
  app.post("/api/unit-swaps", async (req, res) => {
    const parsed = insertUnitSwapSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid unit swap data", details: parsed.error.flatten() });
    }
    const swap = await storage.createUnitSwap(parsed.data);
    return res.json({ swap });
  });

  app.get("/api/unit-swaps/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId);
    if (isNaN(propertyId)) return res.status(400).json({ error: "Invalid propertyId" });
    const swaps = await storage.getUnitSwaps(propertyId);
    return res.json({ swaps });
  });

  app.delete("/api/unit-swaps/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const ok = await storage.deleteUnitSwap(id);
    return res.json({ ok });
  });

  app.patch("/api/unit-swaps/commit/:propertyId", async (req, res) => {
    const propertyId = parseInt(req.params.propertyId);
    if (isNaN(propertyId)) return res.status(400).json({ error: "Invalid propertyId" });
    await storage.commitUnitSwaps(propertyId);
    return res.json({ ok: true });
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
    // Reject villas / single-family / estates — the business combines two
    // condos or two townhomes in the same building. A "community" of
    // detached homes is not the same product.
    const typeCheck = checkCommunityType(result.data.unitTypes, result.data.researchSummary);
    if (!typeCheck.eligible) {
      return res.status(400).json({
        error: "Community type not supported",
        reason: typeCheck.reason,
        matchedDisqualifier: typeCheck.matchedDisqualifier,
      });
    }
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

    try {
      const communities = await researchCommunitiesForCity(city, state);
      return res.json({ communities });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/community/scan-top-markets
  // Runs the community finder across a curated list of US vacation-rental
  // hotspots (TOP_MARKET_SEEDS). Streams NDJSON per-market as results come in
  // so the UI can render progressively — the whole sweep takes a few minutes.
  //
  // Body (optional): { markets?: [{city, state}], maxMarkets?: number }
  //   - Defaults to TOP_MARKET_SEEDS
  //   - maxMarkets caps the sweep (for quota conservation)
  //
  // NDJSON events:
  //   {type:"start", markets:[{city,state,tag}]}
  //   {type:"market-start", city, state, tag, index, total}
  //   {type:"market-done", city, state, count, communities:[...]}
  //   {type:"market-error", city, state, error}
  //   {type:"all-done", totalCommunities, topCommunity?}
  app.post("/api/community/scan-top-markets", async (req: Request, res: Response) => {
    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    const body = (req.body ?? {}) as {
      markets?: Array<{ city: string; state: string; tag?: string }>;
      maxMarkets?: number;
    };

    const requested = body.markets && body.markets.length > 0 ? body.markets : TOP_MARKET_SEEDS;
    const limit = Math.min(requested.length, Math.max(1, body.maxMarkets ?? 12));
    const markets = requested.slice(0, limit);

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const emit = (o: Record<string, unknown>) => res.write(JSON.stringify(o) + "\n");

    emit({ type: "start", markets });
    console.log(`[scan-top-markets] starting sweep of ${markets.length} cities`);

    let totalCommunities = 0;
    let topCommunity: { score: number; data: any } | null = null;

    for (let i = 0; i < markets.length; i++) {
      const { city, state, tag } = markets[i] as { city: string; state: string; tag?: string };
      emit({ type: "market-start", city, state, tag, index: i + 1, total: markets.length });
      try {
        const communities = await researchCommunitiesForCity(city, state);
        totalCommunities += communities.length;
        for (const c of communities) {
          const score = c.confidenceScore + (c.combinabilityScore ?? 50);
          if (!topCommunity || score > topCommunity.score) {
            topCommunity = { score, data: { ...c, tag } };
          }
        }
        emit({ type: "market-done", city, state, tag, count: communities.length, communities });
        console.log(`[scan-top-markets] ${city}, ${state}: ${communities.length} qualifying`);
      } catch (e: any) {
        console.error(`[scan-top-markets] ${city}, ${state} error:`, e.message);
        emit({ type: "market-error", city, state, tag, error: e.message });
      }
    }

    emit({
      type: "all-done",
      totalCommunities,
      topCommunity: topCommunity?.data ?? null,
      marketCount: markets.length,
    });
    console.log(`[scan-top-markets] done: ${totalCommunities} communities across ${markets.length} markets`);
    res.end();
  });

  // GET /api/community/top-markets/seeds
  // Returns the curated seed list so the UI can show a preview / checkboxes.
  app.get("/api/community/top-markets/seeds", (_req, res) => {
    res.json({ markets: TOP_MARKET_SEEDS });
  });


  // ============================================================
  // Step 3: Generate algorithm-based unit pairing suggestions for a community
  // ============================================================
  app.post("/api/community/search-units", async (req, res) => {
    const { communityName, city, state, unitTypes: rawUnitTypes } = req.body as {
      communityName: string; city: string; state: string; unitTypes?: string;
    };
    if (!communityName) return res.status(400).json({ error: "communityName required" });

    const searchApiKey = process.env.SEARCHAPI_API_KEY;
    if (!searchApiKey) return res.status(500).json({ error: "SEARCHAPI_API_KEY not configured" });

    // ── 1. Search Airbnb & VRBO for existing listings at this community ──────
    const ratesByBR: Record<number, number[]> = {};
    let airbnbListingCount = 0;
    const searchQueries = [
      `"${communityName}" ${city} ${state} site:airbnb.com per night`,
      `"${communityName}" ${city} ${state} site:vrbo.com per night`,
      `"${communityName}" ${city} ${state} vacation rental nightly rate`,
    ];

    for (const q of searchQueries) {
      try {
        const resp = await fetch(
          `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(q)}&num=8&api_key=${searchApiKey}`,
        );
        if (!resp.ok) continue;
        const data = await resp.json() as any;
        const organic = (data.organic_results || []) as Array<{ title: string; link: string; snippet: string }>;
        for (const r of organic) {
          if (r.link?.includes("airbnb.com") || r.link?.includes("vrbo.com")) airbnbListingCount++;
          const text = r.title + " " + r.snippet;
          // Extract bedroom count
          const brMatch = text.match(/(\d+)\s*(?:bed|br|bedroom)/i);
          const br = brMatch ? parseInt(brMatch[1]) : null;
          // Extract nightly rate
          const rateMatches = text.match(/\$\s*(\d{2,4})\s*(?:\/\s*night|per night|a night)/gi) || [];
          for (const m of rateMatches) {
            const rate = parseInt(m.replace(/[^\d]/g, ""));
            if (rate >= 80 && rate <= 3000 && br && br >= 1 && br <= 6) {
              if (!ratesByBR[br]) ratesByBR[br] = [];
              ratesByBR[br].push(rate);
            }
          }
        }
      } catch { /* ignore */ }
    }

    // ── 2. Parse available unit types ─────────────────────────────────────────
    // From research step: e.g. "2BR, 3BR" or "3-bedroom, 2-bedroom"
    const parsedTypes = new Set<number>();
    if (rawUnitTypes) {
      const nums = rawUnitTypes.match(/(\d+)\s*(?:br|bed)/gi) || rawUnitTypes.match(/\d+/g) || [];
      for (const n of nums) {
        const br = parseInt(n);
        if (br >= 1 && br <= 6) parsedTypes.add(br);
      }
    }
    // Also add bedroom types found from Airbnb/VRBO search
    for (const br of Object.keys(ratesByBR)) parsedTypes.add(parseInt(br));
    // Default to 2BR + 3BR if nothing found (most common vacation rental config)
    if (parsedTypes.size === 0) { parsedTypes.add(2); parsedTypes.add(3); }

    const availableTypes = Array.from(parsedTypes).sort((a, b) => a - b);

    // ── 3. Calculate median rate per bedroom type ─────────────────────────────
    const medianRate = (arr: number[]) => {
      if (!arr?.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    // Estimate per-unit nightly rate for each BR type (if not found in search, use location-based estimate)
    const baseRatePerBR: Record<number, number> = {};
    const isHawaii = state === "Hawaii" || state === "HI";
    const isFlorida = state === "Florida" || state === "FL";
    const basePricePerBR = isHawaii ? 160 : isFlorida ? 120 : 100;
    for (const br of availableTypes) {
      const found = medianRate(ratesByBR[br]);
      baseRatePerBR[br] = found ?? (br * basePricePerBR);
    }

    // ── 4. Generate pairing combinations ─────────────────────────────────────
    const MARKUP = 1.38;
    type Pairing = {
      unit1Beds: number; unit2Beds: number; totalBeds: number;
      estimatedUnit1Rate: number; estimatedUnit2Rate: number;
      estimatedSellRate: number; estimatedSellRateHigh: number;
      rationale: string; isTopPick: boolean; matchScore: number;
    };
    const pairings: Pairing[] = [];

    // Generate all valid combinations (including same type twice)
    const typeArr = availableTypes;
    for (let i = 0; i < typeArr.length; i++) {
      for (let j = i; j < typeArr.length; j++) {
        const b1 = typeArr[i], b2 = typeArr[j];
        const total = b1 + b2;
        if (total < 3 || total > 10) continue;
        const r1 = baseRatePerBR[b1] ?? b1 * basePricePerBR;
        const r2 = baseRatePerBR[b2] ?? b2 * basePricePerBR;
        const buyCost = r1 + r2;
        const sellLow = Math.round(buyCost * MARKUP / 25) * 25;
        const sellHigh = Math.round(sellLow * 1.15 / 25) * 25;

        // Score: same-size units are best (guests get symmetric experience), larger is better for demand
        const matchScore = (b1 === b2 ? 2 : 0) + Math.min(total / 2, 3);
        const reasons: string[] = [];
        if (b1 === b2) reasons.push(`Matched unit sizes (${b1}BR + ${b2}BR) — symmetric guest experience`);
        else reasons.push(`Mixed sizes: ${b1}BR + ${b2}BR`);
        if (total >= 6) reasons.push("high-demand large group configuration");
        if (total >= 8) reasons.push("rare 8BR+ inventory");
        if (b1 === b2 && total >= 6) reasons.push("⭐ algorithm top pick");

        pairings.push({
          unit1Beds: b1, unit2Beds: b2, totalBeds: total,
          estimatedUnit1Rate: r1, estimatedUnit2Rate: r2,
          estimatedSellRate: sellLow, estimatedSellRateHigh: sellHigh,
          rationale: reasons.join(" · "),
          isTopPick: b1 === b2 && total >= 6,
          matchScore,
        });
      }
    }

    pairings.sort((a, b) => b.matchScore - a.matchScore);

    console.log(`[search-units] ${communityName}: ${availableTypes.join("BR, ")}BR available, ${pairings.length} pairings, ${airbnbListingCount} listings found`);

    res.json({
      communityProfile: {
        availableTypes,
        airbnbListingCount,
        ratesByBR: Object.fromEntries(
          Object.entries(ratesByBR).map(([k, v]) => [k, { median: medianRate(v), count: v.length }])
        ),
      },
      suggestedPairings: pairings,
      // backward compat
      units: [],
      grouped: {},
    });
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

  // ========== INBOX — Auto-Approve ==========

  app.get("/api/inbox/auto-approve/status", (_req, res) => {
    res.json(getAutoApproveStatus());
  });

  app.post("/api/inbox/auto-approve/toggle", (req, res) => {
    const { enabled } = req.body as { enabled: boolean };
    setAutoApproveEnabled(!!enabled);
    res.json(getAutoApproveStatus());
  });

  app.post("/api/inbox/auto-approve/run", async (_req, res) => {
    try {
      const result = await runAutoApprove();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: "Auto-approve run failed", message: err.message });
    }
  });

  // ========== INBOX — Auto-Reply Agent ==========

  app.get("/api/inbox/auto-reply/status", (_req, res) => {
    res.json(getAutoReplyStatus());
  });

  app.post("/api/inbox/auto-reply/toggle", (req, res) => {
    const { enabled } = req.body as { enabled: boolean };
    setAutoReplyEnabled(!!enabled);
    res.json(getAutoReplyStatus());
  });

  app.post("/api/inbox/auto-reply/run", async (_req, res) => {
    try {
      const result = await runAutoReply();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: "Auto-reply run failed", message: err.message });
    }
  });

  app.get("/api/inbox/auto-reply/logs", async (req, res) => {
    try {
      const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 200);
      const logs = await storage.getAutoReplyLogs(limit);
      res.json(logs);
    } catch (err: any) {
      // Fail-soft: if the table doesn't exist yet (Postgres 42P01) or any other
      // storage error, return an empty array so the inbox page still renders.
      // The real fix is running `npm run db:push` on Railway to create the table.
      const missingTable = /42P01|does not exist|relation .* does not exist/i.test(err.message || "");
      console.error(`[auto-reply/logs] ${missingTable ? "table missing — returning []" : err.message}`);
      res.json([]);
    }
  });

  app.post("/api/inbox/auto-reply/logs/:id/send", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await sendDraftedReply(id);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to send draft", message: err.message });
    }
  });

  app.post("/api/inbox/auto-reply/logs/:id/dismiss", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await dismissReply(id);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to dismiss", message: err.message });
    }
  });

  // ========== INBOX — Airbnb Pre-Approval / Decline / Special Offer ==========
  //
  // Guesty surfaces Airbnb-specific inquiry actions via several paths; their
  // schema has drifted across API versions so we try known-good URLs in order
  // until one works. This lets the host pre-approve an Airbnb inquiry directly
  // from the inbox without clicking over to Guesty's UI.
  //
  // POST /api/inbox/reservations/:reservationId/airbnb/preapprove
  //      body: {} (nothing required)
  // POST /api/inbox/reservations/:reservationId/airbnb/decline
  //      body: { reason?: string, message?: string }
  // POST /api/inbox/reservations/:reservationId/airbnb/special-offer
  //      body: { price: number, message?: string, expirationDays?: number }

  async function callGuestyAirbnbAction(
    reservationId: string,
    action: "preapprove" | "decline" | "special-offer",
    body: Record<string, unknown> = {},
  ): Promise<{ success: true; via: string; data: any } | { success: false; error: string; attempts: Array<{ path: string; method: string; status?: number; error: string }> }> {
    // Diagnostic on reservation 69e6…1d8c revealed a `preApproveState: false`
    // field and no POST action endpoints. Guesty tracks pre-approval as a
    // writable flag on the reservation document — PUT to update.
    // We keep the POST variants as fallbacks in case any account exposes them.
    //
    // Also added: `/reservations/{id}/preapprove` and PATCH variants that
    // some community threads mention work on specific Guesty tenants.
    const candidates: Record<typeof action, Array<{ method: "POST" | "PUT" | "PATCH"; path: string; body?: Record<string, unknown> }>> = {
      preapprove: [
        // Primary: update the preApproveState field directly
        { method: "PUT",   path: `/reservations/${reservationId}`, body: { preApproveState: true } },
        { method: "PATCH", path: `/reservations/${reservationId}`, body: { preApproveState: true } },
        // Bare verb endpoints reported by some tenants
        { method: "POST",  path: `/reservations/${reservationId}/preapprove` },
        { method: "POST",  path: `/reservations/${reservationId}/pre-approve` },
        // Status-transition pattern
        { method: "PUT",   path: `/reservations/${reservationId}`, body: { status: "preApproved" } },
        // Channel-prefixed fallbacks (already known-404 on your tenant but kept
        // so another account's response doesn't regress)
        { method: "POST",  path: `/airbnb2/reservations/${reservationId}/preapprove` },
        { method: "POST",  path: `/airbnb/reservations/${reservationId}/preapprove` },
      ],
      decline: [
        { method: "PUT",   path: `/reservations/${reservationId}`, body: { status: "declined" } },
        { method: "POST",  path: `/reservations/${reservationId}/decline` },
        { method: "POST",  path: `/airbnb2/reservations/${reservationId}/decline` },
        { method: "POST",  path: `/airbnb/reservations/${reservationId}/decline` },
      ],
      "special-offer": [
        { method: "POST",  path: `/reservations/${reservationId}/special-offer` },
        { method: "POST",  path: `/airbnb2/reservations/${reservationId}/special-offer` },
        { method: "POST",  path: `/airbnb/reservations/${reservationId}/special-offer` },
      ],
    };

    const attempts: Array<{ path: string; method: string; status?: number; error: string }> = [];
    let lastError = "";

    // Expected state-change per action — we check this via GET afterward to
    // confirm Guesty actually applied the change (some endpoints return 200
    // but ignore the field).
    const verifyExpectations: Record<typeof action, (r: any) => boolean> = {
      preapprove: (r) => r?.preApproveState === true || r?.status === "preApproved" || r?.status === "accepted",
      decline:    (r) => r?.status === "declined" || r?.status === "canceled",
      "special-offer": () => true, // no reliable field to verify
    };

    for (const c of candidates[action]) {
      try {
        const data = await guestyRequest(c.method, c.path, c.body ?? body);
        // If this is a PUT/PATCH to /reservations/{id}, verify the state changed.
        const isUpdateAttempt = (c.method === "PUT" || c.method === "PATCH") && c.path === `/reservations/${reservationId}`;
        if (isUpdateAttempt) {
          try {
            const fetched = await guestyRequest("GET", `/reservations/${reservationId}`) as any;
            if (!verifyExpectations[action](fetched)) {
              attempts.push({
                path: c.path,
                method: c.method,
                status: 200,
                error: `${c.method} returned 200 but state did not change (still preApproveState=${fetched?.preApproveState}, status=${fetched?.status})`,
              });
              console.warn(`[airbnb-action] ${action} via ${c.method} ${c.path} 200 but no-op`);
              continue;
            }
          } catch {
            // Couldn't verify — assume success
          }
        }
        console.log(`[airbnb-action] ${action} via ${c.method} ${c.path} OK`);
        return { success: true, via: `${c.method} ${c.path}`, data };
      } catch (err: any) {
        lastError = err.message ?? String(err);
        const m = /Guesty\s+(\d{3})/.exec(lastError);
        const status = m ? parseInt(m[1], 10) : undefined;
        attempts.push({ path: c.path, method: c.method, status, error: lastError });
        console.warn(`[airbnb-action] ${action} via ${c.method} ${c.path} failed (${status ?? "?"}): ${lastError}`);
      }
    }

    return { success: false, error: lastError || "No Guesty endpoint accepted the request", attempts };
  }

  // Diagnostic — returns the full Guesty reservation object so we can inspect
  // what actions/URLs/state it exposes. Helpful for figuring out what endpoint
  // pre-approval lives at for a given Guesty account.
  app.get("/api/inbox/reservations/:reservationId/debug", async (req, res) => {
    try {
      const reservation = await guestyRequest("GET", `/reservations/${req.params.reservationId}`) as any;
      return res.json({
        keys: reservation && typeof reservation === "object" ? Object.keys(reservation) : [],
        reservation,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/inbox/reservations/:reservationId/airbnb/preapprove", async (req, res) => {
    const reservationId = req.params.reservationId;
    if (!reservationId) return res.status(400).json({ error: "reservationId required" });
    const result = await callGuestyAirbnbAction(reservationId, "preapprove");
    if (!result.success) return res.status(502).json(result);
    return res.json(result);
  });

  app.post("/api/inbox/reservations/:reservationId/airbnb/decline", async (req, res) => {
    const reservationId = req.params.reservationId;
    if (!reservationId) return res.status(400).json({ error: "reservationId required" });
    const { reason, message } = req.body as { reason?: string; message?: string };
    const result = await callGuestyAirbnbAction(reservationId, "decline", {
      ...(reason ? { reason } : {}),
      ...(message ? { message } : {}),
    });
    if (!result.success) return res.status(502).json(result);
    return res.json(result);
  });

  app.post("/api/inbox/reservations/:reservationId/airbnb/special-offer", async (req, res) => {
    const reservationId = req.params.reservationId;
    if (!reservationId) return res.status(400).json({ error: "reservationId required" });
    const { price, message, expirationDays } = req.body as {
      price?: number; message?: string; expirationDays?: number;
    };
    if (!price || typeof price !== "number" || price <= 0) {
      return res.status(400).json({ error: "price (number > 0) required" });
    }
    const result = await callGuestyAirbnbAction(reservationId, "special-offer", {
      price,
      ...(message ? { message } : {}),
      ...(expirationDays ? { expirationDays } : {}),
    });
    if (!result.success) return res.status(502).json(result);
    return res.json(result);
  });

  // ========== INBOX — Message Templates ==========

  app.get("/api/inbox/templates", async (_req, res) => {
    try {
      const templates = await storage.getMessageTemplates();
      res.json(templates);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch templates", message: err.message });
    }
  });

  app.post("/api/inbox/templates", async (req, res) => {
    try {
      const parsed = insertMessageTemplateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
      const template = await storage.createMessageTemplate(parsed.data);
      res.status(201).json(template);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to create template", message: err.message });
    }
  });

  app.put("/api/inbox/templates/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const template = await storage.updateMessageTemplate(id, req.body);
      if (!template) return res.status(404).json({ error: "Template not found" });
      res.json(template);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to update template", message: err.message });
    }
  });

  app.delete("/api/inbox/templates/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const ok = await storage.deleteMessageTemplate(id);
      if (!ok) return res.status(404).json({ error: "Template not found" });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to delete template", message: err.message });
    }
  });

  // ========== INBOX — AI Draft Reply ==========

  app.post("/api/inbox/ai-draft", async (req, res) => {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(503).json({ error: "AI drafting unavailable (no ANTHROPIC_API_KEY configured)" });

    const { guestMessage, propertyName, guestName, checkIn, checkOut } = req.body as {
      guestMessage: string;
      propertyName?: string;
      guestName?: string;
      checkIn?: string;
      checkOut?: string;
    };

    if (!guestMessage) return res.status(400).json({ error: "guestMessage is required" });

    const systemPrompt = `You are a friendly, professional vacation rental host for NexStay. You manage premium multi-unit properties in Hawaii. Write warm, helpful, concise replies to guest messages. Never mention that units are combined. Sign off as "The NexStay Team".`;

    const userPrompt = `Guest name: ${guestName || "Guest"}
Property: ${propertyName || "our property"}
${checkIn ? `Check-in: ${checkIn}` : ""}
${checkOut ? `Check-out: ${checkOut}` : ""}

Guest message:
"${guestMessage}"

Write a helpful, friendly reply in 3-4 sentences. Be specific and warm. Do not include a subject line.`;

    try {
      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 400,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      const claudeData = await claudeResp.json() as any;
      const draft: string = claudeData?.content?.[0]?.text ?? "";
      res.json({ draft });
    } catch (err: any) {
      res.status(500).json({ error: "AI draft failed", message: err.message });
    }
  });

  return httpServer;
}
