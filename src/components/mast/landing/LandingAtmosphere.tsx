import { useEffect, useRef, useState } from "react";

type Star = {
  id: number;
  x: number;
  y: number;
  size: number;
  opacity: number;
  type: "drift-a" | "drift-b" | "breathe" | "twinkle";
  duration: number;
  delay: number;
};

// ─── Fixed backdrop: living deep-space night atmosphere ───────────────────────
// Sits fixed behind the entire landing page, establishing a continuous,
// quiet, organic night environment that extends down all sections.
// Cloud layers drift with perceptible displacement, stars breathe and twinkle
// unsynchronized, and atmospheric haze moves independently without freezing.
export function LandingAtmosphere() {
  const [stars, setStars] = useState<Star[]>([]);
  const hazeParallaxRef = useRef<HTMLDivElement>(null);
  const cloudsParallaxRef = useRef<HTMLDivElement>(null);
  const starsParallaxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Generate deterministic starfield with 3 distinct behavioral tiers
    const starList: Star[] = [];
    const count = 66;
    let s = 107;
    const rand = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };

    for (let i = 0; i < count; i++) {
      let x = rand() * 100;
      let y = rand() * 100;

      // Keep star density sparse directly over the main hero headline (x: 5-45%, y: 12-42%)
      if (x > 5 && x < 42 && y > 12 && y < 44) {
        if (rand() > 0.16) {
          x = (x + 46) % 100;
        }
      }

      const roll = rand();
      let type: Star["type"] = "drift-a";
      let duration = 70;
      let size = 0.75 + rand() * 0.65;
      let opacity = 0.22;
      let delay = 0;

      if (roll < 0.60) {
        // GROUP A (~60%): Mostly stable with slow micro-drift (0.15–0.35 opacity)
        type = rand() > 0.5 ? "drift-a" : "drift-b";
        duration = 65 + rand() * 25; // 65s - 90s slow drift
        opacity = 0.18 + rand() * 0.16; // 0.18 - 0.34
        size = 0.7 + rand() * 0.55;
        delay = -(rand() * 35);
      } else if (roll < 0.85) {
        // GROUP B (~25%): Gentle breathing (0.12–0.50 opacity)
        type = "breathe";
        duration = 5.5 + rand() * 4.0; // 5.5s - 9.5s breathing cycle
        opacity = 0.14 + rand() * 0.20;
        size = 0.85 + rand() * 0.55;
        delay = -(rand() * 12);
      } else {
        // GROUP C (~15%): Twinkling accents (0.15–0.70 opacity)
        type = "twinkle";
        duration = 3.5 + rand() * 3.2; // 3.5s - 6.7s twinkling cycle
        opacity = 0.16 + rand() * 0.26;
        size = 0.95 + rand() * 0.55;
        delay = -(rand() * 8);
      }

      starList.push({ id: i, x, y, size, opacity, type, duration, delay });
    }

    setStars(starList);

    // Subtle depth-based scroll parallax across the page
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          const sy = window.scrollY;
          if (starsParallaxRef.current) {
            starsParallaxRef.current.style.transform = `translate3d(0, ${sy * 0.025}px, 0)`;
          }
          if (cloudsParallaxRef.current) {
            cloudsParallaxRef.current.style.transform = `translate3d(0, ${sy * 0.05}px, 0)`;
          }
          if (hazeParallaxRef.current) {
            hazeParallaxRef.current.style.transform = `translate3d(0, ${sy * 0.08}px, 0)`;
          }
          ticking = false;
        });
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div
      className="fixed inset-0 overflow-hidden pointer-events-none z-0 w-screen h-screen select-none"
      aria-hidden="true"
    >
      {/* Deep night sky base: seamless gradient from deepest space into calm dark world */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, #020512 0%, #01030c 38%, #010208 70%, #000104 100%)",
        }}
      />

      {/* Atmospheric depth & haze layer: moves independently behind the globe */}
      <div ref={hazeParallaxRef} className="absolute inset-0 will-change-transform">
        <div
          className="absolute right-[4%] top-[4%] w-[64vw] h-[64vw] max-w-[840px] max-h-[840px] rounded-full blur-[120px] mix-blend-screen opacity-[0.034] animate-atmo-haze"
          style={{
            background:
              "radial-gradient(circle at 50% 48%, rgba(95, 140, 220, 0.85) 0%, rgba(40, 75, 160, 0.3) 55%, transparent 80%)",
          }}
        />

        {/* Global mid-page atmospheric veil extending down the landing page */}
        <div
          className="absolute left-[15%] top-[45%] w-[70vw] h-[35vh] blur-[110px] mix-blend-screen opacity-[0.016]"
          style={{
            background:
              "radial-gradient(ellipse at 50% 50%, rgba(85, 125, 205, 0.7) 0%, transparent 75%)",
          }}
        />
      </div>

      {/* Asynchronous multi-layer cloud formations */}
      {/* Never loop or reset simultaneously; continuous, slow, organic drift with noticeable displacement */}
      <div ref={cloudsParallaxRef} className="absolute inset-0 overflow-hidden will-change-transform">
        {/* Layer 1: Macro atmospheric vapor sheets (105s continuous cycle) */}
        <svg
          className="absolute right-[-10%] top-[-6%] w-[90vw] h-[100vh] opacity-[0.11] mix-blend-screen animate-atmo-cloud-macro"
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
        >
          <defs>
            <filter id="atmo-macro-noise" x="0%" y="0%" width="100%" height="100%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.0042 0.0026"
                numOctaves="4"
                result="noise"
                seed="42"
              />
              <feColorMatrix
                type="matrix"
                values="
                  0 0 0 0 0.22
                  0 0 0 0 0.32
                  0 0 0 0 0.54
                  2.8 0 0 0 -1.05"
              />
            </filter>
            <radialGradient id="atmo-macro-mask" cx="66%" cy="40%" r="52%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="42%" stopColor="#ffffff" stopOpacity="0.75" />
              <stop offset="72%" stopColor="#ffffff" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
            <mask id="atmo-mask-1">
              <rect width="1000" height="1000" fill="url(#atmo-macro-mask)" />
            </mask>
          </defs>
          <rect
            width="1000"
            height="1000"
            filter="url(#atmo-macro-noise)"
            mask="url(#atmo-mask-1)"
          />
        </svg>

        {/* Layer 2: Secondary atmospheric cloud bank (74s cycle, phased -24s) */}
        <svg
          className="absolute right-[-6%] top-[2%] w-[82vw] h-[88vh] opacity-[0.08] mix-blend-screen animate-atmo-cloud-secondary"
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
        >
          <defs>
            <filter id="atmo-sec-noise" x="0%" y="0%" width="100%" height="100%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.0058 0.0032"
                numOctaves="4"
                result="secNoise"
                seed="91"
              />
              <feColorMatrix
                type="matrix"
                values="
                  0 0 0 0 0.24
                  0 0 0 0 0.34
                  0 0 0 0 0.58
                  2.5 0 0 0 -0.95"
              />
            </filter>
            <radialGradient id="atmo-sec-mask" cx="62%" cy="44%" r="48%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="46%" stopColor="#ffffff" stopOpacity="0.7" />
              <stop offset="78%" stopColor="#ffffff" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
            <mask id="atmo-mask-2">
              <rect width="1000" height="1000" fill="url(#atmo-sec-mask)" />
            </mask>
          </defs>
          <rect
            width="1000"
            height="1000"
            filter="url(#atmo-sec-noise)"
            mask="url(#atmo-mask-2)"
          />
        </svg>

        {/* Layer 3: Fine high-altitude cirrus filaments (46s cycle, phased -15s) */}
        <svg
          className="absolute right-[-2%] top-[5%] w-[76vw] h-[78vh] opacity-[0.06] mix-blend-screen animate-atmo-cloud-cirrus"
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
        >
          <defs>
            <filter id="atmo-cirrus-noise" x="0%" y="0%" width="100%" height="100%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.0084 0.0042"
                numOctaves="3"
                result="cirrus"
                seed="77"
              />
              <feColorMatrix
                type="matrix"
                values="
                  0 0 0 0 0.26
                  0 0 0 0 0.38
                  0 0 0 0 0.62
                  2.2 0 0 0 -0.85"
              />
            </filter>
            <radialGradient id="atmo-cirrus-mask" cx="58%" cy="48%" r="44%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="50%" stopColor="#ffffff" stopOpacity="0.6" />
              <stop offset="82%" stopColor="#ffffff" stopOpacity="0.1" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
            <mask id="atmo-mask-3">
              <rect width="1000" height="1000" fill="url(#atmo-cirrus-mask)" />
            </mask>
          </defs>
          <rect
            width="1000"
            height="1000"
            filter="url(#atmo-cirrus-noise)"
            mask="url(#atmo-mask-3)"
          />
        </svg>
      </div>

      {/* Living stars: asynchronous micro-drift, gentle breathing, perceptible twinkling */}
      <div ref={starsParallaxRef} className="absolute inset-0 will-change-transform">
        {stars.map((star: Star) => {
          let animClass = "";
          if (star.type === "drift-a") animClass = "animate-star-drift-a";
          else if (star.type === "drift-b") animClass = "animate-star-drift-b";
          else if (star.type === "breathe") animClass = "animate-star-breathe";
          else if (star.type === "twinkle") animClass = "animate-star-twinkle";

          return (
            <div
              key={star.id}
              className={`absolute bg-[#e8f0fe] rounded-full ${animClass}`}
              style={
                {
                  left: `${star.x}%`,
                  top: `${star.y}%`,
                  width: `${star.size}px`,
                  height: `${star.size}px`,
                  opacity: star.opacity,
                  "--star-duration": `${star.duration}s`,
                  "--star-delay": `${star.delay}s`,
                } as React.CSSProperties
              }
            />
          );
        })}
      </div>
    </div>
  );
}
