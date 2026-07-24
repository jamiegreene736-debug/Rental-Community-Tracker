import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dedupeLocalPhotoItems } from "../server/photo-content-dedupe";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rct-photo-content-dedupe-"));
try {
  fs.writeFileSync(path.join(dir, "01-community.jpg"), Buffer.from("same-photo"));
  fs.writeFileSync(path.join(dir, "21-community.jpg"), Buffer.from("same-photo"));
  fs.writeFileSync(path.join(dir, "25-community.jpg"), Buffer.from("different-photo"));
  fs.writeFileSync(path.join(dir, "26-community.jpg"), Buffer.from("third-photo"));

  const source = ["01-community.jpg", "21-community.jpg", "25-community.jpg", "26-community.jpg"];
  const result = await dedupeLocalPhotoItems(source, (filename) => path.join(dir, filename));
  assert.deepEqual(result.unique, ["01-community.jpg", "25-community.jpg", "26-community.jpg"]);
  assert.deepEqual(result.duplicates, [{
    item: "21-community.jpg",
    duplicateOf: "01-community.jpg",
  }]);

  assert.equal(
    1 + 14 + 11 + result.unique.length,
    29,
    "cover + Unit A + Unit B + three unique community photos should total 29",
  );

  const unreadable = await dedupeLocalPhotoItems(
    ["missing-a.jpg", "missing-b.jpg"],
    (filename) => path.join(dir, filename),
  );
  assert.deepEqual(unreadable.unique, ["missing-a.jpg", "missing-b.jpg"]);
  assert.equal(unreadable.duplicates.length, 0);

  const hiddenFirst = await dedupeLocalPhotoItems(
    ["01-community.jpg", "21-community.jpg"],
    (filename) => filename === "01-community.jpg" ? null : path.join(dir, filename),
  );
  assert.deepEqual(
    hiddenFirst.unique,
    ["01-community.jpg", "21-community.jpg"],
    "a hidden alias must not suppress the visible copy",
  );

  const routes = fs.readFileSync(path.resolve("server/routes.ts"), "utf8");
  const repush = fs.readFileSync(path.resolve("server/guesty-photo-repush.ts"), "utf8");
  assert.match(routes, /dedupeLocalPhotoItems\(\s*resolvedImageFiles,/);
  assert.match(routes, /dedupeLocalPhotoItems\(\s*rawPhotos,/);
  assert.match(repush, /dedupeLocalPhotoItems\(\s*resolvedFiles,/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("photo-content-dedupe: all tests passed");
