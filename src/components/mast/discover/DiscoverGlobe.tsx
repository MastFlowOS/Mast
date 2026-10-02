/**
 * Discover's hero visual: a globe wrapped in slowly travelling orbit lines.
 *
 * Layers, back to front:
 *   1. atmosphere  — static radial glow
 *   2. orbits (back half)  — CSS, continuous
 *   3. globe disk  — dark sphere (CSS) + canvas map (lazy) + light/rim overlays
 *   4. orbits (front half) — CSS, continuous
 *   5. selection chips — current niche and region, fade in when chosen
 *
 * The component is sized by the page through the `--g` custom property (globe
 * diameter), so rings, glow and chips all scale together. It is decorative:
 * everything in it is aria-hidden, and the real controls live in the cards.
 */
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { nicheIcon } from "./nicheVisuals";
import { OrbitRings } from "./OrbitRings";

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

export function DiscoverGlobe({ regions, niches, className }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);

  // Don't tick animations nobody can see (scrolled away, or a hidden tab's
  // layer): pause the orbits while the stage is offscreen.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setPaused(!entry.isIntersecting), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const region = summarize(regions);
  const niche = summarize(niches);
  const NicheIcon = niche ? nicheIcon(niche.label) : null;

  return (
    <div
      ref={stageRef}
      aria-hidden="true"
      data-paused={paused}
      className={`dg-stage pointer-events-none relative select-none ${className ?? ""}`}
      style={{ width: "var(--g)", height: "var(--g)" }}
    >
      {/* 1 — atmosphere */}
      <div
        className="absolute left-1/2 top-1/2 rounded-full"
        style={{
          width: "calc(var(--g) * 1.7)",
          height: "calc(var(--g) * 1.7)",
          transform: "translate(-50%, -50%)",
          background:
            "radial-gradient(closest-side, oklch(0.5 0.2 275 / 0.34), oklch(0.42 0.18 265 / 0.16) 48%, transparent 72%)",
        }}
      />

      {/* 2 — orbits behind the planet */}
      <OrbitRings side="back" />

      {/* 3 — the planet */}
      <div
        className="absolute inset-0 overflow-hidden rounded-full"
        style={{
          background: "radial-gradient(circle at 36% 30%, #1d2670, #0f1647 50%, #060a23 100%)",
          boxShadow:
            "0 0 0 1px oklch(0.75 0.1 270 / 0.28), 0 0 calc(var(--g) * 0.12) oklch(0.55 0.2 275 / 0.55), inset 0 0 calc(var(--g) * 0.08) oklch(0.6 0.15 265 / 0.35)",
        }}
      >
        <Suspense fallback={null}>
          <GlobeCanvas regions={regions} />
        </Suspense>
        {/* Terminator + vignette: lit from the upper left, falling off to the limb. */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              "radial-gradient(circle at 34% 28%, oklch(0.8 0.1 265 / 0.2), transparent 46%), radial-gradient(circle at 50% 50%, transparent 52%, oklch(0.1 0.04 270 / 0.78) 100%)",
          }}
        />
      </div>

      {/* 4 — orbits in front of the planet */}
      <OrbitRings side="front" />

      {/* 5 — what's currently selected */}
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
