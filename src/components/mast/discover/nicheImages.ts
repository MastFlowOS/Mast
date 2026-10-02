/**
 * Niche → static artwork. One image per niche, always the same one.
 *
 * These are niche illustrations (public/images/niches/), never scraped
 * business photos or logos. To use a photo, drop it in src/assets/niche-photos/
 * named by slug (see README there); nothing else changes.
 * Unknown niches (a future catalog addition) fall back to default.svg.
 */
import { GENERATED_NICHE_FILES } from "./nicheImages.generated";

const BASE = "/images/niches/";

/**
 * Real photos: any file in src/assets/niche-photos/ named by slug
 * (coffee-shop.webp) wins over the illustration. Only URLs are collected here;
 * the browser still fetches just the images the carousel renders.
 */
const PHOTO_URLS = import.meta.glob("/src/assets/niche-photos/*.{webp,jpg,jpeg,png}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const slug = (n: string) =>
  n
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const PHOTOS = new Map<string, string>(
  Object.entries(PHOTO_URLS).map(([path, url]) => [
    (path.split("/").pop() ?? "").replace(/\.[a-z]+$/, ""),
    url,
  ]),
);

export const NICHE_IMAGE_FALLBACK = `${BASE}default.svg`;

export function nicheImage(name: string): string {
  const photo = PHOTOS.get(slug(name));
  if (photo) return photo;
  const file = GENERATED_NICHE_FILES[name];
  return file ? `${BASE}${file}` : NICHE_IMAGE_FALLBACK;
}
