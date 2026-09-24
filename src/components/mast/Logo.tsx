import { Link } from "@tanstack/react-router";
import { MastWordmark } from "./MastWordmark";

interface LogoProps {
  to?: string;
  /** Rendered height in px of the wordmark. */
  height?: number;
}

export function Logo({ to = "/", height = 24 }: LogoProps) {
  return (
    <Link to={to} className="flex items-center group">
      <MastWordmark height={height} />
    </Link>
  );
}
