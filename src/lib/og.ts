import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const font = (f: string) => readFileSync(path.join(root, "src", "assets", "fonts", f));

export function ogFonts() {
  return [
    { name: "Jakarta", data: font("jakarta-500.ttf"), weight: 500 as const, style: "normal" as const },
    { name: "Jakarta", data: font("jakarta-700.ttf"), weight: 700 as const, style: "normal" as const },
    { name: "Instrument", data: font("instrument-italic.ttf"), weight: 400 as const, style: "italic" as const },
  ];
}

export const LOGO_URI = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+CiAgPGRlZnM+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InNiLWJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMjMxYTQ0Ii8+PHN0b3Agb2Zmc2V0PSIuNTUiIHN0b3AtY29sb3I9IiMxMTBhMjQiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMwYTAyMTIiLz48L2xpbmVhckdyYWRpZW50PgogICAgPHJhZGlhbEdyYWRpZW50IGlkPSJzYi1nbG93IiBjeD0iLjIiIGN5PSIuMTUiIHI9Ii43NSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjNjU2OWQyIiBzdG9wLW9wYWNpdHk9Ii41NSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzY1NjlkMiIgc3RvcC1vcGFjaXR5PSIwIi8+PC9yYWRpYWxHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ic2ItcGFwZXIiIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNmZmZmZmYiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNlNmU4ZmIiLz48L2xpbmVhckdyYWRpZW50PgogIDwvZGVmcz4KICA8cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNSIgZmlsbD0idXJsKCNzYi1iZykiLz4KICA8cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNSIgZmlsbD0idXJsKCNzYi1nbG93KSIvPgogIDxnIHRyYW5zZm9ybT0icm90YXRlKC01IDMyIDMwKSB0cmFuc2xhdGUoMCAzKSI+CiAgICA8cGF0aCBkPSJNMTcuNSAxMi41YTMuNSAzLjUgMCAwIDEgMy41LTMuNWgyMGEzLjUgMy41IDAgMCAxIDMuNSAzLjV2MTYuNmwtNSA1LTQuOC0zLjUtNS42IDcuMy00LjktMy42LTYuNyA4LjZ6IiBmaWxsPSJ1cmwoI3NiLXBhcGVyKSIvPgogICAgPHJlY3QgeD0iMjIuNSIgeT0iMTUiIHdpZHRoPSIxMSIgaGVpZ2h0PSIzLjIiIHJ4PSIxLjYiIGZpbGw9IiM2NTY5ZDIiLz4KICAgIDxyZWN0IHg9IjIyLjUiIHk9IjIxLjIiIHdpZHRoPSIxNiIgaGVpZ2h0PSIyLjUiIHJ4PSIxLjI1IiBmaWxsPSIjMGEwMjEyIiBvcGFjaXR5PSIuMTQiLz4KICAgIDxyZWN0IHg9IjIyLjUiIHk9IjI2LjIiIHdpZHRoPSI5IiBoZWlnaHQ9IjIuNSIgcng9IjEuMjUiIGZpbGw9IiMwYTAyMTIiIG9wYWNpdHk9Ii4xNCIvPgogIDwvZz4KICA8ZyB0cmFuc2Zvcm09InJvdGF0ZSgtNSAzMiAzMCkgdHJhbnNsYXRlKDAgMykiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzVlY2JhMSIgc3Ryb2tlLXdpZHRoPSI0LjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+CiAgICA8cGF0aCBkPSJNMTcuNSA0Mi45bDYuNy04LjYgNC45IDMuNiA1LjYtNy4zIDQuOCAzLjUgNS01IDcuMi03LjMiLz4KICAgIDxwYXRoIGQ9Ik00NC45IDIxLjhoNi44djYuOCIvPgogIDwvZz4KPC9zdmc+Cg==";

export function tickerLogoUri(t: string): string | null {
  const f = path.join(root, "public", "logos", `${t}.png`);
  return existsSync(f) ? `data:image/png;base64,${readFileSync(f).toString("base64")}` : null;
}

export const OG_BG = "linear-gradient(135deg, #dfe6fd 0%, #e9e4fb 55%, #d9eef1 100%)";
