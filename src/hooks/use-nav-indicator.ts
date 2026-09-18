import { useCallback, useEffect, useRef, useState } from "react";

export interface NavIndicatorStyle {
  top: number;
  height: number;
  opacity: number;
}

export interface UseNavIndicatorResult {
  /** Current position/visibility of the gliding active-item indicator. */
  indicator: NavIndicatorStyle;
  /** Pass as the `ref` of the scrollable nav container element. */
  setContainer: (node: HTMLElement | null) => void;
  /** Pass as the `ref` of each nav item, keyed by its route `to`. */
  registerItem: (to: string, node: HTMLElement | null) => void;
}

/**
 * Positions the sidebar's gliding "active" pill by measuring the DOM node of
 * whichever nav item matches the current route (`activeTo`).
 *
 * Why this exists / what it fixes:
 * The container is tracked as *state* (a callback ref), not a plain
 * `useRef`. That's the load-bearing detail. Some callers (e.g. the
 * dashboard layout) conditionally mount the nav only after some async
 * gate (auth/account loading) resolves. On that transition, `activeTo`
 * (derived from the route) does NOT change — only the nav's presence in
 * the DOM does. A plain `useRef` container has a stable identity across
 * renders, so an effect keyed only on `[activeTo]` would never re-run when
 * the nav appears, leaving the indicator stuck at its initial
 * `{ opacity: 0 }` default even though the correct item is active. Using
 * a state-backed ref means the container's identity changes at exactly
 * the moment the nav mounts, so including it in the effect's dependency
 * array guarantees a remeasure right then — independent of whether the
 * route changed. The route (`activeTo`) remains the sole source of truth
 * for *which* item is active; this only re-syncs the *visual* measurement
 * whenever the DOM it depends on could have gone stale (mount, resize, or
 * the tab regaining visibility after being hidden/suspended).
 */
export function useNavIndicator(activeTo: string): UseNavIndicatorResult {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [indicator, setIndicator] = useState<NavIndicatorStyle>({
    top: 0,
    height: 40,
    opacity: 0,
  });

  const registerItem = useCallback((to: string, node: HTMLElement | null) => {
    if (node) itemRefs.current.set(to, node);
    else itemRefs.current.delete(to);
  }, []);

  const measureItem = useCallback(
    (to: string) => {
      const el = itemRefs.current.get(to);
      if (!container || !el) return null;
      const cr = container.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      return { top: er.top - cr.top + container.scrollTop, height: er.height };
    },
    [container],
  );

  useEffect(() => {
    const update = () => {
      const m = measureItem(activeTo);
      if (m) setIndicator({ top: m.top, height: m.height, opacity: 1 });
    };

    update();
    const raf = requestAnimationFrame(update);

    // Defensive re-sync only — `activeTo` is still what decides which item
    // is active. This just re-runs the same deterministic measurement if
    // layout could have shifted while the tab was hidden/suspended, so the
    // pill can't be left at a stale position.
    const onVisible = () => {
      if (!document.hidden) update();
    };

    window.addEventListener("resize", update);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeTo, measureItem, container]);

  return { indicator, setContainer, registerItem };
}
