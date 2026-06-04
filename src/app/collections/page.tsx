import Link from "next/link";
import type { Metadata } from "next";

import { listCollections } from "@/lib/notion";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Collections — Asset Library",
};

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

export default async function CollectionsPage() {
  const collections = await listCollections().catch(() => null);

  return (
    <>
      <header className="site-header">
        <div className="inner">
          <Link href="/" className="brand">
            Asset<span>Library</span>
          </Link>
          <nav className="nav">
            <Link href="/" className="nav-link">
              Search
            </Link>
            <Link href="/collections" className="nav-link active">
              Collections
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <div className="container">
          <h1 className="page-title">Collections</h1>
          <p className="page-sub">
            Every saved collection, newest first. Open one to view or share it.
          </p>

          {collections === null ? (
            <div className="notice error">
              Couldn&rsquo;t load collections. Check that the Collections
              database is configured.
            </div>
          ) : collections.length === 0 ? (
            <div className="notice">
              No collections yet. Run a search, select some assets, and save a
              collection to see it here.
            </div>
          ) : (
            <ul className="collection-grid">
              {collections.map((c) => (
                <li key={c.id}>
                  <Link href={`/c/${c.id}`} className="collection-card">
                    <span className="collection-name">{c.name}</span>
                    <span className="collection-meta">
                      {c.assetCount}
                      {c.partialCount ? "+" : ""}{" "}
                      {c.assetCount === 1 ? "asset" : "assets"}
                      {c.createdTime && (
                        <>
                          {" · "}
                          {formatDate(c.createdTime)}
                        </>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
