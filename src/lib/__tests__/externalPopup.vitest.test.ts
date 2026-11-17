import { afterEach, describe, expect, it, vi } from "vitest";

const { mockIsDesktopApp, mockOpenDesktopChromePopup } = vi.hoisted(() => ({
  mockIsDesktopApp: vi.fn(() => false),
  mockOpenDesktopChromePopup: vi.fn(async () => true),
}));

vi.mock("@/lib/desktop", () => ({
  isDesktopApp: mockIsDesktopApp,
  openDesktopChromePopup: mockOpenDesktopChromePopup,
}));

import {
  buildGmailComposeUrl,
  normalizeExternalHttpUrl,
  openExternalPopup,
  openGmailComposePopup,
} from "@/lib/externalPopup";

describe("externalPopup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mockIsDesktopApp.mockReturnValue(false);
    mockOpenDesktopChromePopup.mockClear();
  });

  it("normalizes web URLs and rejects unsafe schemes", () => {
    expect(normalizeExternalHttpUrl("example.com/contact")).toBe("https://example.com/contact");
    expect(normalizeExternalHttpUrl("https://www.instagram.com/m/cafe")).toBe(
      "https://www.instagram.com/m/cafe",
    );
    expect(normalizeExternalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeExternalHttpUrl("file:///C:/Windows/win.ini")).toBeNull();
    expect(normalizeExternalHttpUrl("mailto:test@example.com")).toBeNull();
  });

  it("builds a Gmail compose URL with recipient, subject, and body", () => {
    const url = buildGmailComposeUrl({
      to: "owner@cafe.com",
      subject: "Quick idea",
      body: "Hey there!",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://mail.google.com/mail/");
    expect(parsed.searchParams.get("view")).toBe("cm");
    expect(parsed.searchParams.get("to")).toBe("owner@cafe.com");
    expect(parsed.searchParams.get("su")).toBe("Quick idea");
    expect(parsed.searchParams.get("body")).toBe("Hey there!");
  });

  it("opens a new browser tab synchronously in web browser mode and reports blocked tabs", () => {
    const openMock = vi.fn().mockReturnValue({ closed: false });
    vi.stubGlobal("open", openMock);

    const res = openExternalPopup("https://www.instagram.com/m/roasters");
    expect(res.opened).toBe(true);
    expect(res.mode).toBe("browser_popup");
    expect(openMock).toHaveBeenCalledWith(
      "https://www.instagram.com/m/roasters",
      "_blank",
      "noopener,noreferrer",
    );

    openMock.mockReturnValueOnce(null);
    const blocked = openGmailComposePopup({ to: "a@b.com" });
    expect(blocked.opened).toBe(false);
    expect(blocked.mode).toBe("blocked");
  });

  it("delegates to native Chrome popup command inside Tauri desktop app", async () => {
    mockIsDesktopApp.mockReturnValue(true);
    const openMock = vi.fn();
    vi.stubGlobal("open", openMock);

    const res = openExternalPopup("https://www.instagram.com/m/bakery");
    expect(res.opened).toBe(true);
    expect(res.mode).toBe("desktop_chrome_popup");
    expect(mockOpenDesktopChromePopup).toHaveBeenCalledWith(
      "https://www.instagram.com/m/bakery",
    );
    await Promise.resolve();
    expect(openMock).not.toHaveBeenCalled();
  });
});
