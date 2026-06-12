"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

import SiteNav from "@/components/SiteNav";
import UploadAuthGate from "@/components/UploadAuthGate";

type RowStatus = "queued" | "uploading" | "done" | "dedup" | "skipped" | "error";

interface Row {
  id: string;
  file: File;
  previewUrl: string;
  status: RowStatus;
  message?: string;
}

interface UploadResponse {
  deduped?: boolean;
  manifested?: boolean;
  manifest?: { overall_description?: string; visual_tags?: string[] } | null;
  similar?: Array<{ id: string }>;
  error?: string;
}

const ACCEPT = "image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif";
const CONCURRENCY = 2;

function summarise(res: UploadResponse): { status: RowStatus; message: string } {
  if (res.deduped) {
    return { status: "dedup", message: "Already in library — context merged." };
  }
  const tags = res.manifest?.visual_tags?.length ?? 0;
  const desc = res.manifest?.overall_description?.trim();
  if (res.manifested && desc) {
    const summary = desc.length > 140 ? `${desc.slice(0, 140)}…` : desc;
    const extra = tags ? ` · ${tags} tags` : "";
    const sim = res.similar?.length ? ` · ${res.similar.length} similar` : "";
    return { status: "done", message: `${summary}${extra}${sim}` };
  }
  const sim = res.similar?.length ? ` (${res.similar.length} similar found)` : "";
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
      .filter((f) => f.type.startsWith("image/") || /\.hei[cf]$/i.test(f.name))
      .map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()
          .toString(36)
          .slice(2, 7)}`,
        file,
        previewUrl: URL.createObjectURL(file),
        status: "queued" as RowStatus,
      }));
    setRows((prev) => [...prev, ...next]);
  }, []);

  function update(id: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function uploadOne(row: Row) {
    update(row.id, { status: "uploading", message: undefined });
    const form = new FormData();
    form.append("file", row.file);
    if (context.trim()) form.append("context", context.trim());
    if (uploadedBy.trim()) form.append("uploaded_by", uploadedBy.trim());
    if (source.trim()) form.append("source", source.trim());
    form.append("on_similar", onSimilar);
    try {
      const res = await fetch("/api/assets", { method: "POST", body: form });
      const data: UploadResponse = await res.json();
      if (res.status === 409) {
        update(row.id, {
          status: "skipped",
          message: "Skipped — a similar asset already exists.",
        });
        return;
      }
      if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
      update(row.id, summarise(data));
    } catch (err) {
      update(row.id, {
        status: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  async function start() {
    setRunning(true);
    const queue = rows.filter((r) => r.status === "queued" || r.status === "error");
    let cursor = 0;
    async function worker() {
      while (cursor < queue.length) {
        const row = queue[cursor++];
        await uploadOne(row);
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
        Add one or more photos. Each is de-duplicated, stored on the brand CDN,
        and run through Gemini to fill its AI description and tags. Add a person’s
        name or other context on the{" "}
        <Link href="/uploads" className="inline-link">
          review page
        </Link>{" "}
        afterwards. Video ingestion is coming in the next update.
      </p>

      <div className="upload-fields">
        <label>
          Shared context (optional)
          <input
            className="search-input"
            placeholder="e.g. Mother’s Day studio shoot, May 2026"
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
              onChange={(e) =>
                setOnSimilar(e.target.value as "accept" | "reject")
              }
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
          <strong>Drop photos here</strong> or click to choose. JPEG, PNG, WebP
          or HEIC.
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
            <button
              className="btn"
              onClick={() => setRows([])}
              disabled={running}
            >
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
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={row.previewUrl} alt="" className="upload-thumb" />
                <div className="upload-row-body">
                  <div className="upload-row-name">{row.file.name}</div>
                  <div className="upload-row-msg">
                    {row.message ?? statusLabel(row.status)}
                  </div>
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
