import { ImageResponse } from "next/og";
import { getRun } from "@/lib/store";
import { token } from "@/lib/tokens";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OG({ params }: { params: Promise<{ id: string }> }) {
  const run = await getRun((await params).id);
  const fills = (run?.fills ?? []).filter((f) => !f.error).slice(0, 5);
  const money = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(2)}`;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#f5efe3", padding: 56, fontFamily: "sans-serif", color: "#1c1a16" }}>
        <div style={{ display: "flex", flexDirection: "column", width: 400, background: "#fffef9", padding: 32, boxShadow: "0 10px 30px rgba(0,0,0,0.15)", transform: "rotate(-2deg)" }}>
          <div style={{ fontSize: 22, fontFamily: "monospace", letterSpacing: 2 }}>{(run?.merchant ?? "RECEIPT").toUpperCase().slice(0, 22)}</div>
          <div style={{ fontSize: 18, fontFamily: "monospace", marginTop: 8, color: "#6d665a" }}>{`${run?.receipt.currency ?? ""} ${run?.receipt.total.toLocaleString() ?? ""}`}</div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 20, gap: 8 }}>
            {(run?.receipt.items ?? []).slice(0, 7).map((it, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 16, fontFamily: "monospace" }}>
                <span>{it.description.slice(0, 22)}</span>
                <span>{it.amount.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 64, flex: 1, justifyContent: "center" }}>
          <div style={{ fontSize: 28, color: "#e8491d", fontWeight: 700 }}>stockback</div>
          <div style={{ fontSize: 54, fontWeight: 800, lineHeight: 1.05, marginTop: 12 }}>This receipt bought a piece of</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 24 }}>
            {fills.map((f) => (
              <div key={f.ticker} style={{ display: "flex", alignItems: "center", gap: 10, background: "#1c1a16", color: "#f5efe3", borderRadius: 999, padding: "10px 18px", fontSize: 28 }}>
                <span style={{ fontWeight: 700 }}>{f.ticker}</span>
                <span style={{ opacity: 0.7, fontSize: 22 }}>{money(f.usd)}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 22, color: "#6d665a", marginTop: 28 }}>
            {fills.map((f) => token(f.ticker)?.name ?? f.ticker).join(" · ")}
          </div>
          <div style={{ fontSize: 20, color: "#6d665a", marginTop: 16 }}>Stock tokens on Robinhood Chain · reasoned by SERV</div>
        </div>
      </div>
    ),
    size,
  );
}
