import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const baseMetadata: Metadata = {
  title: "Afterglow — Private focus city",
  description: "A bilingual, local-first focus timer with installable Windows, Linux, and Android builds.",
  applicationName: "Afterglow",
  icons: { icon: [{ url: "/favicon.svg", type: "image/svg+xml" }, { url: "/icon-192.png", sizes: "192x192", type: "image/png" }], apple: "/icon-192.png" },
  openGraph: {
    title: "Afterglow — Make your work leave a light on",
    description: "A local-first desk companion that grows a city from your focus.",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "Afterglow", description: "Local-first focus, with native downloads on GitHub." },
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim() || (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  const image = new URL("/og.png", metadataBase).href;
  return {
    ...baseMetadata,
    metadataBase,
    openGraph: { ...baseMetadata.openGraph, images: [{ url: image, width: 1536, height: 1024, alt: "Afterglow local-first focus timer and native app download center" }] },
    twitter: { ...baseMetadata.twitter, images: [image] },
  };
}

export const viewport: Viewport = {
  themeColor: "#173238",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
