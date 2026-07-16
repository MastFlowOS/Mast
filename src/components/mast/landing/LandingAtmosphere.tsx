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
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-[-10] w-screen h-screen">
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

// ─── Scrolling gold streams + shiny particles ──────────────────────────────────
// This scrolls WITH the page content so the streams span the entire landing page
// from top to bottom. Must be placed inside the page's content wrapper.
export function LandingGoldStreams() {
  const [particles, setParticles] = useState<{ id: number; x: number; y: number; size: number; delay: number; duration: number }[]>([]);

  useEffect(() => {
    // Generate organic floating gold particles along/near the stream paths
    const pList = Array.from({ length: 40 }).map((_, i) => ({
      id: i,
      x: Math.random() * 90 + 5, // Keep slightly inside edges
      y: Math.random() * 95 + 2, // Distributed down 5000px content
      size: Math.random() * 2.5 + 1.5, // sizes 1.5px to 4px
      delay: Math.random() * 5,
      duration: Math.random() * 5 + 7, // slow floating cycles
    }));
    setParticles(pList);
  }, []);

  return (
    <div
      className="absolute inset-0 overflow-hidden pointer-events-none z-0"
      aria-hidden="true"
    >
      <svg
        className="absolute inset-0 w-full h-full opacity-[0.28]"
        viewBox="0 0 1440 5000"
        fill="none"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="gold-stream-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#e8c77e" stopOpacity="0.02" />
            <stop offset="15%"  stopColor="#c9a66b" stopOpacity="0.45" />
            <stop offset="50%"  stopColor="#fff3d1" stopOpacity="0.75" />
            <stop offset="85%"  stopColor="#c9a66b" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#e8c77e" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Stream 1 — left side winding flow */}
        <path
          d="M 120,0 C 350,800 -100,1600 250,2400 C 600,3200 50,4000 180,5000"
          stroke="url(#gold-stream-grad)"
          strokeWidth="2"
          strokeLinecap="round"
          className="liquid-gold-path-1"
        />

        {/* Stream 2 — right side winding flow */}
        <path
          d="M 1320,300 C 1000,1100 1450,1900 1100,2700 C 700,3500 1350,4300 1200,5000"
          stroke="url(#gold-stream-grad)"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="liquid-gold-path-2"
        />

        {/* Stream 3 — centre lower flow */}
        <path
          d="M 600,1500 C 850,2300 300,3100 750,4100 C 1000,4600 650,4800 720,5000"
          stroke="url(#gold-stream-grad)"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="liquid-gold-path-3"
        />
      </svg>

      {/* Floating Shiny Gold Particles */}
      <div className="absolute inset-0">
        {particles.map((p) => (
          <div
            key={p.id}
            className="absolute rounded-full bg-gradient-to-r from-[#ffe5a3] via-[#e8c77e] to-[#c9a66b] animate-gold-float animate-gold-twinkle"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              width: `${p.size}px`,
              height: `${p.size}px`,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
              boxShadow: "0 0 4px #ffeab5, 0 0 10px #e8c77e",
            }}
          />
        ))}
      </div>
    </div>
  );
}
