// Isolated diagnostic for the Gemini image-edit (overlay removal) call.
// Reproduces exactly what the app's editImage() does, but prints the full
// HTTP status + response so we can see why cleanup is a no-op.
//
//   GEMINI_API_KEY=... node scripts/test-gemini-image.mjs [imageUrlOrPath]
//
// Defaults to the problem frame on the CDN. On success it writes the cleaned
// image to /tmp/gemini-cleaned.png and reports the byte size; on failure it
// prints the status + body (or the finishReason / safety block).

import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!KEY) {
  console.error("✗ Set GEMINI_API_KEY (your Tier-3 AI Studio key).");
  process.exit(1);
}

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const BASE =
  process.env.GEMINI_GOOGLE_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta";

const src =
  process.argv[2] ||
  "https://brand-cdn.figandbloom.workers.dev/figandbloom/asset-manifest/original-2-scene-05-3ebt7n.jpg";

const PROMPT =
  "Remove only the overlaid graphics from this image: on-screen text and " +
  "captions, subtitles, stickers, emojis, watermarks, logos, usernames, and " +
  "Instagram/TikTok/Reels interface chrome. Cleanly reconstruct the area behind " +
  "them. Do NOT add, remove, or alter any real subject, product, person, or " +
  "background detail. Return the cleaned photo at the same aspect ratio.";

async function loadImage(s) {
  if (/^https?:\/\//.test(s)) {
    const r = await fetch(s);
    if (!r.ok) throw new Error(`fetch image failed: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  return readFile(s);
}

const img = await loadImage(src);
console.log(`→ model: ${MODEL}`);
console.log(`→ input: ${src} (${img.length} bytes)`);

const url = `${BASE}/models/${MODEL}:generateContent`;
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
  body: JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: "image/jpeg", data: img.toString("base64") } },
        ],
      },
    ],
    generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
  }),
});

console.log(`← HTTP ${res.status} ${res.statusText}`);
const text = await res.text();

if (!res.ok) {
  console.error("✗ Error body:\n" + text.slice(0, 2000));
  process.exit(1);
}

const json = JSON.parse(text);
const cand = json.candidates?.[0];
console.log("← finishReason:", cand?.finishReason ?? "(none)");
if (json.promptFeedback) console.log("← promptFeedback:", JSON.stringify(json.promptFeedback));

const parts = cand?.content?.parts ?? [];
const imgPart = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
const inline = imgPart?.inlineData ?? imgPart?.inline_data;
if (inline?.data) {
  const out = Buffer.from(inline.data, "base64");
  await writeFile("/tmp/gemini-cleaned.png", out);
  console.log(`✓ Got edited image: ${out.length} bytes → /tmp/gemini-cleaned.png`);
} else {
  console.log("✗ No image part in response. Parts were:");
  console.log(JSON.stringify(parts.map((p) => Object.keys(p)), null, 2));
  console.log("Full candidate:\n" + JSON.stringify(cand, null, 2).slice(0, 1500));
}
