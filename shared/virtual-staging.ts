/**
 * Provider-neutral guardrails shared by every virtual-staging image backend.
 * Scene-specific instructions are appended by buildVirtualStagingPrompt.
 */
export const VIRTUAL_STAGING_RECIPE_VERSION = "context-aware-furnishings-v2";
export const VIRTUAL_STAGING_RECIPE_SIGNATURE_PREFIX = "virtual-staging-recipe::";

export function virtualStagingRecipeSignature(): string {
  return `${VIRTUAL_STAGING_RECIPE_SIGNATURE_PREFIX}${VIRTUAL_STAGING_RECIPE_VERSION}`;
}

export const VIRTUAL_STAGING_PROMPT =
  "Use the uploaded photograph as the exact base image and perform a restrained virtual furniture replacement only. " +
  "First inspect the photograph to identify the actual room, the function of each movable furnishing, and the existing design language. " +
  "The visible photograph is authoritative; if any supplied scene hint conflicts with what is visibly shown, follow the photograph. " +
  "Preserve the property's established regional and stylistic character rather than restyling it. " +
  "If the existing furniture or decor has a Hawaiian, tropical, island, coastal, or resort character, every replacement must retain that character; do not normalize it into generic neutral contemporary decor. " +
  "For example, replace a Hawaiian-style sofa only with another tasteful Hawaiian-style sofa, never a generic urban sofa. " +
  "Replace each movable item only with the same functional furniture type and approximately the same scale, footprint, orientation, seating or sleeping capacity, and placement: sofa with sofa, sectional with sectional, dining set with dining set, bed with the same bed type, and outdoor lounge or dining furniture with the corresponding outdoor furniture. " +
  "Never substitute indoor furniture for outdoor furniture or outdoor furniture for indoor furniture. " +
  "Regardless of metadata, furniture visibly located outdoors must be replaced only with weather-resistant outdoor furniture, and furniture visibly located indoors must be replaced only with indoor furniture. " +
  "Preserve the condo's permanent architecture and photographic geometry: walls, ceilings, floors, windows, doors, trim, columns, room dimensions, kitchen cabinets, countertops, appliances, built-ins, permanent fixtures, balcony, exterior view, camera position, lens perspective, crop, and ambient lighting. " +
  "Remove or replace only movable furniture, rugs, lamps, artwork, plants, and decorative accessories. " +
  "If no suitable movable furnishing is visible, make no changes. " +
  "Make replacements photorealistic and correctly scaled, with physically plausible shadows. " +
  "Do not move openings, redesign finishes, enlarge the room, straighten the perspective, change the exterior view, add people, or add text, logos, or watermarks. " +
  "If the photograph is primarily a beach, ocean or landscape view, building exterior, pool or shared amenity, map, logo, or floor plan rather than a furnished private room or private patio, balcony, deck, or lanai, make no changes.";

export type VirtualStagingScene =
  | "living-area"
  | "bedroom"
  | "kitchen"
  | "bathroom"
  | "dining"
  | "private-outdoor";

export type VirtualStagingContext =
  | { scene: Exclude<VirtualStagingScene, "private-outdoor">; placement: "indoor" }
  | { scene: "private-outdoor"; placement: "outdoor" };

const SCENE_DESCRIPTION: Record<VirtualStagingScene, string> = {
  "living-area": "an indoor living area",
  bedroom: "an indoor bedroom",
  kitchen: "an indoor kitchen",
  bathroom: "an indoor bathroom",
  dining: "an indoor dining area",
  "private-outdoor": "a private outdoor patio, balcony, deck, or lanai",
};

export function buildVirtualStagingPrompt(context: VirtualStagingContext): string {
  const sceneInstruction = context.placement === "outdoor"
    ? "The metadata indicates a private outdoor patio, balcony, deck, or lanai. When the photograph confirms an outdoor setting, use only weather-resistant, outdoor-rated furniture and outdoor-appropriate accessories. Never add an indoor sofa, bed, indoor rug, or other indoor-only furnishing."
    : `The metadata indicates ${SCENE_DESCRIPTION[context.scene]}. When the photograph confirms an indoor setting, use only interior furniture appropriate for that room's actual function; never introduce patio, deck, or pool furniture indoors. If outdoor furniture is visible beyond an opening, keep it outdoor-rated and do not move it inside.`;
  return `${VIRTUAL_STAGING_PROMPT} ${sceneInstruction}`;
}

export type VirtualStagingJobStatus =
  | "queued"
  | "running"
  | "ready"
  | "confirmed"
  | "failed";

export type VirtualStagingCandidateStatus =
  | "pending"
  | "generating"
  | "succeeded"
  | "failed";

export type VirtualStagingCandidateDto = {
  id: string;
  originalFilename: string;
  originalUrl: string;
  roomLabel: string;
  stagedUrl: string | null;
  status: VirtualStagingCandidateStatus;
  error: string | null;
  attempt: number;
};

export type VirtualStagingJobDto = {
  id: string;
  propertyId: number;
  unitId: string;
  unitLabel: string;
  status: VirtualStagingJobStatus;
  total: number;
  completed: number;
  failed: number;
  selectedCount: number;
  candidates: VirtualStagingCandidateDto[];
  createdAt: string;
  updatedAt: string;
};

export type VirtualStagingSessionAction = "start" | "resume" | "blocked";

/**
 * Decide whether a unit control starts a new paid run, resumes the retained
 * review session, or stays blocked behind another unit's unconfirmed session.
 */
export function virtualStagingSessionAction(input: {
  requestedUnitId: string;
  sessionUnitId: string | null;
  hasResumableSession: boolean;
}): VirtualStagingSessionAction {
  if (!input.hasResumableSession) return "start";
  return input.requestedUnitId === input.sessionUnitId ? "resume" : "blocked";
}

export type VirtualStagingLabelSnapshot = {
  filename: string;
  label: string;
  category: string | null;
  confidence: number | null;
  userLabel: string | null;
  userCategory: string | null;
  hidden: boolean;
  sortOrder: number | null;
  model: string | null;
  perceptualHash: string | null;
  bedroomClusterId: string | null;
  bedroomBedType: string | null;
  channelUsage: string | null;
};

export type VirtualStagingVariantSnapshot = {
  originalFilename: string;
  candidateFilename: string;
  active: boolean;
};

export type ScopedVirtualStagingVariant = VirtualStagingVariantSnapshot & {
  propertyId: number;
  unitId: string;
  folder: string;
};

export type VirtualStagingSource = {
  originalFilename: string;
  activeFilename: string;
  roomLabel: string;
  metadata: VirtualStagingLabelSnapshot | null;
};

export type PlannedVirtualStagingSource = VirtualStagingSource & {
  stagingContext: VirtualStagingContext;
};

type VirtualStagingContextSource = Pick<
  VirtualStagingSource,
  "originalFilename" | "roomLabel"
> & {
  metadata: Pick<
    VirtualStagingLabelSnapshot,
    "label" | "category" | "userLabel" | "userCategory"
  > | null;
};

const IMAGE_FILE_RE = /\.(?:jpe?g|png|webp)$/i;
export const VIRTUAL_STAGING_CANDIDATE_FILENAME_RE = /^virtual-staged-[0-9a-f-]{36}\.jpg$/i;

const CATEGORY_SCENE = new Map<string, VirtualStagingScene>([
  ["living", "living-area"],
  ["living area", "living-area"],
  ["living areas", "living-area"],
  ["living room", "living-area"],
  ["living rooms", "living-area"],
  ["great room", "living-area"],
  ["family room", "living-area"],
  ["lounge", "living-area"],
  ["den", "living-area"],
  ["sitting room", "living-area"],
  ["bedroom", "bedroom"],
  ["bedrooms", "bedroom"],
  ["bed room", "bedroom"],
  ["bed rooms", "bedroom"],
  ["kitchen", "kitchen"],
  ["kitchens", "kitchen"],
  ["bathroom", "bathroom"],
  ["bathrooms", "bathroom"],
  ["bath", "bathroom"],
  ["baths", "bathroom"],
  ["dining", "dining"],
  ["dining area", "dining"],
  ["dining room", "dining"],
  ["outdoor and lanai", "private-outdoor"],
  ["outdoor lanai", "private-outdoor"],
  ["private outdoor", "private-outdoor"],
  ["patio", "private-outdoor"],
  ["balcony", "private-outdoor"],
  ["deck", "private-outdoor"],
  ["lanai", "private-outdoor"],
  ["terrace", "private-outdoor"],
  ["veranda", "private-outdoor"],
  ["porch", "private-outdoor"],
]);

const NON_STAGEABLE_CATEGORIES = new Set([
  "view",
  "views",
  "building exterior",
  "building exteriors",
  "reject",
  "rejected",
  "other",
  "amenity",
  "amenities",
  "pool and spa",
  "pool spa",
  "beach access",
  "grounds and landscaping",
  "grounds landscaping",
  "common area",
  "common areas",
  "activity",
  "activities",
]);

const PRIVATE_OUTDOOR_SPACE_RE = /\b(?:lanai|patio|balcony|deck|terrace|veranda|porch)\b/i;
const PRIVATE_OUTDOOR_USE_RE =
  /\b(?:covered|private|spacious|tropical|oceanfront|garden|seating|furnish(?:ed|ings?)?|dining|lounge|sofa|couch|chair|table|daybed|lounger|outdoor)\b/i;
const PURE_OUTDOOR_VIEW_RE =
  /\b(?:view|sunset|sunrise) from (?:the )?(?:lanai|patio|balcony|deck|terrace|veranda|porch)\b|^(?:ocean|garden|mountain|sunset|sunrise)?\s*(?:lanai|patio|balcony|deck|terrace|veranda|porch) view\b/i;
const OBVIOUS_SHARED_OR_SCENIC_RE =
  /\b(?:(?:community|shared) (?:pool|spa|amenit(?:y|ies)|grounds|area|lounge|dining)|resort (?:pool|spa|grounds|amenit(?:y|ies)|lobby|restaurant|clubhouse|fitness|gym)|(?:pool|spa) deck|poolside (?:seating|lounge|dining|chairs?)|beach (?:access|path|cove|shore|scene|view)|aerial|drone|building exterior|map|logo|tennis court|golf course|parking lot)\b/i;
const PURE_SCENIC_ASSET_RE =
  /^(?:ocean(?:front)? (?:view|vista|sunset|sunrise|panorama)|mountain (?:view|vista)|garden view|coast(?:line|al view|al panorama)|beach(?: view| scene)?|sunset|sunrise|landscape(?: view)?|pool with ocean backdrop)$/i;
const FLOOR_PLAN_ASSET_RE = /^(?:unit )?floor ?plan(?: diagram| layout| graphic)?$/i;

function normalizeVirtualStagingCategory(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function virtualStagingContext(scene: VirtualStagingScene): VirtualStagingContext {
  return scene === "private-outdoor"
    ? { scene, placement: "outdoor" }
    : { scene, placement: "indoor" };
}

function labelDescribesUsablePrivateOutdoorSpace(text: string): boolean {
  if (PURE_OUTDOOR_VIEW_RE.test(text)) return false;
  return (
    PRIVATE_OUTDOOR_SPACE_RE.test(text)
      && PRIVATE_OUTDOOR_USE_RE.test(text)
  )
    || /\boutdoor (?:living|dining|lounge|seating|sofa|sectional|table|chairs?|furniture)\b/i.test(text)
    || /\bbedroom(?: suite)? lanai\b/i.test(text);
}

function inferVirtualStagingScene(text: string): VirtualStagingScene | null {
  const value = text.toLowerCase();
  if (labelDescribesUsablePrivateOutdoorSpace(value)) {
    return "private-outdoor";
  }
  if (/\b(?:bath(?:room)?|shower|toilet|vanity|tub|powder room)\b/.test(value)) return "bathroom";
  if (/\b(?:bed ?room|king bed|queen bed|twin beds?|bunk beds?|murphy bed)\b/.test(value)) return "bedroom";
  if (/\b(?:kitchen|kitchenette)\b/.test(value)) return "kitchen";
  if (/\b(?:dining room|dining area|dining table|breakfast nook)\b/.test(value)) return "dining";
  if (/\b(?:living room|living area|great room|family room|sitting room|indoor lounge|sofa|sectional|couch)\b/.test(value)) {
    return "living-area";
  }
  return null;
}

function labelExplicitlyDescribesScene(text: string, scene: VirtualStagingScene): boolean {
  switch (scene) {
    case "living-area":
      return /\b(?:living room|living area|great room|family room|sitting room|sofa|sectional|couch)\b/i.test(text);
    case "bedroom":
      return /\b(?:bed ?room|king bed|queen bed|twin beds?|bunk beds?|murphy bed)\b/i.test(text);
    case "kitchen":
      return /\b(?:kitchen|kitchenette)\b/i.test(text);
    case "bathroom":
      return /\b(?:bath(?:room)?|shower|toilet|vanity|tub|powder room)\b/i.test(text);
    case "dining":
      return /\b(?:dining room|dining area|dining table|breakfast nook)\b/i.test(text);
    case "private-outdoor":
      return PRIVATE_OUTDOOR_SPACE_RE.test(text) || /\bprivate outdoor\b/i.test(text);
  }
}

/**
 * Classify a visible unit photo without another model call. Human category
 * overrides win, canonical room categories remain authoritative even when a
 * label mentions an ocean view, and ambiguous/scenic photos fail closed.
 */
export function virtualStagingContextForSource(
  source: VirtualStagingContextSource,
): VirtualStagingContext | null {
  const metadata = source.metadata;
  const category = normalizeVirtualStagingCategory(
    metadata?.userCategory?.trim() || metadata?.category,
  );
  const effectiveLabel =
    metadata?.userLabel?.trim()
    || metadata?.label?.trim()
    || source.roomLabel.trim()
    || source.originalFilename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");

  const categoryScene = CATEGORY_SCENE.get(category);
  if (categoryScene) {
    const humanCategoryOverride = Boolean(metadata?.userCategory?.trim());
    if (
      !humanCategoryOverride
      && categoryScene === "private-outdoor"
      && PURE_OUTDOOR_VIEW_RE.test(effectiveLabel)
    ) {
      return null;
    }
    if (
      !humanCategoryOverride
      && (
        OBVIOUS_SHARED_OR_SCENIC_RE.test(effectiveLabel)
        || PURE_SCENIC_ASSET_RE.test(effectiveLabel.trim())
        || FLOOR_PLAN_ASSET_RE.test(effectiveLabel.trim())
      )
      && !labelExplicitlyDescribesScene(effectiveLabel, categoryScene)
    ) {
      return null;
    }
    if (
      !humanCategoryOverride
      && categoryScene !== "private-outdoor"
      && labelDescribesUsablePrivateOutdoorSpace(effectiveLabel)
    ) {
      return virtualStagingContext("private-outdoor");
    }
    return virtualStagingContext(categoryScene);
  }
  if (NON_STAGEABLE_CATEGORIES.has(category)) return null;

  // Legacy "Exterior" mixed private lanais and patios with beaches, views,
  // and building shots. Only a label that describes a usable furnished space
  // can rescue it; "Balcony View" or "Sunset From Lanai" remains excluded.
  if (category === "exterior") {
    return labelDescribesUsablePrivateOutdoorSpace(effectiveLabel)
      ? virtualStagingContext("private-outdoor")
      : null;
  }

  // Older/manual rows sometimes use a generic Interior category or no
  // category. Require an explicit room/furnishing signal instead of spending
  // an image edit on an unknown photo.
  if (category === "interior" || category === "" || !metadata?.category) {
    const inferred = inferVirtualStagingScene(effectiveLabel);
    return inferred ? virtualStagingContext(inferred) : null;
  }
  return null;
}

export function isVirtualStagingCandidateFilename(filename: string): boolean {
  return VIRTUAL_STAGING_CANDIDATE_FILENAME_RE.test(filename);
}

/**
 * Project one physical folder into a unit-scoped active gallery. Some legacy
 * listings intentionally share a source folder across units and properties,
 * so photo_labels.hidden cannot safely decide which original or staged variant
 * is active. Generated files are excluded globally, then only this unit's
 * active candidate replaces its own immutable original in-place.
 */
export function resolveScopedVirtualStagingGallery(input: {
  diskFilenames: readonly string[];
  variants: readonly ScopedVirtualStagingVariant[];
  propertyId: number;
  unitId: string;
  folder: string;
}): string[] {
  const disk = new Set(input.diskFilenames);
  const activeByOriginal = new Map(
    input.variants
      .filter((variant) =>
        variant.active
        && variant.propertyId === input.propertyId
        && variant.unitId === input.unitId
        && variant.folder === input.folder
        && disk.has(variant.candidateFilename),
      )
      .map((variant) => [variant.originalFilename, variant.candidateFilename]),
  );

  return input.diskFilenames
    .filter((filename) => !isVirtualStagingCandidateFilename(filename))
    .map((filename) => activeByOriginal.get(filename) ?? filename);
}

/**
 * Resolve the visible unit gallery to immutable source files. Generated
 * candidates are never allowed to become a future image-edit input.
 */
export type ResolveVirtualStagingSourcesInput = {
  diskFilenames: readonly string[];
  labels: readonly VirtualStagingLabelSnapshot[];
  variants: readonly VirtualStagingVariantSnapshot[];
};

export function resolveVirtualStagingSources(
  input: ResolveVirtualStagingSourcesInput,
): VirtualStagingSource[] {
  const labelByFilename = new Map(input.labels.map((row) => [row.filename, row]));
  const candidateFilenames = new Set(input.variants.map((row) => row.candidateFilename));
  const activeByOriginal = new Map(
    input.variants
      .filter((row) => row.active)
      .map((row) => [row.originalFilename, row.candidateFilename]),
  );

  return input.diskFilenames
    .filter((filename) => IMAGE_FILE_RE.test(filename) && !candidateFilenames.has(filename))
    .map((originalFilename, originalIndex) => {
      const activeFilename = activeByOriginal.get(originalFilename) ?? originalFilename;
      const metadata = labelByFilename.get(activeFilename) ?? labelByFilename.get(originalFilename) ?? null;
      return {
        originalFilename,
        activeFilename,
        roomLabel:
          metadata?.userLabel?.trim()
          || metadata?.label?.trim()
          || originalFilename.replace(/\.[^.]+$/, "").replace(/^\d+[-_]/, "").replace(/[-_]+/g, " ")
          || "Photo",
        metadata,
        originalIndex,
      };
    })
    .filter((source) => !source.metadata?.hidden)
    .sort((a, b) => {
      const aOrder = a.metadata?.sortOrder;
      const bOrder = b.metadata?.sortOrder;
      if (aOrder != null && bOrder != null && aOrder !== bOrder) return aOrder - bOrder;
      if (aOrder != null && bOrder == null) return -1;
      if (aOrder == null && bOrder != null) return 1;
      return a.originalIndex - b.originalIndex;
    })
    .map(({ originalIndex: _originalIndex, ...source }) => source);
}

/**
 * Keep source resolution separate from staging eligibility so no gallery or
 * downstream photo pipeline loses scenic/exterior images. Only the paid
 * virtual-staging candidate plan is narrowed here.
 */
export function resolveStageableVirtualStagingSources(
  input: ResolveVirtualStagingSourcesInput,
): PlannedVirtualStagingSource[] {
  return resolveVirtualStagingSources(input).flatMap((source) => {
    const stagingContext = virtualStagingContextForSource(source);
    return stagingContext ? [{ ...source, stagingContext }] : [];
  });
}

export function summarizeCandidateStatuses(
  statuses: readonly VirtualStagingCandidateStatus[],
): Pick<VirtualStagingJobDto, "status" | "total" | "completed" | "failed"> {
  const total = statuses.length;
  const completed = statuses.filter((status) => status === "succeeded" || status === "failed").length;
  const failed = statuses.filter((status) => status === "failed").length;
  const succeeded = statuses.filter((status) => status === "succeeded").length;
  const running = statuses.some((status) => status === "pending" || status === "generating");
  return {
    status: running ? "running" : succeeded > 0 ? "ready" : "failed",
    total,
    completed,
    failed,
  };
}

export type SelectableVirtualStagingCandidate = {
  id: string;
  status: VirtualStagingCandidateStatus;
  propertyId: number;
  unitId: string;
  jobId: string;
};

/** Validate untrusted confirmation IDs before any storage or DB mutation. */
export function validateVirtualStagingSelection(input: {
  candidateIds: readonly string[];
  candidates: readonly SelectableVirtualStagingCandidate[];
  propertyId: number;
  unitId: string;
  jobId: string;
}): string[] {
  const uniqueIds = Array.from(new Set(input.candidateIds));
  if (uniqueIds.length !== input.candidateIds.length) {
    throw new Error("Candidate selection contains duplicates");
  }
  if (uniqueIds.length === 0) throw new Error("Select at least one staged photo");
  const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  for (const id of uniqueIds) {
    const candidate = byId.get(id);
    if (!candidate) throw new Error("A selected staged photo does not belong to this job");
    if (
      candidate.propertyId !== input.propertyId
      || candidate.unitId !== input.unitId
      || candidate.jobId !== input.jobId
    ) {
      throw new Error("A selected staged photo does not belong to this unit");
    }
    if (candidate.status !== "succeeded") {
      throw new Error("Only successfully generated staged photos can be applied");
    }
  }
  return uniqueIds;
}

export function sameVirtualStagingSelection(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined,
): boolean {
  if (!left || !right || left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}

export function reusableVirtualStagingJobId(
  jobs: ReadonlyArray<{
    id: string;
    propertyId: number;
    unitId: string;
    status: VirtualStagingJobStatus;
  }>,
  propertyId: number,
  unitId: string,
): string | null {
  // Callers provide newest-first rows. The newest row is authoritative: a
  // confirmed review must supersede (rather than reveal) an older ready one.
  const latest = jobs.find((job) =>
    job.propertyId === propertyId
    && job.unitId === unitId,
  );
  return latest && latest.status !== "confirmed" ? latest.id : null;
}
