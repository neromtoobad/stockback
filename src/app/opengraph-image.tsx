import { ImageResponse } from "next/og";
import { LOGO_URI, OG_BG, ogFonts, tickerLogoUri } from "@/lib/og";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Stockback: every receipt buys you a piece of the company";

const LINES: [string, string, string][] = [
  ["AIRPODS PRO 2", "189.99", "AAPL"],
  ["KS WATER 40PK", "4.99", "COST"],
  ["NETFLIX.COM", "15.49", "NFLX"],
  ["YOUTUBE PREMIUM", "13.99", "GOOGL"],
  ["COCA-COLA 35PK", "17.99", "VTI"],
];

export default function OG() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: OG_BG, padding: 64, fontFamily: "Jakarta", color: "#0a0212" }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO_URI} width={60} height={60} alt="" />
            <div style={{ display: "flex", fontSize: 38, fontWeight: 700, letterSpacing: -1 }}>
              stock<span style={{ fontFamily: "Instrument", fontStyle: "italic", fontWeight: 400, color: "#5357c4", fontSize: 44 }}>back</span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 66, fontWeight: 700, lineHeight: 1.02, marginTop: 26, letterSpacing: -2 }}>
            <span>Every receipt buys you</span>
            <span style={{ fontFamily: "Instrument", fontStyle: "italic", fontWeight: 400, color: "#5357c4", fontSize: 76, letterSpacing: -1 }}>a piece of the company.</span>
          </div>
          <div style={{ fontSize: 24, fontWeight: 500, color: "#6e6c8a", marginTop: 24 }}>SERV Reasoning × stock tokens on Robinhood Chain</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", width: 400, marginLeft: 40, alignSelf: "center", background: "#ffffff", borderRadius: 22, padding: "18px 24px", boxShadow: "0 24px 50px rgba(56,52,140,0.25)" }}>
          {LINES.map(([d, a, t]) => {
            const logo = tickerLogoUri(t);
            return (
              <div key={d} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 19, padding: "12px 0", borderBottom: "1px dashed #d9dbf3" }}>
                <span style={{ fontFamily: "monospace" }}>{d}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ color: "#6e6c8a", fontFamily: "monospace" }}>{a}</span>
                  {logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo} width={30} height={30} style={{ borderRadius: 999 }} alt="" />
                  ) : null}
                </span>
              </div>
            );
          })}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, fontSize: 20, fontWeight: 700 }}>
            <span>Stock-back</span>
            <span style={{ background: "#5ecba1", borderRadius: 8, padding: "4px 12px" }}>+$1.00</span>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: ogFonts() },
  );
}
