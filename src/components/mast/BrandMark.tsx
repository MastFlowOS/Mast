import mastIcon from "@/assets/mast-icon.png";
import { cn } from "@/lib/utils";

interface BrandMarkProps {
  className?: string;
  size?: number;
  glow?: boolean;
}

/**
 * Mast brand mark — the crow's nest / mast silhouette.
 * Renders the icon inside a softly glowing rounded tile that
 * matches the dark navy / electric indigo brand system.
 */
export function BrandMark({ className, size = 32, glow = true }: BrandMarkProps) {
  return (
    <span
      className={cn(
        "relative inline-grid place-items-center overflow-hidden rounded-[28%] bg-[oklch(0.14_0.04_265)] ring-1 ring-inset ring-white/10",
        glow && "shadow-brand",
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {glow && (
        <span
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 50% 55%, color-mix(in oklab, var(--brand) 55%, transparent) 0%, transparent 65%)",
          }}
        />
      )}
      <img
        src={mastIcon}
        alt=""
        className="relative h-full w-full object-cover scale-[1.05]"
        draggable={false}
      />
    </span>
  );
}
