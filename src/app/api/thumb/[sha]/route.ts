import { NextResponse } from "next/server";
import sharp from "sharp";

import { findAssetBySha256 } from "@/lib/assets";
import { props, uploadConfig } from "@/lib/config";
import { plainText } from "@/lib/notion";
import { assetsR2Config, r2GetObject, r2HeadObject, r2PutObject } from "@/lib/r2";

export const dynamic = "force-dynamic";

// Grid-sized renditions of assets whose `Preview URL` is the untouched
// original.
//
// Most of the library renders fine from `Preview URL`: Drive-synced rows point
// at a downscaled preview (~640–1000px). App-uploaded rows do NOT — their
// `Preview URL` is the original itself, so a 276-asset collection was pulling
// ~2000x3000 / ~3.2 MB per tile (measured: ~1 GB for one view, and
// ERR_INSUFFICIENT_RESOURCES in the browser). This route serves a 640px WebP
// instead, and the full-resolution file stays where it belongs: behind the
// asset detail page and the "open the original" links.
//
// The URL is content-addressed by the asset's SHA256, which makes every
// rendition immutable (`max-age=31536000, immutable`) and dedupes identical
// uploads for free. Renditions live in the existing derived-objects tier, so
// they are edge-cached and never touch the Manifest, search, or dedup paths.
//
// A cold miss costs one fetch + one resize, ever; after that the CDN edge
// serves it and this server is out of the loop.

/** SHA-256 hex. Also a valid derived-objects filename stem. */
const SHA_RE = /^[0-9a-f]{64}$/i;

const THUMB_WIDTH = Number(process.env.THUMB_WIDTH ?? "640");
const THUMB_QUALITY = Number(process.env.THUMB_QUALITY ?? "72");

// Bound the pixel count we will decode: a plain sharp() on a huge or corrupt
// file can balloon memory, and this process runs on a small instance.
const MAX_INPUT_PIXELS = Number(process.env.THUMB_MAX_INPUT_PIXELS ?? "120000000");

// On-demand resizing is CPU- and memory-hungry. A cold collection view fires
// hundreds of tile requests at once, so cap how many decode simultaneously —
// the rest queue rather than OOM the server.
const MAX_CONCURRENT = Number(process.env.THUMB_CONCURRENCY ?? "2");

let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
}

function release(): void {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
}

function thumbKey(sha: string): string {
  return `${uploadConfig.derivedPrefix}thumbs/${sha.toLowerCase()}.webp`;
}

/**
 * Public CDN URL for a derived key, when `ASSET_DERIVED_CDN_BASE_URL` is set.
 * Returning a redirect keeps the bytes off this server entirely on a warm hit.
 */
function publicDerivedUrl(key: string): string | null {
  const base = uploadConfig.derivedCdnBaseUrl;
  if (!base) return null;
  const rel = key.startsWith(uploadConfig.derivedPrefix)
    ? key.slice(uploadConfig.derivedPrefix.length)
    : key;
  return `${base}/${rel}`;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sha: string }> },
) {
  const { sha } = await params;
  if (!SHA_RE.test(sha)) {
    return new NextResponse("Expected a SHA-256 hex digest.", { status: 400 });
  }

  const key = thumbKey(sha);
  const r2 = assetsR2Config();

  // 1. Warm: serve from the derived tier.
  if (r2) {
    try {
      const head = await r2HeadObject(r2, key);
      if (head.ok) {
        const url = publicDerivedUrl(key);
        if (url) return NextResponse.redirect(url, 302);
        const cached = await r2GetObject(r2, key);
        return new NextResponse(new Uint8Array(cached), {
          headers: { "Content-Type": "image/webp", "Cache-Control": IMMUTABLE },
        });
      }
    } catch (err) {
      // A cache-layer failure must not break the image; fall through and
      // re-render.
      console.warn("thumb cache lookup failed", err);
    }
  }

  // 2. Cold: find the asset this hash belongs to.
  let source: string;
  try {
    const page = await findAssetBySha256(sha);
    if (!page) {
      return new NextResponse("No asset with that hash.", { status: 404 });
    }
    source = plainText(page.properties?.[props.imageUrl]);
  } catch (err) {
    console.error("thumb asset lookup failed", err);
    return new NextResponse("Lookup failed.", { status: 502 });
  }

  // Mixed content and open-redirect hygiene: only ever fetch https.
  if (!source || !/^https:\/\//i.test(source)) {
    return new NextResponse("Asset has no public preview.", { status: 404 });
  }

  // 3. Render it.
  let thumb: Buffer;
  await acquire();
  try {
    const res = await fetch(source, { cache: "no-store" });
    if (!res.ok) throw new Error(`source responded ${res.status}`);
    const input = Buffer.from(await res.arrayBuffer());
    thumb = await sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      // Tolerate mildly malformed JPEGs rather than 500ing a whole grid.
      failOn: "none",
    })
      .rotate() // honour EXIF orientation
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer();
  } catch (err) {
    // Degrade to the original: a heavier image beats a broken tile.
    console.error("thumb generation failed; falling back to the original", err);
    return NextResponse.redirect(source, 302);
  } finally {
    release();
  }

  // 4. Populate the cache (best effort — a failure still serves the bytes).
  if (r2) {
    try {
      await r2PutObject(r2, key, thumb, {
        contentType: "image/webp",
        cacheControl: IMMUTABLE,
      });
    } catch (err) {
      console.warn("thumb cache write failed", err);
    }
  }

  return new NextResponse(new Uint8Array(thumb), {
    headers: { "Content-Type": "image/webp", "Cache-Control": IMMUTABLE },
  });
}
