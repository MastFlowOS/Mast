import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getBusinessLogoUrl } from "../businessLogo";

describe("getBusinessLogoUrl", () => {
  const originalEnv = process.env.VITE_API_BASE_URL;

  beforeEach(() => {
    delete process.env.VITE_API_BASE_URL;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.VITE_API_BASE_URL = originalEnv;
    } else {
      delete process.env.VITE_API_BASE_URL;
    }
  });

  it("generates backend logo scraper URL when VITE_API_BASE_URL is set", () => {
    process.env.VITE_API_BASE_URL = "https://api.mast-os.com";
    const url = getBusinessLogoUrl("https://socochicago.com");
    expect(url).toBe("https://api.mast-os.com/v1/discover/business-logo?url=https%3A%2F%2Fsocochicago.com");
  });

  it("generates a high-res Google Favicon URL fallback when no backend URL is set", () => {
    const url = getBusinessLogoUrl("https://socochicago.com");
    expect(url).toBe("https://www.google.com/s2/favicons?domain=socochicago.com&sz=256");
  });

  it("handles domains with www prefix by stripping www in fallback", () => {
    const url = getBusinessLogoUrl("https://www.papertigercafe.com");
    expect(url).toBe("https://www.google.com/s2/favicons?domain=papertigercafe.com&sz=256");
  });

  it("handles URLs without protocol", () => {
    const url = getBusinessLogoUrl("colectivo.com/pages/lincoln-park");
    expect(url).toBe("https://www.google.com/s2/favicons?domain=colectivo.com&sz=256");
  });

  it("customizes icon size when specified in fallback", () => {
    const url = getBusinessLogoUrl("https://soniascafe.com", 64);
    expect(url).toBe("https://www.google.com/s2/favicons?domain=soniascafe.com&sz=64");
  });

  it("returns null for empty, invalid or local domains", () => {
    expect(getBusinessLogoUrl(null)).toBeNull();
    expect(getBusinessLogoUrl("")).toBeNull();
    expect(getBusinessLogoUrl("   ")).toBeNull();
    expect(getBusinessLogoUrl("localhost")).toBeNull();
    expect(getBusinessLogoUrl("http://localhost:3000")).toBeNull();
    expect(getBusinessLogoUrl("invalid-domain")).toBeNull();
    expect(getBusinessLogoUrl("http://local.test")).toBeNull();
  });
});
