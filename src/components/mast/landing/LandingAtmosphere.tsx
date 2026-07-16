// Fixed, page-wide ambience behind every section of the landing page:
// a slow, non-rhythmic "liquid gold" drift (replaces the old pulsing glow
// blob) plus a barely-visible starfield for a night-sky feel. Both sit at
// z-index -1 so they never fight normal content for stacking order.
export function LandingAtmosphere() {
  return (
    <>
      <div className="liquid-gold-bg" aria-hidden="true" />
      <div className="starfield" aria-hidden="true" />
    </>
  );
}
