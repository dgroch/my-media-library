"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Collection, CollectionSummary } from "@/lib/types";

import MasonryGrid from "./MasonryGrid";

interface Props {
  collections: CollectionSummary[];
  initialSelectedId?: string;
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function CollectionsBrowser({
  collections,
  initialSelectedId,
}: Props) {
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId && collections.some((c) => c.id === initialSelectedId)
      ? initialSelectedId
      : (collections[0]?.id ?? null),
  );
  const [detail, setDetail] = useState<Collection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cache fetched collections so re-selecting one is instant.
  const cache = useRef<Map<string, Collection>>(new Map());

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return collections;
    return collections.filter((c) => c.name.toLowerCase().includes(q));
  }, [filter, collections]);

  const load = useCallback(async (id: string) => {
    setSelectedId(id);

    // Keep the URL in sync so a selected collection is bookmarkable/shareable.
    const url = new URL(window.location.href);
    url.searchParams.set("c", id);
    window.history.replaceState(null, "", url.toString());

    const cached = cache.current.get(id);
    if (cached) {
      setDetail(cached);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setDetail(null);
    try {
      const res = await fetch(`/api/collections/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load collection");
      cache.current.set(id, data);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load collection");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load the initial selection on mount.
  useEffect(() => {
    if (selectedId) load(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arrow-key navigation down/up the (filtered) list.
  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (filtered.length === 0) return;
    e.preventDefault();
    const idx = filtered.findIndex((c) => c.id === selectedId);
    const delta = e.key === "ArrowDown" ? 1 : -1;
    const nextIdx =
      idx === -1
        ? 0
        : Math.min(filtered.length - 1, Math.max(0, idx + delta));
    const next = filtered[nextIdx];
    if (next) load(next.id);
  }

  return (
    <div className="browser">
      <aside className="browser-aside">
        <input
          className="search-input"
          placeholder="Filter collections…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <p className="browser-count">
          {filtered.length}
          {filtered.length !== collections.length ? ` of ${collections.length}` : ""}{" "}
          {collections.length === 1 ? "collection" : "collections"}
        </p>

        {filtered.length === 0 ? (
          <div className="notice">No collections match “{filter}”.</div>
        ) : (
          <ul
            className="collection-list"
            tabIndex={0}
            onKeyDown={onListKeyDown}
          >
            {filtered.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`collection-list-item${
                    c.id === selectedId ? " active" : ""
                  }`}
                  onClick={() => load(c.id)}
                  aria-current={c.id === selectedId}
                >
                  <span className="collection-list-name">{c.name}</span>
                  <span className="collection-list-meta">
                    {c.assetCount}
                    {c.partialCount ? "+" : ""}{" "}
                    {c.assetCount === 1 ? "asset" : "assets"}
                    {c.createdTime && <> · {formatDate(c.createdTime)}</>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="browser-main">
        {!selectedId ? (
          <div className="center">Select a collection to view its assets.</div>
        ) : loading ? (
          <div className="center">Loading…</div>
        ) : error ? (
          <div className="notice error">{error}</div>
        ) : detail ? (
          <>
            <div className="browser-main-head">
              <div>
                <h1 className="page-title">{detail.name}</h1>
                <p className="page-sub">
                  {detail.items.length}{" "}
                  {detail.items.length === 1 ? "asset" : "assets"}
                </p>
              </div>
              <Link
                href={`/c/${detail.id}`}
                className="btn"
                target="_blank"
                rel="noreferrer"
              >
                Open share page ↗
              </Link>
            </div>

            {detail.items.length === 0 ? (
              <div className="notice">This collection is empty.</div>
            ) : (
              <MasonryGrid assets={detail.items} />
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}
