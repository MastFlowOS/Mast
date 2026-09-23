/**
 * HeroFloorSurface — REAL FLOOR TEXTURE BASE
 *
 * Replaces the conceptual gradient-based approach with a single static floor
 * texture layer that visually contains the actual dark physical floor material
 * from the visual reference:
 * - dark physical surface texture (aged charcoal slate & dark bronze)
 * - visible perspective
 * - subtle reflective material (diffuse specular sheen)
 * - fine engraved / astronomical grid details
 * - localized warm gold lighting
 * - large continuous surface extending through the scene
 * - natural fade into the dark environment
 *
 * CSS only handles:
 * - positioning (anchored to hero bottom, full width)
 * - perspective (subtle 3D plane tilt)
 * - scaling (responsive object-cover anchored to bottom)
 * - opacity (tuned so it sits cleanly on the night background)
 * - edge masking/fade (top fade dissolving seamlessly into atmosphere)
 *
 * Keeps separate:
 * - REAL FLOOR TEXTURE (this component — floor base)
 * - RADAR MARKINGS     (existing layer in GlobePresentationSurface)
 * - GLOBE + STAND      (unchanged)
 */

const FLOOR_TEXTURE_ASSET = "/images/mast-hero-floor-texture.webp";

export function HeroFloorSurface() {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 select-none overflow-hidden z-0"
      aria-hidden="true"
      style={{
        // Bounded height covering the ground area of the hero
        height: "clamp(240px, 44vh, 440px)",
        // CSS edge masking / fade: top horizon dissolves gradually into atmosphere
        WebkitMaskImage:
          "linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 100%)",
        maskImage:
          "linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 100%)",
      }}
    >
      <div
        className="relative w-full h-full"
        style={{
          // Physical recession anchored at the bottom edge
          transform: "perspective(2000px) rotateX(4deg)",
          transformOrigin: "50% 100%",
        }}
      >
        <img
          src={FLOOR_TEXTURE_ASSET}
          alt=""
          draggable={false}
          className="pointer-events-none select-none w-full h-full object-cover object-bottom"
          style={{
            opacity: 0.95,
          }}
        />
      </div>
    </div>
  );
}
