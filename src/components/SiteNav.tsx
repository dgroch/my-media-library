import Link from "next/link";

// Lightweight top nav for the secondary pages (upload, review). The home page
// keeps its own header because it also hosts the search box.

const LINKS = [
  { href: "/", label: "Search", key: "search" },
  { href: "/collections", label: "Collections", key: "collections" },
  { href: "/upload", label: "Upload", key: "upload" },
  { href: "/uploads", label: "Review", key: "review" },
];

export default function SiteNav({ active }: { active?: string }) {
  return (
    <header className="site-header">
      <div className="inner">
        <Link href="/" className="brand">
          Asset<span>Library</span>
        </Link>
        <nav className="nav">
          {LINKS.map((link) => (
            <Link
              key={link.key}
              href={link.href}
              className={`nav-link${active === link.key ? " active" : ""}`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
