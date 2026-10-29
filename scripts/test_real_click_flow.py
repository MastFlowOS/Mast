import asyncio
import sys
import os
sys.path.insert(0, os.path.abspath("mast-lead-engine"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
from playwright.async_api import async_playwright
import scraper.maps_scraper as ms

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(locale="en-US")
        await page.goto("https://www.google.com/maps/search/Coffee+Shop+in+Chicago?hl=en", wait_until="domcontentloaded")
        feed = await page.wait_for_selector("div[role='feed']")
        anchors = await feed.query_selector_all("a.hfpxzc")
        print(f"Found {len(anchors)} anchors")
        
        cfg = ms.ScraperConfig(place_settle_ms=200, place_timeout_ms=4000)
        
        for i, anchor in enumerate(anchors[:3]):
            name = await anchor.get_attribute("aria-label")
            print(f"\n--- Card {i}: {name} ---")
            
            # Use real Playwright click
            await anchor.scroll_into_view_if_needed()
            await anchor.click(force=True)
            
            # Wait for h1.DUwDvf to mount with name
            mounted = False
            for _ in range(30):
                await asyncio.sleep(0.1)
                h1 = await page.query_selector("h1.DUwDvf")
                if h1:
                    t = (await h1.inner_text() or "").strip()
                    if t and t.lower() not in {"results", "search results"}:
                        print(f"   h1 mounted in detail panel: {t!r}")
                        mounted = True
                        break
                        
            if not mounted:
                print("   Failed to mount h1!")
                continue
                
            # Wait for place settle
            await ms._wait_for_place_settle(page, config=cfg)
            
            # Extract
            place = await ms._extract_place_data(page, config=cfg)
            if place:
                print(f"   EXTRACTED: name={place.name!r} website={place.website!r} phone={place.phone!r} address={place.address!r}")
            else:
                print("   EXTRACTED: None!")
                
            # Return to results
            await ms._return_to_results(page, "div[role='feed']", config=cfg)
            await asyncio.sleep(0.3)
            
        await browser.close()

asyncio.run(main())
