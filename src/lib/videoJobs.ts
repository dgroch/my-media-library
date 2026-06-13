import "server-only";

// Video→frames orchestration over the durable R2 queue (videoQueue.ts). The web
// service only enqueues (enqueueFrameJob) and reads status (getJob); the actual
// extract → select → cleanup → ingest work runs in the background worker via
// processNextJob (scripts/video-worker.ts), so a stalled or slow job can never
// block the web service or be lost to a redeploy.

import type { AssetMetadataInput } from "./assets";
import { cleanupFrame } from "./cleanup";
import { selectBestFrames } from "./frames";
import { ingestImage } from "./ingest";
import { extractCandidateFrames } from "./video";
import {
  claimNextJob,
  deleteSource,
  enqueue,
  getJob as queueGetJob,
  getSource,
  updateJob,
  videoQueueConfigured,
  type JobFrame,
  type VideoJob,
} from "./videoQueue";

export type { JobFrame, JobStatus, VideoJob } from "./videoQueue";
export { videoQueueConfigured };

export interface EnqueueFrameJobInput {
  videoBuffer: Buffer;
  ext: string;
  filename: string;
  metadata: AssetMetadataInput;
  onSimilar: "accept" | "reject";
  removeChrome: boolean;
}

/** Persist a frames job (clip + record) to the durable queue. Returns its id. */
export async function enqueueFrameJob(
  input: EnqueueFrameJobInput,
): Promise<string> {
  const job = await enqueue(
    {
      filename: input.filename,
      ext: input.ext,
      metadata: input.metadata,
      onSimilar: input.onSimilar,
      removeChrome: input.removeChrome,
    },
    input.videoBuffer,
  );
  return job.id;
}

export async function getJob(id: string): Promise<VideoJob | null> {
  return queueGetJob(id);
}

function baseName(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "") || "frame";
}

/**
 * Claim and fully process the next queued frames job. Returns the job id when
 * one was processed, or null when the queue was empty. Invoked by the worker.
 */
export async function processNextJob(): Promise<string | null> {
  const job = await claimNextJob();
  if (!job) return null;
  await runFrameJob(job);
  return job.id;
}

async function runFrameJob(job: VideoJob): Promise<void> {
  const t0 = Date.now();
  const tag = `[frames ${job.id.slice(0, 8)}]`;
  try {
    const videoBuffer = await getSource(job);
    await updateJob(job.id, { step: "Extracting frames…" });
    console.log(
      `${tag} extracting — ${job.filename} (${(videoBuffer.length / 1e6).toFixed(1)} MB, .${job.ext})`,
    );
    const { frames } = await extractCandidateFrames(videoBuffer, job.ext);
    console.log(`${tag} extracted ${frames.length} candidate frames (${Date.now() - t0}ms)`);
    if (frames.length === 0) {
      throw new Error("No frames could be extracted from the video.");
    }

    await updateJob(job.id, { step: "Selecting unique scenes & best shots…" });
    const selected = await selectBestFrames(frames);
    console.log(`${tag} selected ${selected.length} scenes`);
    if (selected.length === 0) {
      throw new Error("No usable scenes were found in the video.");
    }
    await updateJob(job.id, { totalScenes: selected.length });

    const base = baseName(job.filename);
    const filed: JobFrame[] = [];
    for (let i = 0; i < selected.length; i += 1) {
      const frame = selected[i];
      await updateJob(job.id, {
        step: `Cleaning up & filing scene ${i + 1} of ${selected.length}…`,
        processed: i,
      });
      console.log(`${tag} scene ${i + 1}/${selected.length} — cleanup + ingest`);
      const cleaned = await cleanupFrame(frame.buffer, "image/jpeg", {
        removeChrome: job.removeChrome,
      });
      const result = await ingestImage({
        sourceBytes: cleaned,
        image: cleaned,
        storedMime: "image/jpeg",
        ext: "jpg",
        filename: `${base}-scene-${String(i + 1).padStart(2, "0")}`,
        metadata: job.metadata,
        onSimilar: job.onSimilar,
      });
      if (result.kind === "created" || result.kind === "deduped") {
        filed.push({
          assetId: result.entry.id,
          url: result.entry.url,
          title: result.entry.title,
          t: frame.t,
          deduped: result.kind === "deduped",
          score: frame.score?.overall,
        });
        await updateJob(job.id, { frames: filed, processed: i + 1 });
      } else {
        await updateJob(job.id, { processed: i + 1 });
      }
    }

    await updateJob(job.id, {
      status: "done",
      step: "Done",
      processed: selected.length,
    });
    await deleteSource(job);
    console.log(
      `${tag} done — ${filed.length} filed in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    console.error(`${tag} FAILED after ${Date.now() - t0}ms —`, err);
    await updateJob(job.id, {
      status: "error",
      step: "Failed",
      error: err instanceof Error ? err.message : "Processing failed",
    });
    await deleteSource(job);
  }
}
