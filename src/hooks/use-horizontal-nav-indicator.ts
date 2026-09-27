import { useCallback, useEffect, useRef, useState } from "react";

export interface HorizontalIndicatorStyle {
  x: number;
  width: number;
  opacity: number;
}

/**
 * Positions a shared horizontal sliding pill indicator behind the active
 * navigation item. Measures the active link's position relative to the
 * container and returns transform values for a single absolutely-positioned
 * indicator element.
 *
 * On first mount, the indicator is positioned instantly (no animation).
 * On subsequent route changes, the caller can apply a CSS transition to
 * get the smooth sliding effect.
 */
export function useHorizontalNavIndicator(activeTo: string | null) {
  const containerRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const hasMountedRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [indicator, setIndicator] = useState<HorizontalIndicatorStyle>({
    x: 0,
    width: 0,
    opacity: 0,
  });

  const setContainer = useCallback((node: HTMLElement | null) => {
    containerRef.current = node;
    // Trigger a re-measure when the container mounts
    if (node) setMounted(true);
  }, []);

  const registerItem = useCallback((key: string, node: HTMLElement | null) => {
    if (node) itemRefs.current.set(key, node);
    else itemRefs.current.delete(key);
  }, []);

  const measure = useCallback(() => {
    if (!activeTo || !containerRef.current) return null;
    const el = itemRefs.current.get(activeTo);
    if (!el) return null;

    const cr = containerRef.current.getBoundingClientRect();
    const er = el.getBoundingClientRect();

    return {
      x: er.left - cr.left,
      width: er.width,
    };
  }, [activeTo]);

  useEffect(() => {
    const update = () => {
      const m = measure();
      if (m) {
        setIndicator({ x: m.x, width: m.width, opacity: 1 });
        hasMountedRef.current = true;
      } else {
        setIndicator((prev) => ({ ...prev, opacity: 0 }));
      }
    };

    // Double-RAF to ensure layout is settled after React commit
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(update);
    });

    const onResize = () => {
      const m = measure();
      if (m) setIndicator({ x: m.x, width: m.width, opacity: 1 });
    };

    const onVisible = () => {
      if (!document.hidden) onResize();
    };

    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeTo, measure, mounted]);

  return {
    indicator,
    /** Whether this is the very first positioning (skip transition). */
    isInitial: !hasMountedRef.current,
    setContainer,
    registerItem,
  };
}
