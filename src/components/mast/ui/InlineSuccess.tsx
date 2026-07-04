/**
 * InlineSuccess — Subtle "✓ Saved" confirmation
 *
 * The premium alternative to full toasts for settings saves and
 * field-level confirmations. Fades in, then fades out after 2.5s.
 *
 * Usage (typical — settings form):
 *
 *   const [saved, setSaved] = useState(false);
 *
 *   async function handleSave() {
 *     await saveSettings(data);
 *     setSaved(true);
 *   }
 *
 *   <InlineSuccess visible={saved} onFadeOut={() => setSaved(false)} />
 *
 * Usage (persistent — never fades):
 *
 *   <InlineSuccess visible={saved} persist />
 *
 * Design rules:
 *   - Never use this for destructive confirmations (use toast)
 *   - Never use this for errors (use inline field error or toast)
 *   - Maximum one InlineSuccess visible at a time per form section
 */

import { useEffect } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface InlineSuccessProps {
  /** Controls visibility */
  visible: boolean;
  /** Called when the auto-fade-out animation ends (2.5s) */
  onFadeOut?: () => void;
  /** Prevent auto-fade — stays visible until `visible` becomes false */
  persist?: boolean;
  /** Optional override label (default: "Saved") */
  label?: string;
  className?: string;
}

export function InlineSuccess({
  visible,
  onFadeOut,
  persist = false,
  label = "Saved",
  className,
}: InlineSuccessProps) {
  useEffect(() => {
    if (!visible || persist || !onFadeOut) return;
    // Auto-fade: the CSS animation runs for 2.5s + duration.fast exit
    const timer = setTimeout(onFadeOut, 2800);
    return () => clearTimeout(timer);
  }, [visible, persist, onFadeOut]);

  if (!visible) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        "text-xs font-semibold text-success",
        "animate-scale-in-fast",
        className,
      )}
    >
      <span className="size-4 rounded-full bg-success/15 grid place-items-center">
        <Check className="size-4 text-success" strokeWidth={3} />
      </span>
      {label}
    </span>
  );
}

// ── Hook helper ───────────────────────────────────────────────────────────────
/**
 * useInlineSuccess — manages the visibility lifecycle for InlineSuccess.
 *
 * Usage:
 *   const { show, trigger } = useInlineSuccess();
 *   await saveSettings(data);
 *   trigger();
 *   <InlineSuccess visible={show.visible} onFadeOut={show.reset} />
 */
import { useState, useCallback } from "react";

export function useInlineSuccess() {
  const [visible, setVisible] = useState(false);

  const trigger = useCallback(() => {
    setVisible(false); // reset first so rapid re-triggers animate
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const reset = useCallback(() => {
    setVisible(false);
  }, []);

  return { visible, trigger, reset };
}
