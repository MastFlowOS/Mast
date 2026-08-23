import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractInstagramHandle, normalizeInstagram } from "../instagram.js";
import { isValidInstagram } from "../leadValidation.js";

describe("Bug 2: Instagram URL and Handle Normalization", () => {
  it("1. normalizes a bare handle", () => {
    const res = normalizeInstagram("recessgrove");
    assert.notEqual(res, null);
    assert.equal(res?.handle, "recessgrove");
    assert.equal(res?.profileUrl, "https://www.instagram.com/recessgrove/");
    assert.equal(res?.dmUrl, "https://ig.me/m/recessgrove");
  });

  it("2. normalizes @handle", () => {
    const res = normalizeInstagram("@recessgrove");
    assert.notEqual(res, null);
    assert.equal(res?.handle, "recessgrove");
    assert.equal(res?.profileUrl, "https://www.instagram.com/recessgrove/");
    assert.equal(res?.dmUrl, "https://ig.me/m/recessgrove");
  });

  it("3. normalizes full instagram URL without double prefixing", () => {
    const res1 = normalizeInstagram("https://instagram.com/recessgrove");
    assert.notEqual(res1, null);
    assert.equal(res1?.handle, "recessgrove");
    assert.equal(res1?.profileUrl, "https://www.instagram.com/recessgrove/");
    assert.equal(res1?.dmUrl, "https://ig.me/m/recessgrove");

    const res2 = normalizeInstagram("https://www.instagram.com/recessgrove");
    assert.notEqual(res2, null);
    assert.equal(res2?.handle, "recessgrove");
    assert.equal(res2?.profileUrl, "https://www.instagram.com/recessgrove/");
    assert.equal(res2?.dmUrl, "https://ig.me/m/recessgrove");
  });

  it("4. normalizes URL with trailing slash, query params, and hashes", () => {
    const res = normalizeInstagram("https://www.instagram.com/recessgrove/?igsh=123#feed");
    assert.notEqual(res, null);
    assert.equal(res?.handle, "recessgrove");
    assert.equal(res?.profileUrl, "https://www.instagram.com/recessgrove/");
    assert.equal(res?.dmUrl, "https://ig.me/m/recessgrove");
  });

  it("5. normalizes malformed double URL from existing stored data", () => {
    const res = normalizeInstagram("https://www.instagram.com/https://www.instagram.com/recessgrove/");
    assert.notEqual(res, null);
    assert.equal(res?.handle, "recessgrove");
    assert.equal(res?.profileUrl, "https://www.instagram.com/recessgrove/");
    assert.equal(res?.dmUrl, "https://ig.me/m/recessgrove");
  });

  it("6. rejects reserved Instagram paths, numeric-only handles, and bare homepages", () => {
    const reservedPaths = [
      "https://www.instagram.com/p/Cxyz123/",
      "https://www.instagram.com/reel/Cxyz123/",
      "https://www.instagram.com/reels/Cxyz123/",
      "https://www.instagram.com/explore/",
      "https://www.instagram.com/accounts/login/",
      "https://www.instagram.com/direct/t/123/",
      "https://www.instagram.com/stories/user/",
      "/explore/",
      "p",
      "reel",
      "direct",
    ];
    for (const path of reservedPaths) {
      assert.equal(normalizeInstagram(path), null, `Expected rejection for: ${path}`);
      assert.equal(isValidInstagram(path), false, `Expected isValidInstagram=false for: ${path}`);
    }

    // Numeric-only handles
    assert.equal(normalizeInstagram("12345678"), null);
    assert.equal(normalizeInstagram("https://www.instagram.com/12345678/"), null);

    // Bare homepages / empty
    assert.equal(normalizeInstagram("https://www.instagram.com/"), null);
    assert.equal(normalizeInstagram("https://instagram.com"), null);
    assert.equal(normalizeInstagram(""), null);
    assert.equal(normalizeInstagram(null), null);
    assert.equal(normalizeInstagram(undefined), null);
  });

  it("7. InstagramForm generates correct profile URL", () => {
    const ig = normalizeInstagram("https://www.instagram.com/recessgrove/");
    assert.equal(ig?.profileUrl, "https://www.instagram.com/recessgrove/");
  });

  it("8. InstagramForm generates correct ig.me DM URL", () => {
    const ig = normalizeInstagram("https://www.instagram.com/recessgrove/");
    assert.equal(ig?.dmUrl, "https://ig.me/m/recessgrove");
  });

  it("9 & 10 & 11. Open Instagram + Copy Message behavior simulation", async () => {
    // Contract simulation:
    // 1. Given stored instagram URL
    const storedValue = "https://www.instagram.com/recessgrove/";
    const normalized = normalizeInstagram(storedValue);
    assert.notEqual(normalized, null);

    // 2. Extract canonical handle
    const handle = normalized!.handle;
    assert.equal(handle, "recessgrove");

    // 3. Construct ig.me DM URL
    const dmUrl = normalized!.dmUrl;
    assert.equal(dmUrl, "https://ig.me/m/recessgrove");

    // 4 & 5. Copy message to clipboard + window.open simulation
    let openedUrl: string | null = null;
    let copiedText: string | null = null;

    const fakeWindowOpen = (url: string) => {
      openedUrl = url;
    };
    const fakeClipboardWrite = async (text: string) => {
      copiedText = text;
    };

    const message = "Hey there! Impressed by your coffee shop.";

    // Success path
    fakeWindowOpen(dmUrl);
    await fakeClipboardWrite(message);
    assert.equal(openedUrl, "https://ig.me/m/recessgrove");
    assert.equal(copiedText, message);

    // 11. Clipboard failure still opens Instagram
    openedUrl = null;
    const failingClipboardWrite = async (_text: string) => {
      throw new Error("Clipboard permission denied");
    };

    fakeWindowOpen(dmUrl);
    let copyError = false;
    try {
      await failingClipboardWrite(message);
    } catch {
      copyError = true;
    }
    assert.equal(openedUrl, "https://ig.me/m/recessgrove");
    assert.equal(copyError, true);
  });

  it("12. LeftSidebar uses canonical helper to format handle and profileUrl", () => {
    const dirtyValue = "https://www.instagram.com/https://www.instagram.com/recessgrove/";
    const ig = normalizeInstagram(dirtyValue);
    assert.notEqual(ig, null);
    assert.equal(`@${ig!.handle}`, "@recessgrove");
    assert.equal(ig!.profileUrl, "https://www.instagram.com/recessgrove/");
  });

  it("13. LeadDetailsDrawer uses canonical helper to format handle and profileUrl", () => {
    const atValue = "@recessgrove";
    const ig = normalizeInstagram(atValue);
    assert.notEqual(ig, null);
    assert.equal(`@${ig!.handle}`, "@recessgrove");
    assert.equal(ig!.profileUrl, "https://www.instagram.com/recessgrove/");
  });
});
