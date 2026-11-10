import { describe, it, expect } from "vitest";
import { getBusinessLogoUrl } from "../businessLogo";

describe("getBusinessLogoUrl", () => {
  it("generates a high-res Google Favicon URL for standard https domains", () => {
    const url = getBusinessLogoUrl("https://socochicago.com");
    expect(url).toBe("https://www.google.com/s2/favicons?domain=socochicago.com&sz=256");
  });

  it("handles domains with www prefix by stripping www", () => {
    const url = getBusinessLogoUrl("https://www.papertigercafe.com");
    expect(url).toBe("https://www.google.com/s2/favicons?domain=papertigercafe.com&sz=256");
  });

  it("handles URLs without protocol", () => {
    const url = getBusinessLogoUrl("colectivo.com/pages/lincoln-park");
    expect(url).toBe("https://www.google.com/s2/favicons?domain=colectivo.com&sz=256");
  });

  it("customizes icon size when specified", () => {
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
