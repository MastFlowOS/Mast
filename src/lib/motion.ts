/**
 * MAST Motion System — JavaScript constants
 *
 * These mirror the CSS custom properties defined in styles.css.
 * Use these whenever you need timing/easing in JavaScript
 * (e.g. setTimeout, Web Animations API, conditional class delays).
 *
 * The authoritative source is styles.css.
 * Keep these in sync if CSS tokens ever change.
 */

// ── Durations (milliseconds) ─────────────────────────────────────────────────
export const duration = {
  /** Micro-interactions: checkbox toggle, focus ring. 80ms */
  instant: 80,
  /** Quick feedback: hover states, tooltips. 150ms */
  fast: 150,
  /** Default transitions: most UI state changes. 250ms */
  normal: 250,
  /** Deliberate: panel open, modal, slide-in. 400ms */
  slow: 400,
  /** Page/section entrances. 550ms */
  enter: 550,
  /**
   * Exits are always faster than entrances.
   * Things arrive gracefully, leave quickly. 200ms
   */
  exit: 200,
} as const;

export type Duration = typeof duration[keyof typeof duration];

// ── Easing functions (CSS cubic-bezier strings) ───────────────────────────────
export const easing = {
  /**
   * The primary easing for all spatial movement (sidebar indicator,
   * cards, drawers). Fast start, gentle settle. No overshoot.
   */
  spring: "cubic-bezier(0.16, 1, 0.3, 1)",
  /** Standard deceleration — arrival / entrance */
  out: "cubic-bezier(0, 0, 0.2, 1)",
  /** Standard acceleration — departure / exit */
  in: "cubic-bezier(0.4, 0, 1, 1)",
  /** Both: default for most generic transitions */
  default: "cubic-bezier(0.4, 0, 0.2, 1)",
  /** Only for continuous animations (shimmer, rotate) */
  linear: "linear",
} as const;

export type Easing = typeof easing[keyof typeof easing];

// ── Stagger helpers ───────────────────────────────────────────────────────────
/**
 * Returns the Tailwind delay class for a list index.
 * Usage: <div className={`animate-fade-up ${staggerDelay(i)}`}>
 *
 * @param index — 0-based position in the list
 * @param step  — ms between each item (default 60ms)
 */
export function staggerDelay(index: number, step = 60): string {
  const ms = Math.min(index * step, 800);
  const buckets: Record<number, string> = {
    0: "", 50: "delay-50", 75: "delay-75", 100: "delay-100",
    150: "delay-150", 200: "delay-200", 250: "delay-250",
    300: "delay-300", 350: "delay-350", 400: "delay-400",
    500: "delay-500", 600: "delay-600", 700: "delay-700", 800: "delay-800",
  };
  // Round to nearest bucket
  const closest = Object.keys(buckets)
    .map(Number)
    .reduce((prev, curr) => Math.abs(curr - ms) < Math.abs(prev - ms) ? curr : prev);
  return buckets[closest] ?? "";
}

// ── Transition presets ────────────────────────────────────────────────────────
/**
 * CSS transition shorthand strings for use in inline style objects.
 * These should be the rare exception — prefer Tailwind utilities.
 */
export const transition = {
  /** Card lift on hover */
  card: `transform ${duration.normal}ms ${easing.spring}, box-shadow ${duration.normal}ms ${easing.spring}, border-color ${duration.fast}ms ${easing.default}`,
  /** Sidebar active indicator glide */
  navIndicator: `top ${duration.slow}ms ${easing.spring}, height ${duration.normal}ms ${easing.spring}, opacity ${duration.fast}ms ${easing.default}`,
  /** Button press */
  button: `transform ${duration.instant}ms ${easing.default}, filter ${duration.instant}ms ${easing.default}`,
  /** Generic colour/opacity change */
  color: `color ${duration.fast}ms ${easing.default}, background-color ${duration.fast}ms ${easing.default}, border-color ${duration.fast}ms ${easing.default}, opacity ${duration.fast}ms ${easing.default}`,
  /** Progress bars */
  progress: `width 1.4s ${easing.spring}`,
} as const;

// ── Interaction rules (non-negotiable product principles) ─────────────────────
/**
 * These are the design system's motion rules. Reference them in reviews.
 *
 * 1. Nothing appears instantly — minimum fade-in of `duration.fast`.
 * 2. Nothing disappears instantly — minimum fade-out of `duration.exit`.
 * 3. Exits are always faster than their paired entrances.
 * 4. Spatial movement (things that change position) uses `easing.spring`.
 * 5. Opacity-only changes use `easing.out` (entrance) / `easing.in` (exit).
 * 6. Continuous animations (loading, live indicators) loop at ≤ 2.5s period.
 * 7. Never animate more than 3 properties simultaneously.
 * 8. All list items stagger with `staggerDelay()`. Max stagger: 800ms total.
 * 9. Page transitions use `animate-page-enter` on the route outlet wrapper.
 * 10. Destructive actions use `animate-shake` on error, `animate-success` on confirm.
 */
export const rules = {
  minAppear: duration.fast,
  minDisappear: duration.exit,
  spatialEasing: easing.spring,
  entranceEasing: easing.out,
  exitEasing: easing.in,
  maxConcurrentProperties: 3,
  maxStagger: 800,
} as const;
