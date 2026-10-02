/**
 * Discover's hero visual: the supplied globe artwork (`discover-globe.png`)
 * with the selection overlay on top.
 *
 * Layers, back to front:
 *   1. artwork  — the PNG, shown as provided. It already contains the planet,
 *      atmosphere, stars and orbit lines, so nothing else draws any of those.
 *   2. overlay  — a canvas clipped to the artwork's planet that highlights the
 *      selected country/region and flies in on it (lazy; see GlobeCanvas).
 *   3. selection chips — current niche and region, fade in when chosen.
 *
 * The component is sized by the page through the `--g` custom property: the
 * planet's width in the artwork is `--g`, exactly the footprint the old globe
 * had, so the page layout is unchanged. The artwork is wider than the planet
 * (its orbit trails reach out to ~2.4 × `--g`); it overflows the stage and is
 * clipped by the page's hero container. It is decorative: everything here is
 * aria-hidden, and the real controls live in the cards.
 */
import { Suspense, lazy } from "react";
import { MapPin } from "lucide-react";
import globeArtUrl from "@/assets/discover-globe.png";
import { GLOBE_ART, GLOBE_ASPECT } from "./globeArt";
import { nicheIcon } from "./nicheVisuals";

// Pulls in d3-geo + the map data only after the form has rendered.
const GlobeCanvas = lazy(() => import("./GlobeCanvas"));

type Props = {
  /** Selected region tokens in pick order; the last one is the camera target. */
  regions: readonly string[];
  /** Selected niches in pick order; the last one is shown on the chip. */
  niches: readonly string[];
  className?: string;
};

function summarize(items: readonly string[]): { label: string; extra: number } | null {
  if (items.length === 0) return null;
  return { label: items[items.length - 1], extra: items.length - 1 };
}

// Artwork placement, in multiples of the planet's width (--g), so the planet
// in the PNG lands exactly on the stage's centre line and fills `--g`.
const ART_W = GLOBE_ART.w / (2 * GLOBE_ART.rx); // image width ÷ planet width
const ART_LEFT = 0.5 - (ART_W * GLOBE_ART.cx) / GLOBE_ART.w;
const ART_TOP = 0.5 - (ART_W * GLOBE_ART.cy) / GLOBE_ART.w;

export function DiscoverGlobe({ regions, niches, className }: Props) {
  const region = summarize(regions);
  const niche = summarize(niches);
  const NicheIcon = niche ? nicheIcon(niche.label) : null;

  return (
    <div
      aria-hidden="true"
      className={`dg-stage pointer-events-none relative select-none ${className ?? ""}`}
      style={{ width: "var(--g)", height: "var(--g)" }}
    >
      {/* 1 — the artwork, untouched: planet + atmosphere + stars + orbits */}
      <img
        src={globeArtUrl}
        alt=""
        width={GLOBE_ART.w}
        height={GLOBE_ART.h}
        draggable={false}
        decoding="async"
        className="absolute max-w-none"
        style={{
          width: `calc(var(--g) * ${ART_W})`,
          height: "auto",
          left: `calc(var(--g) * ${ART_LEFT})`,
          top: `calc(var(--g) * ${ART_TOP})`,
        }}
      />

      {/* 2 — selection overlay, clipped to the artwork's planet */}
      <div
        className="absolute left-0 overflow-hidden rounded-full"
        style={{
          width: "100%",
          height: `${GLOBE_ASPECT * 100}%`,
          top: `${((1 - GLOBE_ASPECT) / 2) * 100}%`,
        }}
      >
        <Suspense fallback={null}>
          <GlobeCanvas regions={regions} />
        </Suspense>
      </div>

      {/* 3 — what's currently selected */}
      {niche && NicheIcon && (
        <Chip key={`n-${niche.label}`} className="left-[-6%] top-[12%]">
          <span className="grid size-6 place-items-center rounded-lg bg-brand/20 text-brand">
            <NicheIcon className="size-3.5" />
          </span>
          <span className="max-w-[9rem] truncate">{niche.label}</span>
          {niche.extra > 0 && <span className="text-muted-foreground">+{niche.extra}</span>}
        </Chip>
      )}
      {region && (
        <Chip key={`r-${region.label}`} className="right-[-12%] top-[4%]">
          <span className="grid size-6 place-items-center rounded-lg bg-brand/20 text-brand">
            <MapPin className="size-3.5" />
          </span>
          <span className="max-w-[9rem] truncate">{region.label}</span>
          {region.extra > 0 && <span className="text-muted-foreground">+{region.extra}</span>}
        </Chip>
      )}
    </div>
  );
}

function Chip({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <div
      className={`animate-scale-in-fast absolute z-10 flex items-center gap-2 whitespace-nowrap rounded-xl border border-white/[0.09] px-2.5 py-1.5 text-xs font-semibold text-foreground shadow-[0_10px_30px_-12px_rgb(0_0_0/0.8)] ${className}`}
      style={{ background: "oklch(0.17 0.03 268 / 0.9)" }}
    >
      {children}
    </div>
  );
}
