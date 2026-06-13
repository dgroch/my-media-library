import "server-only";

// In-memory job store + orchestration for the video→frames pipeline. A frames
// job is long (extract → select → clean → ingest each), so POST /api/videos
// starts one of these and returns immediately; the client polls
// GET /api/videos/jobs/:id for progress.
//
// State is per-process and in-memory: it survives the life of the web instance
// but not a redeploy or restart. That's fine for this internal, low-volume tool
// — a dropped job just means re-uploading the clip. Promote to a durable queue
// if this ever needs to be reliable across deploys.

import { randomUUID } from "node:crypto";

import { cleanupFrame } from "./cleanup";
import { selectBestFrames } from "./frames";
import { ingestImage } from "./ingest";
import type { AssetMetadataInput } from "./assets";
import { extractCandidateFrames } from "./video";

export type JobStatus = "processing" | "done" | "error";

export interface JobFrame {
  assetId: string;
  url: string;
  title: string;
  t: number;
  deduped: boolean;
  /** Gemini best-shot score, when scoring ran. */
  score?: number;
}

export interface VideoJob {
  id: string;
  status: JobStatus;
  filename: string;
  step: string;
  /** Selected scene count — known once selection finishes. */
  totalScenes: number;
  /** Frames ingested so far. */
  processed: number;
  frames: JobFrame[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const jobs = new Map<string, VideoJob>();

// Evict finished jobs after an hour so the map doesn't grow unbounded.
const TTL_MS = 60 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "processing" && now - job.updatedAt > TTL_MS) {
      jobs.delete(id);
    }
  }
}

export function getJob(id: string): VideoJob | undefined {
  return jobs.get(id);
}

function update(job: VideoJob, patch: Partial<VideoJob>) {
  Object.assign(job, patch, { updatedAt: Date.now() });
}

export interface FrameJobInput {
  videoBuffer: Buffer;
  ext: string;
  filename: string;
  metadata: AssetMetadataInput;
  onSimilar: "accept" | "reject";
  removeChrome: boolean;
}

/** Create a job and kick off processing (not awaited). Returns the job id. */
export function startFrameJob(input: FrameJobInput): string {
  sweep();
  const job: VideoJob = {
    id: randomUUID(),
    status: "processing",
    filename: input.filename,
    step: "Queued",
    totalScenes: 0,
    processed: 0,
    frames: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);
  // Fire-and-forget; errors are captured onto the job.
  void runFrameJob(job, input);
  return job.id;
}

function baseName(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "") || "frame";
}

async function runFrameJob(job: VideoJob, input: FrameJobInput): Promise<void> {
  const t0 = Date.now();
  const tag = `[frames ${job.id.slice(0, 8)}]`;
  try {
    update(job, { step: "Extracting frames…" });
    console.log(
      `${tag} extracting — ${input.filename} (${(input.videoBuffer.length / 1e6).toFixed(1)} MB, .${input.ext})`,
    );
    const { frames } = await extractCandidateFrames(input.videoBuffer, input.ext);
    console.log(`${tag} extracted ${frames.length} candidate frames (${Date.now() - t0}ms)`);
    if (frames.length === 0) {
      throw new Error("No frames could be extracted from the video.");
    }

    update(job, { step: "Selecting unique scenes & best shots…" });
    const selected = await selectBestFrames(frames);
    console.log(`${tag} selected ${selected.length} scenes`);
    if (selected.length === 0) {
      throw new Error("No usable scenes were found in the video.");
    }
    update(job, { totalScenes: selected.length });

    const base = baseName(input.filename);
    for (let i = 0; i < selected.length; i += 1) {
      const frame = selected[i];
      update(job, {
        step: `Cleaning up & filing scene ${i + 1} of ${selected.length}…`,
      });
      console.log(`${tag} scene ${i + 1}/${selected.length} — cleanup + ingest`);
      const cleaned = await cleanupFrame(frame.buffer, "image/jpeg", {
        removeChrome: input.removeChrome,
      });
      const result = await ingestImage({
        sourceBytes: cleaned,
        image: cleaned,
        storedMime: "image/jpeg",
        ext: "jpg",
        filename: `${base}-scene-${String(i + 1).padStart(2, "0")}`,
        metadata: input.metadata,
        onSimilar: input.onSimilar,
      });

      if (result.kind === "created" || result.kind === "deduped") {
        job.frames.push({
          assetId: result.entry.id,
          url: result.entry.url,
          title: result.entry.title,
          t: frame.t,
          deduped: result.kind === "deduped",
          score: frame.score?.overall,
        });
      }
      update(job, { processed: i + 1 });
    }

    update(job, { status: "done", step: "Done" });
    console.log(
      `${tag} done — ${job.frames.length} filed in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    console.error(`${tag} FAILED after ${Date.now() - t0}ms —`, err);
    update(job, {
      status: "error",
      step: "Failed",
      error: err instanceof Error ? err.message : "Processing failed",
    });
  }
}
