import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  isDesktopApp: vi.fn(() => true),
  stopDesktopWorker: vi.fn().mockResolvedValue({
    is_running: false,
    status: "stopped",
    recent_logs: [],
  }),
  check: vi.fn(),
  relaunch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/desktop", () => ({
  isDesktopApp: mocks.isDesktopApp,
  stopDesktopWorker: mocks.stopDesktopWorker,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mocks.check,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mocks.relaunch,
}));

import { useDesktopUpdater } from "@/lib/desktop/useDesktopUpdater";

describe("useDesktopUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopApp.mockReturnValue(true);
    mocks.stopDesktopWorker.mockResolvedValue({
      is_running: false,
      status: "stopped",
      recent_logs: [],
    });
    mocks.relaunch.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not check for updates outside the desktop runtime", () => {
    mocks.isDesktopApp.mockReturnValue(false);
    const { result } = renderHook(() => useDesktopUpdater());

    expect(result.current.status).toBe("idle");
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("detects an available update, downloads with progress, stops the worker, installs, and relaunches", async () => {
    const callOrder: string[] = [];
    const close = vi.fn().mockResolvedValue(undefined);
    const download = vi.fn(async (onEvent?: (event: any) => void) => {
      callOrder.push("download");
      onEvent?.({ event: "Started", data: { contentLength: 200 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Finished" });
    });
    const install = vi.fn(async () => {
      callOrder.push("install");
    });

    mocks.stopDesktopWorker.mockImplementation(async () => {
      callOrder.push("stopDesktopWorker");
      return { is_running: false, status: "stopped", recent_logs: [] };
    });
    mocks.relaunch.mockImplementation(async () => {
      callOrder.push("relaunch");
    });

    mocks.check.mockResolvedValue({
      version: "1.0.2",
      currentVersion: "1.0.0",
      download,
      install,
      close,
    });

    const { result } = renderHook(() => useDesktopUpdater());

    await waitFor(() => {
      expect(result.current.status).toBe("available");
    });
    expect(result.current.version).toBe("1.0.2");

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(callOrder).toEqual([
      "download",
      "stopDesktopWorker",
      "install",
      "relaunch",
    ]);
    expect(install).toHaveBeenCalledWith({ restartAfterInstall: true });
    expect(result.current.progress).toBe(100);
  });

  it("surfaces retryable error state when download or install fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const download = vi.fn().mockRejectedValue(new Error("Network dropped"));
    const install = vi.fn();

    mocks.check.mockResolvedValue({
      version: "1.0.3",
      currentVersion: "1.0.0",
      download,
      install,
      close,
    });

    const { result } = renderHook(() => useDesktopUpdater());

    await waitFor(() => {
      expect(result.current.status).toBe("available");
    });

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Network dropped");
    expect(mocks.stopDesktopWorker).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });
});
