type ZillowPhotoVariant = {
  url: string;
  score: number;
  position: number;
};

function zillowPhotoVariantScore(url: string): number {
  const sizeMatch = url.match(/_(?:cc_ft_|uncropped_scaled_within_)?(\d{3,4})\.(?:jpe?g|png|webp)(?:[?#]|$)/i);
  if (sizeMatch) return Number.parseInt(sizeMatch[1], 10);
  if (/-p_h\./i.test(url)) return 1200;
  if (/-p_f\./i.test(url)) return 1024;
  if (/-p_e\./i.test(url)) return 800;
  if (/-p_d\./i.test(url)) return 600;
  if (/-p_c\./i.test(url)) return 400;
  return 0;
}

/**
 * Collapse Zillow CDN size/format variants without changing gallery order.
 * The first occurrence owns the position; a later, larger rendering replaces
 * only that URL. Non-Zillow URLs are de-duplicated by their queryless URL.
 */
export function dedupeZillowPhotoVariants(urls: readonly string[]): string[] {
  const variants = new Map<string, ZillowPhotoVariant>();

  for (let position = 0; position < urls.length; position += 1) {
    const url = String(urls[position] ?? "").trim();
    if (!/^https?:\/\//i.test(url)) continue;

    const queryless = url.replace(/[?#].*$/, "");
    let zillowHash: string | undefined;
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      const isZillowCdn = hostname === "zillowstatic.com" || hostname.endsWith(".zillowstatic.com");
      zillowHash = isZillowCdn
        ? parsed.pathname.match(/\/fp\/([a-f0-9]{16,})-/i)?.[1]?.toLowerCase()
        : undefined;
    } catch {
      // Keep malformed candidates isolated under their queryless URL key.
    }
    const key = zillowHash
      ? `zillow-fp:${zillowHash}`
      : `url:${queryless.toLowerCase()}`;
    const score = zillowPhotoVariantScore(url);
    const existing = variants.get(key);

    if (!existing) {
      variants.set(key, { url, score, position });
    } else if (score > existing.score) {
      variants.set(key, { url, score, position: existing.position });
    }
  }

  return Array.from(variants.values())
    .sort((left, right) => left.position - right.position)
    .map((variant) => variant.url);
}
