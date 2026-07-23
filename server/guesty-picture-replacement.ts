export type GuestyPictureForReplacement = {
  original: string;
  caption: string;
};

export type NormalizedGuestyPicture = {
  original: string;
  caption: string;
};

export type GuestyPictureReplacementVerification = {
  confirmed: boolean;
  expectedTotal: number;
  observedTotal: number | null;
  observedPictures: unknown[] | null;
  readAttempts: number;
  replaceAttempts: number;
  lastReadError: string | null;
  lastReplaceError: string | null;
};

type ReplaceAndVerifyOptions = {
  pictures: GuestyPictureForReplacement[];
  replace: (pictures: GuestyPictureForReplacement[]) => Promise<unknown>;
  read: () => Promise<unknown>;
  waitsMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  onVerify?: (event: {
    attempt: number;
    expected: number;
    got: number | null;
    exactMatch: boolean;
    error: string | null;
  }) => void;
  onRetry?: (event: { attempt: number; expected: number; error: string | null }) => void;
};

export function normalizeGuestyPictureForVerification(raw: unknown): NormalizedGuestyPicture | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const picture = raw as Record<string, unknown>;
  const originalRaw = String(picture.original ?? picture.url ?? "").trim();
  if (!originalRaw) return null;

  let original = originalRaw;
  try {
    const parsed = new URL(originalRaw);
    parsed.hash = "";
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    original = parsed.toString();
  } catch {
    // Local/non-standard URLs compare by their trimmed spelling.
  }

  return {
    original,
    caption: String(picture.caption ?? "").trim().replace(/\s+/g, " "),
  };
}

/**
 * Exact ordered identity check for a whole Guesty gallery. A count match alone
 * cannot prove that hidden/replaced photos were removed.
 */
export function guestyPicturesExactlyMatch(actualRaw: unknown, expectedRaw: unknown): boolean {
  if (!Array.isArray(actualRaw) || !Array.isArray(expectedRaw)) return false;
  const actual = actualRaw
    .map(normalizeGuestyPictureForVerification)
    .filter((picture): picture is NormalizedGuestyPicture => picture !== null);
  const expected = expectedRaw
    .map(normalizeGuestyPictureForVerification)
    .filter((picture): picture is NormalizedGuestyPicture => picture !== null);

  if (
    actual.length !== actualRaw.length
    || expected.length !== expectedRaw.length
    || actual.length !== expected.length
  ) {
    return false;
  }

  return actual.every((picture, index) =>
    picture.original === expected[index].original
    && picture.caption === expected[index].caption);
}

/**
 * Replace the complete pictures[] array and prove the exact ordered read-back.
 * Only the first two mismatches trigger corrective PUTs; the last attempt is a
 * read, so this function never returns immediately after an unverified write.
 */
export async function replaceGuestyPicturesAndVerify(
  options: ReplaceAndVerifyOptions,
): Promise<GuestyPictureReplacementVerification> {
  const expected = options.pictures.map((picture) => ({
    original: String(picture.original ?? "").trim(),
    caption: String(picture.caption ?? ""),
  }));
  if (
    expected.length === 0
    || expected.some((picture) => !normalizeGuestyPictureForVerification(picture))
  ) {
    throw new Error("A non-empty gallery with valid picture URLs is required.");
  }

  const waitsMs = options.waitsMs?.length ? options.waitsMs : [3_000, 6_000, 10_000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let replaceAttempts = 1;
  await options.replace(expected);

  let observedPictures: unknown[] | null = null;
  let observedTotal: number | null = null;
  let lastReadError: string | null = null;
  let lastReplaceError: string | null = null;

  for (let index = 0; index < waitsMs.length; index++) {
    await sleep(waitsMs[index]);
    const attempt = index + 1;

    try {
      const raw = await options.read();
      const pictures = Array.isArray(raw)
        ? raw
        : (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pictures))
          ? (raw as { pictures: unknown[] }).pictures
          : null;
      if (!pictures) throw new Error("Guesty listing response omitted pictures[].");

      observedPictures = pictures;
      observedTotal = pictures.length;
      lastReadError = null;
      const exactMatch = guestyPicturesExactlyMatch(pictures, expected);
      options.onVerify?.({
        attempt,
        expected: expected.length,
        got: observedTotal,
        exactMatch,
        error: null,
      });
      if (exactMatch) {
        return {
          confirmed: true,
          expectedTotal: expected.length,
          observedTotal,
          observedPictures,
          readAttempts: attempt,
          replaceAttempts,
          lastReadError: null,
          lastReplaceError,
        };
      }
    } catch (error) {
      lastReadError = error instanceof Error ? error.message : String(error);
      options.onVerify?.({
        attempt,
        expected: expected.length,
        got: null,
        exactMatch: false,
        error: lastReadError,
      });
    }

    if (index < waitsMs.length - 1 && observedPictures !== null) {
      replaceAttempts++;
      try {
        await options.replace(expected);
        lastReplaceError = null;
        options.onRetry?.({ attempt, expected: expected.length, error: null });
      } catch (error) {
        // A transient corrective PUT failure must not make the function return
        // immediately after an unverified write attempt. Keep the remaining
        // read slots; the original PUT may still become visible.
        lastReplaceError = error instanceof Error ? error.message : String(error);
        options.onRetry?.({ attempt, expected: expected.length, error: lastReplaceError });
      }
    }
  }

  return {
    confirmed: false,
    expectedTotal: expected.length,
    observedTotal,
    observedPictures,
    readAttempts: waitsMs.length,
    replaceAttempts,
    lastReadError,
    lastReplaceError,
  };
}
