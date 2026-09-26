import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Stockback: every receipt buys you a piece of the company";

const LINES: [string, string, string][] = [
  ["AIRPODS PRO 2", "189.99", "AAPL"],
  ["KS WATER 40PK", "4.99", "COST"],
  ["CELSIUS 15CT", "24.99", "CELH"],
  ["NETFLIX.COM", "15.49", "NFLX"],
  ["COCA-COLA 35PK", "17.99", "VTI"],
];

export default function OG() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#f5efe3", padding: 64, fontFamily: "sans-serif", color: "#1c1a16" }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
          <div style={{ fontSize: 30, color: "#e8491d", fontWeight: 700 }}>stockback</div>
          <div style={{ fontSize: 68, fontWeight: 800, lineHeight: 1.02, marginTop: 14 }}>Every receipt buys you a piece of the company.</div>
          <div style={{ fontSize: 26, color: "#6d665a", marginTop: 26 }}>SERV Reasoning × stock tokens on Robinhood Chain</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", width: 420, marginLeft: 48, alignSelf: "center", background: "#fffef9", padding: 30, boxShadow: "0 10px 30px rgba(0,0,0,0.15)", transform: "rotate(2deg)" }}>
          {LINES.map(([d, a, t]) => (
            <div key={d} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: "monospace", fontSize: 20, padding: "12px 0", borderBottom: "1px dashed #d8cfbd" }}>
              <span>{d}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ color: "#6d665a" }}>{a}</span>
                <span style={{ background: "#1c1a16", color: "#f5efe3", borderRadius: 999, padding: "4px 12px", fontSize: 18 }}>{t}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
