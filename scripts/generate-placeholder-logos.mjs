/**
 * Skapar enkla cirkel-SVG med initialer för varje unikt lagnamn (slug).
 * Hoppar över ifk-olme.svg om filen redan finns (ersätt med egen klubbmärke).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { teamSlug, teamInitials } from "../src/lib/teamLogos.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "data.json"), "utf8"));

const names = new Set();
for (const m of data.matches || []) {
  const f = m.fixture;
  if (!f) continue;
  if (f.home) names.add(f.home);
  if (f.away) names.add(f.away);
}
for (const f of data.fixturesP11 || []) {
  if (f.home) names.add(f.home);
  if (f.away) names.add(f.away);
}

function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h) % 360;
}

const outDir = path.join(root, "public", "logos");
fs.mkdirSync(outDir, { recursive: true });

let n = 0;
for (const displayName of names) {
  const slug = teamSlug(displayName);
  if (!slug) continue;
  const outPath = path.join(outDir, `${slug}.svg`);
  if (slug === "ifk-olme" && fs.existsSync(outPath)) {
    const st = fs.statSync(outPath);
    if (st.size > 400) continue;
  }

  const initials = teamInitials(displayName).replace(/</g, "").slice(0, 2);
  const h = hue(slug);
  const fill = `hsl(${h} 44% 36%)`;
  const fill2 = `hsl(${h} 48% 28%)`;
  const safeLabel = displayName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="${safeLabel}">
  <defs>
    <linearGradient id="g-${slug}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${fill}"/>
      <stop offset="100%" style="stop-color:${fill2}"/>
    </linearGradient>
  </defs>
  <circle cx="32" cy="32" r="28" fill="url(#g-${slug})" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>
  <text x="32" y="40" text-anchor="middle" fill="#ffffff" font-size="18" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-weight="700">${initials}</text>
</svg>`;

  fs.writeFileSync(outPath, svg, "utf8");
  n++;
}

console.log(`Wrote ${n} logo files under public/logos/`);
