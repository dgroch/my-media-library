// Perceptual hash (pHash) for near-duplicate detection. 64-bit DCT hash:
// the image is normalised to 256px grayscale (contrast-stretched, per the
// upload-path spec), downsampled to 32x32, transformed with a 2D DCT-II, and
// the top-left 8x8 low-frequency block is thresholded against its median.
// Re-exports, resizes, light crops and format conversions land within a small
// Hamming distance; unrelated images land far apart.
//
// No "server-only" import: this module is pure (sharp + math) so it can be
// exercised directly by scripts/tests.

import sharp from "sharp";

const NORM_SIZE = 256; // normalisation size from the spec
const DCT_SIZE = 32; // DCT input
const HASH_SIZE = 8; // low-frequency block → 64 bits

/** Compute the 64-bit pHash of an image buffer as 16 lowercase hex chars. */
export async function perceptualHash(image: Buffer): Promise<string> {
  // Pass 1: normalised 256px grayscale (sharp applies resize before
  // normalise within one pipeline, so the contrast stretch sees the
  // normalised size either way; two explicit passes keep the order exact).
  const normalised = await sharp(image)
    .resize(NORM_SIZE, NORM_SIZE, { fit: "fill" })
    .grayscale()
    .normalise()
    .raw()
    .toBuffer();

  // Pass 2: downsample to the DCT input size.
  const px = await sharp(normalised, {
    raw: { width: NORM_SIZE, height: NORM_SIZE, channels: 1 },
  })
    .resize(DCT_SIZE, DCT_SIZE, { fit: "fill" })
    .raw()
    .toBuffer();

  const dct = dct2d(px, DCT_SIZE);

  // Top-left 8x8 block, thresholded against the median of its AC terms (the
  // DC coefficient is overall brightness and would skew the median).
  const block: number[] = [];
  for (let v = 0; v < HASH_SIZE; v++) {
    for (let u = 0; u < HASH_SIZE; u++) {
      block.push(dct[v * DCT_SIZE + u]);
    }
  }
  const ac = block.slice(1).slice().sort((a, b) => a - b);
  const median =
    ac.length % 2 === 1
      ? ac[(ac.length - 1) / 2]
      : (ac[ac.length / 2 - 1] + ac[ac.length / 2]) / 2;

  let bits = 0n;
  for (let i = 0; i < block.length; i++) {
    bits <<= 1n;
    if (block[i] > median) bits |= 1n;
  }
  return bits.toString(16).padStart(16, "0");
}

/** Hamming distance between two 64-bit hex pHashes (0–64). */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** True when `a` and `b` parse as pHashes and sit within `threshold` bits. */
export function isSimilar(a: string, b: string, threshold: number): boolean {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return false;
  return hammingDistance(a, b) <= threshold;
}

// Separable 2D DCT-II over an n×n grayscale buffer (rows then columns).
// n=32 → 32*32*32*2 ≈ 65k multiply-adds; negligible per upload.
function dct2d(px: Buffer, n: number): Float64Array {
  // Precompute the cosine basis once per call (n is tiny).
  const cos = new Float64Array(n * n);
  for (let u = 0; u < n; u++) {
    for (let x = 0; x < n; x++) {
      cos[u * n + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n));
    }
  }

  const rows = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let u = 0; u < n; u++) {
      let sum = 0;
      for (let x = 0; x < n; x++) sum += px[y * n + x] * cos[u * n + x];
      rows[y * n + u] = sum;
    }
  }

  const out = new Float64Array(n * n);
  for (let u = 0; u < n; u++) {
    for (let v = 0; v < n; v++) {
      let sum = 0;
      for (let y = 0; y < n; y++) sum += rows[y * n + u] * cos[v * n + y];
      out[v * n + u] = sum;
    }
  }
  return out;
}
