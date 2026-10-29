import asyncio
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from scraper.maps_scraper import MapsScraper
from utils.runtime import ScraperConfig

async def main():
    config = ScraperConfig(
        headless=True,
        place_timeout_ms=8000,
        card_operation_timeout_ms=15000,
    )
    print("Starting MapsScraper.search('Coffee Shop in Seattle', max_results=3)...")
    results = []
    async with MapsScraper(config=config) as scraper:
        async for r in scraper.search("Coffee Shop in Seattle", city="Seattle", country="US", niche="Coffee Shop", max_results=3):
            results.append(r)
            print(f"\n>>> YIELDED PLACE: name='{r.name}' site='{r.website}' phone='{r.phone}' address='{r.address}' maps_link='{r.maps_link}'\n")
    print(f"Total results returned: {len(results)}")

if __name__ == "__main__":
    asyncio.run(main())
