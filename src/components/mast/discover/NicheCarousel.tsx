import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { nicheHue, nicheIcon } from "./nicheVisuals";

type Props = {
  /** Niches to show, already filtered by the search box. */
  niches: string[];
  /** Everything currently selected (multi-select). */
  selected: string[];
  /** The most recently picked niche — the one brought into focus. */
  focused: string | null;
  query: string;
  onToggle: (niche: string) => void;
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Horizontally scrolling niche tiles.
 *
 * Selecting a tile marks it (ring + check) and — if it is newly picked —
 * glides it to the centre of the strip where it grows slightly, so the choice
 * is the thing you are looking at. Only transform/opacity/shadow transition;
 * the strip itself scrolls natively. Keyboard: tiles are a roving-tabindex
 * group (←/→ move, Space/Enter toggle), so ~80 tiles are one tab stop.
 */
export function NicheCarousel({ niches, selected, focused, query, onToggle }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef(new Map<string, HTMLButtonElement>());
  const prevSelectedCount = useRef(selected.length);
  const [edges, setEdges] = useState({ start: true, end: false });
  const [tabStop, setTabStop] = useState<string | null>(null);

  const updateEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const start = el.scrollLeft <= 2;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  // Recompute edge state when the list changes (search) or the strip resizes.
  useEffect(() => {
    updateEdges();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [niches, updateEdges]);

  // A new search starts from the left.
  useEffect(() => {
    scrollerRef.current?.scrollTo?.({ left: 0 });
  }, [query]);

  // Bring a newly picked niche to the middle of the strip.
  useEffect(() => {
    const grew = selected.length > prevSelectedCount.current;
    prevSelectedCount.current = selected.length;
    if (!grew || !focused) return;
    const el = scrollerRef.current;
    const tile = tileRefs.current.get(focused);
    if (!el || !tile) return;
    const left = tile.offsetLeft - (el.clientWidth - tile.offsetWidth) / 2;
    el.scrollTo?.({ left: Math.max(0, left), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [focused, selected.length]);

  const scrollByPage = (dir: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy?.({
      left: dir * Math.max(160, el.clientWidth * 0.7),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  const activeStop =
    tabStop && niches.includes(tabStop) ? tabStop : (focused && niches.includes(focused) ? focused : niches[0]);

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? niches.length - 1 : index + (e.key === "ArrowRight" ? 1 : -1);
    const target = niches[Math.max(0, Math.min(niches.length - 1, next))];
    if (!target) return;
    setTabStop(target);
    tileRefs.current.get(target)?.focus();
  };

  if (niches.length === 0) {
    return (
      <div className="flex h-[132px] items-center justify-center rounded-2xl border border-dashed border-border/80 text-sm text-muted-foreground">
        No niches match “{query}”
      </div>
    );
  }

  const anySelected = selected.length > 0;
  const fade = `linear-gradient(90deg, ${edges.start ? "#000" : "transparent"}, #000 44px, #000 calc(100% - 44px), ${edges.end ? "#000" : "transparent"})`;

  return (
    <div className="relative">
      <div
        ref={scrollerRef}
        role="group"
        aria-label="Business niches"
        onScroll={updateEdges}
        // Soft fade only on the side that has more to scroll to.
        style={{ maskImage: fade, WebkitMaskImage: fade }}
        className="relative flex gap-3 overflow-x-auto py-4 pl-9 pr-[max(2.25rem,calc(50%-55px))] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {niches.map((name, i) => {
          const isSelected = selected.includes(name);
          const isFocused = isSelected && name === focused;
          const Icon = nicheIcon(name);
          const hue = nicheHue(name);
          return (
            <button
              key={name}
              ref={(el) => {
                if (el) tileRefs.current.set(name, el);
                else tileRefs.current.delete(name);
              }}
              type="button"
              aria-pressed={isSelected}
              tabIndex={name === activeStop ? 0 : -1}
              onClick={() => {
                setTabStop(name);
                onToggle(name);
              }}
              onFocus={() => setTabStop(name)}
              onKeyDown={(e) => onKeyDown(e, i)}
              style={{
                background: `linear-gradient(155deg, oklch(0.33 0.1 ${hue}), oklch(0.2 0.05 ${hue + 14}))`,
              }}
              className={cn(
                "relative h-[100px] w-[110px] shrink-0 cursor-pointer overflow-hidden rounded-2xl border p-3 text-left outline-none",
                "transition-[transform,opacity,box-shadow,border-color] duration-[380ms] [transition-timing-function:var(--ease-spring)]",
                "focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                isSelected
                  ? "border-brand/70 opacity-100"
                  : cn("border-white/[0.07] hover:opacity-100 hover:scale-100", anySelected ? "opacity-55" : "opacity-85", "scale-[0.96]"),
                isFocused
                  ? "scale-[1.07] shadow-[0_14px_34px_-10px_color-mix(in_oklab,var(--brand)_75%,transparent)]"
                  : isSelected && "scale-100",
              )}
            >
              <span
                aria-hidden="true"
                className="grid size-9 place-items-center rounded-xl bg-white/[0.07]"
                style={{ color: `oklch(0.88 0.09 ${hue})` }}
              >
                <Icon className="size-[18px]" />
              </span>
              <span className="absolute inset-x-3 bottom-2.5 line-clamp-2 text-[12px] font-semibold leading-[1.15] text-foreground">
                {name}
              </span>
              {isSelected && (
                <span
                  aria-hidden="true"
                  className="absolute right-2 top-2 grid size-5 place-items-center rounded-full bg-brand text-brand-foreground shadow-[0_0_12px_color-mix(in_oklab,var(--brand)_70%,transparent)]"
                >
                  <Check className="size-3" strokeWidth={3.5} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <ArrowButton side="left" disabled={edges.start} onClick={() => scrollByPage(-1)} />
      <ArrowButton side="right" disabled={edges.end} onClick={() => scrollByPage(1)} />
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
      aria-label={side === "left" ? "Scroll niches left" : "Scroll niches right"}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-full border border-border bg-card/95 text-muted-foreground shadow-md transition-[opacity,color,border-color] duration-200",
        "hover:border-brand/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/70 outline-none",
        "disabled:pointer-events-none disabled:opacity-0",
        side === "left" ? "left-0" : "right-0",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}
