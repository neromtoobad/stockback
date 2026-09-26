import type { Metadata, Viewport } from "next";
import { Urbanist, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const urbanist = Urbanist({ variable: "--font-urbanist", subsets: ["latin"], weight: ["400", "500", "600", "700", "800"] });
const mono = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3100"),
  title: "Stockback · own what you buy",
  description:
    "Snap a receipt. SERV Reasoning traces who profits from each purchase, applies your rules, and an agent wallet buys a sliver of those companies as stock tokens on Robinhood Chain.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0a0212" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${urbanist.variable} ${mono.variable} antialiased`}>{children}</body>
    </html>
  );
}
