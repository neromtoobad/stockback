import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Instrument_Serif, Geist_Mono } from "next/font/google";
import "./globals.css";

const sans = Plus_Jakarta_Sans({ variable: "--font-ui", subsets: ["latin"], weight: ["400", "500", "600", "700", "800"] });
const serif = Instrument_Serif({ variable: "--font-display", subsets: ["latin"], weight: "400", style: ["normal", "italic"] });
const mono = Geist_Mono({ variable: "--font-num", subsets: ["latin"] });

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
      <body className={`${sans.variable} ${serif.variable} ${mono.variable} antialiased`}>{children}</body>
    </html>
  );
}
