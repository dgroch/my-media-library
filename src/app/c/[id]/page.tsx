import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import MasonryGrid from "@/components/MasonryGrid";
import { getCollection } from "@/lib/notion";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const collection = await getCollection(id).catch(() => null);
  return {
    title: collection ? `${collection.name} — Asset Library` : "Collection",
  };
}

export default async function CollectionPage({ params }: PageProps) {
  const { id } = await params;
  const collection = await getCollection(id).catch(() => null);

  if (!collection) notFound();

  return (
    <>
      <header className="site-header">
        <div className="inner">
          <Link href="/" className="brand">
            Asset<span>Library</span>
          </Link>
        </div>
      </header>

      <main>
        <div className="container">
          <h1 className="page-title">{collection.name}</h1>
          <p className="page-sub">
            {collection.items.length}{" "}
            {collection.items.length === 1 ? "asset" : "assets"}
          </p>

          {collection.items.length === 0 ? (
            <div className="notice">This collection is empty.</div>
          ) : (
            <MasonryGrid assets={collection.items} />
          )}
        </div>
      </main>
    </>
  );
}
