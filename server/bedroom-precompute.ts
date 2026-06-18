// Persist bedroom cluster assignments at photo ingest for fast community checks.

import fs from "fs";
import path from "path";
import {
  BEDROOM_CLUSTER_DISTANCE,
  clusterBedroomPhotosByHash,
  detectBedTypeFromCaption,
  pickMasterClusterIndex,
} from "../shared/photo-bedroom-coverage-logic";
import { computeDhash } from "./photo-hashing";
import { storage } from "./storage";

const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;

export type BedroomPrecomputeFile = {
  filename: string;
  label: string;
  absPath: string;
};

/** Cluster bedroom-category photos and persist bedroom_cluster_id + bed type per row. */
export async function persistBedroomPrecomputeForFolder(
  folder: string,
  files: BedroomPrecomputeFile[],
): Promise<{ clusters: number; filesUpdated: number }> {
  if (files.length === 0) return { clusters: 0, filesUpdated: 0 };

  const samples: Array<{
    filename: string;
    label: string;
    hash?: string;
  }> = [];

  for (const f of files) {
    try {
      const buf = await fs.promises.readFile(f.absPath);
      const hash = await computeDhash(buf);
      samples.push({ filename: f.filename, label: f.label, hash });
    } catch {
      samples.push({ filename: f.filename, label: f.label });
    }
  }

  const clustered = clusterBedroomPhotosByHash(
    samples.map((s, i) => ({ id: String(i), caption: s.label, hash: s.hash, filename: s.filename })),
    BEDROOM_CLUSTER_DISTANCE,
  );

  let filesUpdated = 0;
  for (let ci = 0; ci < clustered.length; ci++) {
    const cluster = clustered[ci];
    const clusterId = `room-${ci + 1}`;
    const captions = cluster.map((c) => c.caption ?? "").join(" ");
    const bedType = detectBedTypeFromCaption(captions);
    for (const item of cluster) {
      const filename = (item as any).filename as string;
      if (!filename) continue;
      await storage.updatePhotoLabelBedroomPrecompute(folder, filename, {
        bedroomClusterId: clusterId,
        bedroomBedType: bedType,
      }).catch(() => {});
      filesUpdated += 1;
    }
  }

  return { clusters: clustered.length, filesUpdated };
}

/** Backfill precompute for all bedroom-category rows in a folder on disk. */
export async function backfillBedroomPrecomputeForFolder(folder: string, photoDir: string): Promise<void> {
  const labels = await storage.getPhotoLabelsByFolder(folder);
  const bedroomRows = labels.filter((r) => /^bedrooms?$/i.test(String(r.userCategory ?? r.category ?? "")));
  if (bedroomRows.length === 0) return;
  const files: BedroomPrecomputeFile[] = [];
  for (const row of bedroomRows) {
    const abs = path.join(photoDir, row.filename);
    try {
      await fs.promises.access(abs);
      files.push({
        filename: row.filename,
        label: row.userLabel ?? row.label,
        absPath: abs,
      });
    } catch {
      // missing on disk
    }
  }
  await persistBedroomPrecomputeForFolder(folder, files);
}

export async function clearBedroomPrecomputeForFolder(folder: string): Promise<void> {
  const labels = await storage.getPhotoLabelsByFolder(folder);
  await Promise.all(
    labels.map((row) =>
      storage.updatePhotoLabelBedroomPrecompute(folder, row.filename, {
        bedroomClusterId: null,
        bedroomBedType: null,
      }).catch(() => {}),
    ),
  );
}
