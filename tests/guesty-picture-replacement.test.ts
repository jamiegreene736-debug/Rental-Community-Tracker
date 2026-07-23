import assert from "node:assert/strict";
import { acquireGuestyPictureMutation } from "../server/guesty-picture-mutation";
import {
  guestyPicturesExactlyMatch,
  replaceGuestyPicturesAndVerify,
  type GuestyPictureForReplacement,
} from "../server/guesty-picture-replacement";

const target = (count: number): GuestyPictureForReplacement[] =>
  Array.from({ length: count }, (_, index) => ({
    original: `https://cdn.example/new-${index + 1}.jpg`,
    caption: `Photo ${index + 1}`,
  }));

const stale = (count: number): GuestyPictureForReplacement[] =>
  Array.from({ length: count }, (_, index) => ({
    original: `https://cdn.example/old-${index + 1}.jpg`,
    caption: `Old Photo ${index + 1}`,
  }));

const noSleep = async () => undefined;

console.log("guesty-picture-replacement: exact whole-gallery verification");

{
  const expected = target(31);
  const oldGallery = stale(36);
  const writes: GuestyPictureForReplacement[][] = [];
  const reads = [oldGallery, expected];
  const result = await replaceGuestyPicturesAndVerify({
    pictures: expected,
    replace: async (pictures) => { writes.push(structuredClone(pictures)); },
    read: async () => ({ pictures: reads.shift() ?? expected }),
    waitsMs: [0, 0, 0],
    sleep: noSleep,
  });

  assert.equal(result.confirmed, true);
  assert.equal(result.observedTotal, 31);
  assert.equal(result.replaceAttempts, 2);
  assert.deepEqual(writes[0], expected);
  assert.deepEqual(writes[1], expected);
  console.log("  ✓ a stale 36-photo gallery is replaced and verified as the exact 31-photo target");
}

{
  const expected = target(31);
  const wrongSameCount = stale(31);
  const reads = [wrongSameCount, expected];
  const result = await replaceGuestyPicturesAndVerify({
    pictures: expected,
    replace: async () => undefined,
    read: async () => ({ pictures: reads.shift() ?? expected }),
    waitsMs: [0, 0, 0],
    sleep: noSleep,
  });

  assert.equal(result.confirmed, true);
  assert.equal(result.replaceAttempts, 2);
  console.log("  ✓ equal counts with stale photo identities never produce a false confirmation");
}

{
  const expected = target(2);
  const wrongSameCount = stale(2);
  const actions: string[] = [];
  const result = await replaceGuestyPicturesAndVerify({
    pictures: expected,
    replace: async () => { actions.push("PUT"); },
    read: async () => { actions.push("GET"); return { pictures: wrongSameCount }; },
    waitsMs: [0, 0, 0],
    sleep: noSleep,
  });

  assert.equal(result.confirmed, false);
  assert.equal(result.replaceAttempts, 3);
  assert.equal(actions.at(-1), "GET");
  assert.deepEqual(actions, ["PUT", "GET", "PUT", "GET", "PUT", "GET"]);
  console.log("  ✓ persistent mismatches fail closed and finish with a verification read, not a blind write");
}

{
  const expected = target(2);
  const reads = [stale(2), expected];
  const actions: string[] = [];
  let replaceCall = 0;
  const result = await replaceGuestyPicturesAndVerify({
    pictures: expected,
    replace: async () => {
      actions.push("PUT");
      replaceCall++;
      if (replaceCall === 2) throw new Error("transient PUT failure");
    },
    read: async () => {
      actions.push("GET");
      return { pictures: reads.shift() ?? expected };
    },
    waitsMs: [0, 0, 0],
    sleep: noSleep,
  });

  assert.equal(result.confirmed, true);
  assert.equal(actions.at(-1), "GET");
  console.log("  ✓ a corrective PUT failure still proceeds to a final read and can observe the initial write");
}

{
  const expected = target(2);
  const result = await replaceGuestyPicturesAndVerify({
    pictures: expected,
    replace: async () => undefined,
    read: async () => { throw new Error("Guesty unavailable"); },
    waitsMs: [0, 0, 0],
    sleep: noSleep,
  });

  assert.equal(result.confirmed, false);
  assert.equal(result.observedTotal, null);
  assert.equal(result.lastReadError, "Guesty unavailable");
  console.log("  ✓ unreadable read-backs never inherit the submitted count as a verified count");
}

assert.equal(
  guestyPicturesExactlyMatch(
    [{ url: "https://CDN.EXAMPLE/a.jpg#fragment", caption: "  Living   Room " }],
    [{ original: "https://cdn.example/a.jpg", caption: "Living Room" }],
  ),
  true,
);
assert.equal(
  guestyPicturesExactlyMatch(
    [{ original: "https://cdn.example/old.jpg", caption: "Living Room" }],
    [{ original: "https://cdn.example/new.jpg", caption: "Living Room" }],
  ),
  false,
);
console.log("  ✓ comparison normalizes harmless URL/caption spelling but preserves identity");

console.log("guesty-picture-replacement: per-listing mutation serialization");
{
  const releaseFirst = await acquireGuestyPictureMutation("listing-a");
  let secondAcquired = false;
  const second = acquireGuestyPictureMutation("listing-a").then((release) => {
    secondAcquired = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(secondAcquired, false);

  const releaseOther = await acquireGuestyPictureMutation("listing-b");
  releaseOther();
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondAcquired, true);
  releaseSecond();
  console.log("  ✓ same-listing writers queue while different listings remain independent");
}

console.log("guesty-picture-replacement: all tests passed");
