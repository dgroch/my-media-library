"use client";

import { useCallback, useEffect, useState } from "react";

import AssetEditCard, { type ReviewEntry } from "@/components/AssetEditCard";
import SiteNav from "@/components/SiteNav";
import UploadAuthGate from "@/components/UploadAuthGate";

function Review() {
  const [entries, setEntries] = useState<ReviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/assets/recent?limit=40");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load uploads");
      setEntries(data.results as ReviewEntry[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load uploads");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className="review-head">
        <div>
          <h1 className="page-title">Review uploads</h1>
          <p className="page-sub">
            Recent assets, newest first. Add the details Gemini can’t infer —
            who’s in the shot, the exact product, usage rights — and save to make
            them findable straight away.
          </p>
        </div>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? <span className="spinner" /> : "Refresh"}
        </button>
      </div>

      {error && <div className="notice error">{error}</div>}
      {loading && entries.length === 0 && (
        <div className="center">Loading uploads…</div>
      )}
      {!loading && entries.length === 0 && !error && (
        <div className="notice">No uploads yet. Add some on the Upload page.</div>
      )}

      <div className="edit-list">
        {entries.map((entry) => (
          <AssetEditCard
            key={entry.id}
            entry={entry}
            onDeleted={(id) =>
              setEntries((prev) => prev.filter((e) => e.id !== id))
            }
          />
        ))}
      </div>
    </>
  );
}

export default function ReviewPage() {
  return (
    <>
      <SiteNav active="review" />
      <main>
        <div className="container">
          <UploadAuthGate>
            <Review />
          </UploadAuthGate>
        </div>
      </main>
    </>
  );
}
