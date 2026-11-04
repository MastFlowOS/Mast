SCRAPER_PATH = r"mast-lead-engine\scraper\maps_scraper.py"
with open(SCRAPER_PATH, "r", encoding="utf-8") as f:
    c = f.read()

target = """    url = getattr(page, "url", "") or ""
    place_id = _stable_place_id_from_url(url) if "/maps/place/" in url else ""
    if not detail_open and "/maps/place/" in url and "/maps/search/" not in url:
        detail_open = True
    if not raw_name and "/maps/place/" in url and "/maps/search/" not in url:
        slug_name = _place_name_from_href(url)
        if slug_name:
            raw_name = slug_name"""

replacement = """    url = getattr(page, "url", "") or ""
    place_id = _stable_place_id_from_url(url) if "/maps/place/" in url else ""
    if not detail_open and "/maps/place/" in url and "/maps/search/" not in url:
        detail_open = True"""

assert target in c, "target not found"
c = c.replace(target, replacement, 1)
with open(SCRAPER_PATH, "w", encoding="utf-8", newline="") as f:
    f.write(c)
print("updated snapshot logic cleanly")
