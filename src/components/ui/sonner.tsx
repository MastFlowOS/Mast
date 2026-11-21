import { useEffect } from "react";
import { Toaster as Sonner, toast as sonnerToast, useSonner } from "sonner";
import { useRouterState } from "@tanstack/react-router";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const pathname = useRouterState({
    select: (s) => s.location?.pathname ?? "",
  });
  const isDashboard =
    pathname.startsWith("/dashboard") ||
    (typeof window !== "undefined" &&
      window.location.pathname.startsWith("/dashboard"));

  const { toasts } = useSonner();

  // Inside the dashboard, routine action toasts ("Opening Instagram",
  // "Message generated", "Copied to clipboard", etc.) already have inline UI
  // feedback and must NOT spam the Dynamic Island or notification history.
  // Real notifications (replies, discovery completion, imports, follow-ups)
  // publish directly via publishDynamicIslandEvent / addNotification.
  useEffect(() => {
    if (!isDashboard) return;
    for (const t of toasts) {
      if (!t.delete) {
        sonnerToast.dismiss(t.id);
      }
    }
  }, [isDashboard, toasts]);

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
