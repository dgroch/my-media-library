import "server-only";

// Frame selection — turns the raw candidate frames from video.ts into the
// handful worth keeping: one best shot per unique scene. Two stages:
//   1. Unique scenes — cluster near-identical frames by perceptual hash so a
//      held shot doesn't yield ten copies.
//   2. Best shot — within each scene, pick the strongest frame. Sharpness is a
//      cheap pre-filter; the actual pick is the Gemini frame score, which
//      judges subject prominence and composition (what sharpness can't see),
//      falling back to sharpness when Gemini is unavailable.

import sharp from "sharp";

import { geminiConfigured } from "./config";
import { scoreFrame, type FrameScore } from "./gemini";
import { hammingDistance, perceptualHash } from "./phash";
import type { ExtractedFrame } from "./video";

export interface SelectedFrame {
  t: number;
  buffer: Buffer;
  phash: string;
  sharpness: number;
  /** Gemini subject/composition score when available. */
  score?: FrameScore;
}

interface Scored extends ExtractedFrame {
  phash: string;
  sharpness: number;
  entropy: number;
}

// pHash Hamming distance at or under which two frames are "the same scene".
const SCENE_DISTANCE = 10;
// How many of a scene's sharpest frames to spend a Gemini score on.
const CANDIDATES_PER_SCENE = 3;
// Drop a scene whose best frame scores below this overall (transitions, blanks).
const MIN_OVERALL = 3;

async function measure(frame: ExtractedFrame): Promise<Scored> {
  const [phash, stats] = await Promise.all([
    perceptualHash(frame.buffer),
    sharp(frame.buffer).stats(),
  ]);
  return {
    ...frame,
    phash,
    sharpness: stats.sharpness ?? 0,
    entropy: stats.entropy ?? 0,
  };
}

/** Greedy cluster: a frame joins the first scene whose anchor it resembles. */
function clusterScenes(frames: Scored[]): Scored[][] {
  const scenes: Scored[][] = [];
  for (const frame of frames) {
    const scene = scenes.find(
      (s) => hammingDistance(s[0].phash, frame.phash) <= SCENE_DISTANCE,
    );
    if (scene) scene.push(frame);
    else scenes.push([frame]);
  }
  return scenes;
}

/** Pick the best frame of one scene. */
async function pickBest(scene: Scored[]): Promise<SelectedFrame | null> {
  const bySharpness = [...scene].sort((a, b) => b.sharpness - a.sharpness);

  if (!geminiConfigured()) {
    const best = bySharpness[0];
    return best
      ? { t: best.t, buffer: best.buffer, phash: best.phash, sharpness: best.sharpness }
      : null;
  }

  const candidates = bySharpness.slice(0, CANDIDATES_PER_SCENE);
  let best: { frame: Scored; score: FrameScore } | null = null;
  for (const frame of candidates) {
    try {
      const score = await scoreFrame({
        buffer: frame.buffer,
        mimeType: "image/jpeg",
      });
      if (!best || score.overall > best.score.overall) best = { frame, score };
    } catch {
      // Scoring failed — keep going; we fall back to sharpness below.
    }
  }

  if (best) {
    if (best.score.overall < MIN_OVERALL) return null; // weak scene, drop it
    return {
      t: best.frame.t,
      buffer: best.frame.buffer,
      phash: best.frame.phash,
      sharpness: best.frame.sharpness,
      score: best.score,
    };
  }

  const fallback = bySharpness[0];
  return fallback
    ? {
        t: fallback.t,
        buffer: fallback.buffer,
        phash: fallback.phash,
        sharpness: fallback.sharpness,
      }
    : null;
}

/**
 * Reduce candidate frames to one best shot per unique scene, chronological.
 * `maxScenes` caps how many make it through.
 */
export async function selectBestFrames(
  frames: ExtractedFrame[],
  maxScenes = 12,
): Promise<SelectedFrame[]> {
  if (frames.length === 0) return [];
  const measured = await Promise.all(frames.map(measure));
  const scenes = clusterScenes(measured);

  const picks: SelectedFrame[] = [];
  for (const scene of scenes) {
    const best = await pickBest(scene);
    if (best) picks.push(best);
  }

  picks.sort((a, b) => a.t - b.t);
  if (picks.length <= maxScenes) return picks;

  // Too many scenes — keep the highest-scoring, then restore time order.
  const ranked = [...picks].sort(
    (a, b) => (b.score?.overall ?? b.sharpness) - (a.score?.overall ?? a.sharpness),
  );
  return ranked.slice(0, maxScenes).sort((a, b) => a.t - b.t);
}
