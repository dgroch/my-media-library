"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import MasonryGrid from "@/components/MasonryGrid";
import SaveCollectionModal from "@/components/SaveCollectionModal";
import type { Asset, SearchResponse } from "@/lib/types";

export default function HomePage() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Asset[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showSave, setShowSave] = useState(false);

  const runSearch = useCallback(async (q: string, cursor?: string) => {
    const isMore = Boolean(cursor);
    if (isMore) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/search?${params.toString()}`);
      const data: SearchResponse & { error?: string } = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      setResults((prev) =>
        isMore ? [...prev, ...data.results] : data.results,
      );
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      if (!isMore) setResults([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setQuery(input);
    setSearched(true);
    runSearch(input);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <header className="site-header">
        <div className="inner">
          <Link href="/" className="brand">
            Asset<span>Library</span>
          </Link>
          <Link href="/collections" className="nav-link">
            Collections
          </Link>
          <Link href="/upload" className="nav-link">
            Upload
          </Link>
          <Link href="/uploads" className="nav-link">
            Review
          </Link>
          <form className="search-form" onSubmit={onSubmit}>
            <input
              className="search-input"
              placeholder="Describe what you want — e.g. cosy autumn bouquet, candid unboxing reel…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={loading}>
              {loading ? <span className="spinner" /> : "Search"}
            </button>
          </form>
        </div>
      </header>

      <main>
        <div className="container">
          {!searched && (
            <>
              <h1 className="page-title">Search the asset manifest</h1>
              <p className="page-sub">
                Semantic search across images and video. Describe what you need,
                select the assets you want, and save a shareable collection.
              </p>
            </>
          )}

          {error && <div className="notice error">{error}</div>}

          {loading && <div className="center">Searching…</div>}

          {!loading && searched && results.length === 0 && !error && (
            <div className="notice">
              No images matched “{query}”. Try a different term.
            </div>
          )}

          {results.length > 0 && (
            <>
              <MasonryGrid
                assets={results}
                selectable
                selectedIds={selected}
                onToggle={toggle}
              />
              {nextCursor && (
                <div className="load-more">
                  <button
                    className="btn"
                    onClick={() => runSearch(query, nextCursor)}
                    disabled={loadingMore}
                  >
                    {loadingMore ? <span className="spinner" /> : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {selected.size > 0 && (
        <div className="selection-bar">
          <span className="count">{selected.size} selected</span>
          <button className="btn" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button className="btn btn-primary" onClick={() => setShowSave(true)}>
            Save collection
          </button>
        </div>
      )}

      {showSave && (
        <SaveCollectionModal
          assetIds={[...selected]}
          onClose={() => setShowSave(false)}
          onSaved={() => setSelected(new Set())}
        />
      )}
    </>
  );
}
