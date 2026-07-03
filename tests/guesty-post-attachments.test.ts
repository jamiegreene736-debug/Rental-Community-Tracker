import assert from "node:assert/strict";
import {
  bodyWithoutAttachmentUrls,
  collectPostAttachments,
  looksLikeImageUrl,
} from "../shared/guesty-post-attachments";

console.log("guesty-post-attachments tests");

// ── looksLikeImageUrl ───────────────────────────────────────────────────────
assert.equal(looksLikeImageUrl("https://x.com/a/photo.jpg"), true, "jpg extension");
assert.equal(looksLikeImageUrl("https://x.com/a/photo.PNG?w=100"), true, "png with query");
assert.equal(looksLikeImageUrl("https://x.com/a/file.pdf"), false, "pdf is not an image");
assert.equal(looksLikeImageUrl("https://x.com/opaque", "image/jpeg"), true, "content-type wins");
assert.equal(
  looksLikeImageUrl("https://media.vrbo.com/lodging/12/3456/photo"),
  true,
  "VRBO media host counts as image even without extension",
);
assert.equal(
  looksLikeImageUrl("https://a0.muscache.com/im/pictures/abc"),
  true,
  "Airbnb muscache host counts as image",
);
assert.equal(
  looksLikeImageUrl("https://assets.guesty.com/attachments/xyz"),
  true,
  "Guesty asset host counts as image",
);
assert.equal(looksLikeImageUrl("https://example.com/page"), false, "plain page is not an image");

// ── attachments array of plain string URLs (VRBO photo message shape) ───────
const stringAtts = collectPostAttachments({
  _id: "p1",
  body: "",
  attachments: ["https://media.vrbo.com/messages/photo-1", "https://x.com/notes.pdf"],
});
assert.equal(stringAtts.length, 2);
assert.equal(stringAtts[0].url, "https://media.vrbo.com/messages/photo-1");
assert.equal(stringAtts[0].isImage, true, "media host string attachment is an image");
assert.equal(stringAtts[1].isImage, false, "pdf attachment is a file, not an image");
assert.ok(stringAtts.findIndex((a) => a.isImage) === 0, "images sort before files");

// ── attachments array of objects with varied URL/name/type keys ─────────────
const objAtts = collectPostAttachments({
  attachments: [
    { url: "https://x.com/a.jpg", filename: "a.jpg" },
    { href: "https://x.com/opaque-1", contentType: "image/png" },
    { src: "https://x.com/opaque-2", type: "image" },
    { link: "https://x.com/doc", name: "agreement.pdf", mimeType: "application/pdf" },
    { file: { url: "https://x.com/nested.webp" } },
    { note: "no url here" },
    "not-a-url",
  ],
});
assert.equal(objAtts.length, 5, "every URL-bearing shape is captured; junk is dropped");
assert.equal(objAtts.filter((a) => a.isImage).length, 4);
assert.equal(objAtts.find((a) => a.url === "https://x.com/a.jpg")?.name, "a.jpg");
assert.equal(objAtts.find((a) => a.url === "https://x.com/doc")?.isImage, false);
assert.equal(objAtts.find((a) => a.url === "https://x.com/nested.webp")?.isImage, true, "one nested hop (file.url)");

// ── media/images/files collection keys + nested meta containers ─────────────
assert.equal(collectPostAttachments({ media: ["https://x.com/m.jpeg"] }).length, 1);
assert.equal(collectPostAttachments({ images: [{ url: "https://x.com/i.png" }] }).length, 1);
assert.equal(
  collectPostAttachments({ meta: { attachments: ["https://x.com/meta.gif"] } }).length,
  1,
  "attachments nested under meta are found",
);

// ── image URLs embedded in the body (HTML img tag + bare URL) ───────────────
const htmlBody = collectPostAttachments({
  body: `<p>see photo</p><img src="https://x.com/inline-photo" alt="">`,
});
assert.equal(htmlBody.length, 1);
assert.equal(htmlBody[0].url, "https://x.com/inline-photo");
assert.equal(htmlBody[0].isImage, true, "img tag src is always an image");

const bareUrlBody = collectPostAttachments({
  body: "Here is the damage https://media.vrbo.com/uploads/guest/123 thanks",
});
assert.equal(bareUrlBody.length, 1, "bare media-host URL in text is captured");

assert.equal(
  collectPostAttachments({ body: "Just text, see https://example.com/page for info" }).length,
  0,
  "non-media links in the body are NOT treated as attachments",
);

// ── dedup: same URL in attachments AND body counts once ─────────────────────
const deduped = collectPostAttachments({
  body: "https://x.com/a.jpg",
  attachments: [{ url: "https://x.com/a.jpg" }],
});
assert.equal(deduped.length, 1, "same URL from body + attachments dedupes");

// ── no attachments → empty, and never throws on junk shapes ─────────────────
assert.deepEqual(collectPostAttachments({ body: "hi" }), []);
assert.deepEqual(collectPostAttachments(null), []);
assert.deepEqual(collectPostAttachments("just a string"), []);
assert.deepEqual(collectPostAttachments({ attachments: "not-an-array" }), []);

// ── bodyWithoutAttachmentUrls ───────────────────────────────────────────────
const atts = [{ url: "https://x.com/a.jpg", isImage: true }];
assert.equal(bodyWithoutAttachmentUrls("https://x.com/a.jpg", atts), "", "URL-only body collapses to empty");
assert.equal(
  bodyWithoutAttachmentUrls("Look at this!\nhttps://x.com/a.jpg", atts),
  "Look at this!",
  "real text survives with the URL removed",
);
assert.equal(bodyWithoutAttachmentUrls("plain message", atts), "plain message");
assert.equal(bodyWithoutAttachmentUrls("", atts), "");

console.log("  ✓ guesty post attachment extraction (photos in guest inbox)");
