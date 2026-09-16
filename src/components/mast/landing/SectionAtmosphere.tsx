import { useEffect, useState } from "react";

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

export type SectionAtmosphereVariant = "hero" | "solutions" | "features" | "platform" | "customers" | "footer";

// ─── Global Night World Foundation (Continuous backdrop beneath all sections) ──
// Prevents any atmospheric vacuums: ensures every section has faint global night tone,
// sparse distant stars, and subtle ambient depth behind the entire page.
export function GlobalAtmosphereFoundation() {
  const [globalStars, setGlobalStars] = useState<Star[]>([]);

  useEffect(() => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const count = 48;
    const list: Star[] = [];

    for (let i = 0; i < count; i++) {
      const x = rand() * 100;
      const y = rand() * 100;
      const roll = rand();
      const size = 0.6 + rand() * 0.5; // Fine micro-stars 0.6px - 1.1px
      let opacity = 0.12 + rand() * 0.16; // Faint 0.12 - 0.28
      let type: Star["type"] = "drift-a";
      let duration = 80;

      if (roll < 0.70) {
        type = rand() > 0.5 ? "drift-a" : "drift-b";
        duration = 75 + rand() * 35;
      } else {
        type = "breathe";
        duration = 7.0 + rand() * 5.0;
      }

      const delay = -(rand() * 25);
      list.push({ id: i, x, y, size, opacity, type, duration, delay });
    }

    setGlobalStars(list);
  }, []);

  return (
    <div
      className="fixed inset-0 pointer-events-none select-none -z-10 overflow-hidden"
      aria-hidden="true"
    >
      {/* 1. Deep space base gradient across entire page */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, #020512 0%, #01030c 24%, #01020a 52%, #010208 76%, #000104 100%)",
        }}
      />

      {/* 2. Global faint atmospheric depth veils (never a dead black void) */}
      <div
        className="absolute right-[5%] top-[12%] w-[75vw] h-[65vh] blur-[150px] mix-blend-screen opacity-[0.024] animate-atmo-haze"
        style={{
          background:
            "radial-gradient(ellipse at 50% 50%, rgba(70, 110, 200, 0.75) 0%, transparent 75%)",
        }}
      />
      <div
        className="absolute left-[8%] top-[55%] w-[80vw] h-[55vh] blur-[140px] mix-blend-screen opacity-[0.018]"
        style={{
          background:
            "radial-gradient(ellipse at 50% 50%, rgba(55, 90, 175, 0.65) 0%, transparent 75%)",
        }}
      />

      {/* 3. Global sparse distant micro-stars */}
      <div className="absolute inset-0">
        {globalStars.map((star) => {
          let animClass = "";
          if (star.type === "drift-a") animClass = "animate-star-drift-a";
          else if (star.type === "drift-b") animClass = "animate-star-drift-b";
          else if (star.type === "breathe") animClass = "animate-star-breathe";

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

// ─── Section-Specific Atmosphere (Local Environmental Conditions) ─────────────

function generateStars(variant: SectionAtmosphereVariant): Star[] {
  let count = 20;
  let seed = 100;

  switch (variant) {
    case "hero":
      count = 34;
      seed = 107;
      break;
    case "solutions":
      count = 22;
      seed = 223;
      break;
    case "features":
      count = 24;
      seed = 349;
      break;
    case "platform":
      count = 26;
      seed = 419;
      break;
    case "customers":
      count = 18;
      seed = 479;
      break;
    case "footer":
      count = 14;
      seed = 601;
      break;
  }

  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const stars: Star[] = [];

  for (let i = 0; i < count; i++) {
    const x = rand() * 100;
    const y = rand() * 100;

    const roll = rand();
    let type: Star["type"] = "drift-a";
    let duration = 70;
    let size = 0.75 + rand() * 0.6;
    let opacity = 0.22;
    let delay = 0;

    if (roll < 0.65) {
      // Group A (~65%): Mostly stable with slow micro-drift (0.15–0.35 opacity)
      type = rand() > 0.5 ? "drift-a" : "drift-b";
      duration = 60 + rand() * 30;
      opacity = 0.16 + rand() * 0.16;
      size = 0.7 + rand() * 0.5;
      delay = -(rand() * 35);
    } else if (roll < 0.90) {
      // Group B (~25%): Gentle breathing (0.12–0.48 opacity)
      type = "breathe";
      duration = 5.5 + rand() * 4.0;
      opacity = 0.14 + rand() * 0.20;
      size = 0.85 + rand() * 0.5;
      delay = -(rand() * 12);
    } else {
      // Group C (~10%): Noticeable twinkling (0.15–0.70 opacity)
      type = "twinkle";
      duration = 3.5 + rand() * 3.0;
      opacity = 0.18 + rand() * 0.28;
      size = 0.95 + rand() * 0.55;
      delay = -(rand() * 8);
    }

    stars.push({ id: i, x, y, size, opacity, type, duration, delay });
  }

  return stars;
}

export function SectionAtmosphere({ variant }: { variant: SectionAtmosphereVariant }) {
  const [stars, setStars] = useState<Star[]>([]);

  useEffect(() => {
    setStars(generateStars(variant));
  }, [variant]);

  // Soft vertical feathering on section atmospheres prevents rectangular boundary cutoffs
  const maskStyle: React.CSSProperties =
    variant === "hero"
      ? {
          WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 85%, transparent 100%)",
          maskImage: "linear-gradient(to bottom, black 0%, black 85%, transparent 100%)",
        }
      : variant === "footer"
      ? {
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 15%, black 100%)",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 15%, black 100%)",
        }
      : {
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%)",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%)",
        };

  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden select-none z-0"
      style={maskStyle}
      aria-hidden="true"
    >
      {/* 1. Atmospheric Haze & Ambient Depth (Autonomous, time-based) */}
      {variant === "hero" && (
        <>
          {/* Full-width continuous night sky depth across the entire hero width */}
          <div
            className="absolute inset-0 blur-[130px] mix-blend-screen opacity-[0.028] animate-atmo-haze pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse 95% 65% at 50% 45%, rgba(70, 110, 200, 0.75) 0%, rgba(35, 65, 140, 0.25) 60%, transparent 85%)",
            }}
          />
          {/* Soft planetary back-glow framing the Earth on the right */}
          <div
            className="absolute right-[4%] top-[10%] w-[52vw] h-[52vw] max-w-[680px] max-h-[680px] rounded-full blur-[120px] mix-blend-screen opacity-[0.032] pointer-events-none"
            style={{
              background:
                "radial-gradient(circle at 50% 50%, rgba(85, 130, 225, 0.8) 0%, rgba(40, 70, 160, 0.25) 55%, transparent 80%)",
            }}
          />
        </>
      )}

      {variant === "solutions" && (
        <div
          className="absolute left-[10%] top-[20%] w-[65vw] h-[40vh] blur-[120px] mix-blend-screen opacity-[0.024]"
          style={{
            background:
              "radial-gradient(ellipse at 50% 50%, rgba(85, 125, 205, 0.7) 0%, transparent 75%)",
          }}
        />
      )}

      {variant === "features" && (
        <div
          className="absolute right-[15%] top-[25%] w-[60vw] h-[40vh] blur-[115px] mix-blend-screen opacity-[0.022]"
          style={{
            background:
              "radial-gradient(ellipse at 50% 50%, rgba(70, 105, 190, 0.65) 0%, transparent 75%)",
          }}
        />
      )}

      {variant === "platform" && (
        <div
          className="absolute inset-0 blur-[125px] mix-blend-screen opacity-[0.030] animate-atmo-haze"
          style={{
            background:
              "radial-gradient(ellipse 90% 50% at 50% 45%, rgba(65, 100, 185, 0.7) 0%, transparent 75%)",
          }}
        />
      )}

      {variant === "customers" && (
        <div
          className="absolute right-[12%] top-[25%] w-[55vw] h-[35vh] blur-[110px] mix-blend-screen opacity-[0.016]"
          style={{
            background:
              "radial-gradient(ellipse at 50% 50%, rgba(60, 95, 180, 0.6) 0%, transparent 75%)",
          }}
        />
      )}

      {/* 2. Autonomous Horizontally Moving Cloud Formations */}
      {/* HERO: Full-width continuous atmospheric field spanning entire viewport + overscan */}
      {variant === "hero" && (
        <div
          className="absolute inset-0 overflow-hidden pointer-events-none"
          style={{
            maskImage:
              "linear-gradient(to right, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0.48) 35%, rgba(0,0,0,0.80) 65%, rgba(0,0,0,0.95) 85%, rgba(0,0,0,0.85) 100%)",
            WebkitMaskImage:
              "linear-gradient(to right, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0.48) 35%, rgba(0,0,0,0.80) 65%, rgba(0,0,0,0.95) 85%, rgba(0,0,0,0.85) 100%)",
          }}
        >
          {/* Formation A (Macro Elongated Belt): Translates Left -> Right (115s loop) - mid sky */}
          <div className="absolute top-[16%] inset-x-0 h-[52%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-macro">
              <HeroCloudTileA idSuffix="a1" />
              <HeroCloudTileA idSuffix="a2" />
            </div>
          </div>

          {/* Formation B (Secondary Drift): Translates Right -> Left (82s loop) - upper sky */}
          <div className="absolute top-[-2%] inset-x-0 h-[48%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-secondary">
              <HeroCloudTileB idSuffix="b1" />
              <HeroCloudTileB idSuffix="b2" />
            </div>
          </div>

          {/* Formation C (Cirrus Ribbons): Translates Left -> Right (50s loop) - lower/mid sky */}
          <div className="absolute top-[42%] inset-x-0 h-[44%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-cirrus">
              <HeroCloudTileC idSuffix="c1" />
              <HeroCloudTileC idSuffix="c2" />
            </div>
          </div>
        </div>
      )}

      {variant === "solutions" && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-[0.075]">
          <div className="flex w-[200%] h-full animate-cloud-belt-solutions">
            <SolutionsCloudTile idSuffix="s1" />
            <SolutionsCloudTile idSuffix="s2" />
          </div>
        </div>
      )}

      {variant === "features" && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-[0.068]">
          <div className="flex w-[200%] h-full animate-cloud-belt-features">
            <FeaturesCloudTile idSuffix="f1" />
            <FeaturesCloudTile idSuffix="f2" />
          </div>
        </div>
      )}

      {/* Platform Section: Upper thin wisps + Middle depth + Lower entering formation */}
      {variant === "platform" && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-[0.085]">
          {/* Upper thin wisps (45s loop LTR) */}
          <div className="absolute top-[4%] inset-x-0 h-[46%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-platform-c">
              <PlatformCloudTileUpper idSuffix="p-up1" />
              <PlatformCloudTileUpper idSuffix="p-up2" />
            </div>
          </div>

          {/* Lower entering cloud bank (70s loop RTL) */}
          <div className="absolute bottom-[4%] inset-x-0 h-[52%] overflow-hidden">
            <div className="flex w-[200%] h-full animate-cloud-belt-platform-b">
              <PlatformCloudTileLower idSuffix="p-dn1" />
              <PlatformCloudTileLower idSuffix="p-dn2" />
            </div>
          </div>
        </div>
      )}

      {variant === "customers" && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-[0.045]">
          <div className="flex w-[200%] h-full animate-cloud-belt-customers">
            <CustomersCloudTile idSuffix="cu1" />
            <CustomersCloudTile idSuffix="cu2" />
          </div>
        </div>
      )}

      {/* 3. Section-Specific Living Stars (No Scroll Parallax) */}
      <div className="absolute inset-0 pointer-events-none">
        {stars.map((star) => {
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

// ─── Cloud SVG Tiles (Deterministic elongated procedural atmospheric formations) ──

function HeroCloudTileA({ idSuffix }: { idSuffix: string }) {
  const filterId = `hero-cloud-a-${idSuffix}`;
  const maskId = `hero-mask-a-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative opacity-[0.11] mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 400" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0018 0.008"
              numOctaves="4"
              result="noise"
              seed="42"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.22
                0 0 0 0 0.32
                0 0 0 0 0.54
                2.4 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="22%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="78%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="400" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="400" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function HeroCloudTileB({ idSuffix }: { idSuffix: string }) {
  const filterId = `hero-cloud-b-${idSuffix}`;
  const maskId = `hero-mask-b-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative opacity-[0.085] mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 360" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0024 0.009"
              numOctaves="4"
              result="noise"
              seed="91"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.24
                0 0 0 0 0.34
                0 0 0 0 0.58
                2.2 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="25%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="75%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="360" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="360" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function HeroCloudTileC({ idSuffix }: { idSuffix: string }) {
  const filterId = `hero-cloud-c-${idSuffix}`;
  const maskId = `hero-mask-c-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative opacity-[0.065] mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 320" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0032 0.012"
              numOctaves="3"
              result="noise"
              seed="77"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.26
                0 0 0 0 0.38
                0 0 0 0 0.62
                2.0 0 0 0 -0.8"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="30%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="70%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="320" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="320" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function SolutionsCloudTile({ idSuffix }: { idSuffix: string }) {
  const filterId = `sol-cloud-${idSuffix}`;
  const maskId = `sol-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 400" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0022 0.0085"
              numOctaves="3"
              result="noise"
              seed="12"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.20
                0 0 0 0 0.30
                0 0 0 0 0.50
                2.1 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="20%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="80%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="400" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="400" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function FeaturesCloudTile({ idSuffix }: { idSuffix: string }) {
  const filterId = `feat-cloud-${idSuffix}`;
  const maskId = `feat-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 400" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0020 0.0075"
              numOctaves="3"
              result="noise"
              seed="64"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.18
                0 0 0 0 0.26
                0 0 0 0 0.44
                2.0 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="25%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="75%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="400" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="400" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function PlatformCloudTileUpper({ idSuffix }: { idSuffix: string }) {
  const filterId = `plat-up-cloud-${idSuffix}`;
  const maskId = `plat-up-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 350" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0026 0.010"
              numOctaves="3"
              result="noise"
              seed="53"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.22
                0 0 0 0 0.32
                0 0 0 0 0.52
                2.0 0 0 0 -0.82"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="22%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="78%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="350" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="350" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function PlatformCloudTileLower({ idSuffix }: { idSuffix: string }) {
  const filterId = `plat-dn-cloud-${idSuffix}`;
  const maskId = `plat-dn-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 420" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0019 0.008"
              numOctaves="3"
              result="noise"
              seed="82"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.20
                0 0 0 0 0.28
                0 0 0 0 0.48
                2.1 0 0 0 -0.85"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="25%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="75%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="420" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="420" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}

function CustomersCloudTile({ idSuffix }: { idSuffix: string }) {
  const filterId = `cust-cloud-${idSuffix}`;
  const maskId = `cust-mask-${idSuffix}`;
  return (
    <div className="w-1/2 h-full shrink-0 relative mix-blend-screen">
      <svg className="w-full h-full" viewBox="0 0 1600 350" preserveAspectRatio="none">
        <defs>
          <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.0028 0.011"
              numOctaves="3"
              result="noise"
              seed="88"
              stitchTiles="stitch"
            />
            <feColorMatrix
              type="matrix"
              values="
                0 0 0 0 0.22
                0 0 0 0 0.32
                0 0 0 0 0.52
                1.8 0 0 0 -0.8"
            />
          </filter>
          <linearGradient id={maskId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="30%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="70%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`m-${maskId}`}>
            <rect width="1600" height="350" fill={`url(#${maskId})`} />
          </mask>
        </defs>
        <rect width="1600" height="350" filter={`url(#${filterId})`} mask={`url(#m-${maskId})`} />
      </svg>
    </div>
  );
}
