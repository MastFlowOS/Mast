/**
 * MastConfirm — Replaces all window.confirm() calls in MAST
 *
 * Three places in the codebase use native browser confirm():
 *   - CRM bulk delete
 *   - Lead Workspace archive
 *   - Lead Workspace delete
 *
 * This component provides a styled, animated alternative using the
 * Radix AlertDialog primitive already installed in the project.
 *
 * Usage:
 *   <MastConfirm
 *     trigger={<Button variant="destructive">Delete</Button>}
 *     title="Delete 3 leads?"
 *     description="This action cannot be undone."
 *     confirmLabel="Delete leads"
 *     onConfirm={handleDelete}
 *     destructive
 *   />
 *
 * Or via the hook (for programmatic confirmation):
 *   const { confirm, ConfirmDialog } = useMastConfirm();
 *   <ConfirmDialog />
 *   ...
 *   const yes = await confirm({
 *     title: "Archive this lead?",
 *     description: "It will be moved out of your active CRM.",
 *   });
 *   if (yes) archiveLead(id);
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useCallback, useRef, useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";

// ── Declarative variant ───────────────────────────────────────────────────────
interface MastConfirmProps {
  /** What triggers the dialog to open */
  trigger: React.ReactNode;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Uses red confirm button and shows warning icon */
  destructive?: boolean;
  /** Called when user clicks the confirm button */
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}

export function MastConfirm({
  trigger,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  disabled = false,
}: MastConfirmProps) {
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await onConfirm();
    } finally {
      setLoading(false);
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild disabled={disabled}>
        {trigger}
      </AlertDialogTrigger>
      <AlertDialogContent className="border-border bg-card max-w-md animate-scale-in">
        <AlertDialogHeader>
          <div className="flex items-start gap-4">
            {destructive && (
              <div className="size-10 rounded-xl bg-destructive/10 border border-destructive/20 grid place-items-center shrink-0">
                {confirmLabel.toLowerCase().includes("delete") ? (
                  <Trash2 className="size-4 text-destructive" />
                ) : (
                  <AlertTriangle className="size-4 text-destructive" />
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <AlertDialogTitle className="text-base font-bold">
                {title}
              </AlertDialogTitle>
              {description && (
                <AlertDialogDescription className="text-sm text-muted-foreground leading-relaxed">
                  {description}
                </AlertDialogDescription>
              )}
            </div>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-1 gap-2">
          <AlertDialogCancel
            className={cn(
              "rounded-lg border-border text-muted-foreground",
              "hover:text-foreground hover:bg-card",
              "transition-colors mast-focus",
            )}
          >
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={loading}
            className={cn(
              "rounded-lg font-semibold btn-press mast-focus",
              destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-brand text-brand-foreground hover:bg-brand-dark",
            )}
          >
            {loading ? "Working…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Hook variant (programmatic) ───────────────────────────────────────────────
interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

/**
 * useMastConfirm — Promise-based confirmation dialog.
 *
 * Renders <ConfirmDialog /> somewhere in the tree (once, near the root of
 * a page component), then call `confirm(options)` to open it.
 * Returns a Promise<boolean> that resolves when the user decides.
 */
export function useMastConfirm() {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({
    title: "Are you sure?",
    destructive: true,
  });
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    setOptions(opts);
    setOpen(true);
    return new Promise((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  function handleConfirm() {
    resolveRef.current?.(true);
    setOpen(false);
  }

  function handleCancel() {
    resolveRef.current?.(false);
    setOpen(false);
  }

  function ConfirmDialog() {
    return (
      <AlertDialog open={open} onOpenChange={(v) => !v && handleCancel()}>
        <AlertDialogContent className="border-border bg-card max-w-md animate-scale-in">
          <AlertDialogHeader>
            <div className="flex items-start gap-4">
              {options.destructive && (
                <div className="size-10 rounded-xl bg-destructive/10 border border-destructive/20 grid place-items-center shrink-0">
                  <AlertTriangle className="size-4 text-destructive" />
                </div>
              )}
              <div className="space-y-1.5">
                <AlertDialogTitle className="text-base font-bold">
                  {options.title}
                </AlertDialogTitle>
                {options.description && (
                  <AlertDialogDescription className="text-sm text-muted-foreground leading-relaxed">
                    {options.description}
                  </AlertDialogDescription>
                )}
              </div>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-1 gap-2">
            <AlertDialogCancel
              onClick={handleCancel}
              className="rounded-lg border-border text-muted-foreground hover:text-foreground hover:bg-card transition-colors mast-focus"
            >
              {options.cancelLabel ?? "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              className={cn(
                "rounded-lg font-semibold btn-press mast-focus",
                options.destructive
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "bg-brand text-brand-foreground hover:bg-brand-dark",
              )}
            >
              {options.confirmLabel ?? "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return { confirm, ConfirmDialog };
}
