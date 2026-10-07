/**
 * Avatar crop math. Pure functions — no DOM — so they can be unit tested.
 *
 * Coordinate model:
 *  - The crop circle (diameter `circle`) is centred in the viewport.
 *  - The image is centred in the viewport, then translated by `pan` (screen px).
 *  - Displayed size of the image = natural size * scale, where
 *    scale = minScale * zoom and zoom >= 1.
 */

export const AVATAR_OUTPUT_SIZE = 256;

/**
 * Smallest scale at which the image still fully covers the crop circle
 * (its shorter side equals the circle diameter). Anything smaller would
 * leave empty space inside the circle.
 */
export function computeMinScale(natW: number, natH: number, circle: number): number {
  if (!(natW > 0) || !(natH > 0) || !(circle > 0)) return 1;
  return Math.max(circle / natW, circle / natH);
}

/** Clamp pan so the displayed image always covers the whole crop circle. */
export function clampPan(
  pan: { x: number; y: number },
  natW: number,
  natH: number,
  scale: number,
  circle: number,
): { x: number; y: number } {
  const maxX = Math.max(0, (natW * scale - circle) / 2);
  const maxY = Math.max(0, (natH * scale - circle) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)),
    y: Math.min(maxY, Math.max(-maxY, pan.y)),
  };
}

/**
 * Square source rectangle, in ORIGINAL image pixels, that sits under the crop circle.
 */
export function computeSourceRect(
  natW: number,
  natH: number,
  scale: number,
  pan: { x: number; y: number },
  circle: number,
): { sx: number; sy: number; sSize: number } {
  const sSize = Math.min(circle / scale, natW, natH);
  const sx = natW / 2 - pan.x / scale - sSize / 2;
  const sy = natH / 2 - pan.y / scale - sSize / 2;
  return {
    sx: Math.min(natW - sSize, Math.max(0, sx)),
    sy: Math.min(natH - sSize, Math.max(0, sy)),
    sSize,
  };
}
