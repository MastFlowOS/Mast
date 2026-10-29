import asyncio
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(locale="en-US", viewport={"width": 1280, "height": 900})
        page = await context.new_page()
        url = "https://www.google.com/maps/place/Moore+Coffee+Shop/@47.6116389,-122.3412222,13z"
        print(f"Navigating to {url}...")
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(3000)
        
        # Find all elements containing 'Moore' where is_visible is True
        els = await page.query_selector_all("text='Moore Coffee Shop'")
        print(f"Found {len(els)} elements matching text 'Moore Coffee Shop':")
        for i, el in enumerate(els):
            tag = await el.evaluate("e => e.tagName")
            cls = await el.get_attribute("class") or ""
            box = await el.bounding_box()
            vis = await el.is_visible()
            html = await el.evaluate("e => e.outerHTML")
            parent = await el.evaluate("e => e.parentElement ? e.parentElement.tagName + '.' + (e.parentElement.className||'') : 'none'")
            print(f"[{i}] <{tag} class='{cls}'> parent=<{parent}> vis={vis} box={box}")

        # Also let's check what h1 or title elements exist that are visible
        headings = await page.query_selector_all("h1, [role='main'] *")
        visible_with_text = []
        for h in headings:
            if await h.is_visible():
                txt = (await h.inner_text()).strip()
                if txt and len(txt) < 50:
                    tag = await h.evaluate("e => e.tagName")
                    cls = await h.get_attribute("class") or ""
                    box = await h.bounding_box()
                    visible_with_text.append((tag, cls, txt, box))
        print("\nVisible elements in role='main' with short text:")
        for v in visible_with_text[:15]:
            print(f"  <{v[0]} class='{v[1]}'>: {repr(v[2])} box={v[3]}")

        await browser.close()

asyncio.run(main())
