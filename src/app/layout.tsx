import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Providers } from "@/components/providers";
import { Toaster } from "@/components/ui/toaster";
import "leaflet/dist/leaflet.css";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Geo Attendance",
  description: "Geo-location based attendance management",
  manifest: "/manifest.json",
};

// Separate `viewport` export — required by Next.js 14 metadata API.
// Disables pinch-zoom in the Capacitor WebView so the UI behaves like a
// native app. Also sets the theme color used by the Android status bar.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Matches --primary (hsl(245 58% 51%)) so the Android status bar tracks the theme.
  themeColor: "#463acb",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
