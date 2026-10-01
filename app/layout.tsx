import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// ─── Ariadne's Thread [AT-0061] ─────────────────────
// What: Use only repository-bundled Geist fonts for the application shell
// Why:  Google Fonts TLS failures were able to block an otherwise valid production container build
// Date: 2026-09-30
// Related: [AT-0028] infra→wrangler.jsonc:CodeMarketContainer, Dockerfile:builder
// ─────────────────────────────────────────────────────
const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Code Market",
  description: "Re-imagine any website in seconds with AI-powered website builder.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans`}>
        {children}
      </body>
    </html>
  );
}
