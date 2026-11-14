import { useEffect, useRef } from "react";
import { Toaster as Sonner, toast as sonnerToast, useSonner } from "sonner";
import { useRouterState } from "@tanstack/react-router";
import {
  dynamicIslandStore,
  publishDynamicIslandEvent,
} from "@/lib/dynamic-island";
import { addNotification } from "@/lib/notifications";

type ToasterProps = React.ComponentProps<typeof Sonner>;

function toText(node: unknown): string {
  if (typeof node === "function") {
    try {
      return toText((node as () => unknown)());
    } catch {
      return "";
    }
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node).trim();
  }
  return "";
}

const Toaster = ({ ...props }: ToasterProps) => {
  const pathname = useRouterState({
    select: (s) => s.location?.pathname ?? "",
  });
  const isDashboard =
    pathname.startsWith("/dashboard") ||
    (typeof window !== "undefined" &&
      window.location.pathname.startsWith("/dashboard"));

  const { toasts } = useSonner();
  const seenIdsRef = useRef<Set<string | number>>(new Set());

  useEffect(() => {
    if (!isDashboard) return;

    for (const t of toasts) {
      if (t.delete || seenIdsRef.current.has(t.id)) continue;
      seenIdsRef.current.add(t.id);

      const rawTitle = toText(t.title);
      const rawDesc = toText(t.description);
      if (!rawTitle && !rawDesc) {
        sonnerToast.dismiss(t.id);
        continue;
      }

      const title = rawTitle || rawDesc;
      const description = rawTitle && rawDesc ? rawDesc : undefined;

      // Avoid clobbering a dedicated rich Dynamic Island event (e.g. discovery_complete,
      // import_complete, discovery_error) that was published in the same tick.
      const now = Date.now();
      const recentRichEvent = dynamicIslandStore
        .getSnapshot()
        .some(
          (ev) =>
            (ev.type === "discovery_complete" ||
              ev.type === "import_complete" ||
              ev.type === "discovery_error") &&
            now - ev.timestamp < 900,
        );

      if (!recentRichEvent) {
        const isExport = /export/i.test(title);
        const eventType =
          t.type === "error"
            ? "discovery_error"
            : isExport
              ? "import_complete"
              : t.type === "success"
                ? "discovery_complete"
                : "notification";

        publishDynamicIslandEvent({
          id: `toast_${t.id}`,
          type: eventType,
          title: isExport && !/^export/i.test(title) ? "Export complete" : title,
          description:
            isExport && !/^export/i.test(title) ? `${title}.` : description,
          autoDismissMs: t.type === "error" ? 7500 : 6000,
        });

        addNotification({
          icon:
            t.type === "error"
              ? "Bell"
              : t.type === "success" || isExport
                ? "CheckCircle2"
                : "Bell",
          iconColor:
            t.type === "error"
              ? "text-rose-400"
              : t.type === "success" || isExport
                ? "text-emerald-400"
                : "text-amber-400",
          iconBg:
            t.type === "error"
              ? "bg-rose-500/10 border-rose-500/20"
              : t.type === "success" || isExport
                ? "bg-emerald-400/10 border-emerald-400/20"
                : "bg-amber-400/10 border-amber-400/20",
          title: isExport && !/^export/i.test(title) ? "Export complete" : title,
          body:
            isExport && !/^export/i.test(title)
              ? `${title}.`
              : description || title,
        });
      }

      sonnerToast.dismiss(t.id);
    }
  }, [isDashboard, toasts]);

  // Inside the dashboard, all notifications live inside the center Dynamic Island
  // and its centered dropdown — never render side toast popups.
  if (isDashboard) {
    return null;
  }

  return (
    <Sonner
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
