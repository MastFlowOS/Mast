/**
 * assetPreload.ts
 *
 * Coordinates loading and decoding of critical visual assets required for the
 * initial landing-page viewport before dismissing the loading screen.
 */

export interface PreloadResult {
  success: boolean;
  timedOut: boolean;
  durationMs: number;
  criticalAssets: {
    fonts: boolean;
    globe: boolean;
    ground: boolean;
    nebula: boolean;
    goldFlow: boolean;
    brandMark: boolean;
  };
}

const CRITICAL_IMAGES = {
  globe: "/images/mast-globe-final.png",
  ground: "/images/mast-hero-ground.webp",
  nebula: "/images/mast-hero-nebula.webp",
  goldFlowStatic: "/images/mast-gold-flow.png",
  brandMark: "/images/mast-wordmark.png",
};

const CRITICAL_VIDEO = "/images/mast-gold-flow-motion.mp4";

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * Preload and decode an image using HTMLImageElement.decode() where available.
 * Resolves true if successfully decoded/loaded, false if failed. Never throws.
 */
export function preloadAndDecodeImage(src: string, timeoutMs = 3000): Promise<boolean> {
  return withTimeout(
    new Promise<boolean>((resolve) => {
      if (typeof window === "undefined") {
        resolve(true);
        return;
      }

      const img = new Image();
      img.src = src;

      const onDone = async () => {
        if (typeof img.decode === "function") {
          try {
            await Promise.race([
              img.decode(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("decode-timeout")), 1200)
              ),
            ]);
          } catch {
            // Decode timed out or failed, but image loaded
          }
        }
        resolve(true);
      };

      if (img.complete && img.naturalWidth > 0) {
        onDone();
        return;
      }

      img.onload = () => onDone();
      img.onerror = () => {
        console.warn(`[AssetPreload] Nonessential image failed or missing: ${src}`);
        resolve(false);
      };
    }),
    timeoutMs,
    false
  );
}

/**
 * Preload video metadata/canplay with a conservative timeout cap.
 */
function preloadVideo(src: string, capMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      resolve(true);
      return;
    }

    let resolved = false;
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.src = src;

    const cleanup = () => {
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    };

    const onReady = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(true);
      }
    };

    const onError = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        console.warn(`[AssetPreload] Video unavailable, graceful fallback to static flow: ${src}`);
        resolve(false);
      }
    };

    if (video.readyState >= 2) {
      resolve(true);
      return;
    }

    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(false);
      }
    }, capMs);
  });
}

/**
 * Ensure critical typography fonts are loaded before revealing the viewport.
 */
export async function preloadCriticalFonts(timeoutMs = 1500): Promise<boolean> {
  if (typeof document === "undefined" || !("fonts" in document)) {
    return true;
  }
  return withTimeout(
    Promise.allSettled([
      document.fonts.load('600 24px "Playfair Display"'),
      document.fonts.load('600 16px "Plus Jakarta Sans"'),
      document.fonts.ready,
    ])
      .then(() => true)
      .catch(() => false),
    timeoutMs,
    true
  );
}

/**
 * Wait for all critical assets required for the landing-page initial viewport.
 */
export async function waitForCriticalLandingAssets(
  timeoutMs = 3500
): Promise<PreloadResult> {
  const startTime = performance.now();
  let timedOut = false;

  const fontPromise = preloadCriticalFonts(1800);
  const globePromise = preloadAndDecodeImage(CRITICAL_IMAGES.globe, 3000);
  const groundPromise = preloadAndDecodeImage(CRITICAL_IMAGES.ground, 3000);
  const nebulaPromise = preloadAndDecodeImage(CRITICAL_IMAGES.nebula, 3000);
  const brandPromise = preloadAndDecodeImage(CRITICAL_IMAGES.brandMark, 3000);
  const flowPromise = Promise.race([
    preloadVideo(CRITICAL_VIDEO, 1200),
    preloadAndDecodeImage(CRITICAL_IMAGES.goldFlowStatic, 3000),
  ]);

  const assetsPromise = Promise.all([
    fontPromise,
    globePromise,
    groundPromise,
    nebulaPromise,
    brandPromise,
    flowPromise,
  ]);

  const timeoutPromise = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs)
  );

  const outcome = await Promise.race([assetsPromise, timeoutPromise]);

  let fonts = true;
  let globe = true;
  let ground = true;
  let nebula = true;
  let brandMark = true;
  let goldFlow = true;

  if (outcome === "timeout") {
    timedOut = true;
    console.warn(
      `[AssetPreload] Safety timeout (${timeoutMs}ms) elapsed. Releasing viewport safely.`
    );
  } else {
    [fonts, globe, ground, nebula, brandMark, goldFlow] = outcome;
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    success: !timedOut && fonts && globe && ground && nebula,
    timedOut,
    durationMs,
    criticalAssets: {
      fonts,
      globe,
      ground,
      nebula,
      goldFlow: Boolean(goldFlow),
      brandMark,
    },
  };
}

/**
 * Smoothly dismiss the loading screen.
 */
export function dismissPreloader(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve();
      return;
    }
    const preloader = document.getElementById("mast-preloader");
    if (!preloader) {
      document.body.classList.remove("mast-loading");
      resolve();
      return;
    }

    if (preloader.classList.contains("mast-preloader-hidden")) {
      document.body.classList.remove("mast-loading");
      resolve();
      return;
    }

    // Add fade class
    preloader.classList.add("mast-preloader-fade");
    document.body.classList.remove("mast-loading");

    const onTransitionEnd = () => {
      preloader.classList.add("mast-preloader-hidden");
      preloader.removeEventListener("transitionend", onTransitionEnd);
      resolve();
    };

    preloader.addEventListener("transitionend", onTransitionEnd);

    // Fallback in case transitionend does not fire
    setTimeout(() => {
      preloader.classList.add("mast-preloader-hidden");
      resolve();
    }, 450);
  });
}
