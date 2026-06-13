// Background worker for the durable video→frames queue. Claims one job at a
// time from R2, runs the full extract → select → cleanup → ingest pipeline, and
// writes progress back to the job record — entirely off the web service.
//
// Reuses the app's pipeline modules directly. They `import "server-only"`, which
// only resolves to a no-op under the `react-server` export condition, so this is
// launched as:
//
//   node --conditions=react-server --import tsx scripts/video-worker.ts
//
// (see the `worker:video` npm script). Runs on a Render `type: worker` service;
// see render.yaml. Needs the same asset env as the web service (Notion, OpenAI,
// Gemini, the brand R2 creds) plus the queue R2 creds.

import { processNextJob } from "../src/lib/videoJobs";
import { videoQueueConfigured } from "../src/lib/videoQueue";

const IDLE_MS = Number(process.env.VIDEO_WORKER_IDLE_MS || "10000");

async function main(): Promise<void> {
  if (!videoQueueConfigured()) {
    console.error(
      "video-worker: queue storage not configured — set R2_* (or ASSET_R2_* / VIDEO_QUEUE_*).",
    );
    process.exit(1);
  }
  console.log(`video-worker: started (idle poll ${IDLE_MS}ms)`);

  // Drain continuously: when a job finishes, immediately look for the next one;
  // only sleep when the queue is empty.
  for (;;) {
    let processed = false;
    try {
      const id = await processNextJob();
      if (id) {
        processed = true;
        console.log(`video-worker: finished job ${id}`);
      }
    } catch (err) {
      console.error("video-worker: loop error —", err);
    }
    if (!processed) await new Promise((r) => setTimeout(r, IDLE_MS));
  }
}

main().catch((err) => {
  console.error("video-worker: fatal —", err);
  process.exit(1);
});
