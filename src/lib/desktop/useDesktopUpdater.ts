import { useCallback, useEffect, useRef, useState } from "react";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isDesktopApp, stopDesktopWorker } from "@/lib/desktop";

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export type DesktopUpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export interface DesktopUpdaterState {
  status: DesktopUpdaterStatus;
  version: string | null;
  currentVersion: string | null;
  progress: number | null;
  error: string | null;
  installUpdate: () => Promise<void>;
  checkForUpdate: () => Promise<void>;
}

/**
 * Silently checks for signed MAST desktop updates in the background and exposes
 * an Antigravity-style one-click install + relaunch flow for the header bar.
 */
export function useDesktopUpdater(): DesktopUpdaterState {
  const [status, setStatus] = useState<DesktopUpdaterStatus>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pendingUpdateRef = useRef<Update | null>(null);
  const activeOpRef = useRef(false);

  const releasePendingUpdate = useCallback(async () => {
    const prev = pendingUpdateRef.current;
    pendingUpdateRef.current = null;
    if (prev && typeof prev.close === "function") {
      try {
        await prev.close();
      } catch {
        // Ignore resource cleanup failures for already-consumed updates
      }
    }
  }, []);

  const checkForUpdate = useCallback(async () => {
    if (!isDesktopApp() || activeOpRef.current) return;

    try {
      const update = await check();
      if (!update) {
        await releasePendingUpdate();
        setVersion(null);
        setCurrentVersion(null);
        setStatus((prev) => (prev === "downloading" || prev === "installing" ? prev : "idle"));
        return;
      }

      if (pendingUpdateRef.current && pendingUpdateRef.current !== update) {
        await releasePendingUpdate();
      }

      pendingUpdateRef.current = update;
      setVersion(update.version);
      setCurrentVersion(update.currentVersion ?? null);
      setError(null);
      setStatus("available");
    } catch {
      // Background update checks stay silent when offline or when no release manifest exists yet
    }
  }, [releasePendingUpdate]);

  const installUpdate = useCallback(async () => {
    if (!isDesktopApp() || activeOpRef.current) return;

    let update = pendingUpdateRef.current;
    if (!update) {
      try {
        update = await check();
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to check for updates");
        return;
      }
      if (!update) {
        setStatus("idle");
        setVersion(null);
        return;
      }
      pendingUpdateRef.current = update;
      setVersion(update.version);
      setCurrentVersion(update.currentVersion ?? null);
    }

    activeOpRef.current = true;
    setError(null);
    setProgress(0);
    setStatus("downloading");

    let totalBytes = 0;
    let downloadedBytes = 0;

    try {
      await update.download((event: DownloadEvent) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? 0;
          downloadedBytes = 0;
          setProgress(0);
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          if (totalBytes > 0) {
            const pct = Math.min(99, Math.round((downloadedBytes / totalBytes) * 100));
            setProgress(pct);
          }
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });

      setStatus("installing");
      setProgress(100);

      // Stop the local Python worker cleanly before launching the installer so
      // Windows does not hold an open file lock on mast-desktop-worker.exe.
      try {
        await stopDesktopWorker();
      } catch {
        // Best-effort worker shutdown; continue installing update
      }

      await update.install({ restartAfterInstall: true });
      await relaunch();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      activeOpRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isDesktopApp()) return;

    void checkForUpdate();
    const timer = window.setInterval(() => {
      void checkForUpdate();
    }, UPDATE_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      if (!activeOpRef.current) {
        void releasePendingUpdate();
      }
    };
  }, [checkForUpdate, releasePendingUpdate]);

  return {
    status,
    version,
    currentVersion,
    progress,
    error,
    installUpdate,
    checkForUpdate,
  };
}
