import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  isDesktopApp: vi.fn(() => true),
  getDesktopAuthItem: vi.fn<(key: string) => Promise<string | null>>(),
  setDesktopAuthItem: vi.fn<(key: string, value: string) => Promise<void>>(),
  removeDesktopAuthItem: vi.fn<(key: string) => Promise<void>>(),
}));

vi.mock("@/lib/desktop", () => ({
  isDesktopApp: mocks.isDesktopApp,
  getDesktopAuthItem: mocks.getDesktopAuthItem,
  setDesktopAuthItem: mocks.setDesktopAuthItem,
  removeDesktopAuthItem: mocks.removeDesktopAuthItem,
}));

import { createDesktopAwareAuthStorage } from "@/lib/supabase";

describe("createDesktopAwareAuthStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.isDesktopApp.mockReturnValue(true);
    mocks.getDesktopAuthItem.mockResolvedValue(null);
    mocks.setDesktopAuthItem.mockResolvedValue(undefined);
    mocks.removeDesktopAuthItem.mockResolvedValue(undefined);
  });

  it("hydrates http://tauri.localhost localStorage from the disk desktop store", async () => {
    mocks.getDesktopAuthItem.mockResolvedValueOnce('{"access_token":"fresh-oauth"}');
    window.localStorage.setItem("sb-jsbxonmlhkrtuiivehwx-auth-token", '{"access_token":"stale"}');

    const storage = createDesktopAwareAuthStorage();
    expect(storage).toBeDefined();

    const value = await storage!.getItem("sb-jsbxonmlhkrtuiivehwx-auth-token");

    expect(value).toBe('{"access_token":"fresh-oauth"}');
    expect(window.localStorage.getItem("sb-jsbxonmlhkrtuiivehwx-auth-token")).toBe(
      '{"access_token":"fresh-oauth"}',
    );
  });

  it("migrates an existing localStorage token into the disk desktop store when disk is empty", async () => {
    window.localStorage.setItem("sb-jsbxonmlhkrtuiivehwx-auth-token", '{"access_token":"existing"}');
    mocks.getDesktopAuthItem.mockResolvedValueOnce(null);

    const storage = createDesktopAwareAuthStorage();
    const value = await storage!.getItem("sb-jsbxonmlhkrtuiivehwx-auth-token");

    expect(value).toBe('{"access_token":"existing"}');
    expect(mocks.setDesktopAuthItem).toHaveBeenCalledWith(
      "sb-jsbxonmlhkrtuiivehwx-auth-token",
      '{"access_token":"existing"}',
    );
  });

  it("mirrors setItem and removeItem to both localStorage and disk desktop store", async () => {
    const storage = createDesktopAwareAuthStorage();

    await storage!.setItem("sb-jsbxonmlhkrtuiivehwx-auth-token", '{"access_token":"new"}');
    expect(window.localStorage.getItem("sb-jsbxonmlhkrtuiivehwx-auth-token")).toBe(
      '{"access_token":"new"}',
    );
    expect(mocks.setDesktopAuthItem).toHaveBeenCalledWith(
      "sb-jsbxonmlhkrtuiivehwx-auth-token",
      '{"access_token":"new"}',
    );

    await storage!.removeItem("sb-jsbxonmlhkrtuiivehwx-auth-token");
    expect(window.localStorage.getItem("sb-jsbxonmlhkrtuiivehwx-auth-token")).toBeNull();
    expect(mocks.removeDesktopAuthItem).toHaveBeenCalledWith(
      "sb-jsbxonmlhkrtuiivehwx-auth-token",
    );
  });
});
