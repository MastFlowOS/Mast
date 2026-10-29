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
        
        feed = await page.wait_for_selector("div[role='feed']", timeout=15000)
        cards = await feed.query_selector_all("div.Nv2PK")
        print(f"Found {len(cards)} cards")
        
        for i, card in enumerate(cards[:5]):
            anchor = await card.query_selector("a.hfpxzc")
            name = await anchor.get_attribute("aria-label") if anchor else ""
            print(f"\n[{i}] Clicking {name}...")
            await page.evaluate("el => el.click()", anchor)
            
            # Wait for h1.DUwDvf to mount with name
            for _ in range(20):
                await asyncio.sleep(0.1)
                h1 = await page.query_selector("h1.DUwDvf")
                if h1:
                    t = (await h1.inner_text() or "").strip()
                    if t and t.lower() not in {"results", "search results"}:
                        print(f"   h1 mounted: {t}")
                        break
            
            # Wait for place settle
            cfg = ms.ScraperConfig(place_settle_ms=200, place_timeout_ms=3000)
            await ms._wait_for_place_settle(page, config=cfg)
            
            # Now test _probe_detail_panel_website
            probe_site = await ms._probe_detail_panel_website(page)
            print(f"   _probe_detail_panel_website result: {probe_site!r}")
            
            # Now test _extract_place_data
            place = await ms._extract_place_data(page, config=cfg)
            if place:
                print(f"   _extract_place_data: name={place.name!r} site={place.website!r} phone={place.phone!r} addr={place.address!r}")
            else:
                print(f"   _extract_place_data returned None!")
            
            # Press escape to return
            await page.keyboard.press("Escape")
            await asyncio.sleep(0.3)
            
        await browser.close()

asyncio.run(main())
