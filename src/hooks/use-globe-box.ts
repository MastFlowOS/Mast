import { useEffect, useState, type RefObject } from "react";

/**
 * Reads the globe's own box — GlobeStand's root element, via the pedestal
 * anchor marker's parent (see GlobeStand's comment on why the marker's
 * parent IS the globe frame) — once, from a single call site (Hero), so
 * GoldFlow and GroundSurface can both consume the same measurement instead
 * of each running its own resize/fonts-ready listener against the same
 * element. Triggers match what both call sites already relied on: a mount
 * measurement, window resize, and the font swap that can shift layout on
 * first load.
 */
export function useGlobeBox(pedestalAnchorRef: RefObject<HTMLDivElement | null>) {
  const [box, setBox] = useState<DOMRect | null>(null);

  useEffect(() => {
    const measure = () => {
      const el = pedestalAnchorRef.current?.parentElement;
      if (!el) return;
      setBox(el.getBoundingClientRect());
    };

    measure();

    window.addEventListener("resize", measure, { passive: true });
    document.fonts?.ready?.then(measure).catch(() => {});

    return () => {
      window.removeEventListener("resize", measure);
    };
  }, [pedestalAnchorRef]);

  return box;
}
