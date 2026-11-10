import { describe, it, expect } from "vitest";
import { extractLogoFromHtml } from "../businessLogoScraper";

describe("extractLogoFromHtml", () => {
  it("extracts header logo img", () => {
    const html = `
      <html>
        <header>
          <a href="/"><img class="site-logo" src="/assets/brand-logo.png" alt="Company Logo" /></a>
        </header>
      </html>
    `;
    const logo = extractLogoFromHtml(html, "https://example.com");
    expect(logo).toBe("https://example.com/assets/brand-logo.png");
  });

  it("extracts apple-touch-icon when header logo not present", () => {
    const html = `
      <html>
        <head>
          <link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">
        </head>
      </html>
    `;
    const logo = extractLogoFromHtml(html, "https://example.com");
    expect(logo).toBe("https://example.com/icons/apple-touch-icon-180.png");
  });

  it("extracts og:image", () => {
    const html = `
      <html>
        <head>
          <meta property="og:image" content="https://cdn.example.com/social-logo.jpg">
        </head>
      </html>
    `;
    const logo = extractLogoFromHtml(html, "https://example.com");
    expect(logo).toBe("https://cdn.example.com/social-logo.jpg");
  });

  it("extracts schema.org JSON-LD logo", () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Organization",
              "name": "Example Co",
              "logo": "https://example.com/logo.svg"
            }
          </script>
        </head>
      </html>
    `;
    const logo = extractLogoFromHtml(html, "https://example.com");
    expect(logo).toBe("https://example.com/logo.svg");
  });

  it("upgrades Squarespace format to 1500w", () => {
    const html = `
      <header>
        <img class="header-title-logo" src="//images.squarespace-cdn.com/content/v1/xyz/logo.png?format=500w" alt="Cafe Logo" />
      </header>
    `;
    const logo = extractLogoFromHtml(html, "https://example.com");
    expect(logo).toBe("https://images.squarespace-cdn.com/content/v1/xyz/logo.png?format=1500w");
  });

  it("strips GoDaddy/wsimg downsizing parameter", () => {
    const html = `
      <img class="logo" src="//img1.wsimg.com/isteam/ip/123/blob.png/:/rs=w:180,h:180,m" />
    `;
    const logo = extractLogoFromHtml(html, "https://example.com");
    expect(logo).toBe("https://img1.wsimg.com/isteam/ip/123/blob.png");
  });
});
