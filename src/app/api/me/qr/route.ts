import QRCode from "qrcode";
import { isAddress } from "viem";

export const runtime = "nodejs";

// QR for funding an agent wallet (the address only; wallets pick the network themselves).
export async function GET(req: Request) {
  const a = new URL(req.url).searchParams.get("a") ?? "";
  if (!isAddress(a)) return new Response("bad address", { status: 400 });
  const svg = await QRCode.toString(a, { type: "svg", margin: 1, color: { dark: "#0a0212", light: "#ffffff" } });
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
}
