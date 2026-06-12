"use client";

import { useState } from "react";

// One editable manifest row on the review page. Shows the AI enrichment
// (read-only, for reference) and lets a human author the fields Gemini can't
// know — a person's name, the product, rights — then PATCHes the change. The
// session cookie authorises the request (same-origin), so no token is handled
// here.

export interface PersonTag {
  name: string;
  consent?: boolean;
}

export interface ReviewEntry {
  id: string;
  title: string;
  url: string;
  description: string;
  mediaType: string;
  context: string;
  people: PersonTag[];
  product: string;
  location: string;
  shoot: string;
  credit: string;
  rights: { kind: string; notes: string };
  tags: string[];
  source: string;
  status?: string;
}

const RIGHTS = ["internal", "licensed", "restricted"];

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export default function AssetEditCard({ entry }: { entry: ReviewEntry }) {
  const [context, setContext] = useState(entry.context);
  const [people, setPeople] = useState(entry.people.map((p) => p.name).join(", "));
  const [consent, setConsent] = useState(
    entry.people.length > 0 && entry.people.every((p) => p.consent === true),
  );
  const [product, setProduct] = useState(entry.product);
  const [location, setLocation] = useState(entry.location);
  const [shoot, setShoot] = useState(entry.shoot);
  const [credit, setCredit] = useState(entry.credit);
  const [source, setSource] = useState(entry.source);
  const [tags, setTags] = useState(entry.tags.join(", "));
  const [rightsKind, setRightsKind] = useState(entry.rights.kind || "internal");
  const [rightsNotes, setRightsNotes] = useState(entry.rights.notes);

  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  function touched() {
    if (state !== "saving") setState("dirty");
  }

  function splitList(value: string): string[] {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function save() {
    setState("saving");
    setError(null);
    const names = splitList(people);
    const body = {
      context,
      product,
      location,
      shoot,
      credit,
      source,
      tags: splitList(tags),
      rights: { kind: rightsKind, notes: rightsNotes },
      people: names.map((name) =>
        consent ? { name, consent: true } : { name },
      ),
    };
    try {
      const res = await fetch(`/api/assets/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Save failed (${res.status})`);
      setState("saved");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  const isVideo = entry.mediaType === "video";

  return (
    <div className="edit-card">
      <div className="edit-card-media">
        {entry.url ? (
          <a href={entry.url} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={entry.url} alt={entry.title} loading="lazy" />
          </a>
        ) : (
          <div className="placeholder">
            <div className="placeholder-glyph">{isVideo ? "▶" : "🖼"}</div>
          </div>
        )}
        {entry.description ? (
          <p className="edit-card-ai">{entry.description}</p>
        ) : (
          <p className="edit-card-ai muted">No AI description yet.</p>
        )}
      </div>

      <div className="edit-card-form">
        <label>
          People (comma-separated names)
          <input
            className="search-input"
            placeholder="e.g. Kellie, Tom"
            value={people}
            onChange={(e) => {
              setPeople(e.target.value);
              touched();
            }}
          />
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => {
              setConsent(e.target.checked);
              touched();
            }}
          />
          Consent to publish these people
        </label>

        <label>
          Context
          <textarea
            className="search-input"
            rows={2}
            placeholder="Anything the classifier can’t know"
            value={context}
            onChange={(e) => {
              setContext(e.target.value);
              touched();
            }}
          />
        </label>

        <div className="edit-card-grid">
          <label>
            Product
            <input
              className="search-input"
              value={product}
              onChange={(e) => {
                setProduct(e.target.value);
                touched();
              }}
            />
          </label>
          <label>
            Location
            <input
              className="search-input"
              value={location}
              onChange={(e) => {
                setLocation(e.target.value);
                touched();
              }}
            />
          </label>
          <label>
            Shoot
            <input
              className="search-input"
              value={shoot}
              onChange={(e) => {
                setShoot(e.target.value);
                touched();
              }}
            />
          </label>
          <label>
            Credit
            <input
              className="search-input"
              value={credit}
              onChange={(e) => {
                setCredit(e.target.value);
                touched();
              }}
            />
          </label>
          <label>
            Source
            <input
              className="search-input"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                touched();
              }}
            />
          </label>
          <label>
            Rights
            <select
              className="search-input"
              value={rightsKind}
              onChange={(e) => {
                setRightsKind(e.target.value);
                touched();
              }}
            >
              {RIGHTS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label>
          Tags (comma-separated)
          <input
            className="search-input"
            value={tags}
            onChange={(e) => {
              setTags(e.target.value);
              touched();
            }}
          />
        </label>
        <label>
          Rights notes
          <input
            className="search-input"
            value={rightsNotes}
            onChange={(e) => {
              setRightsNotes(e.target.value);
              touched();
            }}
          />
        </label>

        <div className="edit-card-actions">
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={state === "saving" || state === "idle" || state === "saved"}
          >
            {state === "saving" ? <span className="spinner" /> : "Save"}
          </button>
          {state === "saved" && <span className="save-ok">Saved ✓</span>}
          {state === "error" && <span className="save-err">{error}</span>}
        </div>
      </div>
    </div>
  );
}
