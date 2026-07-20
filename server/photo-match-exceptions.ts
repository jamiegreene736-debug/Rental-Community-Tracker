// app_settings store for operator-confirmed photo-match exceptions
// (shared/photo-match-exceptions.ts holds the pure logic). Same fail-soft
// promise-tail pattern as the photo-folder pin store — an exception is a
// suppression upgrade, never a blocker: a store failure means the scanner just
// keeps warning (safe direction).

import { storage } from "./storage";
import {
  PHOTO_MATCH_EXCEPTIONS_SETTING_KEY,
  addPhotoMatchException,
  exceptionSetForFolder,
  parsePhotoMatchExceptions,
  removePhotoMatchException,
  serializePhotoMatchExceptions,
  type PhotoMatchException,
  type PhotoMatchExceptionStore,
} from "../shared/photo-match-exceptions";

let tail: Promise<void> = Promise.resolve();
function mutateStore(fn: (store: PhotoMatchExceptionStore) => void): Promise<void> {
  tail = tail.then(async () => {
    try {
      const raw = await storage.getSetting(PHOTO_MATCH_EXCEPTIONS_SETTING_KEY);
      const store = parsePhotoMatchExceptions(raw ?? null);
      fn(store);
      await storage.setSetting(PHOTO_MATCH_EXCEPTIONS_SETTING_KEY, serializePhotoMatchExceptions(store));
    } catch (err: any) {
      console.warn("[photo-match-exceptions] store write failed:", err?.message ?? err);
    }
  });
  return tail;
}

export async function loadPhotoMatchExceptions(): Promise<PhotoMatchExceptionStore> {
  try {
    const raw = await storage.getSetting(PHOTO_MATCH_EXCEPTIONS_SETTING_KEY);
    return parsePhotoMatchExceptions(raw ?? null);
  } catch {
    return Object.create(null);
  }
}

/** The normalized-URL set the scanner consults for one folder. */
export async function confirmedMatchSetForFolder(folder: string): Promise<Set<string>> {
  return exceptionSetForFolder(await loadPhotoMatchExceptions(), folder);
}

export async function confirmPhotoMatchException(
  folder: string,
  url: string,
  title?: string,
): Promise<PhotoMatchException | null> {
  let added: PhotoMatchException | null = null;
  await mutateStore((store) => {
    added = addPhotoMatchException(store, folder, url, new Date(), title);
  });
  return added;
}

export async function unconfirmPhotoMatchException(folder: string, url: string): Promise<boolean> {
  let removed = false;
  await mutateStore((store) => {
    removed = removePhotoMatchException(store, folder, url);
  });
  return removed;
}
