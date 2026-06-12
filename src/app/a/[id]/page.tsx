"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import AssetEditCard, { type ReviewEntry } from "@/components/AssetEditCard";
import SiteNav from "@/components/SiteNav";
import UploadAuthGate from "@/components/UploadAuthGate";

function Editor({ id }: { id: string }) {
  const [entry, setEntry] = useState<ReviewEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/assets/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load asset");
      setEntry(data as ReviewEntry);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load asset");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className="review-head">
        <div>
          <h1 className="page-title">Edit asset</h1>
          <p className="page-sub">
            Add the details Gemini can’t infer — who’s in the shot, the exact
            product, usage rights — and save to make them findable straight away.
          </p>
        </div>
        <Link href="/" className="btn">
          ← Back to search
        </Link>
      </div>

      {error && <div className="notice error">{error}</div>}
      {loading && <div className="center">Loading…</div>}
      {entry && (
        <div className="edit-list">
          <AssetEditCard entry={entry} />
        </div>
      )}
    </>
  );
}

export default function AssetEditPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  return (
    <>
      <SiteNav />
      <main>
        <div className="container">
          <UploadAuthGate>
            {id ? <Editor id={id} /> : <div className="notice">No asset id.</div>}
          </UploadAuthGate>
        </div>
      </main>
    </>
  );
}
