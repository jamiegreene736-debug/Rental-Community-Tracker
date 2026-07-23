import { randomBytes } from "node:crypto";

const PHOTO_PERSIST_PROOF_TTL_MS = 10 * 60_000;
const photoPersistProofs = new Map<string, {
  sourceUrl: string;
  photoUrls: string[];
  expiresAt: number;
}>();

export function issuePhotoPersistProof(
  sourceUrl: string,
  photoUrls: readonly string[],
  now: number = Date.now(),
): string {
  for (const [token, proof] of Array.from(photoPersistProofs.entries())) {
    if (proof.expiresAt <= now) photoPersistProofs.delete(token);
  }
  const token = randomBytes(24).toString("base64url");
  photoPersistProofs.set(token, {
    sourceUrl,
    photoUrls: photoUrls
      .filter((url) => /^https?:\/\//i.test(url))
      .slice(0, 120),
    expiresAt: now + PHOTO_PERSIST_PROOF_TTL_MS,
  });
  return token;
}

/** One-time bridge from a server-proved hunt gallery into its loopback persist. */
export function consumePhotoPersistProof(
  token: string,
  sourceUrl: string,
  now: number = Date.now(),
): string[] {
  const proof = photoPersistProofs.get(token);
  if (!proof) return [];
  photoPersistProofs.delete(token);
  if (proof.expiresAt <= now || proof.sourceUrl !== sourceUrl) return [];
  return proof.photoUrls;
}
