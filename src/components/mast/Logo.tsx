import { Link } from "@tanstack/react-router";
import { BrandMark } from "./BrandMark";

interface LogoProps {
  to?: string;
  size?: number;
  showWordmark?: boolean;
}

export function Logo({ to = "/", size = 32, showWordmark = true }: LogoProps) {
  return (
    <Link to={to} className="flex items-center gap-2.5 group">
      <BrandMark size={size} />
      {showWordmark && (
        <span className="font-bold text-lg tracking-[0.02em] text-foreground">
          MAST
        </span>
      )}
    </Link>
  );
}
