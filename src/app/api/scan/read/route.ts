import { NextResponse } from "next/server";
import { readReceipt } from "@/lib/pipeline";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { image?: string; text?: string };
    if (body.image) {
      if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(body.image)) return fail(new Error("Unsupported image format"), 400);
      if (body.image.length > 8_000_000) return fail(new Error("Image too large"), 413);
    } else if (!body.text?.trim()) {
      return fail(new Error("Send an image or receipt text"), 400);
    }
    const { data, trace } = await readReceipt({ imageDataUrl: body.image, text: body.text });
    return NextResponse.json({ receipt: data, trace });
  } catch (err) {
    return fail(err);
  }
}
