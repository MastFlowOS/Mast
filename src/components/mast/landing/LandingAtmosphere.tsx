import { useEffect, useState } from "react";

type Star = {
  id: number;
  x: number;
  y: number;
  size: number;
  opacity: number;
  twinkle: boolean;
  delay: number;
};

// ─── Fixed backdrop: realistic deep space night atmosphere ─────────────────────
// Sits fixed behind the entire landing page, establishing a serene, quiet,
// premium night environment with high-altitude atmospheric formations and
// a sparse scattering of distant stars.
export function LandingAtmosphere() {
  const [stars, setStars] = useState<Star[]>([]);

  useEffect(() => {
    // Generate deterministic sparse starfield avoiding text clutter
    // Seeded distribution to preserve stable star positions
    const starList: Star[] = [];
    const count = 56;
    let s = 42;
    const rand = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };

    for (let i = 0; i < count; i++) {
      let x = rand() * 100;
      let y = rand() * 100;

      // Keep star density sparse directly over the main hero headline (x: 5-45%, y: 12-42%)
      if (x > 6 && x < 42 && y > 12 && y < 44) {
        if (rand() > 0.18) {
          // Push outward toward the margins or upper sky
          x = (x + 48) % 100;
        }
      }

      const size = 0.65 + rand() * 0.75; // Fine points: 0.65px - 1.4px
      const opacity = 0.12 + rand() * 0.32; // Subtle brightness: 0.12 - 0.44
      const twinkle = rand() < 0.2; // Only 20% have gentle slow twinkle
      const delay = rand() * 6;

      starList.push({ id: i, x, y, size, opacity, twinkle, delay });
    }

    setStars(starList);
  }, []);

  return (
    <div
      className="fixed inset-0 overflow-hidden pointer-events-none z-0 w-screen h-screen select-none"
      aria-hidden="true"
    >
      {/* Deep night sky base: extremely dark navy/black gradient from top to bottom */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, #020512 0%, #01030b 45%, #010207 75%, #000104 100%)",
        }}
      />

      {/* Very faint high-altitude atmospheric gradient (horizon glow) */}
      <div
        className="absolute inset-0 opacity-[0.035]"
        style={{
          background:
            "radial-gradient(ellipse 90% 60% at 75% 35%, rgba(100, 145, 230, 0.4) 0%, rgba(30, 58, 138, 0.1) 50%, transparent 80%)",
        }}
      />

      {/* Realistic high-altitude cloud formations — organic fractal vapor field */}
      {/* Placed behind and around the Earth globe on the right side of the hero */}
      <div className="absolute inset-0 overflow-hidden">
        {/* Layer 1: High-altitude cirrus / aerosol texture generated via SVG fractal noise */}
        <svg
          className="absolute right-[-10%] top-[-5%] w-[85vw] h-[95vh] opacity-[0.038] mix-blend-screen animate-atmo-cloud-1"
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
        >
          <defs>
            <filter id="atmo-cirrus-noise" x="0%" y="0%" width="100%" height="100%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.0055 0.0035"
                numOctaves="4"
                result="noise"
                seed="88"
              />
              <feColorMatrix
                type="matrix"
                values="
                  0 0 0 0 0.62
                  0 0 0 0 0.74
                  0 0 0 0 0.92
                  1 0 0 0 0"
              />
            </filter>
            <radialGradient id="atmo-cirrus-mask" cx="62%" cy="42%" r="52%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="45%" stopColor="#ffffff" stopOpacity="0.6" />
              <stop offset="75%" stopColor="#ffffff" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
            <mask id="atmo-mask">
              <rect width="1000" height="1000" fill="url(#atmo-cirrus-mask)" />
            </mask>
          </defs>
          <rect
            width="1000"
            height="1000"
            filter="url(#atmo-cirrus-noise)"
            mask="url(#atmo-mask)"
          />
        </svg>

        {/* Layer 2: Soft, diffuse stratospheric veil hugging behind the globe */}
        {/* Ultra-low contrast, huge blur, no sharp edges, no cartoon appearance */}
        <div
          className="absolute right-[5%] top-[10%] w-[55vw] h-[55vw] max-w-[750px] max-h-[750px] rounded-full blur-[100px] mix-blend-screen opacity-[0.024] animate-atmo-cloud-2"
          style={{
            background:
              "radial-gradient(circle at 45% 45%, rgba(135, 175, 235, 0.9) 0%, rgba(70, 110, 190, 0.4) 50%, transparent 80%)",
          }}
        />

        {/* Layer 3: Gentle atmospheric shelf stretching horizontally across the mid-hero */}
        <div
          className="absolute right-[0%] top-[30%] w-[65vw] h-[25vw] max-h-[320px] blur-[90px] mix-blend-screen opacity-[0.018]"
          style={{
            background:
              "radial-gradient(ellipse at 55% 50%, rgba(110, 155, 225, 0.8) 0%, rgba(45, 80, 160, 0.3) 55%, transparent 80%)",
          }}
        />
      </div>

      {/* Stars: sparse, tiny, restrained points of light */}
      <div className="absolute inset-0">
        {stars.map((star: Star) => (
          <div
            key={star.id}
            className={`absolute bg-[#e4ecfa] rounded-full ${
              star.twinkle ? "animate-atmo-twinkle" : ""
            }`}
            style={{
              left: `${star.x}%`,
              top: `${star.y}%`,
              width: `${star.size}px`,
              height: `${star.size}px`,
              opacity: star.opacity,
              animationDelay: `${star.delay}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
