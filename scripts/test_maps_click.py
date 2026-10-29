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
        await page.goto("https://www.google.com/maps/search/Coffee+Shop+in+Seattle?hl=en", wait_until="domcontentloaded", timeout=30000)
        
        feed = await page.wait_for_selector("div[role='feed']", timeout=15000)
        cards = await feed.query_selector_all("div.Nv2PK")
        print(f"Found {len(cards)} cards")
        
        for i, card in enumerate(cards[:3]):
            anchor = await card.query_selector("a.hfpxzc")
            aria = await anchor.get_attribute("aria-label") if anchor else ""
            href = await anchor.get_attribute("href") if anchor else ""
            print(f"\n--- Card {i}: {aria} ---")
            print(f"HREF: {href[:80]}")
            
            # Use DOM click
            print("Dispatching DOM click on anchor...")
            await page.evaluate("el => el.click()", anchor)
            
            # Wait for URL to update or h1.DUwDvf to appear
            for s in range(5):
                await page.wait_for_timeout(1000)
                print(f"[{s+1}s] URL: {page.url}")
                if "/maps/place/" in page.url:
                    break

            if "/maps/place/" in page.url:
                print("SUCCESS! Place opened via DOM click!")
                h1 = await page.query_selector("h1.DUwDvf")
                print("h1 text:", await h1.inner_text() if h1 else None)
                auth = await page.query_selector("a[data-item-id='authority']")
                print("website:", await auth.get_attribute("href") if auth else None)
                phone = await page.query_selector("[data-item-id^='phone:']")
                print("phone:", await phone.get_attribute("aria-label") if phone else None)
                
                # Press Escape or click back to close detail pane
                print("Pressing Escape to return to results...")
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(1000)
                print("URL after Escape:", page.url)

        await browser.close()

asyncio.run(main())
