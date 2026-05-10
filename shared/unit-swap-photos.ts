export function replacementPhotoFolderForUnit(propertyId: number | string, oldUnitId: string): string {
  const prop = String(propertyId)
    .trim()
    .replace(/^-/, "draft-")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const unit = String(oldUnitId)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return `replacement-p${prop || "unknown"}-u${unit || "unit"}`.slice(0, 96);
}
