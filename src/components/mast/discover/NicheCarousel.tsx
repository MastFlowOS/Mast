import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { nicheImage, NICHE_IMAGE_FALLBACK } from "./nicheImages";

type Props = {
  /** The whole niche catalog, in display order. Search never removes cards. */
  niches: readonly string[];
  /** Niches matching the search box; the first one is glided to the centre. */
  matches: readonly string[];
  /** Everything currently selected (multi-select). */
  selected: string[];
  /** The most recently picked niche — the one brought into focus. */
  focused: string | null;
  query: string;
  onToggle: (niche: string) => void;
};

// Card geometry, as fractions of the strip width so exactly three cards fit:
// a big centre card and one smaller neighbour tucked behind it on each side.
// Anything further out is parked (invisible) behind the neighbours.
const CENTER_W = 0.40;
const SIDE_W = 0.28;
const OVERLAP = 0.035;
const CENTER_RATIO = 0.76; // height / width
const SIDE_RATIO = 0.82;
const LABEL_H = 30;
const CENTER_LABEL_H = 38;
const FALLBACK_W = 340;
const PAD_Y = 12; // room for the centre card's glow
const ARROW_INSET = 16; // strip margin so arrows only overlap the card corners

/** The carousel opens on the middle card so a neighbour shows on both sides. */
export const startIndex = (count: number) => Math.max(0, Math.floor((count - 1) / 2));

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Centre-focused image carousel.
 *
 * `center` is the card in the middle (larger, full brightness). Arrows, clicks
 * on a neighbour and search all just move `center`; the strip glides because
 * every card is positioned with a transitioned transform. Only cards within
 * reach of the visible strip are mounted, so only their images are requested
 * (and they are `loading="lazy"` too) — the other ~60 stay out of the DOM.
 * Selection is unchanged: click / Enter toggles via `onToggle`; selected cards
 * get the purple outline, glow and check.
 */
export function NicheCarousel({ niches, matches, selected, focused, query, onToggle }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef(new Map<string, HTMLButtonElement>());
  const prevSelectedCount = useRef(selected.length);
  const [width, setWidth] = useState(0);
  const [center, setCenter] = useState(() => {
    const i = focused ? niches.indexOf(focused) : -1;
    return i >= 0 ? i : startIndex(niches.length);
  });
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const wantFocus = useRef(false);

  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const last = niches.length - 1;
  const clamp = (i: number) => Math.max(0, Math.min(last, i));

  // Search → glide the first match to the middle.
  useEffect(() => {
    const first = matches[0];
    if (!query.trim() || !first) return;
    const i = niches.indexOf(first);
    if (i >= 0) setCenter(i);
  }, [query, matches, niches]);

  // A newly picked niche glides to the middle too.
  useEffect(() => {
    const grew = selected.length > prevSelectedCount.current;
    prevSelectedCount.current = selected.length;
    if (!grew || !focused) return;
    const i = niches.indexOf(focused);
    if (i >= 0) setCenter(i);
  }, [focused, selected.length, niches]);

  // Keep keyboard focus on the centre card while arrowing.
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    tileRefs.current.get(niches[center])?.focus();
  }, [center, niches]);

  const sw0 = width || FALLBACK_W;
  const cw = sw0 * CENTER_W;
  const ch = cw * CENTER_RATIO;
  const sw = sw0 * SIDE_W;
  const sh = sw * SIDE_RATIO;
  const stripH = ch + PAD_Y * 2;

  // Left edge of card i. The centre card is centred; the neighbours sit just
  // behind it; cards further out are parked under the neighbours (hidden).
  const xOf = (i: number) => {
    const cLeft = sw0 / 2 - cw / 2;
    if (i === center) return cLeft;
    return i < center ? cLeft + sw0 * OVERLAP - sw : cLeft + cw - sw0 * OVERLAP;
  };

  // Mount only what can be seen (+2 cards of runway each side).
  const reach = 2; // centre ± 1 are shown; ±2 are mounted so they glide in/out
  const from = clamp(center - reach);
  const to = clamp(center + reach);
  const visible = useMemo(() => niches.slice(from, to + 1), [niches, from, to]);

  const move = (delta: number) => setCenter((c) => clamp(c + delta));

  const onKeyDown = (e: React.KeyboardEvent) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      wantFocus.current = true;
      setCenter(e.key === "Home" ? 0 : last);
      return;
    }
    if (!delta) return;
    e.preventDefault();
    wantFocus.current = true;
    move(delta);
  };

  if (query.trim() && matches.length === 0) {
    return (
      <div
        style={{ height: stripH }}
        className="flex items-center justify-center rounded-2xl border border-dashed border-border/80 text-sm text-muted-foreground"
      >
        No niches match “{query}”
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={stripRef}
        role="group"
        aria-label="Business niches"
        onKeyDown={onKeyDown}
        style={{ height: stripH, marginInline: ARROW_INSET }}
        className="relative overflow-x-clip overflow-y-visible"
      >
        {visible.map((name, idx) => {
          const i = from + idx;
          const isCenter = i === center;
          const dist = Math.abs(i - center);
          const isSelected = selected.includes(name);
          const w = isCenter ? cw : sw;
          const h = isCenter ? ch : sh;
          return (
            <button
              key={name}
              ref={(el) => {
                if (el) tileRefs.current.set(name, el);
                else tileRefs.current.delete(name);
              }}
              type="button"
              aria-pressed={isSelected}
              aria-current={isCenter ? "true" : undefined}
              tabIndex={isCenter ? 0 : -1}
              aria-hidden={dist > 1 ? true : undefined}
              onClick={() => {
                // Same toggle as before; a neighbour also glides to the middle.
                setCenter(i);
                onToggle(name);
              }}
              style={{
                width: w,
                height: h,
                top: (stripH - h) / 2,
                transform: `translateX(${xOf(i)}px)`,
                opacity: dist === 0 ? 1 : dist === 1 ? 0.95 : 0,
                zIndex: isCenter ? 3 : dist === 1 ? 2 : 1,
                pointerEvents: dist > 1 ? "none" : undefined,
              }}
              className={cn(
                "group absolute left-0 flex cursor-pointer flex-col overflow-hidden rounded-[22px] border bg-card p-0 text-left outline-none",
                "transition-[transform,width,height,top,opacity,box-shadow,border-color] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                "hover:opacity-100 focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                isCenter
                  ? "border-2 border-brand shadow-[0_0_0_4px_color-mix(in_oklab,var(--brand)_16%,transparent),0_0_34px_-2px_color-mix(in_oklab,var(--brand)_65%,transparent)]"
                  : isSelected
                    ? "border-2 border-brand/80"
                    : "border-white/[0.08]",
              )}
            >
              <span className="relative min-h-0 flex-1 overflow-hidden">
                <img
                  src={nicheImage(name)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  onError={(e) => {
                    if (failed.has(name)) return;
                    setFailed((s) => new Set(s).add(name));
                    e.currentTarget.src = NICHE_IMAGE_FALLBACK;
                  }}
                  className={cn(
                    "absolute inset-0 size-full object-cover transition-[filter] duration-500",
                    !isCenter && "brightness-75 saturate-[0.85]",
                  )}
                />
                <span
                  aria-hidden="true"
                  className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent"
                />
              </span>
              <span
                style={{
                  height: isCenter ? CENTER_LABEL_H : LABEL_H,
                  // neighbours: centre the name in the part that isn't hidden behind the centre card
                  paddingLeft: !isCenter && i > center ? sw0 * OVERLAP : 0,
                  paddingRight: !isCenter && i < center ? sw0 * OVERLAP : 0,
                }}
                className="grid shrink-0 place-items-center overflow-hidden bg-card px-1.5 transition-[height] duration-500 motion-reduce:transition-none"
              >
                {/* Fixed size + transform scale: the name never re-wraps or jumps while gliding. */}
                <span
                  style={{ transform: `scale(${isCenter ? 1.12 : 0.82})` }}
                  className={cn(
                    "block max-w-full origin-center whitespace-nowrap text-center text-[16px] leading-none transition-[transform,color] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                    isCenter ? "font-semibold tracking-tight text-white" : "font-medium text-white/60",
                  )}
                >
                  {name}
                </span>
              </span>
              {isSelected && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute grid place-items-center rounded-full bg-brand text-brand-foreground shadow-[0_0_16px_color-mix(in_oklab,var(--brand)_75%,transparent)]",
                    isCenter ? "right-2.5 top-2.5 size-9" : "right-2 top-2 size-7",
                  )}
                >
                  <Check className={isCenter ? "size-5" : "size-4"} strokeWidth={3.5} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <ArrowButton side="left" disabled={center <= 0} onClick={() => move(-1)} />
      <ArrowButton side="right" disabled={center >= last} onClick={() => move(1)} />
    </div>
  );
}

function ArrowButton({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous niche" : "Next niche"}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "absolute top-[46%] z-10 grid size-9 -translate-y-1/2 place-items-center rounded-full border-[1.5px] border-white/20 bg-card/90 text-foreground shadow-md backdrop-blur transition-[opacity,color,border-color] duration-200",
        "hover:border-brand/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/70 outline-none",
        "disabled:pointer-events-none disabled:opacity-30",
        side === "left" ? "left-0" : "right-0",
      )}
    >
      <Icon className="size-4" strokeWidth={2.6} />
    </button>
  );
}
