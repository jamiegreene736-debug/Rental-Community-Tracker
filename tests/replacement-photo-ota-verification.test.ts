import assert from "node:assert/strict";
import sharp from "sharp";
import {
  issueReplacementPhotoReceipt,
  normalizeReplacementPhotoUrls,
  replacementPhotoContentDigest,
  validateReplacementPhotoReceipt,
  verifyReplacementPhotoSet,
  type ReplacementPhotoOtaVerification,
} from "../server/replacement-photo-ota-verification";

const SOURCE_URL = "https://www.zillow.com/homedetails/123-Test-St/123_zpid/";
const SECRET = "test-only-replacement-photo-secret";
const RECEIPT_TARGET = { propertyId: 23, targetUnitId: "unit-a" };
const PHOTO_URLS = [
  "https://photos.example.com/room-1.jpg",
  "https://photos.example.com/room-2.jpg",
  "https://photos.example.com/room-3.jpg",
];

let passed = 0;
let failed = 0;

async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(error);
  }
}

async function imageBuffer(seed: number): Promise<Buffer> {
  const width = 90;
  const height = 80;
  const pixels = Buffer.alloc(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const offset = (row * width + col) * 3;
      const value = (col * (seed + 3) + row * (seed + 7) + ((col + seed) % 13) * 11) % 256;
      pixels[offset] = value;
      pixels[offset + 1] = (value * 3 + seed * 17) % 256;
      pixels[offset + 2] = (255 - value + seed * 5) % 256;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

const sourceBuffers = await Promise.all(PHOTO_URLS.map((_url, index) => imageBuffer(index + 1)));

function imageFetcher(extra: Record<string, Buffer> = {}) {
  const byUrl = new Map<string, Buffer>(PHOTO_URLS.map((url, index) => [url, sourceBuffers[index]]));
  for (const [url, buffer] of Object.entries(extra)) byUrl.set(url, buffer);
  return async (url: string) => {
    const buffer = byUrl.get(url);
    return buffer ? { buffer, contentType: "image/jpeg" } : null;
  };
}

function cleanLens() {
  return Promise.resolve({ ok: true as const, data: { visual_matches: [] } });
}

await test("normalizes and de-duplicates the exact proposed gallery", () => {
  assert.deepEqual(
    normalizeReplacementPhotoUrls([
      PHOTO_URLS[0],
      `${PHOTO_URLS[0]}#fragment`,
      "ftp://photos.example.com/no.jpg",
      "not-a-url",
      PHOTO_URLS[1],
    ]),
    PHOTO_URLS.slice(0, 2),
  );
});

let cleanVerification: ReplacementPhotoOtaVerification | null = null;
await test("checks every proposed photo and returns verified only at full coverage", async () => {
  cleanVerification = await verifyReplacementPhotoSet(
    {
      apiKey: "test-key",
      sourceUrl: SOURCE_URL,
      photoUrls: PHOTO_URLS,
      maxLensAttempts: 2,
    },
    {
      fetchImage: imageFetcher(),
      fetchLens: cleanLens,
      now: () => 1_000,
      sleep: async () => {},
      random: () => 0,
    },
  );
  assert.equal(cleanVerification.status, "verified");
  assert.equal(cleanVerification.checkedPhotos, PHOTO_URLS.length);
  assert.equal(cleanVerification.totalPhotos, PHOTO_URLS.length);
  assert.equal(cleanVerification.photos.length, PHOTO_URLS.length);
  assert.equal(cleanVerification.failures.length, 0);
});

await test("zero photos is incomplete and can never issue a safe receipt", async () => {
  const result = await verifyReplacementPhotoSet(
    { apiKey: "test-key", sourceUrl: SOURCE_URL, photoUrls: [] },
    { fetchImage: imageFetcher(), fetchLens: cleanLens },
  );
  assert.equal(result.status, "incomplete");
  assert.equal(result.checkedPhotos, 0);
  assert.throws(() => issueReplacementPhotoReceipt({ verification: result, secret: SECRET, ...RECEIPT_TARGET }));
});

await test("a provider failure retries and still requires complete coverage", async () => {
  const calls = new Map<string, number>();
  const result = await verifyReplacementPhotoSet(
    {
      apiKey: "test-key",
      sourceUrl: SOURCE_URL,
      photoUrls: PHOTO_URLS,
      maxLensAttempts: 2,
    },
    {
      fetchImage: imageFetcher(),
      fetchLens: async (photoUrl) => {
        const count = (calls.get(photoUrl) ?? 0) + 1;
        calls.set(photoUrl, count);
        if (photoUrl === PHOTO_URLS[1] && count === 1) {
          return { ok: false, error: "temporary timeout", retryable: true };
        }
        return { ok: true, data: { visual_matches: [] } };
      },
      sleep: async () => {},
      random: () => 0,
    },
  );
  assert.equal(result.status, "verified");
  assert.equal(result.checkedPhotos, PHOTO_URLS.length);
  assert.equal(result.lensCalls, PHOTO_URLS.length + 1);
});

await test("a failed photo after retries makes the whole gallery incomplete", async () => {
  const result = await verifyReplacementPhotoSet(
    {
      apiKey: "test-key",
      sourceUrl: SOURCE_URL,
      photoUrls: PHOTO_URLS,
      maxLensAttempts: 2,
    },
    {
      fetchImage: imageFetcher(),
      fetchLens: async (photoUrl) =>
        photoUrl === PHOTO_URLS[2]
          ? { ok: false, error: "provider unavailable", retryable: true }
          : { ok: true, data: { visual_matches: [] } },
      sleep: async () => {},
      random: () => 0,
    },
  );
  assert.equal(result.status, "incomplete");
  assert.equal(result.checkedPhotos, PHOTO_URLS.length - 1);
  assert.ok(result.failures.some((failure) => failure.photoUrl === PHOTO_URLS[2]));
  assert.throws(() => issueReplacementPhotoReceipt({ verification: result, secret: SECRET, ...RECEIPT_TARGET }));
});

for (const platform of [
  { label: "Airbnb", listingUrl: "https://www.airbnb.com/rooms/12345" },
  { label: "VRBO", listingUrl: "https://www.vrbo.com/12345" },
  { label: "Booking.com", listingUrl: "https://www.booking.com/hotel/us/test-unit.html" },
]) {
  await test(`identity-verified photo reuse on ${platform.label} rejects the replacement`, async () => {
    const matchImageUrl = `https://matches.example.com/${encodeURIComponent(platform.label)}.jpg`;
    const result = await verifyReplacementPhotoSet(
      {
        apiKey: "test-key",
        sourceUrl: SOURCE_URL,
        photoUrls: [PHOTO_URLS[0]],
      },
      {
        fetchImage: imageFetcher({ [matchImageUrl]: sourceBuffers[0] }),
        fetchLens: async () => ({
          ok: true,
          data: {
            visual_matches: [{
              link: platform.listingUrl,
              thumbnail: matchImageUrl,
              score: 0.99,
            }],
          },
        }),
      },
    );
    assert.equal(result.status, "matched");
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].listingUrl, platform.listingUrl);
    assert.throws(() => issueReplacementPhotoReceipt({ verification: result, secret: SECRET, ...RECEIPT_TARGET }));
  });
}

await test("an unverifiable strong OTA result blocks acceptance instead of becoming clean", async () => {
  const result = await verifyReplacementPhotoSet(
    {
      apiKey: "test-key",
      sourceUrl: SOURCE_URL,
      photoUrls: [PHOTO_URLS[0]],
    },
    {
      fetchImage: imageFetcher(),
      fetchLens: async () => ({
        ok: true,
        data: {
          visual_matches: [{
            link: "https://www.airbnb.com/rooms/99999",
            score: 0.99,
          }],
        },
      }),
    },
  );
  assert.equal(result.status, "incomplete");
  assert.equal(result.matches.length, 0);
  assert.ok(result.failures.some((failure) => failure.stage === "match-image"));
});

await test("strong OTA results beyond the identity-check budget fail closed", async () => {
  const distinctMatch = await imageBuffer(77);
  const matchImages = Object.fromEntries(
    Array.from({ length: 7 }, (_value, index) => [
      `https://matches.example.com/lookalike-${index}.jpg`,
      distinctMatch,
    ]),
  );
  const result = await verifyReplacementPhotoSet(
    {
      apiKey: "test-key",
      sourceUrl: SOURCE_URL,
      photoUrls: [PHOTO_URLS[0]],
    },
    {
      fetchImage: imageFetcher(matchImages),
      fetchLens: async () => ({
        ok: true,
        data: {
          visual_matches: Array.from({ length: 7 }, (_value, index) => ({
            link: `https://www.airbnb.com/rooms/${90000 + index}`,
            thumbnail: `https://matches.example.com/lookalike-${index}.jpg`,
            score: 0.99,
          })),
        },
      }),
    },
  );
  assert.equal(result.status, "incomplete");
  assert.ok(result.failures.some((failure) => failure.reason.includes("additional strong airbnb result")));
});

await test("signed receipt binds source URL, ordered photo list, content, policy, and expiry", () => {
  assert.ok(cleanVerification);
  const issued = issueReplacementPhotoReceipt({
    verification: cleanVerification!,
    secret: SECRET,
    ...RECEIPT_TARGET,
    now: 2_000,
    ttlMs: 10_000,
  });
  const valid = validateReplacementPhotoReceipt({
    receipt: issued.receipt,
    secret: SECRET,
    sourceUrl: SOURCE_URL,
    ...RECEIPT_TARGET,
    photoUrls: PHOTO_URLS,
    now: 5_000,
  });
  assert.equal(valid.ok, true);

  const changedSource = validateReplacementPhotoReceipt({
    receipt: issued.receipt,
    secret: SECRET,
    sourceUrl: "https://www.redfin.com/HI/Test/home/987",
    ...RECEIPT_TARGET,
    photoUrls: PHOTO_URLS,
    now: 5_000,
  });
  assert.deepEqual(changedSource.ok, false);

  const changedPhotos = validateReplacementPhotoReceipt({
    receipt: issued.receipt,
    secret: SECRET,
    sourceUrl: SOURCE_URL,
    ...RECEIPT_TARGET,
    photoUrls: PHOTO_URLS.slice(0, 2),
    now: 5_000,
  });
  assert.deepEqual(changedPhotos.ok, false);

  const changedTarget = validateReplacementPhotoReceipt({
    receipt: issued.receipt,
    secret: SECRET,
    sourceUrl: SOURCE_URL,
    propertyId: RECEIPT_TARGET.propertyId,
    targetUnitId: "unit-b",
    photoUrls: PHOTO_URLS,
    now: 5_000,
  });
  assert.deepEqual(changedTarget.ok, false);

  const expired = validateReplacementPhotoReceipt({
    receipt: issued.receipt,
    secret: SECRET,
    sourceUrl: SOURCE_URL,
    ...RECEIPT_TARGET,
    photoUrls: PHOTO_URLS,
    now: 12_001,
  });
  assert.deepEqual(expired.ok, false);
});

await test("commit-time content changes invalidate the discovery receipt", async () => {
  assert.ok(cleanVerification);
  const changed = await verifyReplacementPhotoSet(
    {
      apiKey: "test-key",
      sourceUrl: SOURCE_URL,
      photoUrls: PHOTO_URLS,
    },
    {
      fetchImage: imageFetcher({ [PHOTO_URLS[1]]: await imageBuffer(99) }),
      fetchLens: cleanLens,
    },
  );
  assert.equal(changed.status, "verified");
  assert.notEqual(
    replacementPhotoContentDigest(changed.photos),
    replacementPhotoContentDigest(cleanVerification!.photos),
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
