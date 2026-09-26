import { ImageResponse } from "next/og";
import { getRun } from "@/lib/store";
import { token } from "@/lib/tokens";
import { LOGO_URI, OG_BG, ogFonts, tickerLogoUri } from "@/lib/og";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OG({ params }: { params: Promise<{ id: string }> }) {
  const run = await getRun((await params).id);
  const fills = (run?.fills ?? []).filter((f) => !f.error).slice(0, 4);
  const names = fills.map((f) => token(f.ticker)?.name ?? f.ticker);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: OG_BG, padding: 56, fontFamily: "Jakarta", color: "#0a0212" }}>
        <div style={{ display: "flex", flexDirection: "column", width: 380, alignSelf: "center", background: "#fffef9", padding: 30, boxShadow: "0 20px 44px rgba(56,52,140,0.25)", transform: "rotate(-2deg)" }}>
          <div style={{ fontSize: 22, fontFamily: "monospace", letterSpacing: 2 }}>{(run?.merchant ?? "RECEIPT").toUpperCase().slice(0, 22)}</div>
          <div style={{ fontSize: 18, fontFamily: "monospace", marginTop: 8, color: "#6e6c8a" }}>{`${run?.receipt.currency ?? ""} ${run?.receipt.total.toLocaleString() ?? ""}`}</div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 20, gap: 8 }}>
            {(run?.receipt.items ?? []).slice(0, 8).map((it, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 16, fontFamily: "monospace" }}>
                <span>{it.description.slice(0, 22)}</span>
                <span>{it.amount.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 60, flex: 1, justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO_URI} width={50} height={50} alt="" />
            <div style={{ display: "flex", fontSize: 32, fontWeight: 700, letterSpacing: -1 }}>
              stock<span style={{ fontFamily: "Instrument", fontStyle: "italic", fontWeight: 400, color: "#5357c4", fontSize: 37 }}>back</span>
            </div>
            {run?.mode === "live" ? (
              <span style={{ marginLeft: 8, background: "#5ecba1", borderRadius: 8, padding: "4px 10px", fontSize: 18, fontWeight: 700 }}>LIVE ON-CHAIN</span>
            ) : null}
          </div>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 52, fontWeight: 700, lineHeight: 1.05, marginTop: 18, letterSpacing: -1.5 }}>
            <span>This receipt bought</span>
            <span style={{ fontFamily: "Instrument", fontStyle: "italic", fontWeight: 400, color: "#5357c4", fontSize: 60 }}>a piece of</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 22 }}>
            {fills.map((f) => {
              const logo = tickerLogoUri(f.ticker);
              return (
                <div key={f.ticker} style={{ display: "flex", alignItems: "center", gap: 12, background: "#0a0212", color: "#ffffff", borderRadius: 999, padding: "8px 20px 8px 8px", fontSize: 26 }}>
                  {logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo} width={42} height={42} style={{ borderRadius: 999 }} alt="" />
                  ) : null}
                  <span style={{ fontWeight: 700 }}>{f.ticker}</span>
                  <span style={{ color: "#5ecba1", fontSize: 22 }}>{`+$${f.usd.toFixed(2)}`}</span>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 22, fontWeight: 500, color: "#6e6c8a", marginTop: 22 }}>{names.join(" · ").slice(0, 80)}</div>
          <div style={{ fontSize: 19, fontWeight: 500, color: "#6e6c8a", marginTop: 10 }}>Stock tokens on Robinhood Chain · reasoned by SERV</div>
        </div>
      </div>
    ),
    { ...size, fonts: ogFonts() },
  );
}
