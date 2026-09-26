// Renders index.html frame by frame in headless Chrome and encodes with ffmpeg.
//   node render.mjs --stills 0,1.5,6.2            -> out/still-<t>.png
//   node render.mjs --mp4 [--workers 4] [--out f] -> out/stockback-reel.mp4
import puppeteer from "puppeteer-core";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const FF = ffmpegInstaller.path;

async function openPage() {
  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none"],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => (m.type() === "warn" || m.type() === "error") && console.log("[page]", m.text()));
  await page.goto("file://" + path.join(here, "index.html"), { waitUntil: "networkidle0" });
  await page.evaluate(() => window.READY);
  return { browser, page, total: await page.evaluate(() => window.TOTAL_FRAMES) };
}

async function shot(page, f) {
  await page.evaluate((n) => window.renderFrame(n), f);
  return page.screenshot({ type: "png", optimizeForSpeed: true });
}

function encoder(file) {
  const ff = spawn(FF, [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", "60", "-c:v", "png", "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p",
    "-profile:v", "high", "-level", "4.2", "-r", "60", "-g", "120", file,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  return ff;
}

if (args.includes("--audio")) {
  const { browser, page } = await openPage();
  const res = await page.evaluate(() => window.renderAudio());
  writeFileSync(path.join(out, "score.wav"), Buffer.from(res.wav, "base64"));
  console.log("score.wav written, pre-normalise peak", res.peak.toFixed(3));
  await browser.close();
} else if (args.includes("--stills")) {
  const { browser, page } = await openPage();
  for (const t of arg("--stills", "0").split(",").map(Number)) {
    writeFileSync(path.join(out, `still-${t.toFixed(2)}.png`), await shot(page, Math.round(t * 60)));
  }
  console.log("stills done");
  await browser.close();
} else {
  const workers = Number(arg("--workers", 4));
  const file = path.join(out, arg("--out", "stockback-reel.mp4"));
  const from = Math.round(Number(arg("--from", 0)) * 60);
  const started = Date.now();
  const probe = await openPage();
  const to = Math.min(probe.total, Math.round(Number(arg("--to", 60)) * 60));
  await probe.browser.close();
  const span = Math.ceil((to - from) / workers);
  const segs = [];
  await Promise.all(
    Array.from({ length: workers }, async (_, w) => {
      const a = from + w * span, b = Math.min(to, a + span);
      if (a >= b) return;
      const seg = path.join(out, `seg-${w}.mp4`);
      segs[w] = seg;
      const { browser, page } = await openPage();
      const ff = encoder(seg);
      for (let f = a; f < b; f++) {
        const buf = await shot(page, f);
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
        if ((f - a) % 300 === 0) console.log(`w${w} ${f - a}/${b - a}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
      }
      ff.stdin.end();
      await new Promise((r) => ff.on("close", r));
      await browser.close();
    }),
  );
  const list = path.join(out, "segs.txt");
  writeFileSync(list, segs.filter(Boolean).map((s) => `file '${s}'`).join("\n"));
  const score = path.join(out, "score.wav");
  const withAudio = args.includes("--with-audio");
  const concatArgs = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list];
  if (withAudio) concatArgs.push("-i", score, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-shortest");
  else concatArgs.push("-c", "copy");
  concatArgs.push("-movflags", "+faststart", file);
  await new Promise((r) => spawn(FF, concatArgs, { stdio: "inherit" }).on("close", r));
  segs.forEach((s) => s && rmSync(s));
  rmSync(list);
  console.log("wrote", file, `${((Date.now() - started) / 1000).toFixed(0)}s`);
}
