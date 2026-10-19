import { useCallback, useEffect, useState } from "react";
import {
  isDesktopApp,
  getDesktopWorkerStatus,
  startDesktopWorker,
  stopDesktopWorker,
  updateDesktopWorkerToken,
  setActiveDesktopPlan,
  type DesktopWorkerStatus,
} from "./index";
import { supabase } from "../supabase";

export interface UseDesktopWorkerResult {
  isDesktop: boolean;
  workerStatus: DesktopWorkerStatus;
  isLoading: boolean;
  error: string | null;
  startWorker: () => Promise<void>;
  stopWorker: () => Promise<void>;
  prepareAndStartWorker: (timeoutMs?: number) => Promise<boolean>;
  ensureWorkerRunning: () => Promise<boolean>;
  setActivePlan: (planId: string | null) => Promise<void>;
  refreshStatus: () => Promise<void>;
}

const DEFAULT_STATUS: DesktopWorkerStatus = {
  is_running: false,
  status: "stopped",
  recent_logs: [],
};

/**
 * React hook to observe and control the local Python discovery worker in MAST Desktop.
 * On the web, isDesktop is false and all worker operations safely reject or no-op.
 */
export function useDesktopWorker(): UseDesktopWorkerResult {
  const [isDesktop, setIsDesktop] = useState<boolean>(() => isDesktopApp());
  const [workerStatus, setWorkerStatus] = useState<DesktopWorkerStatus>(DEFAULT_STATUS);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronize state if Tauri v2 bridge completes injection around mount
  useEffect(() => {
    if (isDesktop) return;

    if (isDesktopApp()) {
      setIsDesktop(true);
      return;
    }

    // WebView2 bridge injection may complete a few milliseconds after React mounts.
    // Poll briefly to detect when the bridge attaches.
    let checks = 0;
    const interval = setInterval(() => {
      checks += 1;
      if (isDesktopApp()) {
        setIsDesktop(true);
        clearInterval(interval);
      } else if (checks >= 25) {
        clearInterval(interval);
      }
    }, 200);

    return () => clearInterval(interval);
  }, [isDesktop]);

  const refreshStatus = useCallback(async () => {
    if (!isDesktopApp() && !isDesktop) return;
    try {
      const status = await getDesktopWorkerStatus();
      setWorkerStatus(status);
      if (status.last_error) {
        setError(status.last_error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [isDesktop]);

  const startWorker = useCallback(async () => {
    const isApp = isDesktopApp() || isDesktop;
    if (!isApp) {
      throw new Error("Cannot start desktop worker in a web browser environment");
    }
    if (!isDesktop) {
      setIsDesktop(true);
    }
    setIsLoading(true);
    setError(null);
    try {
      if (!supabase) {
        throw new Error("Supabase authentication client is not configured.");
      }
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session || !session.access_token) {
        throw new Error("Cannot start desktop discovery worker: User is not authenticated.");
      }

      // Base API URL for cloud coordination
      const apiEnv =
        typeof import.meta !== "undefined" && import.meta.env
          ? import.meta.env
          : (process.env as Record<string, string | undefined>);
      const apiUrl = (apiEnv?.VITE_API_BASE_URL ||
        apiEnv?.VITE_API_URL ||
        apiEnv?.VITE_BACKEND_URL) as string | undefined;

      if (!apiUrl || !apiUrl.trim()) {
        throw new Error(
          "Cannot start desktop discovery worker: MAST API base URL is not configured. Configure VITE_API_BASE_URL.",
        );
      }

      const newStatus = await startDesktopWorker({
        apiUrl: apiUrl.trim(),
        authToken: session.access_token,
      });
      setWorkerStatus(newStatus);
      if (!newStatus.is_running && newStatus.status === "error") {
        throw new Error(newStatus.last_error || "Desktop worker failed to start.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const stopWorker = useCallback(async () => {
    if (!isDesktopApp()) return;
    setIsLoading(true);
    try {
      const newStatus = await stopDesktopWorker();
      setWorkerStatus(newStatus);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial poll and periodic status check when running
  useEffect(() => {
    if (!isDesktop) return;

    void refreshStatus();

    const interval = setInterval(() => {
      void refreshStatus();
    }, 5000);

    return () => clearInterval(interval);
  }, [isDesktop, refreshStatus]);

  // Clean shutdown on logout and safe handling on token refresh
  useEffect(() => {
    if (!isDesktop || !supabase) return;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        void stopDesktopWorker().then((status) => setWorkerStatus(status));
      } else if (event === "TOKEN_REFRESHED" && session?.access_token) {
        // Safe token refresh:
        // Propagate the token to the desktop host so active and future discovery
        // tasks pick up the refreshed credentials without terminating running processes.
        void updateDesktopWorkerToken(session.access_token);
        if (workerStatus.status === "error" && workerStatus.last_error?.includes("401")) {
          setError(null);
        }
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [isDesktop, workerStatus.status, workerStatus.last_error]);

  const prepareAndStartWorker = useCallback(
    async (timeoutMs = 15000): Promise<boolean> => {
      const isApp = isDesktopApp() || isDesktop;
      if (!isApp) {
        throw new Error("Cannot run local desktop worker outside of the desktop application.");
      }
      if (!isDesktop) {
        setIsDesktop(true);
      }

      try {
        const current = await getDesktopWorkerStatus();
        if (current.is_running) {
          setWorkerStatus(current);
          return true;
        }
      } catch {
        // Non-fatal query error; proceed to startWorker
      }

      await startWorker();

      // Poll for confirmed readiness
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
          const verified = await getDesktopWorkerStatus();
          if (verified.is_running) {
            setWorkerStatus(verified);
            return true;
          }
          if (verified.status === "error" || verified.last_error) {
            const errMsg = verified.last_error || "Desktop worker failed to start.";
            throw new Error(errMsg);
          }
        } catch (err) {
          if (
            err instanceof Error &&
            !err.message.includes("fetch") &&
            !err.message.includes("Network")
          ) {
            throw err;
          }
        }
      }

      // Final verification before timeout failure
      const finalCheck = await getDesktopWorkerStatus().catch(() => null);
      if (finalCheck?.is_running) {
        setWorkerStatus(finalCheck);
        return true;
      }

      const timeoutErr = finalCheck?.last_error
        ? `Desktop worker failed to start: ${finalCheck.last_error}`
        : `Desktop worker startup timed out after ${Math.round(
            timeoutMs / 1000,
          )}s without confirmed readiness.`;
      throw new Error(timeoutErr);
    },
    [isDesktop, startWorker],
  );

  const ensureWorkerRunning = useCallback(async (): Promise<boolean> => {
    return prepareAndStartWorker();
  }, [prepareAndStartWorker]);

  const setActivePlan = useCallback(async (planId: string | null): Promise<void> => {
    if (!isDesktopApp() && !isDesktop) return;
    await setActiveDesktopPlan(planId);
  }, [isDesktop]);

  return {
    isDesktop,
    workerStatus,
    isLoading,
    error,
    startWorker,
    stopWorker,
    prepareAndStartWorker,
    ensureWorkerRunning,
    setActivePlan,
    refreshStatus,
  };
}
