import Link from "next/link";
import type { Metadata } from "next";

import CollectionsBrowser from "@/components/CollectionsBrowser";
import { listCollections } from "@/lib/notion";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Collections — Asset Library",
};

interface PageProps {
  searchParams: Promise<{ c?: string }>;
}

export default async function CollectionsPage({ searchParams }: PageProps) {
  const { c } = await searchParams;
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
          {collections === null ? (
            <div className="notice error">
              Couldn&rsquo;t load collections. Check that the Collections
              database is configured.
            </div>
          ) : collections.length === 0 ? (
            <>
              <h1 className="page-title">Collections</h1>
              <div className="notice">
                No collections yet. Run a search, select some assets, and save a
                collection to see it here.
              </div>
            </>
          ) : (
            <CollectionsBrowser
              collections={collections}
              initialSelectedId={c}
            />
          )}
        </div>
      </main>
    </>
  );
}
