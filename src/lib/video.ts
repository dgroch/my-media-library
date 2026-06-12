import "server-only";

// Video frame extraction — the ffmpeg side of the video→frames pipeline. Uses
// the bundled static ffmpeg/ffprobe binaries (ffmpeg-static / ffprobe-static)
// so it works on Render's plain Node runtime with no system packages. Heavy and
// slow: only ever called from a background job (see videoJobs.ts), never inline
// in a request.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const run = promisify(execFile);

const FFMPEG = ffmpegPath as unknown as string;
const FFPROBE = ffprobeStatic.path;

// ffmpeg writes its frame/scene logs to stderr and can be chatty; give it room.
const MAX_BUFFER = 64 * 1024 * 1024;

export interface VideoMeta {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}

export interface ExtractedFrame {
  /** Source timestamp in seconds. */
  t: number;
  buffer: Buffer;
}

/** Probe container/stream metadata. */
export async function probeVideo(path: string): Promise<VideoMeta> {
  const { stdout } = await run(
    FFPROBE,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { maxBuffer: MAX_BUFFER },
  );
  const json = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
  };
  const video = json.streams?.find((s) => s.codec_type === "video");
  if (!video) throw new Error("No video stream found");
  const [num, den] = (video.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationSec: Number(json.format?.duration ?? 0),
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: den ? num / den : 0,
  };
}

/**
 * Scene-change timestamps via ffmpeg's `scene` score. Returns the seconds at
 * which the frame differs from the previous one by more than `threshold`
 * (0..1) — i.e. the cut points, which are the candidate "unique scenes".
 */
export async function detectSceneTimestamps(
  path: string,
  threshold = 0.3,
): Promise<number[]> {
  // showinfo prints one line per selected frame with `pts_time:<sec>`.
  const args = [
    "-i",
    path,
    "-vf",
    `select='gt(scene,${threshold})',showinfo`,
    "-f",
    "null",
    "-",
  ];
  let stderr = "";
  try {
    const res = await run(FFMPEG, args, { maxBuffer: MAX_BUFFER });
    stderr = res.stderr;
  } catch (err) {
    // ffmpeg can exit non-zero on `-f null` in some builds even when it printed
    // the info we need; fall back to whatever it wrote to stderr.
    stderr = (err as { stderr?: string }).stderr ?? "";
  }
  const times: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) times.push(t);
  }
  return times;
}

/**
 * Choose the timestamps to extract: the detected scene cuts, plus the first
 * frame and a uniform safety net, deduplicated and capped. This guarantees
 * coverage even for a single-shot clip with no detected cuts.
 */
export function planFrameTimestamps(
  meta: VideoMeta,
  scenes: number[],
  maxFrames = 24,
): number[] {
  const safeEnd = Math.max(0, meta.durationSec - 0.3);
  const uniformCount = Math.min(
    8,
    Math.max(3, Math.floor(meta.durationSec / 3) + 1),
  );
  const uniform: number[] = [];
  for (let i = 0; i < uniformCount; i += 1) {
    uniform.push((safeEnd * (i + 0.5)) / uniformCount);
  }

  const all = [0.2, ...scenes, ...uniform]
    .filter((t) => t >= 0 && t <= safeEnd)
    .sort((a, b) => a - b);

  // Collapse timestamps that land within ~0.4s of each other.
  const merged: number[] = [];
  for (const t of all) {
    if (merged.length === 0 || t - merged[merged.length - 1] > 0.4) {
      merged.push(Number(t.toFixed(2)));
    }
  }

  if (merged.length <= maxFrames) return merged;
  // Evenly thin to the cap, preserving spread.
  const step = merged.length / maxFrames;
  const thinned: number[] = [];
  for (let i = 0; i < maxFrames; i += 1) {
    thinned.push(merged[Math.floor(i * step)]);
  }
  return thinned;
}

/** Extract a single full-resolution JPEG frame at `t` seconds. */
async function extractOne(path: string, t: number, dir: string): Promise<Buffer> {
  const out = join(dir, `f_${Math.round(t * 1000)}.jpg`);
  // -ss before -i seeks fast (keyframe-accurate is fine for stills).
  await run(
    FFMPEG,
    ["-y", "-ss", String(t), "-i", path, "-frames:v", "1", "-q:v", "2", out],
    { maxBuffer: MAX_BUFFER },
  );
  return readFile(out);
}

/**
 * Decode a video buffer to a set of candidate frames. Writes the input to a
 * temp file (ffmpeg needs a seekable path), probes it, detects scenes, and
 * extracts the planned timestamps. The caller is responsible for selecting the
 * unique/best frames (see frames.ts).
 */
export async function extractCandidateFrames(
  videoBuffer: Buffer,
  ext = "mp4",
  maxFrames = 24,
): Promise<{ meta: VideoMeta; frames: ExtractedFrame[] }> {
  const dir = await mkdtemp(join(tmpdir(), "vid-"));
  const input = join(dir, `in.${ext}`);
  try {
    await writeFile(input, videoBuffer);
    const meta = await probeVideo(input);
    if (!meta.durationSec || meta.durationSec <= 0) {
      throw new Error("Could not read video duration");
    }
    const scenes = await detectSceneTimestamps(input);
    const timestamps = planFrameTimestamps(meta, scenes, maxFrames);
    const frames: ExtractedFrame[] = [];
    for (const t of timestamps) {
      try {
        frames.push({ t, buffer: await extractOne(input, t, dir) });
      } catch {
        // Skip an unreadable timestamp rather than failing the whole job.
      }
    }
    return { meta, frames };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
