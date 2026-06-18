// Compact dashboard status derived from a full photo community check result.

export type BedroomBadgeTier = "pass" | "warn" | "fail" | null;

export type PhotoCommunityRowStatus = {
  propertyId: number;
  checkedAt: string | null;
  running?: boolean;
  bedroomsOk: boolean | null;
  /** Three-tier bedroom badge: pass / warn / fail. */
  bedroomsTier: BedroomBadgeTier;
  communityFolderOk: boolean | null;
  sameCommunityOk: boolean | null;
  overall: "pass" | "fail" | "warn" | "skipped" | null;
  bedroomsFound: number | null;
  bedroomsExpected: number | null;
  communityPhotosChecked: number | null;
  communityPhotosTotal: number | null;
  communityAuditComplete: boolean | null;
  summary: string | null;
  error: string | null;
};

type CheckLike = {
  verdict?: "pass" | "warn" | "fail";
  allSameCommunity?: "yes" | "no";
  community?: {
    matchesExpected?: "yes" | "no";
    allSameCommunity?: boolean;
    photosChecked?: number;
    photosTotal?: number;
  } | null;
  units?: Array<{ sameAsCommunity?: "yes" | "no" }>;
  bedroomCoverage?: {
    matchesListing?: "yes" | "no" | "n/a";
    tier?: "pass" | "warn" | "fail";
    bedroomsFoundCombined?: number;
    expectedListingBedrooms?: number | null;
    units?: Array<{ tier?: "pass" | "warn" | "fail"; matchesListing?: "yes" | "no" | "n/a" }>;
  } | null;
  summary?: string;
};

export function deriveBedroomBadgeTier(
  bedroomCoverage: CheckLike["bedroomCoverage"],
  bedroomsFound: number | null,
  bedroomsExpected: number | null,
): BedroomBadgeTier {
  if (bedroomCoverage?.tier) return bedroomCoverage.tier;
  if (bedroomsExpected != null && bedroomsExpected > 0 && bedroomsFound != null) {
    if (bedroomsFound < bedroomsExpected) return "fail";
    if (bedroomCoverage?.units?.some((u) => u.tier === "warn" || u.matchesListing === "no")) return "warn";
    return "pass";
  }
  if (bedroomCoverage?.matchesListing === "yes") return "pass";
  if (bedroomCoverage?.matchesListing === "no") return "fail";
  return null;
}

export function derivePhotoCommunityRowStatus(
  propertyId: number,
  result: CheckLike,
  checkedAt: string,
): PhotoCommunityRowStatus {
  const bedroomsExpected = result.bedroomCoverage?.expectedListingBedrooms ?? null;
  const bedroomsFound = result.bedroomCoverage?.bedroomsFoundCombined ?? null;
  const communityPhotosChecked = result.community?.photosChecked ?? null;
  const communityPhotosTotal = result.community?.photosTotal ?? null;
  const communityAuditComplete =
    communityPhotosTotal != null && communityPhotosTotal > 0
      ? (communityPhotosChecked ?? 0) >= communityPhotosTotal
      : null;

  const bedroomsTier = deriveBedroomBadgeTier(result.bedroomCoverage, bedroomsFound, bedroomsExpected);
  let bedroomsOk: boolean | null = null;
  if (bedroomsTier === "pass") bedroomsOk = true;
  else if (bedroomsTier === "fail") bedroomsOk = false;
  else if (bedroomsTier === "warn") bedroomsOk = null;

  let communityFolderOk: boolean | null = null;
  if (result.community) {
    const folderOk =
      result.community.matchesExpected === "yes"
      && result.community.allSameCommunity !== false;
    communityFolderOk = folderOk;
  } else if ((result.units?.length ?? 0) > 0) {
    communityFolderOk = false;
  }

  let sameCommunityOk: boolean | null = null;
  if (result.allSameCommunity === "yes") sameCommunityOk = true;
  else if (result.allSameCommunity === "no") sameCommunityOk = false;
  else if ((result.units?.length ?? 0) > 0) {
    const allUnitsYes = result.units!.every((u) => u.sameAsCommunity === "yes");
    const anyUnitNo = result.units!.some((u) => u.sameAsCommunity === "no");
    if (allUnitsYes) sameCommunityOk = true;
    else if (anyUnitNo) sameCommunityOk = false;
  }

  const checks = [
    bedroomsTier === "pass" ? true : bedroomsTier === "fail" ? false : null,
    communityFolderOk,
    sameCommunityOk,
  ].filter((v) => v !== null);
  let overall: PhotoCommunityRowStatus["overall"] = null;
  if (checks.length > 0) {
    if (bedroomsTier === "fail" || checks.some((v) => v === false)) overall = "fail";
    else if (bedroomsTier === "warn" || result.verdict === "warn") overall = "warn";
    else if (checks.every((v) => v === true)) overall = "pass";
    else overall = result.verdict ?? null;
  }

  return {
    propertyId,
    checkedAt,
    bedroomsOk,
    bedroomsTier,
    communityFolderOk,
    sameCommunityOk,
    overall,
    bedroomsFound,
    bedroomsExpected,
    communityPhotosChecked,
    communityPhotosTotal,
    communityAuditComplete,
    summary: result.summary?.trim() || null,
    error: null,
  };
}

export function photoCommunityStatusLabel(status: PhotoCommunityRowStatus): string {
  if (
    status.bedroomsTier === "pass"
    && status.communityFolderOk === true
    && status.sameCommunityOk === true
  ) {
    return "All photo community checks passed";
  }
  const parts: string[] = [];
  if (status.bedroomsTier === "fail") {
    parts.push(`Bedrooms ${status.bedroomsFound ?? "?"}/${status.bedroomsExpected ?? "?"} ✗`);
  } else if (status.bedroomsTier === "warn" && status.bedroomsExpected) {
    parts.push(`Bedrooms ${status.bedroomsFound}/${status.bedroomsExpected} ⚠`);
  } else if (status.bedroomsTier === "pass" && status.bedroomsExpected) {
    parts.push(`Bedrooms ${status.bedroomsFound}/${status.bedroomsExpected} ✓`);
  }
  if (status.communityFolderOk === false) {
    const cov = status.communityPhotosChecked != null && status.communityPhotosTotal != null
      ? ` (${status.communityPhotosChecked}/${status.communityPhotosTotal})`
      : "";
    parts.push(`Community folder${cov} ✗`);
  } else if (status.communityFolderOk === true && status.communityPhotosChecked != null && status.communityPhotosTotal != null) {
    parts.push(`Community folder ${status.communityPhotosChecked}/${status.communityPhotosTotal} ✓`);
  }
  if (status.sameCommunityOk === false) parts.push("Same community ✗");
  if (parts.length === 0 && status.overall === "pass") return "All photo community checks passed";
  return parts.join(" · ") || status.summary || "Not checked";
}
