import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Asset Library",
  description: "Search the Brand Asset Manifest and build shareable collections.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
