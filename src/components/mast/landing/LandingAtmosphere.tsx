import { useEffect, useState } from "react";

// ─── Fixed backdrop: stars, nebulae, deep sky ─────────────────────────────────
// This sits fixed behind everything and covers the full viewport as you scroll.
export function LandingAtmosphere() {
  const [stars, setStars] = useState<{ id: number; x: number; y: number; size: number; delay: number; duration: number }[]>([]);

  useEffect(() => {
    // Generate organic star positions only once on mount
    const starList = Array.from({ length: 60 }).map((_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: Math.random() * 1.6 + 0.6, // sizes 0.6px to 2.2px
      delay: Math.random() * 4,
      duration: Math.random() * 3 + 3, // 3s to 6s twinkle cycle
    }));
    setStars(starList);
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-0 w-screen h-screen">
      {/* Deep sky base color */}
      <div className="absolute inset-0 bg-[#02040c]" />

      {/* Cloudy nebula vibe: extremely soft, drifting colored blobs of extremely low opacity */}
      <div className="absolute top-[8%] left-[10%] w-[70vw] h-[70vw] rounded-full bg-indigo-950/8 blur-[130px] mix-blend-screen animate-cloud-drift-1" />
      <div className="absolute bottom-[25%] right-[5%] w-[65vw] h-[65vw] rounded-full bg-purple-950/8 blur-[110px] mix-blend-screen animate-cloud-drift-2" />
      <div className="absolute top-[45%] right-[20%] w-[50vw] h-[50vw] rounded-full bg-amber-950/4 blur-[110px] mix-blend-screen animate-cloud-drift-3" />

      {/* Stars twinkle overlay */}
      <div className="absolute inset-0">
        {stars.map((star) => (
          <div
            key={star.id}
            className="absolute bg-white rounded-full animate-twinkle"
            style={{
              left: `${star.x}%`,
              top: `${star.y}%`,
              width: `${star.size}px`,
              height: `${star.size}px`,
              animationDelay: `${star.delay}s`,
              animationDuration: `${star.duration}s`,
              opacity: 0.1 + Math.random() * 0.45,
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Scrolling liquid gold streams ─────────────────────────────────────────
// This scrolls WITH the page content. Thin, semi-transparent flowing threads
// with a soft blur (no bevel/specular lighting) so the texture reads as a
// faint, elegant wash of light rather than a physical 3D object. It's
// strongest near the top of the page (around the globe) and gently fades
// out as it moves further down through the content.
export function LandingGoldStreams() {
  return (
    <div
      className="absolute inset-0 overflow-hidden pointer-events-none z-0"
      aria-hidden="true"
    >
      <svg
        className="absolute inset-0 w-full h-full opacity-[0.4]"
        viewBox="0 0 1440 5000"
        fill="none"
        preserveAspectRatio="none"
      >
        <defs>
          {/* Delicate gold colour stops — soft, translucent, no hard metallic highlight */}
          <linearGradient id="gold-stream-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%"   stopColor="#8a6f27" stopOpacity="0" />
            <stop offset="20%"  stopColor="#b08a3e" stopOpacity="0.28" />
            <stop offset="45%"  stopColor="#e8c77a" stopOpacity="0.5" />
            <stop offset="55%"  stopColor="#fdf0cf" stopOpacity="0.55" />
            <stop offset="70%"  stopColor="#e8c77a" stopOpacity="0.45" />
            <stop offset="88%"  stopColor="#b08a3e" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#8a6f27" stopOpacity="0" />
          </linearGradient>

          {/* Soft feather — a gentle blur only, no bevel/specular/3D lighting */}
          <filter id="liquid-gold-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" />
          </filter>

          {/* Vertical fade so the texture lives mostly behind/around the globe
              at the top of the page, and quietly recedes further down */}
          <linearGradient id="gold-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#ffffff" stopOpacity="1" />
            <stop offset="16%"  stopColor="#ffffff" stopOpacity="0.85" />
            <stop offset="32%"  stopColor="#ffffff" stopOpacity="0.45" />
            <stop offset="55%"  stopColor="#ffffff" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.08" />
          </linearGradient>
          <mask id="gold-fade-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1440" height="5000">
            <rect x="0" y="0" width="1440" height="5000" fill="url(#gold-fade)" />
          </mask>
        </defs>

        <g mask="url(#gold-fade-mask)" filter="url(#liquid-gold-glow)">
          {/* Stream 1 — left side winding flow */}
          <path
            d="M 120,0 C 350,800 -100,1600 250,2400 C 600,3200 50,4000 180,5000"
            stroke="url(#gold-stream-grad)"
            strokeWidth="1.4"
            strokeLinecap="round"
            className="liquid-gold-path-1"
          />

          {/* Stream 2 — right side winding flow */}
          <path
            d="M 1320,300 C 1000,1100 1450,1900 1100,2700 C 700,3500 1350,4300 1200,5000"
            stroke="url(#gold-stream-grad)"
            strokeWidth="1.7"
            strokeLinecap="round"
            className="liquid-gold-path-2"
          />

          {/* Stream 3 — centre lower flow */}
          <path
            d="M 600,1500 C 850,2300 300,3100 750,4100 C 1000,4600 650,4800 720,5000"
            stroke="url(#gold-stream-grad)"
            strokeWidth="1.1"
            strokeLinecap="round"
            className="liquid-gold-path-3"
          />
        </g>
      </svg>
    </div>
  );
}
