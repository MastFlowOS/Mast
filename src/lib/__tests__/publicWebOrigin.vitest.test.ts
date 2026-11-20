import { afterEach, describe, expect, it } from "vitest";
import { getPublicWebOrigin } from "../api";

describe("getPublicWebOrigin", () => {
  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("uses current origin on normal web deployments", () => {
    expect(getPublicWebOrigin()).toBe(window.location.origin);
  });

  it("uses https://mast-flow.vercel.app instead of tauri.localhost inside MAST Desktop", () => {
    (window as any).__TAURI_INTERNALS__ = { invoke: async () => null };
    expect(getPublicWebOrigin()).toBe("https://mast-flow.vercel.app");
  });
});
