import asyncio
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(locale="en-US", viewport={"width": 1400, "height": 900})
        await page.goto("https://www.google.com/maps/search/Coffee+Shop+in+Chicago?hl=en", wait_until="domcontentloaded")
        feed = await page.wait_for_selector("div[role='feed']")
        cards = await feed.query_selector_all("div.Nv2PK")
        
        for i, card in enumerate(cards[:3]):
            anchor = await card.query_selector("a.hfpxzc")
            name = await anchor.get_attribute("aria-label")
            print(f"\n--- Card {i}: {name} ---")
            
            # Click on card itself or anchor
            await card.scroll_into_view_if_needed()
            await anchor.click()
            
            for s in range(5):
                await asyncio.sleep(1)
                h1 = await page.query_selector("h1.DUwDvf")
                txt = (await h1.inner_text() or "").strip() if h1 else None
                print(f"[{s+1}s] h1.DUwDvf: {txt!r} | URL: {page.url[:60]}")
                if txt and txt.lower() not in {"results", "search results"}:
                    break
            
            # Back
            btn = await page.query_selector("button[aria-label*='Back' i]")
            if btn:
                await btn.click()
                await asyncio.sleep(1)
            else:
                await page.keyboard.press("Escape")
                await asyncio.sleep(1)
                
        await browser.close()

asyncio.run(main())
