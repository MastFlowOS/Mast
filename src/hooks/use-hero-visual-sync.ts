import { useState, useCallback, useEffect, useRef } from "react";

const GLOBE_ASSET_WEBP = "/images/mast-globe-final.webp";
const FLOW_ASSET_WEBP = "/images/mast-gold-flow.webp";

function isImageCached(src: string): boolean {
  if (typeof window === "undefined" || typeof Image === "undefined") {
    return false;
  }
  const img = new Image();
  img.src = src;
  return img.complete && img.naturalWidth > 0;
}

/**
 * useHeroVisualSync
 *
 * Coordinates the above-the-fold hero assets (GlobeStand and GoldFlow) so they:
 * 1. Load in parallel from the earliest possible moment.
 * 2. Appear together smoothly once both static assets are ready, preventing
 *    one popping in awkwardly without the other.
 * 3. On warm reloads, recognize cached assets immediately on frame 0 with zero delay.
 * 4. Have a graceful fallback timeout so network stalls never keep the hero hidden.
 */
export function useHeroVisualSync(timeoutMs = 1500) {
  const [globeReady, setGlobeReady] = useState(() => isImageCached(GLOBE_ASSET_WEBP));
  const [flowReady, setFlowReady] = useState(() => isImageCached(FLOW_ASSET_WEBP));
  const [timedOut, setTimedOut] = useState(false);

  const onGlobeReady = useCallback(() => {
    setGlobeReady(true);
  }, []);

  const onFlowReady = useCallback(() => {
    setFlowReady(true);
  }, []);

  // Safety fallback: if either asset takes longer than timeoutMs or network drops,
  // reveal what is ready so content is never stuck in opacity-0.
  useEffect(() => {
    if (globeReady && flowReady) return;

    const timer = setTimeout(() => {
      setTimedOut(true);
    }, timeoutMs);

    return () => clearTimeout(timer);
  }, [globeReady, flowReady, timeoutMs]);

  const isStaticReady = timedOut || (globeReady && flowReady);

  return {
    isStaticReady,
    globeReady,
    flowReady,
    onGlobeReady,
    onFlowReady,
  };
}
