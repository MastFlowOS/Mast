import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NicheCarousel } from "./NicheCarousel";
import { nicheImage, NICHE_IMAGE_FALLBACK } from "./nicheImages";
import { GENERATED_NICHE_FILES } from "./nicheImages.generated";

const NICHES = Object.keys(GENERATED_NICHE_FILES);

class RO {
  constructor(private cb: () => void) {}
  observe() {
    this.cb();
  }
  disconnect() {}
}

function setup(over: Partial<React.ComponentProps<typeof NicheCarousel>> = {}) {
  vi.stubGlobal("ResizeObserver", RO);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 640 });
  const onToggle = vi.fn();
  const utils = render(
    <NicheCarousel
      niches={NICHES}
      matches={NICHES}
      selected={[]}
      focused={null}
      query=""
      onToggle={onToggle}
      {...over}
    />,
  );
  return { ...utils, onToggle };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("nicheImages", () => {
  it("maps every niche to a distinct, existing file", () => {
    const urls = NICHES.map(nicheImage);
    expect(new Set(urls).size).toBe(NICHES.length);
    for (const u of urls) {
      expect(fs.existsSync(path.join(process.cwd(), "public", u))).toBe(true);
    }
  });
  it("falls back for unknown niches", () => {
    expect(nicheImage("Not A Niche")).toBe(NICHE_IMAGE_FALLBACK);
    expect(fs.existsSync(path.join(process.cwd(), "public", NICHE_IMAGE_FALLBACK))).toBe(true);
  });
});

describe("NicheCarousel", () => {
  it("mounts only nearby cards, not the whole library", () => {
    setup();
    const imgs = document.querySelectorAll("img");
    expect(imgs.length).toBeGreaterThan(3);
    expect(imgs.length).toBeLessThan(15);
  });

  it("centres the search match and the checkmark follows selection", () => {
    const { rerender } = setup({ query: "coffee", matches: ["Coffee Shop"] });
    expect(screen.getByRole("button", { name: "Coffee Shop" }).getAttribute("aria-current")).toBe(
      "true",
    );
    expect(document.querySelectorAll("svg.lucide-check").length).toBe(0);
    rerender(
      <NicheCarousel
        niches={NICHES}
        matches={["Coffee Shop"]}
        selected={["Coffee Shop"]}
        focused="Coffee Shop"
        query="coffee"
        onToggle={() => {}}
      />,
    );
    expect(document.querySelectorAll("svg.lucide-check").length).toBe(1);
    expect(screen.getByRole("button", { name: "Coffee Shop" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("arrows move the centre and clicks toggle selection", () => {
    const { onToggle } = setup();
    fireEvent.click(screen.getByLabelText("Next niche"));
    const centre = document.querySelector('[aria-current="true"]')!;
    expect(centre.textContent).toBe(NICHES[1]);
    fireEvent.click(centre);
    expect(onToggle).toHaveBeenCalledWith(NICHES[1]);
  });
});
