import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Crypto Intelligence Terminal",
  description:
    "Real-time cryptocurrency technical, sentiment and derivative intelligence: transformer NLP, multi-factor confluence scoring and live derivative analytics.",
  applicationName: "Crypto Intelligence Terminal",
};

export const viewport: Viewport = {
  themeColor: "#020617",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-canvas">{children}</body>
    </html>
  );
}
