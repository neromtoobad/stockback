// Browser-only helpers that turn a sample receipt into a photo-like JPEG, and shrink
// uploaded photos, so every input reaches SERV's vision step the same way.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function receiptSvg(lines: string[], width = 340): string {
  const lh = 17;
  const top = 26;
  const h = top + lines.length * lh + 34;
  const text = lines
    .map((l, i) => `<text x="18" y="${top + i * lh}" xml:space="preserve">${esc(l)}</text>`)
    .join("");
  // Torn bottom edge: zigzag from right to left.
  let teeth = "";
  for (let x = width; x > 0; x -= 12) teeth += `L${x - 6},${h} L${x - 12},${h - 7} `;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">
<path d="M0,0 H${width} V${h - 7} ${teeth} Z" fill="#fffef9"/>
<g font-family="'Courier New', Courier, monospace" font-size="12.5" fill="#23201b">${text}</g>
</svg>`;
}

export function svgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

// Render a receipt onto a slightly rotated, shadowed "counter top" so it looks like a photo.
export async function sampleToJpeg(lines: string[]): Promise<string> {
  const svg = receiptSvg(lines);
  const img = await loadImage(svgDataUrl(svg));
  const scale = 2;
  const pad = 40;
  const canvas = document.createElement("canvas");
  canvas.width = (img.width + pad * 2) * scale;
  canvas.height = (img.height + pad * 2) * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#8a7b66";
  ctx.fillRect(0, 0, img.width + pad * 2, img.height + pad * 2);
  ctx.translate(pad + img.width / 2, pad + img.height / 2);
  ctx.rotate(-0.012);
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  return canvas.toDataURL("image/jpeg", 0.88);
}

export async function fileToJpeg(file: File, maxSide = 1600): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const k = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * k);
    canvas.height = Math.round(img.height * k);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
