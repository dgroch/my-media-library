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
  // Local copy so rename/delete update the list without a full page reload.
  const [list, setList] = useState<CollectionSummary[]>(collections);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId && collections.some((c) => c.id === initialSelectedId)
      ? initialSelectedId
      : (collections[0]?.id ?? null),
  );
  const [detail, setDetail] = useState<Collection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rename + delete UI state for the selected collection.
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Cache fetched collections so re-selecting one is instant.
  const cache = useRef<Map<string, Collection>>(new Map());

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => c.name.toLowerCase().includes(q));
  }, [filter, list]);

  // Keep the ?c=<id> query param in sync so a selection is bookmarkable.
  function syncUrl(id: string | null) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("c", id);
    else url.searchParams.delete("c");
    window.history.replaceState(null, "", url.toString());
  }

  const load = useCallback(async (id: string) => {
    setSelectedId(id);
    setRenaming(false);
    setConfirmingDelete(false);
    setActionError(null);
    syncUrl(id);

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

  function startRename() {
    if (!detail) return;
    setRenameValue(detail.name);
    setActionError(null);
    setRenaming(true);
  }

  async function saveRename() {
    if (!detail) return;
    const name = renameValue.trim();
    if (!name) {
      setActionError("Collection name cannot be empty.");
      return;
    }
    if (name === detail.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/collections/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to rename");

      const updated = { ...detail, name };
      setDetail(updated);
      cache.current.set(detail.id, updated);
      setList((prev) =>
        prev.map((c) => (c.id === detail.id ? { ...c, name } : c)),
      );
      setRenaming(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to rename");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!detail) return;
    const deletedId = detail.id;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/collections/${deletedId}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to delete");

      cache.current.delete(deletedId);
      setConfirmingDelete(false);

      // Pick the next selection from the current filtered order.
      const idx = filtered.findIndex((c) => c.id === deletedId);
      const remaining = filtered.filter((c) => c.id !== deletedId);
      const next = remaining[idx] ?? remaining[idx - 1] ?? null;

      setList((prev) => prev.filter((c) => c.id !== deletedId));

      if (next) {
        load(next.id);
      } else {
        setSelectedId(null);
        setDetail(null);
        syncUrl(null);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setBusy(false);
    }
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
          {filtered.length !== list.length ? ` of ${list.length}` : ""}{" "}
          {list.length === 1 ? "collection" : "collections"}
        </p>

        {list.length === 0 ? (
          <div className="notice">
            No collections left. Run a search, select some assets, and save a
            collection to see it here.
          </div>
        ) : filtered.length === 0 ? (
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
              <div className="browser-main-head-title">
                {renaming ? (
                  <div className="rename-row">
                    <input
                      className="search-input"
                      autoFocus
                      value={renameValue}
                      disabled={busy}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !busy) saveRename();
                        if (e.key === "Escape") setRenaming(false);
                      }}
                    />
                    <button
                      className="btn btn-primary"
                      onClick={saveRename}
                      disabled={busy}
                    >
                      {busy ? <span className="spinner" /> : "Save"}
                    </button>
                    <button
                      className="btn"
                      onClick={() => setRenaming(false)}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <h1 className="page-title">{detail.name}</h1>
                    <p className="page-sub">
                      {detail.items.length}{" "}
                      {detail.items.length === 1 ? "asset" : "assets"}
                    </p>
                  </>
                )}
              </div>

              {!renaming && (
                <div className="head-actions">
                  <button className="btn" onClick={startRename}>
                    Rename
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={() => {
                      setActionError(null);
                      setConfirmingDelete(true);
                    }}
                  >
                    Delete
                  </button>
                  <Link
                    href={`/c/${detail.id}`}
                    className="btn"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open share page ↗
                  </Link>
                </div>
              )}
            </div>

            {actionError && !confirmingDelete && (
              <div className="notice error" style={{ marginBottom: 16 }}>
                {actionError}
              </div>
            )}

            {detail.items.length === 0 ? (
              <div className="notice">This collection is empty.</div>
            ) : (
              <MasonryGrid assets={detail.items} />
            )}
          </>
        ) : null}
      </section>

      {confirmingDelete && detail && (
        <div
          className="modal-backdrop"
          onClick={() => !busy && setConfirmingDelete(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete collection?</h2>
            <p className="page-sub">
              “{detail.name}” will be removed. This also breaks any share links
              to it. The assets themselves are not affected.
            </p>
            {actionError && (
              <div className="notice error" style={{ marginTop: 4 }}>
                {actionError}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="btn"
                onClick={() => setConfirmingDelete(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={confirmDelete}
                disabled={busy}
              >
                {busy ? <span className="spinner" /> : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
