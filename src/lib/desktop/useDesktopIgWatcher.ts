import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  disconnectDesktopIgWatcher,
  ensureDesktopIgWatcherBackground,
  getDesktopIgWatcherStatus,
  isDesktopApp,
  openDesktopIgWatcher,
  refreshDesktopIgWatcher,
  type DesktopIgWatcherStatus,
  type DesktopIgWatcherUpdateEvent,
} from "./index";
import { syncInstagramWatcherEvents } from "@/lib/api";

const STATUS_CHANGED_EVENT = "mast:desktop-ig-watcher-status";

function broadcastStatus(status: DesktopIgWatcherStatus | null) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(STATUS_CHANGED_EVENT, { detail: status }));
}

/**
 * Headless background controller mounted once inside DashboardLayout when
 * running in the MAST Desktop app.
 *
 * - Automatically resumes the hidden Instagram watcher on app launch if
 *   previously connected.
 * - Listens to `ig-watcher-update` events from Rust and posts matched unread
 *   DM summaries to `/v1/inbox/ig-sync` using the user's current MAST session.
 * - Refreshes the hidden inbox view every 2 minutes so sessions stay live.
 */
export function useDesktopIgWatcherBackground(enabled: boolean) {
  const prevConnectedRef = useRef<boolean | null>(null);
  const promptedLoginRef = useRef(false);
  const sentKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled || !isDesktopApp()) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    const handleUpdate = async (payload: DesktopIgWatcherUpdateEvent) => {
      if (disposed || !payload?.status) return;
      broadcastStatus(payload.status);

      const wasConnected = prevConnectedRef.current;
      prevConnectedRef.current = payload.status.connected;

      if (payload.status.connected && wasConnected === false) {
        promptedLoginRef.current = false;
        toast.success("Instagram connected! Watching replies in the background.");
      }

      if (payload.status.state === "needs_login" && !promptedLoginRef.current) {
        promptedLoginRef.current = true;
        toast.warning("Instagram sign-in needed to watch DM replies.", {
          action: {
            label: "Reconnect",
            onClick: () => {
              void openDesktopIgWatcher(true).then((s) => s && broadcastStatus(s));
            },
          },
        });
      }

      const freshEvents = (payload.events || []).filter((ev) => {
        const key = `${ev.handle || ev.displayName || ""}:${ev.previewText || "unread"}`;
        if (!key || sentKeysRef.current.has(key)) return false;
        if (sentKeysRef.current.size > 400) sentKeysRef.current.clear();
        sentKeysRef.current.add(key);
        return true;
      });

      if (freshEvents.length > 0) {
        try {
          await syncInstagramWatcherEvents(
            freshEvents.map((ev) => ({
              handle: ev.handle || undefined,
              displayName: ev.displayName || undefined,
              previewText: ev.previewText || undefined,
              threadUrl: ev.threadUrl || undefined,
              unread: true,
              observedAt: new Date().toISOString(),
            })),
          );
        } catch (err) {
          console.warn("[desktop-ig-watcher] ig-sync failed:", err);
        }
      }
    };

    void (async () => {
      try {
        unlisten = await listen<DesktopIgWatcherUpdateEvent>("ig-watcher-update", (event) => {
          void handleUpdate(event.payload);
        });
      } catch (err) {
        console.warn("[desktop-ig-watcher] failed to listen for events:", err);
      }

      const initial = await getDesktopIgWatcherStatus();
      if (!disposed && initial) {
        prevConnectedRef.current = initial.connected;
        broadcastStatus(initial);
        if (initial.enabled) {
          const started = await ensureDesktopIgWatcherBackground();
          if (!disposed && started) broadcastStatus(started);
        }
      }
    })();

    const refreshInterval = window.setInterval(() => {
      void getDesktopIgWatcherStatus().then((status) => {
        if (status?.enabled && status.connected && !status.windowVisible) {
          void refreshDesktopIgWatcher();
        }
      });
    }, 120_000);

    return () => {
      disposed = true;
      window.clearInterval(refreshInterval);
      if (unlisten) unlisten();
    };
  }, [enabled]);
}

/**
 * UI hook consumed inside Settings → ReplyObservationCard to show live IG watcher
 * state and trigger Connect / Check Now / Disconnect actions.
 */
export function useDesktopIgWatcherControl() {
  const desktop = isDesktopApp();
  const [status, setStatus] = useState<DesktopIgWatcherStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let active = true;

    void getDesktopIgWatcherStatus().then((s) => {
      if (active && s) setStatus(s);
    });

    const onStatus = (e: Event) => {
      const detail = (e as CustomEvent<DesktopIgWatcherStatus | null>).detail;
      if (active) setStatus(detail ?? null);
    };

    window.addEventListener(STATUS_CHANGED_EVENT, onStatus);
    return () => {
      active = false;
      window.removeEventListener(STATUS_CHANGED_EVENT, onStatus);
    };
  }, [desktop]);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const next = await openDesktopIgWatcher();
      if (next) {
        setStatus(next);
        broadcastStatus(next);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open Instagram sign-in window.");
    } finally {
      setBusy(false);
    }
  }, []);

  const checkNow = useCallback(async () => {
    setBusy(true);
    try {
      const next = await refreshDesktopIgWatcher();
      if (next) {
        setStatus(next);
        broadcastStatus(next);
      }
      toast.success("Checking Instagram DMs in the background...");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not refresh Instagram watcher.");
    } finally {
      setBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      const next = await disconnectDesktopIgWatcher();
      setStatus(next);
      broadcastStatus(next);
      toast.success("Instagram Reply Watcher disconnected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disconnect Instagram watcher.");
    } finally {
      setBusy(false);
    }
  }, []);

  return { desktop, status, busy, connect, checkNow, disconnect };
}
