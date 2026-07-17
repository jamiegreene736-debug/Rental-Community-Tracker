// Pure decision seam for the automatic unit-replacement staging gate.
//
// A replacement candidate is disposable until its staged gallery passes the
// same full photo-community audit used by builder pre-flight. Positive
// contradictions reject (and therefore burn) the candidate. Community, unit,
// and reliable bedroom evidence must be positive. Source-page evidence is a
// veto only: missing/unreadable/uncertain source pages do not block an
// otherwise-positive visual audit, while a strong source contradiction burns.

import { communityIsRealMismatch, isComboPhotoGateInfraWarning } from "./combo-photo-community-gate";
import { isStrongContradiction } from "./photo-community-check-logic";
import { sourcePageIsStrongContradiction, type SourcePageVerdict } from "./source-page-community-logic";

export type StagedCommunityAuditUnit = {
  label: string;
  folder: string;
  sameAsCommunity: "yes" | "no";
  reason?: string;
  photoVerdicts?: Array<{ match?: "yes" | "no" | "uncertain"; reason?: string }>;
};

export type StagedBedroomAuditUnit = {
  label: string;
  folder?: string;
  matchesListing: "yes" | "no" | "n/a";
  bedroomsFound?: number;
  expectedBedrooms?: number | null;
  reason?: string;
};

export type StagedUnitCommunityAudit = {
  ok?: boolean;
  warning?: string | null;
  allSameCommunity?: "yes" | "no";
  community: {
    matchesExpected: "yes" | "no";
    overallStatus?: string;
    identifiedCommunity?: string;
  } | null;
  units: StagedCommunityAuditUnit[];
  bedroomCoverage: {
    matchesListing?: "yes" | "no" | "n/a";
    units: StagedBedroomAuditUnit[];
  } | null;
  sourcePages?: SourcePageVerdict[];
};

export type StagedUnitCommunityGateDecision = {
  decision: "accept" | "reject" | "inconclusive";
  /** Only a positive, candidate-specific contradiction is safe to burn. */
  burnCandidate: boolean;
  reasonCode: "verified" | "community-mismatch" | "bedroom-coverage" | "inconclusive";
  reason: string;
};

function targetUnitFor(
  units: StagedCommunityAuditUnit[],
  targetFolder: string,
): StagedCommunityAuditUnit | null {
  return units.find((unit) => unit.folder === targetFolder)
    ?? (units.length === 1 ? units[0] : null);
}

function targetBedroomUnitFor(
  units: StagedBedroomAuditUnit[],
  target: StagedCommunityAuditUnit,
  targetFolder: string,
): StagedBedroomAuditUnit | null {
  return units.find((unit) => unit.folder === targetFolder)
    ?? units.find((unit) => unit.label === target.label)
    ?? (units.length === 1 ? units[0] : null);
}

/**
 * Classify a full staged audit for one replacement gallery.
 *
 * `reject` is candidate-specific and safe to burn. `inconclusive` means the
 * caller must retry the audit or surface the infrastructure gap; it is never a
 * successful match. Bedroom evidence is trusted only after photo labels are
 * ready, matching the existing pre-flight reliability contract. Source-page
 * evidence is deliberately asymmetric: a strong contradiction rejects, while
 * missing/unreadable/uncertain source data neither proves nor blocks the unit.
 */
export function classifyStagedUnitCommunityAudit(
  audit: StagedUnitCommunityAudit,
  options: { targetFolder: string; bedroomCoverageReliable?: boolean },
): StagedUnitCommunityGateDecision {
  const targetFolder = options.targetFolder.trim();
  const target = targetUnitFor(audit.units ?? [], targetFolder);

  if (communityIsRealMismatch(audit.community)) {
    return {
      decision: "reject",
      burnCandidate: true,
      reasonCode: "community-mismatch",
      reason: `Community gallery positively mismatches${audit.community?.identifiedCommunity ? ` (${audit.community.identifiedCommunity})` : ""}.`,
    };
  }

  if (target?.sameAsCommunity === "no") {
    const positivePhotoMismatch = (target.photoVerdicts ?? []).some((photo) => photo.match === "no");
    if (positivePhotoMismatch || isStrongContradiction(target.reason ?? "")) {
      return {
        decision: "reject",
        burnCandidate: true,
        reasonCode: "community-mismatch",
        reason: `${target.label} positively mismatches the community: ${target.reason || "a staged photo was identified as a different community"}.`,
      };
    }
  }

  const targetSources = (audit.sourcePages ?? []).filter((source) => !target || source.unitLabel === target.label);
  const sourceMismatch = targetSources.find((source) => sourcePageIsStrongContradiction(source));
  if (sourceMismatch) {
    const identified = sourceMismatch.identifiedCommunity || sourceMismatch.identifiedLocation || "a different community";
    return {
      decision: "reject",
      burnCandidate: true,
      reasonCode: "community-mismatch",
      reason: `${sourceMismatch.unitLabel}'s source page positively identifies ${identified}.`,
    };
  }

  const bedroomTarget = target && audit.bedroomCoverage
    ? targetBedroomUnitFor(audit.bedroomCoverage.units ?? [], target, targetFolder)
    : null;
  if (options.bedroomCoverageReliable !== false && bedroomTarget?.matchesListing === "no") {
    const count = bedroomTarget.expectedBedrooms != null
      ? ` (${bedroomTarget.bedroomsFound ?? 0}/${bedroomTarget.expectedBedrooms})`
      : "";
    return {
      decision: "reject",
      burnCandidate: true,
      reasonCode: "bedroom-coverage",
      reason: `${bedroomTarget.label}'s staged gallery fails bedroom coverage${count}: ${bedroomTarget.reason || "not every claimed bedroom is photographed"}.`,
    };
  }

  const infrastructureWarning = isComboPhotoGateInfraWarning(audit.warning);
  const communityConfirmed = audit.community?.matchesExpected === "yes"
    && audit.community.overallStatus !== "unconfirmed"
    && audit.community.overallStatus !== "likely"
    && audit.allSameCommunity !== "no";
  const unitConfirmed = target?.sameAsCommunity === "yes";
  const bedroomsConfirmed = options.bedroomCoverageReliable !== false
    && bedroomTarget?.matchesListing === "yes";

  if (
    !infrastructureWarning
    && !audit.warning
    && audit.ok !== false
    && communityConfirmed
    && unitConfirmed
    && bedroomsConfirmed
  ) {
    return {
      decision: "accept",
      burnCandidate: false,
      reasonCode: "verified",
      reason: `${target?.label ?? "Staged unit"} passed community identity and bedroom coverage.`,
    };
  }

  const missing = [
    infrastructureWarning || audit.warning ? `audit warning: ${audit.warning}` : null,
    !communityConfirmed ? "community identity was not positively verified" : null,
    !target ? "the staged unit was absent from the audit result" : null,
    target && !unitConfirmed ? "the staged unit was not positively matched" : null,
    options.bedroomCoverageReliable === false ? "bedroom labels were not ready" : null,
    options.bedroomCoverageReliable !== false && !bedroomTarget ? "the staged unit had no bedroom-coverage result" : null,
    bedroomTarget && !bedroomsConfirmed ? "bedroom coverage was not positively verified" : null,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    decision: "inconclusive",
    burnCandidate: false,
    reasonCode: "inconclusive",
    reason: missing.join("; ") || "The staged audit did not produce a complete positive verdict.",
  };
}
