import re, time

_ANCHOR_RE = re.compile(r'<a\s[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
_HIRING_LINK_HINTS = ("/careers", "/jobs", "/join-us", "/join-our-team", "/work-with-us")
_HIRING_PHRASE_RE = re.compile(r"we(?:'|’)re hiring|now hiring|join our team|open positions|current openings|careers page", re.IGNORECASE)
_NEW_LOCATION_PHRASE_RE = re.compile(r"new location|opening soon|coming soon|now open in|second location|our new (?:shop|store|studio|location)", re.IGNORECASE)
_HIRING_LINK_RE = re.compile(r'href=["\'](?:https?://[^"\']*)?(?:' + "|".join(re.escape(h) for h in _HIRING_LINK_HINTS) + r')(?:[/?#"\'\s]|$)', re.IGNORECASE)

html = """
<html><body>
""" + "<p>Some generic text about business</p><a href='/about'>About</a><a href='/services'>Services</a><a href='/menu'>Menu</a><a href='/contact'>Contact</a>" * 50 + """
<a href="/careers">Work with us</a>
</body></html>
"""

# Existing implementation
def old_growth_signals(html: str) -> dict:
    if not html: return {}
    signals = {}
    low = html.lower()
    anchors = [href for href, _ in _ANCHOR_RE.findall(html)]
    hiring_link = any(any(h in (a or "").lower() for h in _HIRING_LINK_HINTS) for a in anchors)
    if hiring_link or _HIRING_PHRASE_RE.search(low):
        signals["hiring"] = True
    if _NEW_LOCATION_PHRASE_RE.search(low):
        signals["new_location"] = True
    return signals

# Optimized implementation
def new_growth_signals(html: str) -> dict:
    if not html: return {}
    signals = {}
    if _HIRING_LINK_RE.search(html) or _HIRING_PHRASE_RE.search(html):
        signals["hiring"] = True
    if _NEW_LOCATION_PHRASE_RE.search(html):
        signals["new_location"] = True
    return signals

assert old_growth_signals(html) == new_growth_signals(html)

t0 = time.perf_counter()
for _ in range(5000):
    old_growth_signals(html)
t1 = time.perf_counter()
print(f"Old growth signals: {(t1 - t0)*1000:.2f}ms")

t0 = time.perf_counter()
for _ in range(5000):
    new_growth_signals(html)
t1 = time.perf_counter()
print(f"New growth signals: {(t1 - t0)*1000:.2f}ms")
