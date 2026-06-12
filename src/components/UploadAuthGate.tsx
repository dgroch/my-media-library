"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

// Gates the in-app upload / review pages. Asks /api/session whether uploads are
// configured and whether this browser already holds a session cookie; if not,
// it collects the asset token once and exchanges it for the httpOnly cookie.
// The raw token is never stored in JS or component state beyond the keystroke.

type State = "loading" | "disabled" | "locked" | "ready";

export default function UploadAuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>("loading");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/session");
      const data = await res.json();
      if (!data.configured) setState("disabled");
      else if (data.authed) setState("ready");
      else setState("locked");
    } catch {
      setState("locked");
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sign in failed");
      setToken("");
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "loading") {
    return <div className="center">Checking access…</div>;
  }

  if (state === "disabled") {
    return (
      <div className="notice">
        Uploads are disabled on this deployment. Set{" "}
        <code>ASSET_LIBRARY_TOKEN</code> to enable the upload and review pages.
      </div>
    );
  }

  if (state === "ready") {
    return <>{children}</>;
  }

  return (
    <div className="gate">
      <h2>Sign in to upload</h2>
      <p className="page-sub">
        Enter the asset library token. It is exchanged for a secure session
        cookie and never stored in the browser.
      </p>
      <form onSubmit={submit}>
        <input
          className="search-input"
          type="password"
          placeholder="Asset library token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
        {error && <div className="notice error gate-error">{error}</div>}
        <button
          className="btn btn-primary gate-submit"
          type="submit"
          disabled={submitting || !token}
        >
          {submitting ? <span className="spinner" /> : "Sign in"}
        </button>
      </form>
    </div>
  );
}
