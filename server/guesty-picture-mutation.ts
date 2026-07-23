const pictureMutationTails = new Map<string, Promise<void>>();

/**
 * Serialize all whole-gallery Guesty mutations for one listing. Photo pushes,
 * cover-collage writes, and normalization each rewrite pictures[] in full; a
 * stale snapshot from any one of them must not overwrite a newer gallery.
 */
export async function acquireGuestyPictureMutation(
  listingId: string,
): Promise<() => void> {
  const key = String(listingId ?? "").trim();
  if (!key) throw new Error("Guesty listing ID is required for a picture mutation.");

  const previous = pictureMutationTails.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  pictureMutationTails.set(key, tail);

  await previous.catch(() => undefined);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    void tail.finally(() => {
      if (pictureMutationTails.get(key) === tail) pictureMutationTails.delete(key);
    });
  };
}
