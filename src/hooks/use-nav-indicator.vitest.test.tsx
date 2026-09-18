import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { useNavIndicator } from "./use-nav-indicator";

/**
 * A minimal stand-in for the sidebar nav. Mirrors the real shape:
 * a scrollable container with a set of "item" elements, one of which is
 * "active" (matches `activeTo`). `ready` mirrors the dashboard's auth/
 * account loading gate — while false, the container/items aren't in the
 * DOM at all, exactly like the "Loading workspace…" placeholder branch in
 * src/routes/dashboard.tsx.
 */
function TestNav({ activeTo, ready }: { activeTo: string; ready: boolean }) {
  const { indicator, setContainer, registerItem } = useNavIndicator(activeTo);

  if (!ready) {
    return <div data-testid="loading">Loading workspace…</div>;
  }

  return (
    <nav data-testid="nav" ref={setContainer}>
      <div
        data-testid="indicator"
        style={{ top: indicator.top, height: indicator.height, opacity: indicator.opacity }}
      />
      {["/a", "/b", "/c"].map((to) => (
        <a
          key={to}
          data-testid={`item-${to}`}
          href={to}
          ref={(el) => registerItem(to, el)}
        >
          {to}
        </a>
      ))}
    </nav>
  );
}

// jsdom's getBoundingClientRect always returns zeros. Give the container and
// each item distinguishable, stable rects so we can assert the indicator is
// actually tracking the *active* item's geometry, not just "some" value.
const RECTS: Record<string, DOMRect> = {
  container: { top: 100, left: 0, bottom: 400, right: 0, width: 0, height: 300, x: 0, y: 100 } as DOMRect,
  "/a": { top: 110, left: 0, bottom: 150, right: 0, width: 0, height: 40, x: 0, y: 110 } as DOMRect,
  "/b": { top: 160, left: 0, bottom: 200, right: 0, width: 0, height: 40, x: 0, y: 160 } as DOMRect,
  "/c": { top: 210, left: 0, bottom: 250, right: 0, width: 0, height: 40, x: 0, y: 210 } as DOMRect,
};

let originalGetRect: typeof Element.prototype.getBoundingClientRect;

beforeEach(() => {
  originalGetRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const testId = this.getAttribute("data-testid");
    if (testId === "nav") return RECTS.container;
    if (testId?.startsWith("item-")) return RECTS[testId.replace("item-", "")];
    return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0 } as DOMRect;
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetRect;
  cleanup();
});

describe("useNavIndicator", () => {
  it("becomes visible once the nav mounts, even when the active route did not change", async () => {
    // Simulates: page load while auth/account data is still loading (the
    // dashboard's early-return placeholder), then the gate resolving and
    // the real nav mounting — all while staying on the same route. Before
    // the fix, the indicator's remeasure effect was keyed on `activeTo`
    // (and a stable useRef), so it never re-ran here and the pill stayed
    // at opacity: 0 forever.
    const { rerender } = render(<TestNav activeTo="/a" ready={false} />);
    expect(screen.getByTestId("loading")).not.toBeNull();
    expect(screen.queryByTestId("nav")).toBeNull();

    await act(async () => {
      rerender(<TestNav activeTo="/a" ready={true} />);
      // let the effect's requestAnimationFrame callback flush
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });

    const indicator = screen.getByTestId("indicator");
    expect(indicator.style.opacity).toBe("1");
    expect(indicator.style.top).toBe("10px"); // 110 (item /a top) - 100 (container top)
    expect(indicator.style.height).toBe("40px");
  });

  it("moves to the newly active item and restores correctly when navigating back", async () => {
    const { rerender } = render(<TestNav activeTo="/a" ready={true} />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    expect(screen.getByTestId("indicator").style.top).toBe("10px");

    // Navigate to another item.
    await act(async () => {
      rerender(<TestNav activeTo="/b" ready={true} />);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    expect(screen.getByTestId("indicator").style.top).toBe("60px"); // 160 - 100
    expect(screen.getByTestId("indicator").style.opacity).toBe("1");

    // Navigate back to the original item — must be restored deterministically.
    await act(async () => {
      rerender(<TestNav activeTo="/a" ready={true} />);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    expect(screen.getByTestId("indicator").style.top).toBe("10px");
    expect(screen.getByTestId("indicator").style.opacity).toBe("1");
  });

  it("re-syncs on visibilitychange without depending on it for the initial resting state", async () => {
    render(<TestNav activeTo="/c" ready={true} />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });

    const indicator = screen.getByTestId("indicator");
    expect(indicator.style.top).toBe("110px"); // 210 - 100
    expect(indicator.style.opacity).toBe("1");

    // Simulate returning from a backgrounded tab: this must not be required
    // for correctness (already verified above), but should not break it,
    // and should re-affirm the same deterministic value.
    await act(async () => {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(indicator.style.top).toBe("110px");
    expect(indicator.style.opacity).toBe("1");
  });
});
