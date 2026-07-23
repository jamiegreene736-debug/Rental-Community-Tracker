import fs from "fs";
import path from "path";
import { isVirtualStagingCandidateFilename } from "@shared/virtual-staging";

const IMAGE_EXT = /\.(?:jpe?g|png|webp)$/i;
type FolderLockState = {
  tail: Promise<void>;
  queued: number;
};
const folderWriteLocks = new Map<string, FolderLockState>();

/**
 * Serialize every mutation of one physical folder. A second click can wait,
 * but it may never interleave a promotion or rollback with the first.
 */
export async function acquirePhotoFolderWriteLock(folderKey: string): Promise<() => void> {
  let state = folderWriteLocks.get(folderKey);
  if (!state) {
    state = { tail: Promise.resolve(), queued: 0 };
    folderWriteLocks.set(folderKey, state);
  }
  const previous = state.tail.catch(() => {});
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  state.tail = previous.then(() => gate);
  state.queued += 1;
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    state!.queued -= 1;
    if (state!.queued === 0 && folderWriteLocks.get(folderKey) === state) {
      folderWriteLocks.delete(folderKey);
    }
  };
}

/**
 * Seed a disposable photo-folder stage with metadata and durable virtual
 * staging assets. Scrape-owned images are intentionally omitted.
 */
export async function preparePhotoFolderStage(
  livePath: string,
  stagingPath: string,
): Promise<void> {
  await fs.promises.rm(stagingPath, { recursive: true, force: true });
  await fs.promises.mkdir(stagingPath, { recursive: true });
  const entries = await fs.promises.readdir(livePath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (IMAGE_EXT.test(entry.name) && !isVirtualStagingCandidateFilename(entry.name)) continue;
    await fs.promises.cp(
      path.join(livePath, entry.name),
      path.join(stagingPath, entry.name),
      { recursive: entry.isDirectory(), force: true },
    );
  }
}

/**
 * Promote a proven stage while retaining a rollback copy until the caller's
 * metadata transaction succeeds.
 */
export async function commitPhotoFolderStage(
  livePath: string,
  stagingPath: string,
  backupPath: string,
  afterFilesystemPromotion: () => Promise<void>,
): Promise<void> {
  const hadLiveFolder = !!(await fs.promises.stat(livePath).catch(() => null));
  await fs.promises.rm(backupPath, { recursive: true, force: true });
  if (hadLiveFolder) await fs.promises.rename(livePath, backupPath);
  try {
    await fs.promises.rename(stagingPath, livePath);
    await afterFilesystemPromotion();
  } catch (error) {
    await fs.promises.rm(livePath, { recursive: true, force: true }).catch(() => {});
    if (hadLiveFolder) {
      await fs.promises.rename(backupPath, livePath).catch((restoreError: any) => {
        console.error(
          `[photo-folder] rollback failed for ${livePath}: ${restoreError?.message ?? restoreError}`,
        );
      });
    }
    throw error;
  }
  await fs.promises.rm(backupPath, { recursive: true, force: true }).catch((error: any) => {
    console.warn(`[photo-folder] backup cleanup failed for ${backupPath}: ${error?.message ?? error}`);
  });
}
