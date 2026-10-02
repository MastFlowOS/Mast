/**
 * Generates the static niche artwork in public/images/niches/*.svg and the
 * src/components/mast/discover/nicheImages.generated.ts file map.
 *
 * Every image shares one scene template (dark night-time interior, one accent
 * light, bokeh, floor reflection, a single hero glyph) so the carousel reads as
 * one set. To use real photos instead, drop a file in public/images/niches/
 * and change that niche's entry in nicheImages.ts — no other code changes.
 *
 * Usage:  npm i --no-save lucide-static && node scripts/generate-niche-images.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public/images/niches");
mkdirSync(outDir, { recursive: true });
const iconSvg = (name) =>
  readFileSync(join(root, "node_modules/lucide-static/icons", `${name}.svg`), "utf8")
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");

// [niche, lucide icon, accent hue]
const NICHES = [
  ["Accounting Firm", "calculator", 215],
  ["Advertising Agency", "megaphone", 330],
  ["Architecture Studio", "ruler", 200],
  ["Auto Dealership", "car", 5],
  ["Auto Repair", "wrench", 25],
  ["Bakery", "croissant", 32],
  ["Beauty Salon", "sparkles", 320],
  ["Branding Studio", "pen-tool", 285],
  ["Catering Company", "utensils-crossed", 20],
  ["Chiropractic Clinic", "bone", 175],
  ["Coffee Shop", "coffee", 28],
  ["Construction Company", "hard-hat", 42],
  ["Consulting Firm", "briefcase", 225],
  ["Coworking Space", "users", 255],
  ["Dental Clinic", "smile", 190],
  ["E-commerce", "shopping-cart", 265],
  ["Education Center", "graduation-cap", 240],
  ["Event Planning", "calendar-days", 310],
  ["Financial Advisor", "trending-up", 150],
  ["Fitness Studio", "activity", 350],
  ["Florist", "flower-2", 335],
  ["Food Truck", "truck", 38],
  ["Freelance Designer", "palette", 295],
  ["Funeral Home", "leaf", 160],
  ["Gym", "dumbbell", 355],
  ["Hair Salon", "scissors", 340],
  ["Health Clinic", "heart-pulse", 170],
  ["Home Improvement", "hammer", 35],
  ["Hotel", "bed-double", 45],
  ["HR Consulting", "handshake", 245],
  ["HVAC Company", "wind", 205],
  ["Insurance Agency", "shield-check", 220],
  ["Interior Design Studio", "sofa", 30],
  ["IT Services", "server", 250],
  ["Jewelry Store", "gem", 275],
  ["Landscaping", "tree-pine", 140],
  ["Law Firm", "scale", 235],
  ["Local Services", "store", 260],
  ["Logistics Company", "package", 48],
  ["Manufacturing", "factory", 22],
  ["Marketing Agency", "target", 325],
  ["Medical Clinic", "stethoscope", 180],
  ["Mortgage Broker", "key-round", 210],
  ["Moving Company", "forklift", 40],
  ["Music School", "music", 280],
  ["Non-profit", "heart-handshake", 345],
  ["Optometry Clinic", "eye", 195],
  ["Personal Trainer", "trophy", 12],
  ["Pet Services", "paw-print", 55],
  ["Photography Studio", "camera", 270],
  ["Physical Therapy", "person-standing", 165],
  ["Plumbing", "droplets", 205],
  ["Print Shop", "printer", 230],
  ["Property Management", "building-2", 215],
  ["Psychotherapy Practice", "brain", 290],
  ["Public Relations", "newspaper", 250],
  ["Real Estate", "house", 15],
  ["Recruitment Agency", "user-search", 240],
  ["Repair Services", "toolbox", 30],
  ["Restaurant", "utensils", 18],
  ["Retail", "shopping-bag", 300],
  ["Roofing", "land-plot", 10],
  ["SaaS Founders", "rocket", 262],
  ["Security Company", "shield", 225],
  ["Software Agency", "code-xml", 255],
  ["Spa & Wellness", "waves", 185],
  ["Sports Club", "medal", 8],
  ["Tax Services", "receipt", 150],
  ["Travel Agency", "plane", 200],
  ["Tutoring", "book-open", 235],
  ["Veterinary Clinic", "stethoscope", 50],
  ["Video Production", "video", 305],
  ["Web Design Agency", "globe", 220],
  ["Wedding Planner", "heart", 338],
  ["Yoga Studio", "flower", 170],
];

const slug = (n) =>
  n
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const hash = (s) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
};
const rng = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

function scene(name, icon, hue) {
  const r = rng(hash(name));
  const hsl = (h, s, l) => {
    h = (((h % 360) + 360) % 360) / 360;
    s /= 100;
    l /= 100;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s,
      p = 2 * l - q;
    const f = (t) => {
      t = (t + 1) % 1;
      return t < 1 / 6
        ? p + (q - p) * 6 * t
        : t < 0.5
          ? q
          : t < 2 / 3
            ? p + (q - p) * (2 / 3 - t) * 6
            : p;
    };
    return (
      "#" +
      [f(h + 1 / 3), f(h), f(h - 1 / 3)]
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
    );
  };
  const bokehDefs = [];
  const bokeh = Array.from({ length: 9 }, (_, i) => {
    const cx = 20 + r() * 290,
      cy = 15 + r() * 120,
      rad = 7 + r() * 20;
    const col = hsl(hue + (i % 3 === 0 ? 28 : i % 3 === 1 ? -12 : 4), 90, 62);
    bokehDefs.push(
      i % 2 === 0
        ? `<radialGradient id="b${i}"><stop offset="0" stop-color="${col}"/><stop offset="0.6" stop-color="${col}" stop-opacity="0.45"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>`
        : `<radialGradient id="b${i}"><stop offset="0.55" stop-color="${col}" stop-opacity="0.2"/><stop offset="0.85" stop-color="${col}" stop-opacity="0.75"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>`,
    );
    return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${rad.toFixed(0)}" fill="url(#b${i})" opacity="${(0.3 + r() * 0.5).toFixed(2)}"/>`;
  }).join("");
  const glyph = iconSvg(icon);
  const g = (extra, w, op, col) =>
    `<g transform="${extra}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" opacity="${op}">${glyph}</g>`;
  // 24-unit glyph scaled x4.6 ≈ 110px, centred at (165, 112)
  const place = "translate(110 57) scale(4.6)";
  const flip = "translate(110 213) scale(4.6 -4.6)";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 330 250" preserveAspectRatio="xMidYMid slice">
<title>${name.replace(/&/g, "and")}</title>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hsl(hue + 14, 38, 12)}"/><stop offset="1" stop-color="${hsl(hue + 24, 44, 4)}"/></linearGradient>
<radialGradient id="glow" cx="50%" cy="38%" r="55%"><stop offset="0" stop-color="${hsl(hue, 85, 52)}" stop-opacity="0.62"/><stop offset="1" stop-color="${hsl(hue, 85, 40)}" stop-opacity="0"/></radialGradient>
${bokehDefs.join("")}
<linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hsl(hue, 50, 20)}" stop-opacity="0.55"/><stop offset="1" stop-color="#05060d" stop-opacity="0.95"/></linearGradient>
<radialGradient id="vig" cx="50%" cy="45%" r="75%"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/></radialGradient>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<mask id="refl"><rect x="0" y="170" width="330" height="80" fill="url(#fade)"/></mask>
</defs>
<rect width="330" height="250" fill="url(#bg)"/>
<rect width="330" height="250" fill="url(#glow)"/>
${bokeh}
<rect y="170" width="330" height="80" fill="url(#floor)"/>
<rect y="169.5" width="330" height="1" fill="${hsl(hue, 90, 70)}" opacity="0.35"/>
<g mask="url(#refl)">${g(flip, 1.5, 0.22, hsl(hue, 90, 80))}</g>
${g(place, 2.4, 0.28, hsl(hue, 100, 70))}
${g(place, 1.25, 0.95, hsl(hue, 90, 92))}
<rect width="330" height="250" fill="url(#vig)"/>
</svg>
`;
}

const map = {};
for (const [name, icon, hue] of NICHES) {
  const file = `${slug(name)}.svg`;
  writeFileSync(join(outDir, file), scene(name, icon, hue));
  map[name] = file;
}
writeFileSync(join(outDir, "default.svg"), scene("Business", "store", 250));

const body = Object.entries(map)
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  .join("\n");
writeFileSync(
  join(root, "src/components/mast/discover/nicheImages.generated.ts"),
  `// Generated by scripts/generate-niche-images.mjs — niche name → file in public/images/niches/.\nexport const GENERATED_NICHE_FILES: Record<string, string> = {\n${body}\n};\n`,
);
console.log(`wrote ${NICHES.length} niche images`);
