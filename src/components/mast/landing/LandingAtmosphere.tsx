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

// ─── Scrolling 3D viscous liquid gold streams ─────────────────────────────────
// This scrolls WITH the page content. It features a custom specular lighting
// filter to render a thick, glossy, 3D reflective metallic texture.
export function LandingGoldStreams() {
  return (
    <div
      className="absolute inset-0 overflow-hidden pointer-events-none z-0"
      aria-hidden="true"
    >
      <svg
        className="absolute inset-0 w-full h-full opacity-[0.72]"
        viewBox="0 0 1440 5000"
        fill="none"
        preserveAspectRatio="none"
      >
        <defs>
          {/* Metallic cylindrical gradient for base gold colour stops */}
          <linearGradient id="gold-stream-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%"   stopColor="#8a6f27" stopOpacity="0.0" />
            <stop offset="15%"  stopColor="#a67c1e" stopOpacity="0.8" />
            <stop offset="35%"  stopColor="#c9a66b" stopOpacity="1.0" />
            <stop offset="50%"  stopColor="#fff7db" stopOpacity="1.0" />
            <stop offset="65%"  stopColor="#c9a66b" stopOpacity="1.0" />
            <stop offset="85%"  stopColor="#a67c1e" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#8a6f27" stopOpacity="0.0" />
          </linearGradient>

          {/* 3D Specular Bevel filter matching viscous, reflective liquid gold splash texture */}
          <filter id="liquid-gold-bevel" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="blur" />
            <feSpecularLighting in="blur" specularExponent="28" specularConstant="1.6" lighting-color="#ffffff" result="specLight">
              <feDistantLight azimuth="45" elevation="55" />
            </feSpecularLighting>
            <feComposite in="specLight" in2="SourceAlpha" operator="in" result="specOut" />
            <feFlood flood-color="#d4af37" result="goldColor" />
            <feBlend mode="multiply" in="SourceGraphic" in2="goldColor" result="litBase" />
            <feComposite in="litBase" in2="specOut" operator="arithmetic" k1="0" k2="1" k3="1.3" k4="0" result="litGold" />
            <feDropShadow dx="3" dy="8" stdDeviation="7" flood-color="#000000" flood-opacity="0.5" />
          </filter>
        </defs>

        {/* Stream 1 — left side winding flow */}
        <path
          d="M 120,0 C 350,800 -100,1600 250,2400 C 600,3200 50,4000 180,5000"
          stroke="url(#gold-stream-grad)"
          strokeWidth="11"
          strokeLinecap="round"
          filter="url(#liquid-gold-bevel)"
          className="liquid-gold-path-1"
        />

        {/* Stream 2 — right side winding flow */}
        <path
          d="M 1320,300 C 1000,1100 1450,1900 1100,2700 C 700,3500 1350,4300 1200,5000"
          stroke="url(#gold-stream-grad)"
          strokeWidth="13"
          strokeLinecap="round"
          filter="url(#liquid-gold-bevel)"
          className="liquid-gold-path-2"
        />

        {/* Stream 3 — centre lower flow */}
        <path
          d="M 600,1500 C 850,2300 300,3100 750,4100 C 1000,4600 650,4800 720,5000"
          stroke="url(#gold-stream-grad)"
          strokeWidth="9.5"
          strokeLinecap="round"
          filter="url(#liquid-gold-bevel)"
          className="liquid-gold-path-3"
        />
      </svg>
    </div>
  );
}
