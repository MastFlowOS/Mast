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
        {/* Layer 1: Macro atmospheric vapor sheets with irregular contours and clear dark sky gaps */}
        <svg
          className="absolute right-[-12%] top-[-8%] w-[90vw] h-[105vh] opacity-[0.14] mix-blend-screen animate-atmo-cloud-1"
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
              {/* Thresholding transfer curve: cuts off below 0.38 to create dark voids,
                  ramps up to 1.0 for dense cloud banks in deep atmospheric slate-blue */}
              <feColorMatrix
                type="matrix"
                values="
                  0 0 0 0 0.26
                  0 0 0 0 0.38
                  0 0 0 0 0.62
                  3.4 0 0 0 -1.25"
              />
            </filter>
            <radialGradient id="atmo-macro-mask" cx="68%" cy="40%" r="56%">
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

        {/* Layer 2: Stratified high-altitude cirrus filaments and density variations */}
        <svg
          className="absolute right-[-5%] top-[2%] w-[80vw] h-[85vh] opacity-[0.10] mix-blend-screen animate-atmo-cloud-2"
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
        >
          <defs>
            <filter id="atmo-cirrus-noise" x="0%" y="0%" width="100%" height="100%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.0078 0.0038"
                numOctaves="3"
                result="cirrus"
                seed="77"
              />
              <feColorMatrix
                type="matrix"
                values="
                  0 0 0 0 0.30
                  0 0 0 0 0.44
                  0 0 0 0 0.70
                  2.8 0 0 0 -1.05"
              />
            </filter>
            <radialGradient id="atmo-cirrus-mask" cx="62%" cy="46%" r="50%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
              <stop offset="48%" stopColor="#ffffff" stopOpacity="0.65" />
              <stop offset="80%" stopColor="#ffffff" stopOpacity="0.1" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
            <mask id="atmo-mask-2">
              <rect width="1000" height="1000" fill="url(#atmo-cirrus-mask)" />
            </mask>
          </defs>
          <rect
            width="1000"
            height="1000"
            filter="url(#atmo-cirrus-noise)"
            mask="url(#atmo-mask-2)"
          />
        </svg>

        {/* Layer 3: Soft ambient atmospheric haze hugging the upper planetary horizon */}
        <div
          className="absolute right-[6%] top-[8%] w-[58vw] h-[58vw] max-w-[760px] max-h-[760px] rounded-full blur-[110px] mix-blend-screen opacity-[0.032]"
          style={{
            background:
              "radial-gradient(circle at 48% 46%, rgba(120, 160, 230, 0.9) 0%, rgba(55, 95, 180, 0.35) 55%, transparent 80%)",
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
