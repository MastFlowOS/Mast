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

// Card geometry (px). The centre card is larger; neighbours are clipped by the strip.
const W = 124;
const H = 108;
const CW = 184;
const CH = 138;
const GAP = 18;
const STRIP_H = CH + 26;
// Soft fade where neighbours run out of the strip (reference: partly visible).
const EDGE_FADE =
  "linear-gradient(90deg, transparent 0, #000 72px, #000 calc(100% - 72px), transparent 100%)";

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
    return i >= 0 ? i : 0;
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

  // Left edge of card i (px from the strip's left), centre card centred.
  const xOf = (i: number) =>
    width / 2 - CW / 2 + (i - center) * (W + GAP) + (i > center ? CW - W : 0);

  // Mount only what can be seen (+2 cards of runway each side).
  const reach = Math.ceil(width / 2 / (W + GAP)) + 2;
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
        style={{ height: STRIP_H }}
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
        style={{ height: STRIP_H, maskImage: EDGE_FADE, WebkitMaskImage: EDGE_FADE }}
        className="relative overflow-hidden"
      >
        {visible.map((name, k) => {
          const i = from + k;
          const isCenter = i === center;
          const dist = Math.abs(i - center);
          const isSelected = selected.includes(name);
          const w = isCenter ? CW : W;
          const h = isCenter ? CH : H;
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
              onClick={() => {
                // Same toggle as before; a neighbour also glides to the middle.
                setCenter(i);
                onToggle(name);
              }}
              style={{
                width: w,
                height: h,
                top: (STRIP_H - h) / 2,
                transform: `translateX(${xOf(i)}px)`,
                opacity: isCenter ? 1 : dist === 1 ? 0.72 : 0.45,
                zIndex: isCenter ? 2 : 1,
              }}
              className={cn(
                "group absolute left-0 cursor-pointer overflow-hidden rounded-2xl border bg-card/60 p-0 text-left outline-none",
                "transition-[transform,width,height,top,opacity,box-shadow,border-color] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                "hover:opacity-100 focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                isSelected
                  ? "border-2 border-brand shadow-[0_0_0_1px_color-mix(in_oklab,var(--brand)_55%,transparent),0_0_30px_-2px_color-mix(in_oklab,var(--brand)_70%,transparent)]"
                  : "border-white/[0.08]",
              )}
            >
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
                className="absolute inset-0 size-full object-cover"
              />
              <span
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent"
              />
              <span
                className={cn(
                  "absolute inset-x-2 bottom-2.5 line-clamp-2 text-center font-medium leading-tight transition-[font-size,color] duration-500 motion-reduce:transition-none",
                  isCenter ? "text-[16px] text-white" : "text-[12px] text-white/65",
                )}
              >
                {name}
              </span>
              {isSelected && (
                <span
                  aria-hidden="true"
                  className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-brand text-brand-foreground shadow-[0_0_14px_color-mix(in_oklab,var(--brand)_75%,transparent)]"
                >
                  <Check className="size-4" strokeWidth={3.5} />
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
        "absolute top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-background/80 text-foreground/80 shadow-md backdrop-blur transition-[opacity,color,border-color] duration-200",
        "hover:border-brand/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/70 outline-none",
        "disabled:pointer-events-none disabled:opacity-30",
        side === "left" ? "left-1" : "right-1",
      )}
    >
      <Icon className="size-5" />
    </button>
  );
}
