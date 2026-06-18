// Compact dashboard status derived from a full photo community check result.

export type PhotoCommunityRowStatus = {
  propertyId: number;
  checkedAt: string | null;
  running?: boolean;
  bedroomsOk: boolean | null;
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
    bedroomsFoundCombined?: number;
    expectedListingBedrooms?: number | null;
  } | null;
  summary?: string;
};

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

  let bedroomsOk: boolean | null = null;
  if (result.bedroomCoverage?.matchesListing === "yes") bedroomsOk = true;
  else if (result.bedroomCoverage?.matchesListing === "no") bedroomsOk = false;
  else if (bedroomsExpected != null && bedroomsExpected > 0 && bedroomsFound != null) {
    bedroomsOk = bedroomsFound >= bedroomsExpected;
  }

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

  const checks = [bedroomsOk, communityFolderOk, sameCommunityOk].filter((v) => v !== null);
  let overall: PhotoCommunityRowStatus["overall"] = null;
  if (checks.length > 0) {
    if (checks.every((v) => v === true)) overall = result.verdict === "warn" ? "warn" : "pass";
    else if (checks.some((v) => v === false)) overall = "fail";
    else overall = result.verdict ?? null;
  }

  return {
    propertyId,
    checkedAt,
    bedroomsOk,
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
    status.bedroomsOk === true
    && status.communityFolderOk === true
    && status.sameCommunityOk === true
  ) {
    return "All photo community checks passed";
  }
  const parts: string[] = [];
  if (status.bedroomsOk === false) {
    parts.push(`Bedrooms ${status.bedroomsFound ?? "?"}/${status.bedroomsExpected ?? "?"} ✗`);
  } else if (status.bedroomsOk === true && status.bedroomsExpected) {
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