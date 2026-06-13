import "server-only";

// Durable, R2-backed queue for the video→frames pipeline. Replaces the old
// in-memory job map so jobs survive redeploys and can be processed by a
// separate background worker (see scripts/video-worker.ts). Each job is two R2
// objects under `video-queue/<id>/`: `job.json` (status + progress) and
// `source.<ext>` (the uploaded clip). Single-worker model, so claiming is a
// simple read→mark-processing→write; a stale `processing` job (dead worker) is
// reclaimable after STALE_MS.

import { randomUUID } from "node:crypto";

import type { AssetMetadataInput } from "./assets";
import {
  r2DeleteObject,
  r2GetObject,
  r2ListObjects,
  r2PutObject,
  videoQueueR2Config,
  type R2Config,
} from "./r2";

export type JobStatus = "queued" | "processing" | "done" | "error";

export interface JobFrame {
  assetId: string;
  url: string;
  title: string;
  t: number;
  deduped: boolean;
  score?: number;
}

export interface VideoJob {
  id: string;
  status: JobStatus;
  filename: string;
  ext: string;
  // Pipeline params (not surfaced to the client, but needed by the worker).
  removeChrome: boolean;
  onSimilar: "accept" | "reject";
  metadata: AssetMetadataInput;
  // Progress.
  step: string;
  totalScenes: number;
  processed: number;
  frames: JobFrame[];
  error?: string;
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
}

const PREFIX = process.env.VIDEO_QUEUE_PREFIX || "video-queue/";
const STALE_MS = 30 * 60 * 1000; // reclaim a 'processing' job after this
const TERMINAL_TTL_MS = 2 * 60 * 60 * 1000; // sweep done/error jobs after this

export function videoQueueConfigured(): boolean {
  return videoQueueR2Config() !== null;
}

function cfg(): R2Config {
  const c = videoQueueR2Config();
  if (!c) {
    throw new Error(
      "Video queue storage is not configured (set R2_* / ASSET_R2_* / VIDEO_QUEUE_*).",
    );
  }
  return c;
}

const jobKey = (id: string) => `${PREFIX}${id}/job.json`;
const sourceKey = (id: string, ext: string) => `${PREFIX}${id}/source.${ext}`;

async function writeJob(c: R2Config, job: VideoJob): Promise<void> {
  await r2PutObject(c, jobKey(job.id), Buffer.from(JSON.stringify(job)), {
    contentType: "application/json",
    cacheControl: "no-store",
  });
}

export interface EnqueueParams {
  filename: string;
  ext: string;
  metadata: AssetMetadataInput;
  onSimilar: "accept" | "reject";
  removeChrome: boolean;
}

/** Store the clip + a queued job record. Returns the new job. */
export async function enqueue(
  params: EnqueueParams,
  video: Buffer,
): Promise<VideoJob> {
  const c = cfg();
  const id = randomUUID();
  await r2PutObject(c, sourceKey(id, params.ext), video, {
    contentType: "application/octet-stream",
  });
  const now = Date.now();
  const job: VideoJob = {
    id,
    status: "queued",
    filename: params.filename,
    ext: params.ext,
    removeChrome: params.removeChrome,
    onSimilar: params.onSimilar,
    metadata: params.metadata,
    step: "Queued",
    totalScenes: 0,
    processed: 0,
    frames: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeJob(c, job);
  return job;
}

export async function getJob(id: string): Promise<VideoJob | null> {
  try {
    const buf = await r2GetObject(cfg(), jobKey(id));
    return JSON.parse(buf.toString()) as VideoJob;
  } catch {
    return null;
  }
}

export async function updateJob(
  id: string,
  patch: Partial<VideoJob>,
): Promise<VideoJob | null> {
  const c = cfg();
  const job = await getJob(id);
  if (!job) return null;
  const merged = { ...job, ...patch, updatedAt: Date.now() };
  await writeJob(c, merged);
  return merged;
}

async function readAllJobs(c: R2Config): Promise<VideoJob[]> {
  const keys = (await r2ListObjects(c, PREFIX)).filter((k) =>
    k.endsWith("/job.json"),
  );
  const jobs: VideoJob[] = [];
  for (const k of keys) {
    try {
      jobs.push(JSON.parse((await r2GetObject(c, k)).toString()) as VideoJob);
    } catch {
      // skip unreadable
    }
  }
  return jobs;
}

/**
 * Claim the oldest queued (or stale-processing) job, marking it processing.
 * Also sweeps long-finished jobs. Returns null when there's nothing to do.
 */
export async function claimNextJob(): Promise<VideoJob | null> {
  const c = cfg();
  const jobs = await readAllJobs(c);
  const now = Date.now();

  // Opportunistic cleanup of old terminal jobs.
  for (const j of jobs) {
    if (
      (j.status === "done" || j.status === "error") &&
      now - j.updatedAt > TERMINAL_TTL_MS
    ) {
      await r2DeleteObject(c, jobKey(j.id)).catch(() => {});
      await r2DeleteObject(c, sourceKey(j.id, j.ext)).catch(() => {});
    }
  }

  const claimable = jobs
    .filter(
      (j) =>
        j.status === "queued" ||
        (j.status === "processing" && now - (j.claimedAt ?? 0) > STALE_MS),
    )
    .sort((a, b) => a.createdAt - b.createdAt);

  const job = claimable[0];
  if (!job) return null;
  const claimed: VideoJob = {
    ...job,
    status: "processing",
    claimedAt: now,
    updatedAt: now,
  };
  await writeJob(c, claimed);
  return claimed;
}

export async function getSource(job: VideoJob): Promise<Buffer> {
  return r2GetObject(cfg(), sourceKey(job.id, job.ext));
}

export async function deleteSource(job: VideoJob): Promise<void> {
  await r2DeleteObject(cfg(), sourceKey(job.id, job.ext)).catch(() => {});
}
