import "server-only";

// Frame cleanup — "tidy up" a selected frame for use as a brand image. Two
// steps, both best-effort and both refusing to invent content:
//   1. Overlay removal (optional): inpaint out on-screen text, captions,
//      watermarks and Instagram reel chrome via Gemini's image model. Skipped
//      when no Google image key is configured.
//   2. Conservative correction: a gentle sharpen + mild colour/contrast lift
//      via sharp. No generative steps here — exposure and sharpness only.
// Either step failing returns the prior buffer, so cleanup never loses a frame.

import sharp from "sharp";

import { geminiImageEditConfigured } from "./config";
import { editImage } from "./gemini";

const OVERLAY_PROMPT =
  "Remove only the overlaid graphics from this image: on-screen text and " +
  "captions, subtitles, stickers, emojis, watermarks, logos, progress bars, " +
  "usernames, and Instagram/TikTok/Reels interface chrome. Cleanly reconstruct " +
  "the area behind them to match the surrounding photo. Do NOT add, remove, or " +
  "alter any real subject, product, person, or background detail. Do not change " +
  "the colours, crop, or composition. Return the cleaned photo at the same " +
  "aspect ratio.";

/** Conservative exposure/sharpness pass — no invented detail. */
export async function tidyImage(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer)
      .modulate({ saturation: 1.04, brightness: 1.02 })
      .linear(1.03, -3) // very mild contrast lift
      .sharpen({ sigma: 0.8 })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    return buffer;
  }
}

/** Best-effort generative removal of text/OST/reel chrome. */
export async function removeOverlays(
  buffer: Buffer,
  mimeType: string,
): Promise<Buffer> {
  if (!geminiImageEditConfigured()) return buffer;
  try {
    const edited = await editImage({ buffer, mimeType, prompt: OVERLAY_PROMPT });
    // Normalise back to JPEG so downstream (dedup, CDN) sees one format.
    return await sharp(edited.buffer).jpeg({ quality: 92 }).toBuffer();
  } catch {
    return buffer;
  }
}

export interface CleanupOptions {
  /** Run the generative overlay-removal step (default true). */
  removeChrome?: boolean;
}

/**
 * Clean a single frame: optional overlay removal, then a conservative
 * correction pass. Always returns a usable JPEG buffer.
 */
export async function cleanupFrame(
  buffer: Buffer,
  mimeType = "image/jpeg",
  options: CleanupOptions = {},
): Promise<Buffer> {
  const removeChrome = options.removeChrome ?? true;
  const deChromed = removeChrome
    ? await removeOverlays(buffer, mimeType)
    : buffer;
  return tidyImage(deChromed);
}
