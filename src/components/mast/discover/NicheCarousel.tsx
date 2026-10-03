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
const LABEL_H = 32;
const FALLBACK_W = 340;
const PAD_Y = 12; // room for the centre card's glow
const ARROW_INSET = 16; // strip margin so arrows only overlap the card corners
const SIDE_SCALE = SIDE_W / CENTER_W; // side cards are the centre card, scaled
const REACH = 3; // cards mounted either side of the glide, so they are ready before they appear
const SPRING_W = 13; // spring stiffness (rad/s): higher = snappier
const FADE_OUT = 0.7; // cards past the neighbours fade out over this many card-steps
const PARK_GAP = 0.1; // …while drifting this fraction of a side-card width further out

/** The carousel opens on the middle card so a neighbour shows on both sides. */
export const startIndex = (count: number) => Math.max(0, Math.floor((count - 1) / 2));

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Centre-focused image carousel with a continuous glide.
 *
 * `center` is the card the user has asked for. A critically-damped spring moves a
 * fractional position `pos` toward it every animation frame, and each card's
 * transform / opacity / emphasis is a pure function of its distance from `pos`.
 * So a card is never "switched" between a big and a small state: it is scaled and
 * slid continuously, and rapid clicks just redirect the spring (momentum carries
 * through) instead of restarting a CSS transition.
 *
 * Only compositor properties (transform, opacity) change per frame; card sizes
 * are fixed, and frames are written straight to the DOM so React does not
 * re-render during the glide. Only cards near the glide are mounted.
 */
export function NicheCarousel({ niches, matches, selected, focused, query, onToggle }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef(new Map<string, HTMLButtonElement>());
  const cardRefs = useRef(new Map<number, HTMLDivElement>());
  const prevSelectedCount = useRef(selected.length);
  const [width, setWidth] = useState(0);
  const [center, setCenter] = useState(() => {
    const i = focused ? niches.indexOf(focused) : -1;
    return i >= 0 ? i : startIndex(niches.length);
  });
  const [anchor, setAnchor] = useState(center);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const wantFocus = useRef(false);

  const pos = useRef(center);
  const vel = useRef(0);
  const raf = useRef<number | null>(null);
  const target = useRef(center);
  target.current = center;

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

  const sw0 = width || FALLBACK_W;
  const cw = sw0 * CENTER_W;
  const ch = cw * CENTER_RATIO + LABEL_H;
  const sw = cw * SIDE_SCALE;
  const stripH = ch + PAD_Y * 2;
  // Centre-to-centre distance between the middle card and a neighbour.
  const sideOffset = cw / 2 - sw0 * OVERLAP + sw / 2;

  const from = clamp(anchor - REACH);
  const to = clamp(anchor + REACH);
  const visible = useMemo(() => niches.slice(from, to + 1), [niches, from, to]);

  // Latest geometry + selection, read by the animation loop without re-subscribing.
  const live = useRef({ sw0, cw, sideOffset, selected, from, to });
  live.current = { sw0, cw, sideOffset, selected, from, to };

  /** Write every mounted card's transform / emphasis for a fractional centre position. */
  const apply = (p: number) => {
    const { sw0, cw, sideOffset, selected, from, to } = live.current;
    for (let i = from; i <= to; i++) {
      const el = cardRefs.current.get(i);
      if (!el) continue;
      const d = i - p;
      const ad = Math.abs(d);
      const dir = d < 0 ? -1 : 1;
      const e = smooth(Math.min(ad, 1)); // 0 = centre … 1 = neighbour
      const c = 1 - e; // how "centre" this card is
      const scale = 1 - (1 - SIDE_SCALE) * e;
      const off = dir * (sideOffset * e + Math.max(0, ad - 1) * sw0 * SIDE_W * PARK_GAP);
      const opacity = ad <= 1 ? 1 - 0.05 * ad : Math.max(0, 0.95 * (1 - (ad - 1) / FADE_OUT));

      el.style.transform = `translate3d(${sw0 / 2 + off - cw / 2}px,0,0) scale(${scale})`;
      el.style.opacity = String(opacity);
      el.style.zIndex = String(Math.round(100 - ad * 10));
      el.style.pointerEvents = ad > 1.3 ? "none" : "";

      const isSel = selected.includes(el.dataset.name ?? "");
      (el.querySelector("[data-glow]") as HTMLElement | null)?.style.setProperty("opacity", String(c));
      (el.querySelector("[data-ring]") as HTMLElement | null)?.style.setProperty("opacity", String(isSel ? 1 : c));
      (el.querySelector("[data-dim]") as HTMLElement | null)?.style.setProperty("opacity", String(0.28 * e));
      const label = el.querySelector("[data-label]") as HTMLElement | null;
      if (label) {
        label.style.paddingLeft = d > 0 ? `${(e * sw0 * OVERLAP) / SIDE_SCALE}px` : "0px";
        label.style.paddingRight = d < 0 ? `${(e * sw0 * OVERLAP) / SIDE_SCALE}px` : "0px";
        const text = label.firstElementChild as HTMLElement | null;
        if (text) {
          text.style.transform = `scale(${0.92 + 0.18 * c})`;
          text.style.color = `rgba(255,255,255,${0.55 + 0.4 * c})`;
        }
      }
    }
  };

  // Drive the spring toward the requested card.
  useEffect(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;

    if (prefersReducedMotion()) {
      pos.current = center;
      vel.current = 0;
      setAnchor(center);
      return;
    }
    // A long jump (search, Home/End) glides the last couple of cards, not the whole library.
    if (Math.abs(center - pos.current) > REACH) {
      pos.current = center - Math.sign(center - pos.current) * (REACH - 0.5);
      vel.current = 0;
      setAnchor(Math.round(pos.current));
    }

    let lastT = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.032, Math.max(0.001, (now - lastT) / 1000));
      lastT = now;
      const x = pos.current - target.current;
      vel.current += (-SPRING_W * SPRING_W * x - 2 * SPRING_W * vel.current) * dt;
      pos.current += vel.current * dt;

      const settled = Math.abs(pos.current - target.current) < 0.0006 && Math.abs(vel.current) < 0.003;
      if (settled) {
        pos.current = target.current;
        vel.current = 0;
      }
      apply(pos.current);
      setAnchor((a) => {
        const r = Math.round(pos.current);
        return r === a ? a : r;
      });
      raf.current = settled ? null : requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center]);

  // Newly mounted cards / resized strip / changed selection: paint them at the current position.
  useLayoutEffect(() => {
    apply(pos.current);
  });

  // Keep keyboard focus on the centre card while arrowing.
  useEffect(() => {
    if (!wantFocus.current) return;
    const el = tileRefs.current.get(niches[center]);
    if (!el) return;
    wantFocus.current = false;
    el.focus({ preventScroll: true });
  }, [center, anchor, niches]);

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
          return (
            <div
              key={name}
              data-name={name}
              ref={(el) => {
                if (el) cardRefs.current.set(i, el);
                else cardRefs.current.delete(i);
              }}
              style={{
                width: cw,
                height: ch,
                top: (stripH - ch) / 2,
                willChange: "transform, opacity",
                // first paint, before the loop has positioned it
                opacity: 0,
              }}
              className="absolute left-0"
            >
              {/* centre glow — a separate layer so only its opacity animates */}
              <span
                data-glow
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-[22px] shadow-[0_0_0_4px_color-mix(in_oklab,var(--brand)_16%,transparent),0_0_34px_-2px_color-mix(in_oklab,var(--brand)_65%,transparent)]"
              />
              <button
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
                className={cn(
                  "group relative flex size-full cursor-pointer flex-col overflow-hidden rounded-[22px] border border-white/[0.08] bg-card p-0 text-left outline-none",
                  "focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                )}
              >
                <span className="relative min-h-0 flex-1 overflow-hidden">
                  <img
                    src={nicheImage(name)}
                    alt=""
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
                    className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent"
                  />
                  {/* side cards are dimmed by a black overlay (cheaper than an animated filter) */}
                  <span data-dim aria-hidden="true" className="absolute inset-0 bg-black" style={{ opacity: 0 }} />
                </span>
                <span
                  data-label
                  style={{ height: LABEL_H }}
                  className="grid shrink-0 place-items-center overflow-hidden bg-card px-1.5"
                >
                  <span className="block max-w-full origin-center whitespace-nowrap text-center text-[13px] font-medium leading-none tracking-[0.01em]">
                    {name}
                  </span>
                </span>
                {/* selection / centre outline */}
                <span
                  data-ring
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-[22px] border-2 border-brand"
                  style={{ opacity: 0 }}
                />
                {isSelected && (
                  <span
                    aria-hidden="true"
                    className="absolute right-2.5 top-2.5 grid size-9 place-items-center rounded-full bg-brand text-brand-foreground shadow-[0_0_16px_color-mix(in_oklab,var(--brand)_75%,transparent)]"
                  >
                    <Check className="size-5" strokeWidth={3.5} />
                  </span>
                )}
              </button>
            </div>
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
