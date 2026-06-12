"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

import SiteNav from "@/components/SiteNav";
import UploadAuthGate from "@/components/UploadAuthGate";

type RowStatus =
  | "queued"
  | "uploading"
  | "processing"
  | "done"
  | "dedup"
  | "skipped"
  | "error";

interface Row {
  id: string;
  file: File;
  kind: "image" | "video";
  previewUrl?: string;
  status: RowStatus;
  message?: string;
  // Video-only options + progress.
  choice: "frames" | "video";
  removeChrome: boolean;
  step?: string;
  processed?: number;
  totalScenes?: number;
}

interface UploadResponse {
  deduped?: boolean;
  manifested?: boolean;
  manifest?: { overall_description?: string; visual_tags?: string[] } | null;
  similar?: Array<{ id: string }>;
  error?: string;
}

interface JobResponse {
  status: "processing" | "done" | "error";
  step: string;
  totalScenes: number;
  processed: number;
  frames: Array<{ assetId: string }>;
  error?: string;
}

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/heic,image/heif";
const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-m4v,video/x-matroska";
const ACCEPT = `${IMAGE_ACCEPT},${VIDEO_ACCEPT},.heic,.heif,.mov,.mkv,.m4v`;
const CONCURRENCY = 2;

function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || /\.(mov|mkv|m4v|mp4|webm)$/i.test(file.name);
}

function summariseImage(res: UploadResponse): { status: RowStatus; message: string } {
  if (res.deduped) {
    return { status: "dedup", message: "Already in library — context merged." };
  }
  const tags = res.manifest?.visual_tags?.length ?? 0;
  const desc = res.manifest?.overall_description?.trim();
  const sim = res.similar?.length ? ` · ${res.similar.length} similar` : "";
  if (res.manifested && desc) {
    const summary = desc.length > 140 ? `${desc.slice(0, 140)}…` : desc;
    const extra = tags ? ` · ${tags} tags` : "";
    return { status: "done", message: `${summary}${extra}${sim}` };
  }
  return { status: "done", message: `Stored — no AI enrichment${sim}.` };
}

function Uploader() {
  const [rows, setRows] = useState<Row[]>([]);
  const [context, setContext] = useState("");
  const [uploadedBy, setUploadedBy] = useState("");
  const [source, setSource] = useState("");
  const [onSimilar, setOnSimilar] = useState<"accept" | "reject">("accept");
  const [running, setRunning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    const next: Row[] = Array.from(files)
      .filter((f) => f.type.startsWith("image/") || isVideoFile(f) || /\.hei[cf]$/i.test(f.name))
      .map((file) => {
        const kind = isVideoFile(file) ? "video" : "image";
        return {
          id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()
            .toString(36)
            .slice(2, 7)}`,
          file,
          kind,
          previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
          status: "queued" as RowStatus,
          choice: "frames" as const,
          removeChrome: true,
        };
      });
    setRows((prev) => [...prev, ...next]);
  }, []);

  function update(id: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function appendMetadata(form: FormData) {
    if (context.trim()) form.append("context", context.trim());
    if (uploadedBy.trim()) form.append("uploaded_by", uploadedBy.trim());
    if (source.trim()) form.append("source", source.trim());
    form.append("on_similar", onSimilar);
  }

  async function uploadImage(row: Row) {
    update(row.id, { status: "uploading", message: undefined });
    const form = new FormData();
    form.append("file", row.file);
    appendMetadata(form);
    try {
      const res = await fetch("/api/assets", { method: "POST", body: form });
      const data: UploadResponse = await res.json();
      if (res.status === 409) {
        update(row.id, { status: "skipped", message: "Skipped — a similar asset exists." });
        return;
      }
      if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
      update(row.id, summariseImage(data));
    } catch (err) {
      update(row.id, {
        status: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  async function uploadVideo(row: Row) {
    update(row.id, { status: "uploading", message: undefined, step: "Uploading…" });
    const form = new FormData();
    form.append("file", row.file);
    form.append("choice", row.choice);
    form.append("remove_chrome", String(row.removeChrome));
    appendMetadata(form);
    try {
      const res = await fetch("/api/videos", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);

      if (row.choice === "video") {
        update(row.id, {
          status: data.deduped ? "dedup" : "done",
          message: data.deduped
            ? "Already in library — context merged."
            : "Video stored.",
        });
        return;
      }

      const jobId: string = data.jobId;
      update(row.id, { status: "processing", step: "Extracting frames…" });
      await pollJob(row.id, jobId);
    } catch (err) {
      update(row.id, {
        status: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  async function pollJob(rowId: string, jobId: string) {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1600));
      const res = await fetch(`/api/videos/jobs/${jobId}`);
      const job: JobResponse & { error?: string } = await res.json();
      if (!res.ok) throw new Error(job.error ?? "Lost track of the job.");
      update(rowId, {
        step: job.step,
        processed: job.processed,
        totalScenes: job.totalScenes,
      });
      if (job.status === "done") {
        const n = job.frames.length;
        update(rowId, {
          status: "done",
          message: `Filed ${n} scene${n === 1 ? "" : "s"} from the video.`,
        });
        return;
      }
      if (job.status === "error") {
        update(rowId, { status: "error", message: job.error ?? "Processing failed." });
        return;
      }
    }
  }

  async function start() {
    setRunning(true);
    const queue = rows.filter((r) => r.status === "queued" || r.status === "error");
    let cursor = 0;
    async function worker() {
      while (cursor < queue.length) {
        const row = queue[cursor++];
        if (row.kind === "video") await uploadVideo(row);
        else await uploadImage(row);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
    );
    setRunning(false);
  }

  const pending = rows.filter(
    (r) => r.status === "queued" || r.status === "error",
  ).length;
  const completed = rows.filter(
    (r) => r.status === "done" || r.status === "dedup" || r.status === "skipped",
  ).length;

  return (
    <>
      <h1 className="page-title">Upload assets</h1>
      <p className="page-sub">
        Add photos or videos. Photos are de-duplicated, stored, and run through
        Gemini for an AI description and tags. For a video you choose whether to
        keep the whole clip or extract its best frames. Add a person’s name or
        other context on the{" "}
        <Link href="/uploads" className="inline-link">
          review page
        </Link>{" "}
        afterwards.
      </p>

      <div className="upload-fields">
        <label>
          Shared context (optional)
          <input
            className="search-input"
            placeholder="e.g. UGC creator reel, Mother’s Day 2026"
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />
        </label>
        <div className="upload-fields-row">
          <label>
            Uploaded by
            <input
              className="search-input"
              placeholder="you@figandbloom.com.au"
              value={uploadedBy}
              onChange={(e) => setUploadedBy(e.target.value)}
            />
          </label>
          <label>
            Source
            <input
              className="search-input"
              placeholder="e.g. UGC creator, in-house"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          <label>
            On near-duplicate
            <select
              className="search-input"
              value={onSimilar}
              onChange={(e) => setOnSimilar(e.target.value as "accept" | "reject")}
            >
              <option value="accept">Upload anyway</option>
              <option value="reject">Skip if similar exists</option>
            </select>
          </label>
        </div>
      </div>

      <div
        className={`dropzone${dragOver ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div className="dropzone-glyph">⬆</div>
        <p>
          <strong>Drop photos or videos here</strong> or click to choose. Images
          (JPEG/PNG/WebP/HEIC) and video (MP4/MOV/WebM/MKV).
        </p>
      </div>

      {rows.length > 0 && (
        <>
          <div className="upload-actions">
            <button
              className="btn btn-primary"
              onClick={start}
              disabled={running || pending === 0}
            >
              {running ? (
                <span className="spinner" />
              ) : (
                `Upload ${pending} ${pending === 1 ? "file" : "files"}`
              )}
            </button>
            <button className="btn" onClick={() => setRows([])} disabled={running}>
              Clear
            </button>
            {completed > 0 && (
              <Link href="/uploads" className="btn">
                Review {completed} uploaded →
              </Link>
            )}
          </div>

          <ul className="upload-list">
            {rows.map((row) => (
              <li key={row.id} className={`upload-row status-${row.status}`}>
                {row.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={row.previewUrl} alt="" className="upload-thumb" />
                ) : (
                  <div className="upload-thumb upload-thumb-video">🎬</div>
                )}
                <div className="upload-row-body">
                  <div className="upload-row-name">{row.file.name}</div>
                  <div className="upload-row-msg">
                    {row.status === "processing" && row.totalScenes
                      ? `${row.step} (${row.processed}/${row.totalScenes})`
                      : row.status === "processing"
                        ? row.step
                        : row.message ?? statusLabel(row.status)}
                  </div>
                  {row.kind === "video" &&
                    (row.status === "queued" || row.status === "error") && (
                      <div className="video-options">
                        <label className="seg">
                          <input
                            type="radio"
                            name={`choice-${row.id}`}
                            checked={row.choice === "frames"}
                            onChange={() => update(row.id, { choice: "frames" })}
                          />
                          Extract frames
                        </label>
                        <label className="seg">
                          <input
                            type="radio"
                            name={`choice-${row.id}`}
                            checked={row.choice === "video"}
                            onChange={() => update(row.id, { choice: "video" })}
                          />
                          Keep whole video
                        </label>
                        {row.choice === "frames" && (
                          <label className="seg">
                            <input
                              type="checkbox"
                              checked={row.removeChrome}
                              onChange={(e) =>
                                update(row.id, { removeChrome: e.target.checked })
                              }
                            />
                            Remove captions / reel chrome
                          </label>
                        )}
                      </div>
                    )}
                </div>
                <span className={`pill pill-${row.status}`}>
                  {statusLabel(row.status)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function statusLabel(status: RowStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "uploading":
      return "Uploading…";
    case "processing":
      return "Processing…";
    case "done":
      return "Done";
    case "dedup":
      return "Duplicate";
    case "skipped":
      return "Skipped";
    case "error":
      return "Error";
  }
}

export default function UploadPage() {
  return (
    <>
      <SiteNav active="upload" />
      <main>
        <div className="container narrow">
          <UploadAuthGate>
            <Uploader />
          </UploadAuthGate>
        </div>
      </main>
    </>
  );
}
