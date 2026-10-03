/**
 * Step 3 — Target Region.
 *
 * A flat country map on top (it pans/zooms to whatever is picked and lights the
 * selection up) and a compact dropdown below: the trigger shows the current
 * selection; opening it reveals a search box and then the country list.
 *
 * Selection rules are unchanged and still owned by the page: `onToggle` is the
 * page's toggleRegion (plan restrictions, Global handling, keep-at-least-one),
 * and `hasRegionalSearch` / `isLocalGeoToken` drive the lock icons. This card
 * only presents them.
 */
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { CheckSquare, ChevronDown, Globe2, Lock, MapPin, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { COUNTRIES, REGION_NAMES } from "@/lib/geo/countries";
import { GLOBAL_SCOPE, findCountryByName, isLocalGeoToken } from "@/lib/geo/scope";
import { StepCard } from "./DiscoverPanels";

// d3-geo + the atlas load only after the form has rendered.
const TargetRegionMap = lazy(() => import("./TargetRegionMap"));

/** Every supported country, A→Z (the same data discovery searches). */
const COUNTRY_NAMES: string[] = COUNTRIES.map((c) => c.name).sort((a, b) => a.localeCompare(b));

/** Broader scopes the backend also supports; offered under "Regions" while
 * searching so continent / Global capability is not lost. */
const BROAD_SCOPES: string[] = [...REGION_NAMES, GLOBAL_SCOPE];

/** Land fades out on all four sides: one gradient across, one down, intersected. */
const MAP_FADE =
  "linear-gradient(to right, transparent, #000 16%, #000 84%, transparent), linear-gradient(to bottom, transparent, #000 26%, #000 80%, transparent)";

type Props = {
  /** Selected scope tokens in pick order; the last one is what the map moves to. */
  regions: readonly string[];
  /** The page's toggleRegion: applies plan limits and the selection rules. */
  onToggle: (region: string) => void;
  hasRegionalSearch: boolean;
  className?: string;
};

export function TargetRegionCard({ regions, onToggle, hasRegionalSearch, className }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Search box takes focus the moment the dropdown opens.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const query = search.trim().toLowerCase();
  const matches = (r: string) => r.toLowerCase().includes(query);
  // Names that START with the query rank first ("u" → United …, Uganda …),
  // then the rest; both groups stay A→Z.
  const startsWith = (r: string) => r.toLowerCase().startsWith(query);
  const countries = COUNTRY_NAMES.filter(matches).sort((a, b) => Number(startsWith(b)) - Number(startsWith(a)));
  // Continents / Global only appear once the user is actually searching, so
  // the default list stays a pure country list.
  const broad = query ? BROAD_SCOPES.filter(matches) : [];
  const firstMatch = countries[0] ?? broad[0];

  const pick = (r: string) => {
    onToggle(r);
    setSearch("");
  };

  const close = () => {
    setOpen(false);
    setSearch("");
    triggerRef.current?.focus();
  };

  const current = regions[regions.length - 1];
  const extra = Math.max(0, regions.length - 1);
  const locked = (r: string) => !hasRegionalSearch && !isLocalGeoToken(r);

  return (
    <StepCard step={3} icon={MapPin} title="Target Region" className={className}>
      <div ref={containerRef} className="relative space-y-3">
        {/* The map — decorative; the dropdown below is the control. */}
        <div aria-hidden="true" className="relative aspect-[2.7/1] min-h-[88px] w-full">
          <div
            className="absolute inset-0 overflow-hidden rounded-xl"
            style={{
              // Land melts into the card at the edges, like the reference.
              maskImage: MAP_FADE,
              WebkitMaskImage: MAP_FADE,
              maskComposite: "intersect",
              WebkitMaskComposite: "source-in",
            }}
          >
            <Suspense fallback={null}>
              <TargetRegionMap regions={regions} />
            </Suspense>
          </div>
          {current && (
            <div
              key={current}
              className="animate-scale-in-fast absolute bottom-0 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-white/[0.12] px-2.5 py-0.5 text-[11px] font-semibold text-foreground shadow-[0_8px_22px_-10px_rgb(0_0_0/0.9)]"
              style={{ background: "oklch(0.17 0.03 268 / 0.92)" }}
            >
              {current}
              {extra > 0 && <span className="ml-1.5 text-muted-foreground">+{extra}</span>}
            </div>
          )}
        </div>

        {/* The dropdown */}
        <div className="relative">
          <button
            ref={triggerRef}
            type="button"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls="region-listbox"
            aria-label={`Target region: ${regions.join(", ")}`}
            onClick={() => setOpen((o) => !o)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
            className={cn(
              "flex h-11 w-full cursor-pointer items-center gap-2.5 rounded-xl border bg-black/25 px-3 text-left text-[13px] font-medium text-foreground outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-brand/45",
              open ? "border-brand/60" : "border-white/10 hover:border-white/25",
            )}
          >
            <RegionMark name={current} />
            <span className="min-w-0 flex-1 truncate">{current ?? "Select a country"}</span>
            {extra > 0 && <span className="shrink-0 text-xs text-muted-foreground">+{extra}</span>}
            <ChevronDown
              aria-hidden="true"
              className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
            />
          </button>

          {open && (
            <div className="absolute left-0 right-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
              {/* Search sits at the top of the dropdown… */}
              <div className="relative border-b border-border/60 p-2">
                <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchRef}
                  type="text"
                  aria-label="Search countries"
                  aria-controls="region-listbox"
                  aria-autocomplete="list"
                  placeholder="Search countries…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") close();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (firstMatch) {
                        pick(firstMatch);
                        setOpen(false);
                      }
                    }
                  }}
                  className="h-9 w-full rounded-lg border border-white/10 bg-black/25 pl-8 pr-3 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-brand focus:ring-2 focus:ring-brand/35"
                />
              </div>

              {/* …followed by the list. */}
              <div id="region-listbox" role="listbox" aria-multiselectable="true" className="max-h-52 overflow-y-auto">
                {countries.length + broad.length > 0 ? (
                  <>
                    {countries.map((r) => (
                      <RegionOption key={r} label={r} selected={regions.includes(r)} locked={locked(r)} onPick={() => pick(r)} />
                    ))}
                    {broad.length > 0 && (
                      <p className="border-t border-border/60 px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                        Regions
                      </p>
                    )}
                    {broad.map((r) => (
                      <RegionOption key={r} label={r} selected={regions.includes(r)} locked={locked(r)} onPick={() => pick(r)} />
                    ))}
                  </>
                ) : (
                  <div className="px-3 py-2.5 text-xs text-muted-foreground">No countries match "{search}"</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </StepCard>
  );
}

function RegionOption({
  label,
  selected,
  locked,
  onPick,
}: {
  label: string;
  selected: boolean;
  locked: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      // Keep focus in the search input between picks.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40",
        selected ? "font-medium text-brand" : "text-foreground",
        locked && "opacity-55",
      )}
    >
      <RegionMark name={label} small />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {locked ? (
        <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Locked on your plan" />
      ) : selected ? (
        <CheckSquare className="size-3.5 shrink-0 text-brand" />
      ) : null}
    </button>
  );
}

/** A country's flag, or a globe for Global / continents. */
function RegionMark({ name, small }: { name?: string; small?: boolean }) {
  const code = name ? findCountryByName(name)?.code : undefined;
  const [failed, setFailed] = useState(false);
  const w = small ? "w-4" : "w-5";

  if (!code) {
    return <Globe2 aria-hidden="true" className={cn("shrink-0 text-muted-foreground", small ? "size-4" : "size-5")} />;
  }
  if (failed) {
    // Offline / blocked CDN: fall back to the emoji flag.
    const emoji = [...code.toUpperCase()].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
    return (
      <span aria-hidden="true" className={cn("shrink-0 text-center leading-none", w, small ? "text-sm" : "text-base")}>
        {emoji}
      </span>
    );
  }
  const c = code.toLowerCase();
  return (
    <img
      src={`https://flagcdn.com/w40/${c}.png`}
      srcSet={`https://flagcdn.com/w40/${c}.png 1x, https://flagcdn.com/w80/${c}.png 2x`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className={cn("h-auto shrink-0 rounded-[3px] object-cover shadow-[0_0_0_1px_rgb(255_255_255/0.12)]", w)}
    />
  );
}
