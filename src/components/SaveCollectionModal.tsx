"use client";

import { useState } from "react";

interface Props {
  assetIds: string[];
  onClose: () => void;
  /** Called after a collection is created successfully. */
  onSaved: () => void;
}

export default function SaveCollectionModal({
  assetIds,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, assetIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      const url = `${window.location.origin}/c/${data.id}`;
      setShareUrl(url);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {shareUrl ? (
          <>
            <h2>Collection saved</h2>
            <p className="page-sub">
              Share this link with your agency — no login required.
            </p>
            <div className="link-row">
              <input className="share-link" readOnly value={shareUrl} />
              <button className="btn" onClick={copy}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="modal-actions">
              <a className="btn" href={shareUrl} target="_blank" rel="noreferrer">
                Open
              </a>
              <button className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Save collection ({assetIds.length})</h2>
            <label htmlFor="collection-name">Collection name</label>
            <input
              id="collection-name"
              className="search-input"
              autoFocus
              placeholder="e.g. Spring campaign — Agency X"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !saving) handleSave();
              }}
            />
            {error && (
              <div className="notice error" style={{ marginTop: 14 }}>
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? <span className="spinner" /> : "Save & get link"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
